import { existsSync } from 'node:fs';
import {
  declaredBy,
  decodePort,
  inBlockRange,
  inDynamicPool,
  isHttpRole,
  isReserved,
  type Policy,
  type Project,
  projectByP,
  projectForPath,
  roleName,
  sharedFor,
  summarizePolicy,
} from './policy.js';
import { isVmProxy } from './truth.js';
import type {
  CheckReport,
  Container,
  Lease,
  Listener,
  Live,
  OwnerTool,
  PortRecord,
  SessionFile,
  SessionRecord,
  State,
  TruthSnapshot,
} from './types.js';
import { SEVERITY, STATES } from './types.js';
import { contractHome, hostUser, humanAge, nowIso, pidAlive, shortId } from './util.js';

export const ADVISORY: Record<State, { text: string; command?: (port: number) => string }> = {
  ok: { text: 'none' },
  idle: { text: 'none — shown dimmed' },
  stale: {
    text: 'Owner pid is gone. Suggest release; berth never auto-kills.',
    command: (p) => `berth release --port ${p}`,
  },
  orphan: {
    text: 'Lease cwd no longer exists. Suggest release; tombstone keeps the worktree ID.',
    command: (p) => `berth release --port ${p}`,
  },
  unmanaged: {
    text: 'Bound inside a managed range with no lease and no session marker.',
    command: (p) => `berth adopt ${p} --owner human`,
  },
  squatter: {
    text: "A different session bound a port inside another project's block. Name the holder and the block owner; do not kill.",
    command: (p) => `berth who ${p}`,
  },
  conflict: {
    text: 'Lease owner differs from the live holder. Tell the owning session its belief is wrong.',
    command: (p) => `berth who ${p} --json`,
  },
  drift: {
    text: 'Config declares a port outside its allocation, or a labelled service vanished. Never reassign.',
    command: () => 'berth scan --write',
  },
};

const MACOS_DAEMONS = new Set([
  'ControlCenter',
  'ControlCe',
  'rapportd',
  'launchd',
  'sharingd',
  'AirPlayXPCHelper',
]);

export interface ReconcileInput {
  policy: Policy;
  leases: Lease[];
  sessions: SessionFile[];
  truth: TruthSnapshot;
  version: string;
  now?: number;
  /** Ports that were observed as unfoldable claims (compaction dropped them); shown as conflict. */
  droppedClaims?: { port: number; sessionId: string }[];
}

function toolForListener(l: Listener): OwnerTool {
  if (l.sessionId || l.claudeMarker) return 'claude-code';
  if (MACOS_DAEMONS.has(l.cmd)) return 'macos';
  if (l.pid === undefined || l.source === 'netstat') return 'unknown';
  return 'human';
}

/** Turn raw listeners and containers into one attributed live holder per port. */
export function liveByPort(policy: Policy, truth: TruthSnapshot): Map<number, Live> {
  const byContainer = new Map<number, Container>();
  for (const c of truth.containers)
    for (const p of c.hostPorts) if (!byContainer.has(p)) byContainer.set(p, c);
  const out = new Map<number, Live>();
  for (const l of truth.listeners) {
    const existing = out.get(l.port);
    if (existing && !existing.proxy) continue;
    const proxy = isVmProxy(l.cmd) || (l.cmd === '' && byContainer.has(l.port));
    if (proxy) {
      const c = byContainer.get(l.port);
      if (c) {
        const proj = projectForPath(policy, c.workingDir);
        out.set(l.port, {
          holder: c.name,
          container: c.name,
          proxy: true,
          tool: 'unknown',
          ...(l.pid !== undefined ? { pid: l.pid } : {}),
          ...(c.workingDir ? { cwd: c.workingDir } : {}),
          ...(proj ? { project: proj.name } : {}),
        });
      } else if (!existing) {
        out.set(l.port, {
          holder: l.cmd || 'vm-proxy',
          proxy: true,
          tool: 'unknown',
          ...(l.pid !== undefined ? { pid: l.pid } : {}),
        });
      }
      continue;
    }
    const proj = projectForPath(policy, l.cwd);
    out.set(l.port, {
      holder: l.cmd || (l.pid !== undefined ? `pid ${l.pid}` : 'unknown'),
      tool: toolForListener(l),
      ...(l.pid !== undefined ? { pid: l.pid } : {}),
      ...(l.cwd ? { cwd: l.cwd } : {}),
      ...(l.sessionId ? { sessionId: l.sessionId } : {}),
      ...(proj ? { project: proj.name } : {}),
    });
  }
  return out;
}

