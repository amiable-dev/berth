import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flagString, type ParsedArgs } from '../args.js';
import { resolveContext } from '../context.js';
import {
  allLeases,
  readLeases,
  readSession,
  withLock,
  writeLeases,
  writeSession,
} from '../ledger.js';
import { loadPolicy, type Policy, policyExists, worktreeRange } from '../policy.js';
import { buildReport } from '../report.js';
import type { SessionFile } from '../types.js';
import { atomicWriteSync, nowIso, shortId } from '../util.js';
import { envLines, rolePorts } from './allocate.js';
import type { IO } from './query.js';

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  reason?: string;
  source?: string;
}

async function readStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

function parseHookInput(text: string): HookInput {
  try {
    const v = JSON.parse(text) as HookInput;
    return typeof v === 'object' && v !== null ? v : {};
  } catch {
    return {};
  }
}

const RULES = [
  'Rules: pass the port explicitly (--port $PORT, vite --strictPort); never let a framework pick one.',
  'Check `berth who <port>` before binding anything else; do not kill a listener you do not own.',
  'New service: `berth claim --role <role>` or `berth claim --extra <name>`; scratch: `berth claim --dynamic 1`.',
  'Tell the human the URL you actually bound.',
].join(' ');

export async function buildContextText(
  policy: Policy,
  _sessionId: string | undefined,
  cwd: string,
  deadlineMs: number,
): Promise<{ text: string; exports: string[] }> {
  const started = Date.now();
  const ctx = await resolveContext(policy, cwd, { assign: true });
  const lines: string[] = ['## Ports (berth)'];
  const exports: string[] = [];
  if (!ctx.project) {
    lines.push(
      `This directory is not a project in ${'~/.config/berth/policy.toml'}. Use \`berth claim --dynamic 1\` for a scratch port (${policy.pools.dynamic[0]}–${policy.pools.dynamic[1]}) or add the project and run \`berth doctor\`.`,
    );
  } else if (ctx.W === null) {
    lines.push(
      `Project ${ctx.project.name} (P=${ctx.project.P}), but worktree "${ctx.worktreeName}" has no free slot. Run \`berth worktrees prune --project ${ctx.project.name} --w <n>\` or use \`berth claim --dynamic 1\`.`,
    );
  } else {
    const project = ctx.project;
    const W = ctx.W;
    const [lo, hi] = worktreeRange(policy, project.P, W);
    const [blo, bhi] = [
      policy.scheme.base + 1000 * project.P,
      policy.scheme.base + 1000 * project.P + 999,
    ];
    lines.push(
      `Project ${project.name} (P=${project.P}) owns ${blo}–${bhi}. This checkout is W${W}${ctx.worktreeName ? ` (worktree ${ctx.worktreeName})` : ' (main)'} → ${lo}–${hi}.`,
    );
    const ports = rolePorts(policy, project, W);
    lines.push(`Ports: ${ports.map((p) => `${p.role} ${p.port}`).join(' · ')}.`);
    exports.push(...envLines(policy, ctx, 'shell'));
    lines.push(
      `Exported for this session: PORT (web) and ${ports.map((p) => p.env).join(', ')}; BERTH_BLOCK=${lo}-${hi}.`,
    );
    if (project.declared.length)
      lines.push(
        `Legacy ports this repo still hardcodes: ${project.declared.join(', ')} (migrate with \`berth env --compose-override\` or \`berth env --dotenv\`).`,
      );
    if (Date.now() - started < deadlineMs) {
      try {
        const report = await buildReport({
          policy,
          maxAgeMs: 5000,
          skipDocker: true,
          skipEnv: true,
          skipNetstat: true,
          compact: false,
        });
        const mine = report.ports.filter(
          (p) => p.project === project.name || (p.lease && p.lease.project === project.name),
        );
        const leases = mine.filter((p) => p.lease);
        if (leases.length)
          lines.push(
            `Current leases: ${leases.map((p) => `${p.port} ${p.role} (${p.state}${p.lease?.owner.session_id ? `, session ${shortId(p.lease.owner.session_id)}…` : ''})`).join(' · ')}.`,
          );
        const trouble = mine.filter((p) => p.state !== 'ok' && p.state !== 'idle');
        lines.push(
          trouble.length
            ? `Attention: ${trouble.map((p) => `${p.port} ${p.state}${p.live ? ` (bound by ${p.live.holder})` : ''}`).join(' · ')}.`
            : 'No conflicts touching this project right now.',
        );
      } catch {
        lines.push('(live check skipped)');
      }
    }
  }
  const shared = Object.entries(policy.shared);
  if (shared.length) {
    for (const [name, svc] of shared) {
      lines.push(
        `Shared ${name} (owned by ${svc.owner}; do not start another): ${Object.entries(svc.ports)
          .map(([s, p]) => `${s} ${p}`)
          .join(' · ')}.`,
      );
    }
  }
  lines.push(RULES);
  return { text: lines.join('\n'), exports };
}

