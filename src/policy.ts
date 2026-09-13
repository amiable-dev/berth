import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { policyPath } from './paths.js';
import type { Decoded, PolicySummary } from './types.js';
import { expandHome } from './util.js';

export interface Project {
  name: string;
  P: number;
  path: string;
  declared: number[];
  extras: Record<string, number>;
  note?: string;
}

export interface SharedService {
  owner: string;
  ports: Record<string, number>;
  note?: string;
}

export interface Policy {
  scheme: { base: number; projectMax: number; worktreeMax: number; roles: Record<string, number> };
  pools: { dynamic: [number, number]; ttlHours: number };
  reserved: {
    ranges: [number, number][];
    ports: number[];
    lint: number[];
    ignoreProcesses: string[];
  };
  shared: Record<string, SharedService>;
  projects: Record<string, Project>;
  names: { provider: 'portless' | 'none' };
}

export class PolicyError extends Error {
  override name = 'PolicyError';
}

export const DEFAULT_ROLES: Record<string, number> = {
  web: 0,
  api: 1,
  db: 2,
  cache: 3,
  smtp: 4,
  'mail-ui': 5,
  docs: 6,
  worker: 7,
  'otlp-grpc': 8,
  'otlp-http': 9,
};

const HTTP_ROLES = new Set(['web', 'api', 'docs', 'mail-ui', 'worker', 'otlp-http']);

/** Processes that bind random loopback ports as part of normal operation (IDE helpers, macOS daemons). */
export const DEFAULT_IGNORE_PROCESSES = [
  'Code Helper (Plugin)',
  'Code - Insiders Helper (Plugin)',
  'Cursor Helper (Plugin)',
  'rapportd',
  'sharingd',
  'identityservicesd',
  'tailscaled',
];

type Toml = Record<string, unknown>;

function isObj(v: unknown): v is Toml {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function intOr(v: unknown, fallback: number, what: string, min: number, max: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new PolicyError(`${what} must be an integer between ${min} and ${max}`);
  }
  return v;
}

function intList(v: unknown, what: string): number[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new PolicyError(`${what} must be an array of ports`);
  return v.map((x) => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > 65535) {
      throw new PolicyError(`${what} contains an invalid port: ${String(x)}`);
    }
    return x;
  });
}

function parseRange(s: unknown, what: string): [number, number] {
  if (typeof s !== 'string') throw new PolicyError(`${what} must be a string like "40000-41999"`);
  const m = /^\s*(\d{1,5})\s*-\s*(\d{1,5})\s*$/.exec(s);
  if (!m) throw new PolicyError(`${what} must look like "40000-41999", got "${s}"`);
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (lo < 0 || hi > 65535 || lo > hi) throw new PolicyError(`${what} has an invalid range "${s}"`);
  return [lo, hi];
}

function numberMap(v: unknown, what: string, min: number, max: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (v === undefined) return out;
  if (!isObj(v)) throw new PolicyError(`${what} must be a table of name = number`);
  for (const [k, n] of Object.entries(v)) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      throw new PolicyError(`${what}.${k} must be an integer between ${min} and ${max}`);
    }
    out[k] = n;
  }
  return out;
}