function liveEvidence(port: number, live: Live, truth: TruthSnapshot): string[] {
  const ev: string[] = [];
  if (live.container) {
    const c = truth.containers.find((x) => x.name === live.container);
    const bits = [`container ${live.container}`];
    if (c?.composeProject) bits.push(`compose ${c.composeProject}`);
    if (c?.workingDir) bits.push(`working_dir ${contractHome(c.workingDir)}`);
    ev.push(`docker: ${bits.join(', ')}`);
    const l = truth.listeners.find((x) => x.port === port);
    if (l)
      ev.push(
        `lsof: published through ${l.cmd || 'vm proxy'}${l.pid !== undefined ? ` pid ${l.pid}` : ''} (${truth.colima ? 'Colima' : 'container runtime'})`,
      );
  } else {
    const l = truth.listeners.find((x) => x.port === port);
    const src = l?.source === 'netstat' ? 'netstat' : 'lsof';
    const bits = [live.holder];
    if (live.pid !== undefined) bits.push(`pid ${live.pid}`);
    if (live.cwd) bits.push(`cwd ${contractHome(live.cwd)}`);
    if (l?.source === 'netstat') bits.push('(other user; no cwd without sudo)');
    ev.push(`${src}: ${bits.join(' ')}`);
    if (live.sessionId) ev.push(`ps -E: CLAUDE_CODE_SESSION_ID=${shortId(live.sessionId)}…`);
    else if (live.tool === 'claude-code') ev.push('ps -E: CLAUDECODE=1 (session id not exported)');
  }
  if (live.project) ev.push(`attributed to project ${live.project} by path`);
  return ev;
}

function ownerDesc(l: Lease): string {
  if (l.owner.session_id) return `session ${shortId(l.owner.session_id)}…`;
  if (l.owner.pid) return `pid ${l.owner.pid}`;
  return l.owner.tool;
}

function ownerAlive(l: Lease, sessions: SessionFile[]): boolean {
  if (l.owner.pid && pidAlive(l.owner.pid)) return true;
  if (l.owner.session_id) {
    const s = sessions.find((x) => x.id === l.owner.session_id);
    if (s) return !s.ended && pidAlive(s.pid);
  }
  return false;
}

function liveMatchesLease(live: Live, lease: Lease, policy: Policy): boolean {
  if (lease.owner.session_id && live.sessionId) return lease.owner.session_id === live.sessionId;
  if (lease.owner.pid && live.pid !== undefined && !live.proxy) return lease.owner.pid === live.pid;
  if (live.project) return live.project === lease.project;
  if (live.cwd) {
    const proj = projectForPath(policy, live.cwd);
    if (proj) return proj.name === lease.project;
    return live.cwd === lease.cwd || live.cwd.startsWith(`${lease.cwd}/`);
  }
  // Unattributable holder (root process, VM proxy without a container): assume the lease is honoured.
  return true;
}

function urlFor(
  port: number,
  role: string | undefined,
  kind: string | undefined,
  service?: string,
): string | undefined {
  if (isHttpRole(role)) return `http://localhost:${port}`;
  if (kind === 'shared' && service && !/db|postgres|redis|cache|smtp|grpc|minio/i.test(service))
    return `http://localhost:${port}`;
  return undefined;
}

