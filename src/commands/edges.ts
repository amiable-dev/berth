import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { resolveContext } from '../context.js';
import {
  allLeases,
  compact,
  markWorktreeRemoved,
  pruneWorktreeSlot,
  worktreeSlots,
} from '../ledger.js';
import { isHttpRole, loadPolicy, normalizeDir, type Policy, projectByName } from '../policy.js';
import { appendFileSafe, atomicWriteSync, contractHome, run } from '../util.js';
import { rolePorts } from './allocate.js';
import { isGitRoot } from './project.js';
import type { IO } from './query.js';

export async function cmdCompact(args: ParsedArgs, io: IO): Promise<number> {
  const r = await compact({ deadlineMs: 5000 });
  io.out(
    flagBool(args.flags, 'json')
      ? JSON.stringify(r, null, 2)
      : `folded ${r.folded} claim${r.folded === 1 ? '' : 's'}${r.dropped.length ? `; dropped ${r.dropped.length} (see compact.log)` : ''}`,
  );
  return 0;
}

interface LaunchConfig {
  name: string;
  runtimeExecutable?: string;
  runtimeArgs?: string[];
  port?: number;
  env?: Record<string, string>;
  cwd?: string;
  [k: string]: unknown;
}
interface LaunchJson {
  version?: string;
  configurations?: LaunchConfig[];
  [k: string]: unknown;
}

/**
 * `cwd` is the launch config's `cwd` field, already resolved to a path relative to the
 * repository root (or `undefined` when it equals the repository root: the desktop app already
 * runs configurations from the project directory, so an explicit `cwd` would be redundant and
 * machine-specific for the common case).
 */
export function buildLaunchConfigs(
  policy: Policy,
  projectName: string,
  W: number,
  pkgScripts: Record<string, string>,
  cwd?: string,
): LaunchConfig[] {
  const project = projectByName(policy, projectName);
  if (!project) return [];
  const ports = rolePorts(policy, project, W);
  const web = ports.find((p) => p.role === 'web');
  const api = ports.find((p) => p.role === 'api');
  const out: LaunchConfig[] = [];
  const env: Record<string, string> = {};
  for (const p of ports) env[p.env] = String(p.port);
  const pick = (names: string[]) => names.find((n) => n in pkgScripts);
  const devScript = pick(['dev', 'start', 'serve']);
  if (web && devScript) {
    out.push({
      name: `${project.name} web (berth W${W})`,
      runtimeExecutable: 'npm',
      runtimeArgs: ['run', devScript],
      port: web.port,
      env: { ...env, PORT: String(web.port) },
      ...(cwd ? { cwd } : {}),
    });
  }
  const apiScript = pick(['dev:api', 'api', 'start:api']);
  if (api && apiScript) {
    out.push({
      name: `${project.name} api (berth W${W})`,
      runtimeExecutable: 'npm',
      runtimeArgs: ['run', apiScript],
      port: api.port,
      env: { ...env, PORT: String(api.port) },
      ...(cwd ? { cwd } : {}),
    });
  }
  if (out.length === 0 && web) {
    out.push({
      name: `${project.name} web (berth W${W})`,
      runtimeExecutable: 'npm',
      runtimeArgs: ['run', 'dev'],
      port: web.port,
      env: { ...env, PORT: String(web.port) },
      ...(cwd ? { cwd } : {}),
    });
  }
  return out;
}

/** The common `.git` dir (shared by all worktrees), via `git rev-parse`; `undefined` outside a
 *  git repository or if `git` itself is unavailable. */