export function parsePolicy(text: string): Policy {
  let raw: Toml;
  try {
    raw = parseToml(text) as Toml;
  } catch (e) {
    throw new PolicyError(`policy.toml is not valid TOML: ${(e as Error).message}`);
  }
  const scheme = isObj(raw.scheme) ? raw.scheme : {};
  const base = intOr(scheme.base, 10000, 'scheme.base', 1024, 60000);
  const projectMax = intOr(scheme.project_max, 29, 'scheme.project_max', 0, 60);
  const worktreeMax = intOr(scheme.worktree_max, 9, 'scheme.worktree_max', 0, 9);
  const roles =
    scheme.roles === undefined
      ? { ...DEFAULT_ROLES }
      : numberMap(scheme.roles, 'scheme.roles', 0, 9);
  const roleValues = Object.values(roles);
  if (new Set(roleValues).size !== roleValues.length)
    throw new PolicyError('scheme.roles must map to distinct slots');
  const top = base + 1000 * (projectMax + 1) - 1;
  if (top > 65535)
    throw new PolicyError(`scheme: base ${base} with project_max ${projectMax} exceeds port 65535`);

  const pools = isObj(raw.pools) ? raw.pools : {};
  const dynamic =
    pools.dynamic === undefined
      ? ([40000, 41999] as [number, number])
      : parseRange(pools.dynamic, 'pools.dynamic');
  const ttlHours = intOr(pools.ttl_hours, 8, 'pools.ttl_hours', 1, 24 * 30);
  if (dynamic[0] <= top && dynamic[1] >= base)
    throw new PolicyError('pools.dynamic overlaps the project block range');

  const reserved = isObj(raw.reserved) ? raw.reserved : {};
  const ranges = Array.isArray(reserved.ranges)
    ? reserved.ranges.map((r, i) => parseRange(r, `reserved.ranges[${i}]`))
    : ([
        [0, 1023],
        [49152, 65535],
      ] as [number, number][]);
  const reservedPorts = intList(reserved.ports, 'reserved.ports');
  const lint = intList(reserved.lint, 'reserved.lint');
  let ignoreProcesses = [...DEFAULT_IGNORE_PROCESSES];
  if (reserved.ignore_processes !== undefined) {
    if (
      !Array.isArray(reserved.ignore_processes) ||
      !reserved.ignore_processes.every((x) => typeof x === 'string')
    ) {
      throw new PolicyError('reserved.ignore_processes must be an array of process names');
    }
    ignoreProcesses = reserved.ignore_processes as string[];
  }

  const shared: Record<string, SharedService> = {};
  if (raw.shared !== undefined) {
    if (!isObj(raw.shared)) throw new PolicyError('shared must be a table of services');
    for (const [name, svc] of Object.entries(raw.shared)) {
      if (!isObj(svc)) throw new PolicyError(`shared.${name} must be a table`);
      if (typeof svc.owner !== 'string' || !svc.owner)
        throw new PolicyError(`shared.${name}.owner is required`);
      const ports = numberMap(svc.ports, `shared.${name}.ports`, 1, 65535);
      shared[name] = {
        owner: svc.owner,
        ports,
        ...(typeof svc.note === 'string' ? { note: svc.note } : {}),
      };
    }
  }

  const projects: Record<string, Project> = {};
  const seenP = new Map<number, string>();
  if (raw.projects !== undefined) {
    if (!isObj(raw.projects)) throw new PolicyError('projects must be a table');
    for (const [name, p] of Object.entries(raw.projects)) {
      if (!isObj(p)) throw new PolicyError(`projects.${name} must be a table`);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        throw new PolicyError(`projects.${name}: invalid project name`);
      }
      const P = intOr(p.P, -1, `projects.${name}.P`, 0, projectMax);
      if (P < 0) throw new PolicyError(`projects.${name}.P is required`);
      const prev = seenP.get(P);
      if (prev) throw new PolicyError(`projects.${name}.P = ${P} is already used by ${prev}`);
      seenP.set(P, name);
      if (typeof p.path !== 'string' || !p.path)
        throw new PolicyError(`projects.${name}.path is required`);
      const extras = numberMap(p.extras, `projects.${name}.extras`, 10, 99);
      const extraValues = Object.values(extras);
      if (new Set(extraValues).size !== extraValues.length) {
        throw new PolicyError(`projects.${name}.extras must use distinct slots`);
      }
      for (const k of Object.keys(extras)) {
        if (k in roles)
          throw new PolicyError(`projects.${name}.extras.${k} collides with a canonical role`);
      }
      projects[name] = {
        name,
        P,
        path: path.resolve(expandHome(p.path)),
        declared: intList(p.declared, `projects.${name}.declared`),
        extras,
        ...(typeof p.note === 'string' ? { note: p.note } : {}),
      };
    }
  }
  for (const [name, svc] of Object.entries(shared)) {
    if (!(svc.owner in projects))
      throw new PolicyError(`shared.${name}.owner "${svc.owner}" is not a project`);
  }

  const namesRaw = isObj(raw.names) ? raw.names : {};
  const provider = namesRaw.provider === undefined ? 'portless' : namesRaw.provider;
  if (provider !== 'portless' && provider !== 'none') {
    throw new PolicyError('names.provider must be "portless" or "none"');
  }

  return {
    scheme: { base, projectMax, worktreeMax, roles },
    pools: { dynamic, ttlHours },
    reserved: { ranges, ports: reservedPorts, lint, ignoreProcesses },
    shared,
    projects,
    names: { provider },
  };
}

export function policyExists(file = policyPath()): boolean {
  return existsSync(file);
}

export function loadPolicy(file = policyPath()): Policy {
  if (!existsSync(file)) {
    throw new PolicyError(
      `no policy at ${file}. Create one from examples/policy.example.toml (or set BERTH_POLICY).`,
    );
  }
  return parsePolicy(readFileSync(file, 'utf8'));
}

export function portFor(p: Policy, P: number, W: number, R: number): number {
  return p.scheme.base + 1000 * P + 100 * W + R;
}

export function blockRange(p: Policy, P: number): [number, number] {
  const lo = p.scheme.base + 1000 * P;
  return [lo, lo + 999];
}

export function worktreeRange(p: Policy, P: number, W: number): [number, number] {
  const lo = p.scheme.base + 1000 * P + 100 * W;
  return [lo, lo + 99];
}

export function inBlockRange(p: Policy, port: number): boolean {
  return port >= p.scheme.base && port < p.scheme.base + 1000 * (p.scheme.projectMax + 1);
}

/** Decode a port into P/W/R when it lies in the managed block range; null otherwise. */
export function decodePort(p: Policy, port: number): Decoded | null {
  if (!inBlockRange(p, port)) return null;
  const rel = port - p.scheme.base;
  return { P: Math.floor(rel / 1000), W: Math.floor((rel % 1000) / 100), R: rel % 100 };
}