export function reconcile(input: ReconcileInput): CheckReport {
  const { policy, leases, sessions, truth } = input;
  const now = input.now ?? Date.now();
  const live = liveByPort(policy, truth);
  const leaseByPort = new Map(leases.map((l) => [l.port, l]));
  const dropped = new Set((input.droppedClaims ?? []).map((d) => d.port));

  const ports = new Set<number>();
  for (const l of leases) ports.add(l.port);
  for (const svc of Object.values(policy.shared))
    for (const p of Object.values(svc.ports)) ports.add(p);
  for (const proj of Object.values(policy.projects)) for (const p of proj.declared) ports.add(p);
  let ignored = 0;
  const ignoreSet = new Set(policy.reserved.ignoreProcesses);
  for (const [port, lv] of live) {
    const interesting =
      leaseByPort.has(port) ||
      sharedFor(policy, port) !== undefined ||
      declaredBy(policy, port).length > 0;
    if (!interesting && !lv.container && ignoreSet.has(lv.holder)) {
      ignored++;
      continue;
    }
    if (
      inBlockRange(policy, port) ||
      inDynamicPool(policy, port) ||
      (port >= 1024 && port <= 9999)
    ) {
      ports.add(port);
    }
  }

  const records: PortRecord[] = [];
  for (const port of [...ports].sort((a, b) => a - b)) {
    const lease = leaseByPort.get(port) ?? null;
    const lv = live.get(port) ?? null;
    const shared = sharedFor(policy, port);
    const decoded = decodePort(policy, port);
    const blockProject: Project | undefined = decoded ? projectByP(policy, decoded.P) : undefined;
    const declared = declaredBy(policy, port);
    const reserved = isReserved(policy, port);
    const evidence: string[] = [];
    if (lv) evidence.push(...liveEvidence(port, lv, truth));
    if (lease) {
      evidence.push(
        `lease: ${lease.kind} ${lease.project} W${lease.worktree} ${lease.role} by ${ownerDesc(lease)} since ${lease.created}`,
      );
      if (lease.ended) evidence.push(`session ended ${lease.ended}`);
    }
    if (shared)
      evidence.push(`policy: shared.${shared.name}.${shared.service} owned by ${shared.owner}`);
    if (declared.length > 0)
      evidence.push(`policy: declared by ${declared.map((d) => d.name).join(', ')}`);
    if (decoded && blockProject) {
      evidence.push(
        `block: ${blockProject.name} P=${decoded.P} W${decoded.W} ${roleName(policy, blockProject, decoded.R)}`,
      );
    } else if (decoded) evidence.push(`block: P=${decoded.P} is not assigned to any project`);
    if (reserved.reserved) evidence.push(`policy: ${reserved.why}`);
    if (dropped.has(port))
      evidence.push('compact: a second session claimed this port; its claim was dropped');

    let state: State;
    let project: string | undefined;
    let worktree: number | undefined;
    let role: string | undefined;
    let kind: PortRecord['kind'];

    if (shared) {
      kind = 'shared';
      project = shared.owner;
      role = shared.service;
      if (lv) state = 'ok';
      else {
        const siblings = Object.values(policy.shared[shared.name]?.ports ?? {}).filter(
          (p) => p !== port,
        );
        state = siblings.some((p) => live.has(p)) ? 'drift' : 'idle';
        if (state === 'drift')
          evidence.push(
            'shared stack is partially up: sibling services are bound but this one is not',
          );
      }
    } else if (lease) {
      kind = lease.kind;
      project = lease.project;
      worktree = lease.worktree;
      role = lease.role;
      if (
        lease.kind === 'block' &&
        decoded &&
        blockProject &&
        blockProject.name !== lease.project
      ) {
        state = 'drift';
        evidence.push(
          `policy now assigns P=${decoded.P} to ${blockProject.name}; lease belongs to ${lease.project}`,
        );
      } else if (dropped.has(port)) {
        state = 'conflict';
      } else if (lv) {
        state = liveMatchesLease(lv, lease, policy) ? 'ok' : 'conflict';
      } else if (!existsSync(lease.cwd)) {
        state = 'orphan';
      } else if (lease.expires && Date.parse(lease.expires) < now && !ownerAlive(lease, sessions)) {
        state = 'stale';
        evidence.push(`lease expired ${lease.expires}`);
      } else if (ownerAlive(lease, sessions)) {
        state = 'idle';
      } else if (!lease.owner.pid && !lease.owner.session_id) {
        state = 'idle';
      } else {
        state = 'stale';
      }
    } else if (lv) {
      if (decoded && blockProject) {
        project = blockProject.name;
        worktree = decoded.W;
        role = roleName(policy, blockProject, decoded.R);
        kind = 'block';
        state = lv.project && lv.project !== blockProject.name ? 'squatter' : 'unmanaged';
        if (state === 'squatter')
          evidence.push(`holder belongs to ${lv.project}; block belongs to ${blockProject.name}`);
      } else if (decoded || inDynamicPool(policy, port)) {
        state = 'unmanaged';
        if (inDynamicPool(policy, port)) kind = 'dynamic';
      } else if (reserved.reserved) {
        state = 'ok';
        role = lv.tool === 'macos' ? 'macos' : undefined;
      } else if (declared.length > 0) {
        kind = 'declared';
        const holderDeclares = lv.project ? declared.some((d) => d.name === lv.project) : false;
        if (lv.project && !holderDeclares) {
          state = 'squatter';
          project = declared.map((d) => d.name).join(', ');
          evidence.push(`holder belongs to ${lv.project}, which does not declare ${port}`);
        } else {
          state = 'ok';
          project = lv.project ?? (declared.length === 1 ? declared[0]?.name : undefined);
        }
      } else {
        state = 'unmanaged';
        if (lv.project) project = lv.project;
      }
    } else if (declared.length > 0) {
      kind = 'declared';
      state = 'idle';
      project = declared.map((d) => d.name).join(', ');
    } else {
      continue;
    }

    const adv = ADVISORY[state];
    records.push({
      port,
      state,
      ...(project ? { project } : {}),
      ...(worktree !== undefined ? { worktree } : {}),
      ...(role ? { role } : {}),
      ...(kind ? { kind } : {}),
      decoded,
      lease,
      live: lv,
      evidence,
      advisory: { text: adv.text, ...(adv.command ? { command: adv.command(port) } : {}) },
      ...(urlFor(port, role, kind, shared?.service)
        ? { url: urlFor(port, role, kind, shared?.service) }
        : {}),
      ...(lease ? { age: humanAge(lease.created, now) } : {}),
    });
  }

  const sessionRecords = buildSessions(policy, leases, sessions, truth, records);
  const byState = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<State, number>;
  for (const r of records) byState[r.state]++;
  return {
    version: input.version,
    generatedAt: nowIso(),
    cacheAgeMs: Math.max(0, now - Date.parse(truth.takenAt)),
    host: {
      platform: process.platform,
      user: hostUser(),
      dockerAvailable: truth.dockerAvailable,
      colima: truth.colima,
    },
    policy: summarizePolicy(policy),
    ports: records,
    sessions: sessionRecords,
    summary: {
      ports: records.length,
      attention: records.filter((r) => r.state !== 'ok' && r.state !== 'idle').length,
      liveSessions: sessionRecords.filter((s) => s.alive).length,
      byState,
      ignored,
    },
  };
}