async function gitCommonDir(dir: string): Promise<string | undefined> {
  const r = await run(
    'git',
    ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { timeoutMs: 1500 },
  );
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export type ExcludeAction = 'excluded' | 'already-excluded' | 'tracked' | 'ignored' | 'not-a-repo';

/**
 * After `launch-json --write`, keep `.claude/launch.json` out of git locally: append it to
 * `.git/info/exclude` (never `.gitignore`, which would be committed) unless it is already
 * tracked or already ignored by some other pattern. Silent no-op outside a git repository.
 */
export async function excludeLaunchJsonFromGit(
  dir: string,
): Promise<{ action: ExcludeAction; excludeFile?: string }> {
  const rel = '.claude/launch.json';
  if (!isGitRoot(dir)) return { action: 'not-a-repo' };
  const commonDir = await gitCommonDir(dir);
  if (!commonDir) return { action: 'not-a-repo' };
  const tracked = await run('git', ['-C', dir, 'ls-files', '--error-unmatch', rel], {
    timeoutMs: 1500,
  });
  if (tracked.code === 0) return { action: 'tracked' };
  const ignored = await run('git', ['-C', dir, 'check-ignore', '-q', rel], { timeoutMs: 1500 });
  if (ignored.code === 0) return { action: 'ignored' };
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  const text = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim() === rel)) {
    return { action: 'already-excluded', excludeFile };
  }
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  appendFileSafe(excludeFile, `${sep}${rel}\n`);
  return { action: 'excluded', excludeFile };
}

export async function cmdLaunchJson(args: ParsedArgs, io: IO): Promise<number> {
  const policy = loadPolicy();
  const cwd = flagString(args.flags, 'cwd') ?? process.cwd();
  const ctx = await resolveContext(policy, cwd, { assign: true });
  if (!ctx.project || ctx.W === null) {
    io.err(`${cwd} is not a known project (or its worktree has no slot)`);
    return 1;
  }
  const dir = ctx.worktreePath ?? ctx.project.path;
  let scripts: Record<string, string> = {};
  const pkg = path.join(dir, 'package.json');
  if (existsSync(pkg)) {
    try {
      scripts =
        (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ??
        {};
    } catch {
      scripts = {};
    }
  }
  // The desktop app already runs configurations from `dir` (where .claude/launch.json lives), so
  // a config-level `cwd` is only meaningful — and only written — when --cwd points elsewhere.
  // ctx.cwd is realpath-resolved (see normalizeDir); project.path as parsed from policy.toml is
  // only path.resolve'd, so both sides need normalizeDir before comparing (macOS /var vs
  // /private/var and the like) or every write from the repo root would spuriously get a cwd.
  const rel = path.relative(normalizeDir(dir), ctx.cwd);
  const configCwd = rel === '' ? undefined : rel;
  const configs = buildLaunchConfigs(policy, ctx.project.name, ctx.W, scripts, configCwd);
  const file = path.join(dir, '.claude', 'launch.json');
  let existing: LaunchJson = { version: '0.0.1', configurations: [] };
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, 'utf8')) as LaunchJson;
    } catch {
      io.err(`${file} is not valid JSON; not touching it`);
      return 1;
    }
  }
  const kept = (existing.configurations ?? []).filter((c) => !/\(berth W\d\)$/.test(c.name));
  const merged: LaunchJson = {
    ...existing,
    version: existing.version ?? '0.0.1',
    configurations: [...kept, ...configs],
  };
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  if (flagBool(args.flags, 'write')) {
    atomicWriteSync(file, text, { mode: 0o644 });
    io.out(
      `wrote ${file} (${configs.length} berth configuration${configs.length === 1 ? '' : 's'})`,
    );
    if (args.flags.exclude !== false) {
      const r = await excludeLaunchJsonFromGit(dir);
      if (r.action === 'excluded' && r.excludeFile) {
        io.out(
          `excluded .claude/launch.json via ${contractHome(r.excludeFile)} (never committed by accident)`,
        );
      }
    }
  } else io.out(text);
  return 0;
}

export function aliasName(project: string, role: string, worktreeName?: string): string {
  const base = role === 'web' ? project : `${project}-${role}`;
  return worktreeName ? `${worktreeName.replace(/[^A-Za-z0-9-]+/g, '-')}.${base}` : base;
}

