import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flagString, type ParsedArgs } from '../args.js';
import { resolveContext } from '../context.js';
import { readSession, writeSession } from '../ledger.js';
import { blockRange, loadPolicy, type Policy, policyExists, worktreeRange } from '../policy.js';
import { buildReportFromCache } from '../report.js';
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

/** Hooks must answer fast: total budget for SessionStart, including stdin and git. */
export const HOOK_BUDGET_MS = 180;

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

export function parseHookInput(text: string): HookInput {
  try {
    const v = JSON.parse(text) as HookInput;
    return typeof v === 'object' && v !== null ? v : {};
  } catch {
    return {};
  }
}

export const RULES = [
  'Rules: pass the port explicitly (--port $PORT, vite --strictPort); never let a framework pick one.',
  'Check `berth who <port>` before binding anything else; do not kill a listener you do not own.',
  'New service: `berth claim --role <role>` or `berth claim --extra <name>`; scratch: `berth claim --dynamic 1`.',
  'Tell the human the URL you actually bound.',
].join(' ');

function sharedLines(policy: Policy): string[] {
  return Object.entries(policy.shared).map(
    ([name, svc]) =>
      `Shared ${name} (owned by ${svc.owner}; do not start another): ${Object.entries(svc.ports)
        .map(([s, p]) => `${s} ${p}`)
        .join(' · ')}.`,
  );
}

/**
 * Context for a Claude session. Read-only: no allocation (assign: false), no ledger write, no
 * process spawned except a short git probe; live state comes from the truth cache only.
 */
export async function buildContextText(
  policy: Policy,
  cwd: string,
  opts: { gitTimeoutMs?: number } = {},
): Promise<{ text: string; exports: string[] }> {
  const ctx = await resolveContext(policy, cwd, {
    assign: false,
    gitTimeoutMs: opts.gitTimeoutMs ?? 120,
  });
  const lines: string[] = ['## Ports (berth)'];
  const exports: string[] = [];
  if (!ctx.project) {
    lines.push(
      `This directory is not a project in ~/.config/berth/policy.toml. Use \`berth claim --dynamic 1\` for a scratch port (${policy.pools.dynamic[0]}–${policy.pools.dynamic[1]}) or add the project and run \`berth doctor\`.`,
    );
  } else if (ctx.W === null) {
    lines.push(
      `Project ${ctx.project.name} (P=${ctx.project.P}); worktree "${ctx.worktreeName}" has no W slot yet. Run \`berth env --shell\` once to assign one (or \`berth worktrees prune --project ${ctx.project.name} --w <n>\` if all ${policy.scheme.worktreeMax} are taken).`,
    );
  } else {
    const project = ctx.project;
    const W = ctx.W;
    const [lo, hi] = worktreeRange(policy, project.P, W);
    const [blo, bhi] = blockRange(policy, project.P);
    lines.push(
      `Project ${project.name} (P=${project.P}) owns ${blo}–${bhi}. This checkout is W${W}${ctx.worktreeName ? ` (worktree ${ctx.worktreeName})` : ' (main)'} → ${lo}–${hi}.`,
    );
    const ports = rolePorts(policy, project, W);
    lines.push(`Ports: ${ports.map((p) => `${p.role} ${p.port}`).join(' · ')}.`);
    exports.push(...envLines(policy, ctx, 'shell'));
    lines.push(
      `Exported for this session: PORT (web) and ${ports.map((p) => p.env).join(', ')}; BERTH_BLOCK=${lo}-${hi}.`,
    );
    if (project.declared.length) {
      lines.push(
        `Legacy ports this repo still hardcodes: ${project.declared.join(', ')} (migrate with \`berth env --compose-override\` or \`berth env --dotenv\`).`,
      );
    }
    const report = buildReportFromCache(policy, 5000);
    if (report) {
      const mine = report.ports.filter(
        (p) => p.project === project.name || p.lease?.project === project.name,
      );
      const leases = mine.filter((p) => p.lease);
      if (leases.length) {
        lines.push(
          `Current leases: ${leases
            .map(
              (p) =>
                `${p.port} ${p.role} (${p.state}${p.lease?.owner.session_id ? `, session ${shortId(p.lease.owner.session_id)}…` : ''})`,
            )
            .join(' · ')}.`,
        );
      }
      const trouble = mine.filter((p) => p.state !== 'ok' && p.state !== 'idle');
      lines.push(
        trouble.length
          ? `Attention: ${trouble.map((p) => `${p.port} ${p.state}${p.live ? ` (bound by ${p.live.holder})` : ''}`).join(' · ')}.`
          : 'No conflicts touching this project in the last check.',
      );
    } else {
      lines.push(
        'Live state not checked at session start (no fresh snapshot); run `berth check` when it matters.',
      );
    }
  }
  lines.push(...sharedLines(policy));
  lines.push(RULES);
  return { text: lines.join('\n'), exports };
}

