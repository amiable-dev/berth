import path from 'node:path';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { composeServices, findComposeFile, inferRole, renderOverride } from '../compose.js';
import { type ResolvedContext, resolveContext } from '../context.js';
import { addClaim, allLeases, compact, ownerKey, pidStartSync, releaseLease } from '../ledger.js';
import { overridesDir } from '../paths.js';
import {
  inDynamicPool,
  isReserved,
  loadPolicy,
  type Policy,
  type Project,
  portFor,
  projectByName,
  projectForPath,
  roleName,
  roleNumber,
  worktreeRange,
} from '../policy.js';
import { ownerDesc } from '../reconcile.js';
import { buildReport } from '../report.js';
import { currentSession } from '../session.js';
import type { Lease, LeaseKind, PortRecord } from '../types.js';
import { atomicWriteSync, hostUser, nowIso, parsePort, pidAlive, sleep } from '../util.js';
import type { IO } from './query.js';

export function envName(role: string): string {
  return `${role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PORT`;
}

export interface RolePort {
  role: string;
  R: number;
  port: number;
  env: string;
}

export function rolePorts(policy: Policy, project: Project, W: number): RolePort[] {
  const out: RolePort[] = [];
  for (const [role, R] of Object.entries(policy.scheme.roles)) {
    out.push({ role, R, port: portFor(policy, project.P, W, R), env: envName(role) });
  }
  for (const [role, R] of Object.entries(project.extras)) {
    out.push({ role, R, port: portFor(policy, project.P, W, R), env: envName(role) });
  }
  return out.sort((a, b) => a.R - b.R);
}