export async function cmdNames(args: ParsedArgs, io: IO): Promise<number> {
  const policy = loadPolicy();
  const sub = args.positional[0] ?? 'list';
  if (policy.names.provider === 'none') {
    io.out('names.provider = "none" in policy; nothing to do');
    return 0;
  }
  const probe = await run('portless', ['--version'], { timeoutMs: 4000 });
  if (probe.missing) {
    io.err('portless is not installed (npm i -g portless); names sync disabled');
    return 1;
  }
  if (sub === 'list') {
    const r = await run('portless', ['list'], { timeoutMs: 6000 });
    io.out(r.stdout.trim() || r.stderr.trim() || '(no routes)');
    return r.code === 0 ? 0 : 1;
  }
  if (sub !== 'sync') {
    io.err('usage: berth names list|sync [--all] [--dry-run]');
    return 2;
  }
  const cwd = flagString(args.flags, 'cwd') ?? process.cwd();
  const ctx = await resolveContext(policy, cwd, { assign: false });
  const leases = allLeases().filter(
    (l) => (flagBool(args.flags, 'all') || l.project === ctx.project?.name) && isHttpRole(l.role),
  );
  if (leases.length === 0) {
    io.out('no http leases to alias');
    return 0;
  }
  const dry = flagBool(args.flags, 'dry-run');
  const json = flagBool(args.flags, 'json');
  const results: { name: string; port: number; ok: boolean; error?: string }[] = [];
  for (const l of leases) {
    const slot =
      l.worktree > 0 ? worktreeSlots(l.project).find((s) => s.W === l.worktree)?.name : undefined;
    const name = aliasName(l.project, l.role, slot);
    if (dry) {
      results.push({ name, port: l.port, ok: true });
      if (!json) io.out(`portless alias ${name} ${l.port}`);
      continue;
    }
    const r = await run('portless', ['alias', name, String(l.port)], { timeoutMs: 8000 });
    const err = (r.stderr || r.stdout).trim();
    results.push({ name, port: l.port, ok: r.code === 0, ...(r.code === 0 ? {} : { error: err }) });
    if (!json)
      io.out(
        `${r.code === 0 ? 'ok  ' : 'fail'} ${name}.localhost -> ${l.port}${r.code === 0 ? '' : `: ${err}`}`,
      );
  }
  if (json) io.out(JSON.stringify(results, null, 2));
  return 0;
}

export async function cmdWorktrees(args: ParsedArgs, io: IO): Promise<number> {
  const policy = loadPolicy();
  const sub = args.positional[0] ?? 'list';
  const projectName = flagString(args.flags, 'project');
  if (sub === 'list') {
    if (flagBool(args.flags, 'json')) {
      const all = Object.values(policy.projects)
        .filter((p) => !projectName || p.name === projectName)
        .map((p) => ({ project: p.name, slots: worktreeSlots(p.name) }))
        .filter((x) => x.slots.length > 0);
      io.out(JSON.stringify(all, null, 2));
      return 0;
    }
    for (const p of Object.values(policy.projects).sort((a, b) => a.P - b.P)) {
      if (projectName && p.name !== projectName) continue;
      const slots = worktreeSlots(p.name);
      if (slots.length === 0) continue;
      io.out(`${p.name}`);
      for (const s of slots)
        io.out(
          `  W${s.W}  ${s.name}  ${s.path}${s.removed ? `  (removed ${s.removed})` : existsSync(s.path) ? '' : '  (path missing)'}`,
        );
    }
    return 0;
  }
  const W = Number(flagString(args.flags, 'w'));
  if (!projectName || !Number.isInteger(W) || W < 1) {
    io.err(
      'usage: berth worktrees list | remove --project <name> --w <n> | prune --project <name> --w <n>',
    );
    return 2;
  }
  if (sub === 'remove') {
    io.out(
      markWorktreeRemoved(projectName, W)
        ? `W${W} of ${projectName} marked removed (tombstone kept)`
        : 'no such slot',
    );
    return 0;
  }
  if (sub === 'prune') {
    io.out(
      pruneWorktreeSlot(projectName, W)
        ? `W${W} of ${projectName} pruned; the number may be reused`
        : 'no such slot',
    );
    return 0;
  }
  io.err('unknown worktrees subcommand');
  return 2;
}