/** SessionStart hook: read-only against the ledger, always exit 0, budget ~200 ms. */
export async function cmdContext(args: ParsedArgs, io: IO): Promise<number> {
  const raw = await readStdin(150);
  const input = parseHookInput(raw);
  const sessionId =
    input.session_id ?? flagString(args.flags, 'session') ?? process.env.CLAUDE_CODE_SESSION_ID;
  const cwd = input.cwd ?? flagString(args.flags, 'cwd') ?? process.cwd();
  const emit = (text: string) => {
    io.out(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
      }),
    );
  };
  if (!policyExists()) {
    emit(
      '## Ports (berth)\nberth is installed but has no policy yet: copy examples/policy.example.toml to ~/.config/berth/policy.toml. Until then pass ports explicitly and check `lsof -nP -iTCP:<port> -sTCP:LISTEN` before binding.',
    );
    return 0;
  }
  try {
    const policy = loadPolicy();
    const { text, exports } = await buildContextText(policy, sessionId, cwd, 120);
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (envFile && exports.length) {
      try {
        appendFileSync(envFile, `${exports.join('\n')}\nexport BERTH_SESSION_CONTEXT=1\n`);
      } catch {
        // env file is optional
      }
    }
    if (sessionId) {
      const ctx = await resolveContext(policy, cwd, { assign: false, git: false });
      const pid = Number(process.env.CLAUDE_PID);
      const existing = readSession(sessionId);
      const file: SessionFile = {
        id: sessionId,
        tool: 'claude-code',
        ...(Number.isInteger(pid) && pid > 0
          ? { pid }
          : existing?.pid
            ? { pid: existing.pid }
            : {}),
        started: existing?.started ?? nowIso(),
        ended: null,
        cwd,
        ...(ctx.project ? { project: ctx.project.name } : {}),
        ...(ctx.W !== null ? { worktree: ctx.W } : {}),
      };
      writeSession(file);
    }
    emit(text);
  } catch (e) {
    emit(
      `## Ports (berth)\nberth could not build context: ${(e as Error).message}. Pass ports explicitly and check \`berth doctor\`.`,
    );
  }
  return 0;
}

/** SessionEnd hook: mark the session ended and soft-release its dynamic leases. */
export async function cmdSessionEnd(args: ParsedArgs, _io: IO): Promise<number> {
  const input = parseHookInput(await readStdin(150));
  const sessionId =
    input.session_id ?? flagString(args.flags, 'session') ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return 0;
  const existing = readSession(sessionId);
  writeSession({
    id: sessionId,
    tool: existing?.tool ?? 'claude-code',
    ...(existing?.pid ? { pid: existing.pid } : {}),
    started: existing?.started ?? nowIso(),
    ended: nowIso(),
    cwd: existing?.cwd ?? input.cwd ?? process.cwd(),
    ...(existing?.project ? { project: existing.project } : {}),
    ...(existing?.worktree !== undefined ? { worktree: existing.worktree } : {}),
  });
  try {
    await withLock({ deadlineMs: 1000, cmd: 'session-end' }, () => {
      const ledger = readLeases();
      let changed = false;
      for (const l of ledger.leases) {
        if (l.owner.session_id === sessionId && !l.ended) {
          l.ended = nowIso();
          if (l.kind === 'dynamic') l.expires = nowIso();
          changed = true;
        }
      }
      if (changed) writeLeases(ledger);
    });
  } catch {
    // lock busy: the session file alone is enough for the reconciler to mark leases stale
  }
  return 0;
}

// ---- hooks install ------------------------------------------------------------

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}
interface Settings {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

function berthCommand(sub: string): string {
  const node = process.execPath;
  let script = process.argv[1] ?? '';
  try {
    script = realpathSync(script);
  } catch {
    // keep as is
  }
  return `"${node}" "${script}" ${sub} --hook`;
}

/** berth-installed hook commands end with `context --hook` or `session-end --hook`. */
export function isBerthHook(cmd: string): boolean {
  return (
    /\s(context|session-end) --hook\s*$/.test(cmd) ||
    /berth(\.js)?"?\s+(context|session-end)\s*$/.test(cmd)
  );
}

export function mergeHooks(settings: Settings, install: boolean): Settings {
  const hooks = { ...(settings.hooks ?? {}) };
  const strip = (entries: HookEntry[] | undefined) =>
    (entries ?? [])
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !isBerthHook(h.command)) }))
      .filter((e) => e.hooks.length > 0);
  hooks.SessionStart = strip(hooks.SessionStart);
  hooks.SessionEnd = strip(hooks.SessionEnd);
  if (install) {
    hooks.SessionStart.push({
      matcher: 'startup|resume|clear|compact',
      hooks: [{ type: 'command', command: berthCommand('context'), timeout: 5 }],
    });
    hooks.SessionEnd.push({
      hooks: [{ type: 'command', command: berthCommand('session-end'), timeout: 5 }],
    });
  }
  if (hooks.SessionStart.length === 0) delete hooks.SessionStart;
  if (hooks.SessionEnd.length === 0) delete hooks.SessionEnd;
  return { ...settings, hooks };
}

export async function cmdHooks(args: ParsedArgs, io: IO): Promise<number> {
  const sub = args.positional[0] ?? 'print';
  const file =
    flagString(args.flags, 'settings') ?? path.join(os.homedir(), '.claude', 'settings.json');
  if (sub === 'print') {
    io.out(JSON.stringify(mergeHooks({}, true).hooks, null, 2));
    return 0;
  }
  if (sub !== 'install' && sub !== 'uninstall') {
    io.err('usage: berth hooks install|uninstall|print [--settings <path>]');
    return 2;
  }
  let settings: Settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    } catch (e) {
      io.err(`${file} is not valid JSON: ${(e as Error).message}`);
      return 1;
    }
  }
  const merged = mergeHooks(settings, sub === 'install');
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (existsSync(file)) atomicWriteSync(backup, readFileSync(file, 'utf8'));
  atomicWriteSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  io.out(
    `${sub === 'install' ? 'installed' : 'removed'} berth SessionStart/SessionEnd hooks in ${file}${existsSync(backup) ? ` (backup: ${backup})` : ''}`,
  );
  return 0;
}

export const _test = { parseHookInput, RULES, allLeases };