/** BERTH_SHARED_<STACK>_<SERVICE> pairs: the machine-wide exports available even outside a project. */
export function sharedEnvPairs(policy: Policy): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [name, svc] of Object.entries(policy.shared)) {
    for (const [service, port] of Object.entries(svc.ports)) {
      pairs.push([
        `BERTH_SHARED_${name.toUpperCase()}_${service.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
        String(port),
      ]);
    }
  }
  return pairs;
}

function projectEnvPairs(policy: Policy, ctx: ResolvedContext): [string, string][] {
  const project = ctx.project as Project;
  const W = ctx.W ?? 0;
  const [lo, hi] = worktreeRange(policy, project.P, W);
  const pairs: [string, string][] = [];
  const ports = rolePorts(policy, project, W);
  const web = ports.find((p) => p.role === 'web');
  if (web) pairs.push(['PORT', String(web.port)]);
  for (const p of ports) pairs.push([p.env, String(p.port)]);
  pairs.push(
    ['BERTH_PROJECT', project.name],
    ['BERTH_P', String(project.P)],
    ['BERTH_W', String(W)],
    ['BERTH_BLOCK', `${lo}-${hi}`],
  );
  pairs.push(...sharedEnvPairs(policy));
  return pairs;
}

function formatPairs(pairs: [string, string][], format: 'shell' | 'dotenv' | 'unset'): string[] {
  if (format === 'unset') return pairs.map(([k]) => `unset ${k}`);
  return pairs.map(([k, v]) => (format === 'shell' ? `export ${k}=${shellQuote(v)}` : `${k}=${v}`));
}

/**
 * The exports for this context: a project's role ports, BERTH_* metadata and the shared services,
 * or — when `ctx.project` is unset (outside a registered project) — the shared services alone.
 * `format: 'unset'` emits `unset NAME` for each of the same variable names, nothing else.
 */
export function envLines(
  policy: Policy,
  ctx: ResolvedContext,
  format: 'shell' | 'dotenv' | 'unset',
): string[] {
  return formatPairs(ctx.project ? projectEnvPairs(policy, ctx) : sharedEnvPairs(policy), format);
}

function shellQuote(v: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

async function contextOrFail(
  policy: Policy,
  args: ParsedArgs,
  io: IO,
  opts: { assign?: boolean; quietNoProject?: boolean } = {},
): Promise<ResolvedContext | undefined> {
  const cwd = flagString(args.flags, 'cwd') ?? process.cwd();
  const ctx = await resolveContext(policy, cwd, { assign: opts.assign ?? true });
  const wFlag = flagString(args.flags, 'worktree');
  if (wFlag !== undefined) {
    const W = Number(wFlag);
    if (!Number.isInteger(W) || W < 0 || W > policy.scheme.worktreeMax) {
      io.err(`--worktree must be 0..${policy.scheme.worktreeMax}`);
      return undefined;
    }
    ctx.W = W;
  }
  const projFlag = flagString(args.flags, 'project');
  if (projFlag) {
    const p = projectByName(policy, projFlag);
    if (!p) {
      io.err(`unknown project ${projFlag}`);
      return undefined;
    }
    ctx.project = p;
    if (ctx.W === null) ctx.W = 0;
  }
  if (!ctx.project) {
    // Callers that are quiet outside a project (plain `env --shell`) get the bare context back
    // (ctx.project stays undefined) and decide their own quiet output; everyone else gets today's
    // loud failure.
    if (opts.quietNoProject) return ctx;
    io.err(
      `${cwd} is not inside any project in policy.toml. Add it, pass --project <name>, or use \`berth claim --dynamic 1\`.`,
    );
    return undefined;
  }
  if (ctx.W === null) {
    io.err(
      `worktree "${ctx.worktreeName}" has no free W slot for ${ctx.project.name} (max ${policy.scheme.worktreeMax}). Run: berth worktrees prune --project ${ctx.project.name} --w <n>`,
    );
    return undefined;
  }
  return ctx;
}

export async function cmdEnv(args: ParsedArgs, io: IO): Promise<number> {
  const policy = loadPolicy();
  const json = flagBool(args.flags, 'json');
  const dotenv = flagBool(args.flags, 'dotenv');
  const composeOverride = flagBool(args.flags, 'compose-override');
  const unset = flagBool(args.flags, 'unset');
  const cwd = flagString(args.flags, 'cwd') ?? process.cwd();
  // The plain `--shell` format (the default) is quiet outside a registered project: exit 0 with
  // only the machine-wide BERTH_SHARED_* exports and a comment naming the fix, nothing on stderr.
  // `--strict` restores today's loud failure; `--dotenv`, `--compose-override` and `--json` are
  // explicit requests that keep failing loudly — there is no context to answer them with.
  const quietNoProject = !flagBool(args.flags, 'strict') && !dotenv && !composeOverride && !json;
  const ctx = await contextOrFail(policy, args, io, { quietNoProject });
  if (ctx === undefined) return 1;
  if (!ctx.project) {
    const lines = envLines(policy, ctx, unset ? 'unset' : 'shell');
    if (!unset)
      lines.push(`# berth: ${cwd} is not inside a registered project (berth project add .)`);
    if (lines.length) io.out(lines.join('\n'));
    return 0;
  }
  const project = ctx.project;
  const W = ctx.W ?? 0;
  if (json) {
    io.out(
      JSON.stringify(
        {
          project: project.name,
          P: project.P,
          W,
          worktree: ctx.worktreeName ?? null,
          block: worktreeRange(policy, project.P, W),
          ports: rolePorts(policy, project, W),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (composeOverride) {
    const file = findComposeFile(ctx.worktreePath ?? project.path);
    if (!file) {
      io.err(`no compose file found in ${ctx.worktreePath ?? project.path}`);
      return 1;
    }
    const services = await composeServices(file);
    const used = new Set<number>();
    const mapping: { service: string; host: number; container: number; role: string }[] = [];
    let nextExtra = 10;
    for (const svc of services) {
      for (const p of svc.ports) {
        let role = inferRole(policy, project, svc, p.container);
        let R = roleNumber(policy, project, role);
        if (R === undefined || used.has(R)) {
          while (used.has(nextExtra) || Object.values(project.extras).includes(nextExtra))
            nextExtra++;
          R = nextExtra++;
          role = `${role} (unpinned slot ${R}; pin it under [projects.${project.name}] extras)`;
        }
        used.add(R);
        mapping.push({
          service: svc.name,
          host: portFor(policy, project.P, W, R),
          container: p.container,
          role,
        });
      }
    }
    const out = path.join(overridesDir(), `${project.name}${W ? `-W${W}` : ''}.yml`);
    atomicWriteSync(out, renderOverride(mapping));
    io.out(`# wrote ${out}`);
    for (const m of mapping) io.out(`#   ${m.service}: ${m.host} -> ${m.container}  (${m.role})`);
    io.out(`export COMPOSE_FILE=${shellQuote(`${file}${path.delimiter}${out}`)}`);
    return 0;
  }
  const format = unset ? 'unset' : dotenv ? 'dotenv' : 'shell';
  io.out(envLines(policy, ctx, format).join('\n'));
  return 0;
}

function makeLease(
  policy: Policy,
  ctx: ResolvedContext,
  port: number,
  role: string,
  kind: LeaseKind,
  note?: string,
  sessionOverride?: string,
): Lease {
  const s = currentSession(sessionOverride);
  const project = ctx.project as Project;
  const expires =
    kind === 'dynamic'
      ? new Date(Date.now() + policy.pools.ttlHours * 3600_000).toISOString()
      : null;
  const pidStart = pidStartSync(s.pid);
  return {
    port,
    project: project.name,
    worktree: ctx.W ?? 0,
    role,
    kind,
    owner: {
      session_id: s.id,
      tool: s.tool,
      pid: s.pid,
      ...(pidStart ? { pid_start: pidStart } : {}),
    },
    cwd: ctx.worktreePath ?? ctx.cwd,
    created: nowIso(),
    expires,
    ...(note ? { note } : {}),
  };
}

function guardPort(
  report: Awaited<ReturnType<typeof buildReport>>,
  port: number,
  mine: string,
  force: boolean,
  io: IO,
): boolean {
  const rec: PortRecord | undefined = report.ports.find((p) => p.port === port);
  if (!rec) return true;
  if (rec.lease && rec.lease.owner.session_id !== mine && !force) {
    io.err(
      `${port} is already leased by ${ownerDesc(rec.lease)} (${rec.state}); pass --force to claim it anyway`,
    );
    return false;
  }
  if (rec.live && rec.live.sessionId !== mine && !force) {
    io.err(
      `${port} is bound right now by ${rec.live.holder}${rec.live.pid ? ` pid ${rec.live.pid}` : ''}; pass --force to claim it anyway`,
    );
    return false;
  }
  return true;
}

/** Fold claims and confirm the caller's lease survived (an older claim by another session wins). */
async function settleClaim(
  sessionId: string,
  port: number,
): Promise<{ ok: boolean; holder?: string }> {
  try {
    await compact({ deadlineMs: 500 });
  } catch {
    // lock busy: the claim file still counts; a later compaction settles duplicates
  }
  const now = allLeases().find((l) => l.port === port);
  if (now && now.owner.session_id === sessionId) return { ok: true };
  return { ok: false, ...(now ? { holder: ownerKey(now) } : {}) };
}

export async function cmdClaim(args: ParsedArgs, io: IO): Promise<number> {
  const policy = loadPolicy();
  const note = flagString(args.flags, 'note');
  const force = flagBool(args.flags, 'force');
  const sessionOverride = flagString(args.flags, 'session');
  const me = currentSession(sessionOverride);
  const dynamicN = flagString(args.flags, 'dynamic');
  const report = await buildReport({ policy });

  if (dynamicN !== undefined) {
    const n = Number(dynamicN);
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      io.err('--dynamic takes a count between 1 and 20');
      return 2;
    }
    const cwd = flagString(args.flags, 'cwd') ?? process.cwd();
    const ctx = await resolveContext(policy, cwd, { assign: true });
    const pseudo: ResolvedContext = ctx.project
      ? ctx
      : {
          ...ctx,
          project: {
            name: projectForPath(policy, cwd)?.name ?? 'scratch',
            P: -1,
            path: cwd,
            declared: [],
            extras: {},
          },
          W: 0,
        };
    const taken = new Set<number>([
      ...allLeases().map((l) => l.port),
      ...report.ports.filter((p) => p.live).map((p) => p.port),
    ]);
    const granted: number[] = [];
    for (let attempt = 0; attempt < 3 && granted.length < n; attempt++) {
      const candidates: number[] = [];
      for (
        let p = policy.pools.dynamic[0];
        p <= policy.pools.dynamic[1] && candidates.length < n - granted.length;
        p++
      ) {
        if (!taken.has(p) && !granted.includes(p) && !isReserved(policy, p).reserved)
          candidates.push(p);
      }
      if (candidates.length === 0) break;
      for (const p of candidates) {
        await addClaim(
          me.id,
          makeLease(policy, pseudo, p, 'dynamic', 'dynamic', note, sessionOverride),
        );
      }
      for (const p of candidates) {
        const settled = await settleClaim(me.id, p);
        if (settled.ok) granted.push(p);
        else taken.add(p);
      }
      if (granted.length < n) await sleep(20);
    }
    if (granted.length === 0) {
      io.err('no free port in the dynamic pool');
      return 1;
    }
    if (flagBool(args.flags, 'json')) {
      io.out(
        JSON.stringify(
          { session: me.id, ports: granted, ttlHours: policy.pools.ttlHours },
          null,
          2,
        ),
      );
    } else io.out(granted.join('\n'));
    return 0;
  }

  const ctx = await contextOrFail(policy, args, io);
  if (!ctx?.project) return 1;
  const project = ctx.project;
  const W = ctx.W ?? 0;
  const explicit = flagString(args.flags, 'port');
  const extra = flagString(args.flags, 'extra');
  const role = flagString(args.flags, 'role');
  let port: number;
  let leaseRole: string;
  let kind: LeaseKind = 'block';
  if (explicit !== undefined) {
    const p = parsePort(explicit);
    if (p === null) {
      io.err('--port must be 1..65535');
      return 2;
    }
    const [lo, hi] = worktreeRange(policy, project.P, W);
    const inOwn = p >= lo && p <= hi;
    if (!inOwn && !inDynamicPool(policy, p) && !project.declared.includes(p) && !force) {
      io.err(
        `${p} is outside this worktree's range ${lo}-${hi}, the dynamic pool and the project's declared ports; pass --force to claim it anyway`,
      );
      return 1;
    }
    port = p;
    kind = inOwn ? 'block' : inDynamicPool(policy, p) ? 'dynamic' : 'declared';
    leaseRole = inOwn
      ? roleName(policy, project, p - lo)
      : (role ?? (kind === 'dynamic' ? 'dynamic' : 'declared'));
  } else if (extra !== undefined) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(extra)) {
      io.err('--extra must be a short lowercase name');
      return 2;
    }
    let R = project.extras[extra];
    if (R === undefined) {
      const usedR = new Set<number>(Object.values(project.extras));
      const lo = worktreeRange(policy, project.P, W)[0];
      for (const l of allLeases()) {
        if (l.project === project.name && l.worktree === W && l.kind === 'block')
          usedR.add(l.port - lo);
      }
      R = 10;
      while (usedR.has(R) && R <= 99) R++;
      if (R > 99) {
        io.err('no free extras slot (10..99) in this worktree');
        return 1;
      }
      io.err(
        `note: "${extra}" is not in policy; using slot ${R}. Pin it: extras = { ${extra} = ${R} } under [projects.${project.name}]`,
      );
    }
    port = portFor(policy, project.P, W, R);
    leaseRole = extra;
  } else if (role !== undefined) {
    const R = roleNumber(policy, project, role);
    if (R === undefined) {
      io.err(
        `unknown role "${role}"; canonical roles: ${Object.keys(policy.scheme.roles).join(', ')}${Object.keys(project.extras).length ? `; extras: ${Object.keys(project.extras).join(', ')}` : ''}`,
      );
      return 2;
    }
    port = portFor(policy, project.P, W, R);
    leaseRole = role;
  } else {
    io.err('usage: berth claim --role <role> | --extra <name> | --dynamic <n> | --port <port>');
    return 2;
  }
  if (!guardPort(report, port, me.id, force, io)) return 1;
  await addClaim(me.id, makeLease(policy, ctx, port, leaseRole, kind, note, sessionOverride));
  const settled = await settleClaim(me.id, port);
  if (!settled.ok) {
    io.err(
      `${port} was claimed first by ${settled.holder ?? 'another session'}; your claim was dropped`,
    );
    return 1;
  }
  if (flagBool(args.flags, 'json')) {
    io.out(
      JSON.stringify(
        {
          port,
          role: leaseRole,
          kind,
          project: project.name,
          W,
          session: me.id,
          env: envName(leaseRole),
        },
        null,
        2,
      ),
    );
  } else
    io.out(`${port}  ${leaseRole}  ${project.name} W${W}  (export ${envName(leaseRole)}=${port})`);
  return 0;
}

export async function cmdRelease(args: ParsedArgs, io: IO): Promise<number> {
  const me = currentSession(flagString(args.flags, 'session'));
  const force = flagBool(args.flags, 'force');
  const all = flagBool(args.flags, 'all');
  const portFlag = flagString(args.flags, 'port') ?? args.positional[0];
  const port = portFlag !== undefined ? parsePort(portFlag) : null;
  if (!all && port === null) {
    io.err('usage: berth release --port <port> | --all [--force] [--json]');
    return 2;
  }
  const targets = all
    ? allLeases()
        .filter((l) => l.owner.session_id === me.id)
        .map((l) => l.port)
    : [port as number];
  const released: number[] = [];
  const refused: string[] = [];
  for (const p of targets) {
    const r = await releaseLease(p, { sessionId: me.id, force });
    if (r.released) released.push(p);
    else if (r.refused) refused.push(r.refused);
  }
  for (const r of refused) io.err(r);
  if (flagBool(args.flags, 'json')) io.out(JSON.stringify({ released, refused }, null, 2));
  else io.out(released.length ? `released ${released.join(', ')}` : 'nothing released');
  return refused.length > 0 && released.length === 0 ? 1 : 0;
}

export async function cmdAdopt(args: ParsedArgs, io: IO): Promise<number> {
  const policy = loadPolicy();
  const port = parsePort(args.positional[0]);
  const owner = flagString(args.flags, 'owner') ?? 'human';
  if (port === null || (owner !== 'human' && owner !== 'session')) {
    io.err(
      'usage: berth adopt <port> --owner human|session [--project <name>] [--role <role>] [--note <text>]',
    );
    return 2;
  }
  const report = await buildReport({ policy });
  const rec = report.ports.find((p) => p.port === port);
  if (rec?.lease) {
    io.err(
      `${port} already has a lease (${rec.lease.project} ${rec.lease.role}); release it first`,
    );
    return 1;
  }
  const projName = flagString(args.flags, 'project') ?? rec?.project ?? rec?.live?.project;
  const project = projName
    ? projectByName(policy, projName.split(',')[0]?.trim() ?? projName)
    : undefined;
  if (!project) {
    io.err(`cannot attribute ${port} to a project; pass --project <name>`);
    return 1;
  }
  const decoded = rec?.decoded ?? null;
  const kind: LeaseKind =
    decoded && decoded.P === project.P
      ? 'block'
      : inDynamicPool(policy, port)
        ? 'dynamic'
        : 'declared';
  const role =
    flagString(args.flags, 'role') ??
    rec?.role ??
    (kind === 'block' && decoded ? roleName(policy, project, decoded.R) : kind);
  const ctx: ResolvedContext = {
    cwd: rec?.live?.cwd ?? project.path,
    project,
    W: decoded && decoded.P === project.P ? decoded.W : 0,
    via: 'path',
  };
  const me = currentSession(flagString(args.flags, 'session'));
  // A human owner is the user at the keyboard, never a Claude session id.
  const sessionId = owner === 'session' ? me.id : `human-${hostUser()}`;
  const lease = makeLease(policy, ctx, port, role, kind, flagString(args.flags, 'note'), sessionId);
  if (owner === 'human') {
    lease.owner = {
      session_id: sessionId,
      tool: 'human',
      ...(rec?.live?.pid ? { pid: rec.live.pid } : {}),
    };
  }
  await addClaim(sessionId, lease);
  const settled = await settleClaim(sessionId, port);
  if (!settled.ok) {
    io.err(`${port} was claimed first by ${settled.holder ?? 'another session'}`);
    return 1;
  }
  io.out(
    flagBool(args.flags, 'json')
      ? JSON.stringify(lease, null, 2)
      : `adopted ${port} as ${project.name} ${role} (${kind}) for ${sessionId}`,
  );
  return 0;
}

export async function cmdFree(args: ParsedArgs, io: IO): Promise<number> {
  const port = parsePort(args.positional[0]);
  if (port === null) {
    io.err('usage: berth free <port> [--force] [--json]');
    return 2;
  }
  const force = flagBool(args.flags, 'force');
  const json = flagBool(args.flags, 'json');
  // Ownership is decided by the real caller; --session is deliberately not honoured here.
  const me = currentSession();
  const report = await buildReport();
  const rec = report.ports.find((p) => p.port === port);
  const result = (code: number, message: string, extra: Record<string, unknown> = {}) => {
    if (json) io.out(JSON.stringify({ port, ok: code === 0, message, ...extra }, null, 2));
    else (code === 0 ? io.out : io.err)(message);
    return code;
  };
  if (!rec?.live) return result(0, `${port}: nothing is bound`);
  const live = rec.live;
  if (live.container) {
    return result(
      1,
      `${port} is published by container ${live.container}; stop it with docker (berth never stops containers)`,
    );
  }
  const pid = live.pid;
  if (live.proxy || pid === undefined || !Number.isInteger(pid) || pid <= 1) {
    return result(
      1,
      `${port} is held by ${live.holder} without an owned pid; berth cannot free it`,
    );
  }
  const otherSession = live.sessionId !== undefined && live.sessionId !== me.id;
  const otherLease =
    rec.lease !== null &&
    rec.lease.owner.session_id !== me.id &&
    (rec.state === 'ok' || rec.state === 'idle');
  if ((otherSession || otherLease) && !force) {
    const who = live.sessionId
      ? `session ${live.sessionId.slice(0, 8)}…`
      : rec.lease
        ? ownerDesc(rec.lease)
        : 'another owner';
    return result(1, `${port} belongs to ${who}; refusing. Pass --force only if you are sure.`);
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return result(1, `cannot signal pid ${pid}: ${(e as Error).message}`);
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pidAlive(pid)) await sleep(100);
  if (pidAlive(pid)) {
    if (!force) return result(1, `pid ${pid} ignored SIGTERM; rerun with --force to SIGKILL`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone between checks
    }
  }
  return result(0, `freed ${port} (${live.holder} pid ${pid})`, { pid, holder: live.holder });
}