function fallbackContext(policy: Policy | undefined, why: string): string {
  const shared = policy ? sharedLines(policy) : [];
  return [
    '## Ports (berth)',
    `berth: ${why}. Run \`berth env --shell\` for this project's ports and \`berth doctor\` if that fails.`,
    ...shared,
    RULES,
  ].join('\n');
}

/**
 * When running from the Claude Code plugin, put its bin/ on the session PATH so `berth` works in
 * every Bash call without a global npm install. Skipped when a `berth` is already on PATH.
 */
export function pluginPathExports(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = env.BERTH_PLUGIN_ROOT;
  if (!root) return [];
  const bin = path.join(root, 'bin');
  if (!existsSync(path.join(bin, 'berth'))) return [];
  const onPath = (env.PATH ?? '')
    .split(path.delimiter)
    .some((d) => d && existsSync(path.join(d, 'berth')));
  if (onPath) return [`export BERTH_BIN=${JSON.stringify(path.join(bin, 'berth'))}`];
  return [
    `export PATH=${JSON.stringify(bin)}:"$PATH"`,
    `export BERTH_BIN=${JSON.stringify(path.join(bin, 'berth'))}`,
  ];
}

/** SessionStart hook: read-only against allocation state, always exit 0, hard deadline. */
export async function cmdContext(args: ParsedArgs, io: IO): Promise<number> {
  const started = Date.now();
  const emit = (text: string) => {
    io.out(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
      }),
    );
  };
  let policy: Policy | undefined;
  try {
    const raw = await readStdin(100);
    const input = parseHookInput(raw);
    const sessionId =
      input.session_id ?? flagString(args.flags, 'session') ?? process.env.CLAUDE_CODE_SESSION_ID;
    const cwd = input.cwd ?? flagString(args.flags, 'cwd') ?? process.cwd();
    if (!policyExists()) {
      emit(
        '## Ports (berth)\nberth is installed but has no policy yet: copy examples/policy.example.toml to ~/.config/berth/policy.toml. Until then pass ports explicitly and check `lsof -nP -iTCP:<port> -sTCP:LISTEN` before binding.',
      );
      return 0;
    }
    policy = loadPolicy();
    if (sessionId) {
      try {
        const p = policy;
        const ctx = await resolveContext(p, cwd, { assign: false, git: false });
        const pid = Number(process.env.CLAUDE_PID);
        const existing = readSession(sessionId);
        writeSession({
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
        });
      } catch {
        // recording the session is best-effort
      }
    }
    const remaining = Math.max(20, HOOK_BUDGET_MS - (Date.now() - started));
    const p = policy;
    // The deadline timer must not keep the process alive once the context is built.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), remaining);
    });
    const built = await Promise.race([
      buildContextText(p, cwd, { gitTimeoutMs: Math.min(120, remaining) }),
      deadline,
    ]);
    if (timer) clearTimeout(timer);
    if (!built) {
      emit(fallbackContext(policy, 'context took too long'));
      return 0;
    }
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (envFile) {
      const lines = [...built.exports, 'export BERTH_SESSION_CONTEXT=1', ...pluginPathExports()];
      try {
        appendFileSync(envFile, `${lines.join('\n')}\n`);
      } catch {
        // env file is optional
      }
    }
    emit(built.text);
  } catch (e) {
    emit(fallbackContext(policy, `could not build context (${(e as Error).message})`));
  }
  return 0;
}

/**
 * SessionEnd hook: records that the session ended, nothing else. The reconciler treats an
 * ended session's leases as stale once nothing is bound; no ledger write is needed.
 */
export async function cmdSessionEnd(args: ParsedArgs, _io: IO): Promise<number> {
  try {
    const input = parseHookInput(await readStdin(100));
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
  } catch {
    // never fail a session end
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