function worstOf(states: State[]): State {
  for (const s of SEVERITY) if (states.includes(s)) return s;
  return 'ok';
}

function buildSessions(
  policy: Policy,
  leases: Lease[],
  files: SessionFile[],
  truth: TruthSnapshot,
  records: PortRecord[],
): SessionRecord[] {
  const ids = new Set<string>();
  for (const f of files) ids.add(f.id);
  for (const l of leases) if (l.owner.session_id) ids.add(l.owner.session_id);
  for (const l of truth.listeners) if (l.sessionId) ids.add(l.sessionId);
  const stateByPort = new Map(records.map((r) => [r.port, r.state]));
  const out: SessionRecord[] = [];
  for (const id of ids) {
    const file = files.find((f) => f.id === id);
    const own = leases.filter((l) => l.owner.session_id === id);
    const markers = truth.listeners.filter((l) => l.sessionId === id);
    const how: string[] = [];
    if (file)
      how.push(`SessionStart hook recorded ${file.started}${file.pid ? ` (pid ${file.pid})` : ''}`);
    if (markers.length > 0)
      how.push(
        `ps -E: ${markers.length} listener${markers.length === 1 ? '' : 's'} carry this session id`,
      );
    if (own.length > 0)
      how.push(`${own.length} lease${own.length === 1 ? '' : 's'} claimed by this session`);
    const filePidAlive = file?.pid !== undefined && pidAlive(file.pid);
    const alive = !file?.ended && (filePidAlive || markers.length > 0);
    const tool: OwnerTool =
      file?.tool ?? own[0]?.owner.tool ?? (id.startsWith('human') ? 'human' : 'claude-code');
    const cwd = file?.cwd ?? own[0]?.cwd ?? markers[0]?.cwd;
    const proj = file?.project ?? own[0]?.project ?? projectForPath(policy, cwd)?.name;
    const ports = [...new Set([...own.map((l) => l.port), ...markers.map((m) => m.port)])].sort(
      (a, b) => a - b,
    );
    const states = ports.map((p) => stateByPort.get(p)).filter((s): s is State => s !== undefined);
    out.push({
      id,
      short: shortId(id),
      tool,
      ...(file?.pid !== undefined ? { pid: file.pid } : {}),
      ...(file?.started ? { started: file.started } : {}),
      ended: file?.ended ?? null,
      alive,
      ...(proj ? { project: proj } : {}),
      ...(file?.worktree !== undefined
        ? { worktree: file.worktree }
        : own[0]
          ? { worktree: own[0].worktree }
          : {}),
      ...(cwd ? { cwd } : {}),
      cwdExists: cwd ? existsSync(cwd) : false,
      leases: ports,
      worst: worstOf(states),
      howWeKnow: how.length > 0 ? how : ['no evidence beyond the session id'],
    });
  }
  return out.sort(
    (a, b) => Number(b.alive) - Number(a.alive) || (b.started ?? '').localeCompare(a.started ?? ''),
  );
}
