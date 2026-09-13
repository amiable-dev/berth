import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { composeServices, findComposeFile, inferRole } from '../compose.js';
import { withLock } from '../ledger.js';
import { configDir, policyLockPath, policyPath } from '../paths.js';
import {
  blockRange,
  DEFAULT_IGNORE_PROCESSES,
  DEFAULT_ROLES,
  loadPolicy,
  normalizeDir,
  type Policy,
  type Project,
  parsePolicy,
  policyExists,
  roleNumber,
} from '../policy.js';
import { atomicWriteSync, contractHome, ensureDir } from '../util.js';
import type { IO } from './query.js';
import { scanProject } from './scan.js';

/** A generic starting policy: nothing machine-specific, no projects yet. */
export function renderInitPolicy(
  opts: { base?: number; projectMax?: number; dynamic?: string } = {},
): string {
  const base = opts.base ?? 10000;
  const projectMax = opts.projectMax ?? 29;
  const dynamic = opts.dynamic ?? '40000-41999';
  const roles = Object.entries(DEFAULT_ROLES)
    .map(([k, v]) => `${k} = ${v}`)
    .join(', ');
  const ignore = DEFAULT_IGNORE_PROCESSES.map((s) => JSON.stringify(s)).join(', ');
  return `# berth policy — the agreed port rules for this machine.
# Created by \`berth init\`; edit by hand, keep it in your dotfiles.
#
#   port = ${base} + 1000·P + 100·W + R
#   P project ${0}–${projectMax} (permanent once assigned)   W worktree 0–9 (0 = main checkout)   R role 00–99
#
# Register a repository with \`berth project add <path>\` (appends a [projects.<name>] table).

[scheme]
base = ${base}
project_max = ${projectMax}
worktree_max = 9
roles = { ${roles} }

[pools]
dynamic = "${dynamic}"   # ad-hoc ports: \`berth claim --dynamic N\`
ttl_hours = 8

[reserved]
ranges = ["0-1023", "4000-4999", "49152-65535"]   # privileged, portless wrapper mode, macOS ephemeral
ports  = [5000, 7000]                              # macOS AirPlay receiver (ControlCenter)
lint   = [11211, 11434, 15672, 16686, 19999, 27017] # well-known defaults inside the block range; never given to a canonical role
ignore_processes = [${ignore}] # bind random loopback ports; hidden unless they collide with a lease

# Shared services are declared once with an owner so other projects may connect to them:
#
# [shared.observability]
# owner = "<project name>"
# ports = { grafana = 3000, prometheus = 9090, otlp-grpc = 4317, otlp-http = 4318 }

# ---- projects ---------------------------------------------------------------
# \`declared\` lists legacy hardcoded ports so conflicts are visible before migration.
# \`extras\` names role slots 10–99 for repos with more than ten services.
`;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function projectNameFor(dir: string): string {
  const base = path.basename(normalizeDir(dir));
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
  return NAME_RE.test(cleaned) ? cleaned : `project-${Date.now().toString(36)}`;
}

export function nextFreeP(policy: Policy): number | undefined {
  const used = new Set(Object.values(policy.projects).map((p) => p.P));
  for (let P = 0; P <= policy.scheme.projectMax; P++) if (!used.has(P)) return P;
  return undefined;
}

export interface ProjectSpec {
  name: string;
  P: number;
  path: string;
  declared: number[];
  extras: Record<string, number>;
  note?: string;
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

/** Append one `[projects.<name>]` table; the existing text is preserved byte for byte. */
export function appendProjectTable(toml: string, p: ProjectSpec): string {
  const lines = [
    `[projects.${p.name}]`,
    `P = ${p.P}`,
    `path = ${tomlString(contractHome(p.path))}`,
  ];
  if (p.declared.length)
    lines.push(`declared = [${[...p.declared].sort((a, b) => a - b).join(', ')}]`);
  const extras = Object.entries(p.extras);
  if (extras.length)
    lines.push(`extras = { ${extras.map(([k, v]) => `${tomlKey(k)} = ${v}`).join(', ')} }`);
  if (p.note) lines.push(`note = ${tomlString(p.note)}`);
  const sep =
    toml.length === 0 ? '' : toml.endsWith('\n\n') ? '' : toml.endsWith('\n') ? '\n' : '\n\n';
  return `${toml}${sep}${lines.join('\n')}\n`;
}

export interface AddOptions {
  path: string;
  name?: string;
  P?: number;
  /** Scan the repo for hardcoded ports and Compose services (default true). */
  scan?: boolean;
  note?: string;
  /** Register a directory that is not a git repository root. */
  allowNonGit?: boolean;
}

/** A git worktree root has a `.git` directory (main checkout) or `.git` file (linked worktree). */
export function isGitRoot(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

export interface AddResult extends ProjectSpec {
  created: boolean;
  block: [number, number];
}

/** Infer extras slots for Compose services whose role is not one of the canonical ten. */
export async function inferExtras(
  policy: Policy,
  project: Project,
): Promise<Record<string, number>> {
  const file = findComposeFile(project.path);
  if (!file) return {};
  const services = await composeServices(file);
  const extras: Record<string, number> = {};
  let slot = 10;
  for (const svc of services) {
    for (const port of svc.ports) {
      const role = inferRole(policy, project, svc, port.container);
      if (roleNumber(policy, project, role) !== undefined || role in extras) continue;
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(role)) continue;
      if (slot > 99) break;
      extras[role] = slot++;
    }
  }
  return extras;
}

export async function addProject(policyFile: string, opts: AddOptions): Promise<AddResult> {
  const dir = normalizeDir(opts.path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`${opts.path} does not exist or is not a directory`);
  }
  if (!opts.allowNonGit && !isGitRoot(dir)) {
    throw new Error(
      `${contractHome(dir)} is not a git repository root; run from the repo root or pass --allow-non-git`,
    );
  }
  const name = opts.name ?? projectNameFor(dir);
  if (!NAME_RE.test(name))
    throw new Error(`"${name}" is not a valid project name (letters, digits, . _ -)`);
  // The scan is read-only and slow-ish: do it outside the lock, then re-verify everything inside.
  let declared: number[] = [];
  let extras: Record<string, number> = {};
  if (opts.scan !== false) {
    const probe = parsePolicy(readFileSync(policyFile, 'utf8'));
    const draft: Project = { name, P: -1, path: dir, declared: [], extras: {} };
    try {
      declared = [...new Set(scanProject(draft).map((h) => h.port))].sort((a, b) => a - b);
      extras = await inferExtras(probe, draft);
    } catch {
      // best-effort: a scan failure never blocks registration
    }
  }
  // Writers of policy.toml serialise on one lock; collisions and the free number are decided inside it.
  return withLock({ deadlineMs: 5000, cmd: 'project add', file: policyLockPath() }, () => {
    const text = readFileSync(policyFile, 'utf8');
    const policy = parsePolicy(text);
    const existingByPath = Object.values(policy.projects).find((p) => normalizeDir(p.path) === dir);
    if (existingByPath)
      return { ...existingByPath, created: false, block: blockRange(policy, existingByPath.P) };
    const existingByName = policy.projects[name];
    if (existingByName) {
      throw new Error(
        `project "${name}" already exists with a different path (${existingByName.path})`,
      );
    }
    let P: number;
    if (opts.P !== undefined) {
      if (!Number.isInteger(opts.P) || opts.P < 0 || opts.P > policy.scheme.projectMax) {
        throw new Error(`P must be an integer between 0 and ${policy.scheme.projectMax}`);
      }
      const taken = Object.values(policy.projects).find((p) => p.P === opts.P);
      if (taken)
        throw new Error(`P = ${opts.P} is already used by ${taken.name}; numbers are permanent`);
      P = opts.P;
    } else {
      const free = nextFreeP(policy);
      if (free === undefined)
        throw new Error(`no free project number (project_max = ${policy.scheme.projectMax})`);
      P = free;
    }
    const spec: ProjectSpec = {
      name,
      P,
      path: dir,
      declared,
      extras,
      ...(opts.note ? { note: opts.note } : {}),
    };
    const next = appendProjectTable(text, spec);
    const validated = parsePolicy(next);
    if (!validated.projects[name]) throw new Error('internal: appended table did not parse back');
    atomicWriteSync(policyFile, next, { backup: true, mode: 0o644 });
    return { ...spec, created: true, block: blockRange(validated, P) };
  });
}

export async function cmdInit(args: ParsedArgs, io: IO): Promise<number> {
  const file = policyPath();
  if (policyExists(file) && !flagBool(args.flags, 'force')) {
    io.err(`${file} already exists; edit it, or pass --force to replace it (a human decision)`);
    return 1;
  }
  const baseFlag = flagString(args.flags, 'base');
  const base = baseFlag === undefined ? undefined : Number(baseFlag);
  if (base !== undefined && (!Number.isInteger(base) || base < 1024 || base > 60000)) {
    io.err('--base must be an integer between 1024 and 60000');
    return 2;
  }
  const text = renderInitPolicy({ ...(base !== undefined ? { base } : {}) });
  parsePolicy(text);
  ensureDir(configDir());
  atomicWriteSync(file, text, { backup: true, mode: 0o644 });
  if (flagBool(args.flags, 'json')) io.out(JSON.stringify({ policy: file, projects: 0 }, null, 2));
  else {
    io.out(`wrote ${file}`);
    io.out('next: cd <repo> && berth project add .   (then berth check)');
  }
  return 0;
}

export async function cmdProject(args: ParsedArgs, io: IO): Promise<number> {
  const sub = args.positional[0] ?? 'list';
  const json = flagBool(args.flags, 'json');
  if (sub === 'list') {
    const policy = loadPolicy();
    const rows = Object.values(policy.projects)
      .sort((a, b) => a.P - b.P)
      .map((p) => ({
        name: p.name,
        P: p.P,
        block: blockRange(policy, p.P),
        path: contractHome(p.path),
        declared: p.declared,
        extras: p.extras,
      }));
    if (json) io.out(JSON.stringify(rows, null, 2));
    else
      for (const r of rows)
        io.out(
          `${String(r.P).padStart(2, '0')}  ${r.name.padEnd(30)} ${r.block[0]}–${r.block[1]}  ${r.path}${r.declared.length ? `  declared ${r.declared.join(',')}` : ''}`,
        );
    return 0;
  }
  if (sub !== 'add') {
    io.err(
      'usage: berth project add [path] [--name N] [--number P] [--no-scan] [--note T] [--json] | berth project list [--json]',
    );
    return 2;
  }
  const file = policyPath();
  if (!policyExists(file)) {
    io.err(`no policy at ${file}; run \`berth init\` first`);
    return 1;
  }
  const numberFlag = flagString(args.flags, 'number');
  const P = numberFlag === undefined ? undefined : Number(numberFlag);
  try {
    const r = await addProject(file, {
      path: args.positional[1] ?? flagString(args.flags, 'cwd') ?? process.cwd(),
      ...(flagString(args.flags, 'name') ? { name: flagString(args.flags, 'name') as string } : {}),
      ...(P !== undefined ? { P } : {}),
      ...(args.flags.scan === false ? { scan: false } : {}),
      ...(flagBool(args.flags, 'allow-non-git') ? { allowNonGit: true } : {}),
      ...(flagString(args.flags, 'note') ? { note: flagString(args.flags, 'note') as string } : {}),
    });
    if (json) io.out(JSON.stringify(r, null, 2));
    else {
      io.out(
        `${r.created ? 'registered' : 'already registered'}: ${r.name}  P=${r.P}  block ${r.block[0]}–${r.block[1]}  ${contractHome(r.path)}`,
      );
      if (r.declared.length) io.out(`  declared (found in configs): ${r.declared.join(', ')}`);
      if (Object.keys(r.extras).length)
        io.out(
          `  extras: ${Object.entries(r.extras)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`,
        );
      if (r.created)
        io.out(
          '  next: eval "$(berth env --shell)" · berth env --compose-override · berth launch-json --write · berth check',
        );
    }
    return 0;
  } catch (e) {
    io.err(`berth: ${(e as Error).message}`);
    return 1;
  }
}