export function inDynamicPool(p: Policy, port: number): boolean {
  return port >= p.pools.dynamic[0] && port <= p.pools.dynamic[1];
}

export function isReserved(p: Policy, port: number): { reserved: boolean; why?: string } {
  if (p.reserved.ports.includes(port)) return { reserved: true, why: 'reserved port' };
  for (const [lo, hi] of p.reserved.ranges) {
    if (port >= lo && port <= hi) return { reserved: true, why: `reserved range ${lo}-${hi}` };
  }
  return { reserved: false };
}

export function isLint(p: Policy, port: number): boolean {
  return p.reserved.lint.includes(port);
}

export function projectByP(p: Policy, P: number): Project | undefined {
  return Object.values(p.projects).find((x) => x.P === P);
}

export function projectByName(p: Policy, name: string): Project | undefined {
  return p.projects[name];
}

export function roleNumber(
  p: Policy,
  project: Project | undefined,
  role: string,
): number | undefined {
  if (role in p.scheme.roles) return p.scheme.roles[role];
  if (project && role in project.extras) return project.extras[role];
  if (/^\d{1,2}$/.test(role)) return Number(role);
  return undefined;
}

export function roleName(p: Policy, project: Project | undefined, R: number): string {
  for (const [name, n] of Object.entries(p.scheme.roles)) if (n === R) return name;
  if (project) for (const [name, n] of Object.entries(project.extras)) if (n === R) return name;
  return `slot-${String(R).padStart(2, '0')}`;
}

export function isHttpRole(role: string | undefined): boolean {
  return role !== undefined && HTTP_ROLES.has(role);
}

/** Resolve symlinks for the nearest existing ancestor (macOS /var vs /private/var), keep the rest. */
export function normalizeDir(p: string): string {
  const abs = path.resolve(expandHome(p));
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      const r = missing.length ? path.join(real, ...missing.reverse()) : real;
      return r.endsWith(path.sep) && r.length > 1 ? r.slice(0, -1) : r;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Longest-prefix match of a directory against project paths. */
export function projectForPath(p: Policy, dir: string | undefined): Project | undefined {
  if (!dir) return undefined;
  const d = normalizeDir(dir);
  let best: Project | undefined;
  let bestLen = -1;
  for (const proj of Object.values(p.projects)) {
    const pp = normalizeDir(proj.path);
    if ((d === pp || d.startsWith(`${pp}${path.sep}`)) && pp.length > bestLen) {
      best = proj;
      bestLen = pp.length;
    }
  }
  return best;
}

export function sharedFor(
  p: Policy,
  port: number,
): { name: string; service: string; owner: string } | undefined {
  for (const [name, svc] of Object.entries(p.shared)) {
    for (const [service, n] of Object.entries(svc.ports))
      if (n === port) return { name, service, owner: svc.owner };
  }
  return undefined;
}

export function declaredBy(p: Policy, port: number): Project[] {
  return Object.values(p.projects).filter((x) => x.declared.includes(port));
}

/** Non-fatal warnings about a policy (lint hits, tight ranges). */
export function lintPolicy(p: Policy): string[] {
  const warnings: string[] = [];
  const top = p.scheme.base + 1000 * (p.scheme.projectMax + 1) - 1;
  if (top >= 49152)
    warnings.push(`block range reaches ${top}, inside the macOS ephemeral range (49152+)`);
  for (const proj of Object.values(p.projects)) {
    for (const [name, R] of Object.entries(proj.extras)) {
      for (let W = 0; W <= p.scheme.worktreeMax; W++) {
        const port = portFor(p, proj.P, W, R);
        if (isLint(p, port))
          warnings.push(`${proj.name}.extras.${name} lands on well-known port ${port} (W${W})`);
      }
    }
  }
  return warnings;
}

export function summarizePolicy(p: Policy): PolicySummary {
  return {
    scheme: { ...p.scheme, roles: { ...p.scheme.roles } },
    pools: { dynamic: [...p.pools.dynamic] as [number, number], ttlHours: p.pools.ttlHours },
    reserved: {
      ranges: p.reserved.ranges.map((r) => [...r] as [number, number]),
      ports: [...p.reserved.ports],
      lint: [...p.reserved.lint],
      ignoreProcesses: [...p.reserved.ignoreProcesses],
    },
    shared: Object.fromEntries(
      Object.entries(p.shared).map(([k, v]) => [
        k,
        { owner: v.owner, ports: { ...v.ports }, ...(v.note ? { note: v.note } : {}) },
      ]),
    ),
    projects: Object.values(p.projects)
      .sort((a, b) => a.P - b.P)
      .map((x) => ({
        name: x.name,
        P: x.P,
        path: x.path,
        base: blockRange(p, x.P)[0],
        declared: [...x.declared],
        extras: { ...x.extras },
        ...(x.note ? { note: x.note } : {}),
      })),
  };
}
