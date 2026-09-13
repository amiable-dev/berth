import path from 'node:path';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { composeServices, findComposeFile, inferRole, renderOverride } from '../compose.js';
import { type ResolvedContext, resolveContext } from '../context.js';
import {
  addClaim,
  allLeases,
  compact,
  pidStartSync,
  readLeases,
  removeOwnClaim,
  withLock,
  writeLeases,
} from '../ledger.js';
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
  roleNumber,
  worktreeRange,
} from '../policy.js';
import { buildReport } from '../report.js';
import { currentSession } from '../session.js';
import type { Lease, LeaseKind, PortRecord } from '../types.js';
import { atomicWriteSync, isValidPort, nowIso, parsePort, pidAlive, sleep } from '../util.js';
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
  for (const [role, R] of Object.entries(policy.scheme.roles))
    out.push({ role, R, port: portFor(policy, project.P, W, R), env: envName(role) });
  for (const [role, R] of Object.entries(project.extras))
    out.push({ role, R, port: portFor(policy, project.P, W, R), env: envName(role) });
  return out.sort((a, b) => a.R - b.R);
}

export function envLines(
  policy: Policy,
  ctx: ResolvedContext,
  format: 'shell' | 'dotenv',
): string[] {
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
  for (const [name, svc] of Object.entries(policy.shared)) {
    for (const [service, port] of Object.entries(svc.ports))
      pairs.push([
        `BERTH_SHARED_${name.toUpperCase()}_${service.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
        String(port),
      ]);
  }
  return pairs.map(([k, v]) => (format === 'shell' ? `export ${k}=${shellQuote(v)}` : `${k}=${v}`));
}

function shellQuote(v: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

async function contextOrFail(
  policy: Policy,
  args: ParsedArgs,
  io: IO,
  assign = true,
): Promise<ResolvedContext | undefined> {
  const cwd = flagString(args.flags, 'cwd') ?? process.cwd();
  const ctx = await resolveContext(policy, cwd, { assign });
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
  const ctx = await contextOrFail(policy, args, io);
  if (!ctx?.project) return 1;
  const project = ctx.project;
  const W = ctx.W ?? 0;
  if (flagBool(args.flags, 'json')) {
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
  if (flagBool(args.flags, 'compose-override')) {
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
  const format = flagBool(args.flags, 'dotenv') ? 'dotenv' : 'shell';
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
      ...(pidStartSync(s.pid) ? { pid_start: pidStartSync(s.pid) as string } : {}),
    },
    cwd: ctx.worktreePath ?? ctx.cwd,
    created: nowIso(),
    expires,
    ...(note ? { note } : {}),
  };
}

async function guardPort(
  report: Awaited<ReturnType<typeof buildReport>>,
  port: number,
  mine: string,
  force: boolean,
  io: IO,
): Promise<boolean> {
  const rec: PortRecord | undefined = report.ports.find((p) => p.port === port);
  if (!rec) return true;
  if (rec.lease && rec.lease.owner.session_id !== mine) {
    if (!force) {
      io.err(
        `${port} is already leased by ${rec.lease.owner.session_id ?? rec.lease.owner.tool} (${rec.state}); pass --force to claim it anyway`,
      );
      return false;
    }
  }
  if (rec.live && rec.live.sessionId !== mine && !force) {
    io.err(
      `${port} is bound right now by ${rec.live.holder}${rec.live.pid ? ` pid ${rec.live.pid}` : ''}; pass --force to claim it anyway`,
    );
    return false;
  }
  return true;
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
      for (const p of candidates)
        addClaim(me.id, makeLease(policy, pseudo, p, 'dynamic', 'dynamic', note, sessionOverride));
      try {
        const r = await compact({ deadlineMs: 500 });
        for (const d of r.dropped) if (d.sessionId === me.id) taken.add(d.port);
      } catch {
        // lock busy: the claim files still count; a later compaction settles duplicates
      }
      const mine = new Set(
        allLeases()
          .filter((l) => l.owner.session_id === me.id)
          .map((l) => l.port),
      );
      for (const p of candidates) if (mine.has(p)) granted.push(p);
      if (granted.length < n) await sleep(20);
    }
    if (granted.length === 0) {
      io.err('no free port in the dynamic pool');
      return 1;
    }
    if (flagBool(args.flags, 'json'))
      io.out(
        JSON.stringify({ session: me.id, ports: granted, expires: policy.pools.ttlHours }, null, 2),
      );
    else io.out(granted.join('\n'));
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
  let roleName: string;
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
    roleName = inOwn
      ? roleNameFor(policy, project, p - lo)
      : (role ?? (kind === 'dynamic' ? 'dynamic' : 'declared'));
  } else if (extra !== undefined) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(extra)) {
      io.err('--extra must be a short lowercase name');
      return 2;
    }
    let R = project.extras[extra];
    if (R === undefined) {
      const usedR = new Set<number>(Object.values(project.extras));
      for (const l of allLeases())
        if (l.project === project.name && l.worktree === W && l.kind === 'block')
          usedR.add(l.port - worktreeRange(policy, project.P, W)[0]);
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
    roleName = extra;
  } else if (role !== undefined) {
    const R = roleNumber(policy, project, role);
    if (R === undefined) {
      io.err(
        `unknown role "${role}"; canonical roles: ${Object.keys(policy.scheme.roles).join(', ')}${Object.keys(project.extras).length ? `; extras: ${Object.keys(project.extras).join(', ')}` : ''}`,
      );
      return 2;
    }
    port = portFor(policy, project.P, W, R);
    roleName = role;
  } else {
    io.err('usage: berth claim --role <role> | --extra <name> | --dynamic <n> | --port <port>');
    return 2;
  }
  if (!(await guardPort(report, port, me.id, force, io))) return 1;
  addClaim(me.id, makeLease(policy, ctx, port, roleName, kind, note, sessionOverride));
  try {
    await compact({ deadlineMs: 500 });
  } catch {
    // fine; compaction happens on the next read
  }
  if (flagBool(args.flags, 'json'))
    io.out(
      JSON.stringify(
        {
          port,
          role: roleName,
          kind,
          project: project.name,
          W,
          session: me.id,
          env: envName(roleName),
        },
        null,
        2,
      ),
    );
  else io.out(`${port}  ${roleName}  ${project.name} W${W}  (export ${envName(roleName)}=${port})`);
  return 0;
}

function roleNameFor(policy: Policy, project: Project, R: number): string {
  for (const [n, r] of Object.entries(policy.scheme.roles)) if (r === R) return n;
  for (const [n, r] of Object.entries(project.extras)) if (r === R) return n;
  return `slot-${String(R).padStart(2, '0')}`;
}

export async function cmdRelease(args: ParsedArgs, io: IO): Promise<number> {
  const sessionOverride = flagString(args.flags, 'session');
  const me = currentSession(sessionOverride);
  const force = flagBool(args.flags, 'force');
  const all = flagBool(args.flags, 'all');
  const portFlag = flagString(args.flags, 'port') ?? args.positional[0];
  const port = portFlag !== undefined ? parsePort(portFlag) : null;
  if (!all && port === null) {
    io.err('usage: berth release --port <port> | --all [--session <id>] [--force]');
    return 2;
  }
  const released: number[] = [];
  const refused: string[] = [];
  await withLock({ deadlineMs: 3000, cmd: 'release' }, () => {
    const ledger = readLeases();
    const keep: Lease[] = [];
    for (const l of ledger.leases) {
      const match = all ? l.owner.session_id === me.id : l.port === port;
      if (!match) {
        keep.push(l);
        continue;
      }
      if (l.owner.session_id !== me.id && !force) {
        refused.push(
          `${l.port} is leased by ${l.owner.session_id ?? l.owner.tool}; pass --force to release it`,
        );
        keep.push(l);
        continue;
      }
      released.push(l.port);
    }
    if (released.length > 0) {
      ledger.leases = keep;
      writeLeases(ledger);
    }
  });
  if (port !== null && removeOwnClaim(me.id, port) && !released.includes(port)) released.push(port);
  if (all) {
    for (const l of allLeases())
      if (
        l.owner.session_id === me.id &&
        removeOwnClaim(me.id, l.port) &&
        !released.includes(l.port)
      )
        released.push(l.port);
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
    (kind === 'block' && decoded ? roleNameFor(policy, project, decoded.R) : kind);
  const ctx: ResolvedContext = {
    cwd: rec?.live?.cwd ?? project.path,
    project,
    W: decoded && decoded.P === project.P ? decoded.W : 0,
    via: 'path',
  };
  const sessionId =
    owner === 'session'
      ? currentSession(flagString(args.flags, 'session')).id
      : `human-${currentSession().id.replace(/^human-/, '')}`;
  const lease = makeLease(policy, ctx, port, role, kind, flagString(args.flags, 'note'), sessionId);
  if (owner === 'human')
    lease.owner = {
      session_id: sessionId,
      tool: 'human',
      ...(rec?.live?.pid ? { pid: rec.live.pid } : {}),
    };
  addClaim(sessionId, lease);
  try {
    await compact({ deadlineMs: 500 });
  } catch {
    // fine
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
    io.err('usage: berth free <port> [--force]');
    return 2;
  }
  const force = flagBool(args.flags, 'force');
  const me = currentSession(flagString(args.flags, 'session'));
  const report = await buildReport();
  const rec = report.ports.find((p) => p.port === port);
  if (!rec?.live) {
    io.out(`${port}: nothing is bound`);
    return 0;
  }
  const live = rec.live;
  if (live.container) {
    io.err(
      `${port} is published by container ${live.container}; stop it with docker (berth never stops containers)`,
    );
    return 1;
  }
  if (live.proxy || live.pid === undefined) {
    io.err(`${port} is held by ${live.holder} without an owned pid; berth cannot free it`);
    return 1;
  }
  const otherSession = live.sessionId && live.sessionId !== me.id;
  const otherLease =
    rec.lease &&
    rec.lease.owner.session_id !== me.id &&
    (rec.state === 'ok' || rec.state === 'idle');
  if ((otherSession || otherLease) && !force) {
    io.err(
      `${port} belongs to ${live.sessionId ? `session ${live.sessionId.slice(0, 8)}…` : (rec.lease?.owner.session_id ?? 'another owner')}; refusing. Pass --force only if you are sure.`,
    );
    return 1;
  }
  try {
    process.kill(live.pid, 'SIGTERM');
  } catch (e) {
    io.err(`cannot signal pid ${live.pid}: ${(e as Error).message}`);
    return 1;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pidAlive(live.pid)) await sleep(100);
  if (pidAlive(live.pid)) {
    if (!force) {
      io.err(`pid ${live.pid} ignored SIGTERM; rerun with --force to SIGKILL`);
      return 1;
    }
    try {
      process.kill(live.pid, 'SIGKILL');
    } catch {
      // gone between checks
    }
  }
  io.out(`freed ${port} (${live.holder} pid ${live.pid})`);
  return 0;
}

export function assertPort(n: unknown): number {
  if (!isValidPort(n)) throw new Error('invalid port');
  return n;
}
