import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { truthCachePath } from './paths.js';
import type { Container, Listener, TruthSnapshot } from './types.js';
import { atomicWriteSync, nowIso, readJsonSync, run } from './util.js';

const VM_PROXIES = new Set([
  'ssh',
  'limactl',
  'com.docker.backend',
  'com.docker.vpnkit',
  'vpnkit',
  'OrbStack',
  'orbstack',
  'qemu-system-aarch64',
  'qemu-system-x86_64',
  'gvproxy',
]);

export function isVmProxy(cmd: string): boolean {
  return (
    VM_PROXIES.has(cmd) || cmd.startsWith('com.docker.') || cmd.toLowerCase().includes('orbstack')
  );
}

function portOfName(name: string): number | null {
  const i = name.lastIndexOf(':');
  if (i < 0) return null;
  const n = Number(name.slice(i + 1));
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** Own-user TCP listeners via `lsof -F` (machine-readable). */
export async function lsofListeners(): Promise<Listener[]> {
  const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { timeoutMs: 6000 });
  if (r.missing) return [];
  const out: Listener[] = [];
  let pid: number | undefined;
  let cmd = '';
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      pid = Number(val);
      cmd = '';
    } else if (tag === 'c') {
      cmd = val;
    } else if (tag === 'n') {
      const port = portOfName(val);
      if (port === null) continue;
      out.push({ port, addr: val, pid, cmd, source: 'lsof' });
    }
  }
  return out;
}

/** All listeners including other users' (root) via netstat; pid column is available on macOS. */
export async function netstatListeners(): Promise<Listener[]> {
  const r = await run('netstat', ['-anv', '-p', 'tcp'], { timeoutMs: 4000 });
  if (r.missing || r.code !== 0) return [];
  const out: Listener[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.includes('LISTEN')) continue;
    const cols = line.trim().split(/\s+/);
    const si = cols.indexOf('LISTEN');
    if (si < 4) continue;
    const local = cols[si - 2] ?? '';
    const i = local.lastIndexOf('.');
    if (i < 0) continue;
    const port = Number(local.slice(i + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    // macOS prints either bare pid columns (rhiwat shiwat pid epid) or a `process:pid` token.
    let pid: number | undefined;
    let cmd = '';
    for (const tok of cols.slice(si + 1)) {
      const m = /^(.+):(\d+)$/.exec(tok);
      if (m) {
        cmd = m[1] ?? '';
        pid = Number(m[2]);
        break;
      }
    }
    if (pid === undefined) {
      const n = Number(cols[si + 3]);
      if (Number.isInteger(n) && n > 0 && n < 100000) pid = n;
    }
    out.push({
      port,
      addr: local.replace(/\.(\d+)$/, ':$1'),
      ...(pid !== undefined ? { pid } : {}),
      cmd,
      source: 'netstat',
    });
  }
  return out;
}

export async function cwdForPids(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (pids.length === 0) return map;
  const r = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'pn'], {
    timeoutMs: 6000,
  });
  if (r.missing) return map;
  let pid: number | undefined;
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid !== undefined) map.set(pid, line.slice(1));
  }
  return map;
}

/**
 * Read only the Claude Code markers from own-user processes' environments.
 * Nothing else from the environment is retained.
 */
export async function sessionMarkers(
  pids: number[],
): Promise<Map<number, { sessionId?: string; claude: boolean }>> {
  const map = new Map<number, { sessionId?: string; claude: boolean }>();
  if (pids.length === 0) return map;
  const r = await run('ps', ['-E', '-o', 'pid=,command=', '-p', pids.join(',')], {
    timeoutMs: 4000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.missing) return map;
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const sid = /(?:^|\s)CLAUDE_CODE_SESSION_ID=([A-Za-z0-9-]{8,64})(?:\s|$)/.exec(line)?.[1];
    const claude = /(?:^|\s)CLAUDECODE=1(?:\s|$)/.test(line) || sid !== undefined;
    if (claude || sid) map.set(pid, { ...(sid ? { sessionId: sid } : {}), claude });
  }
  return map;
}

export async function pidStart(pid: number): Promise<string | undefined> {
  const r = await run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 1500 });
  const s = r.stdout.trim();
  return s ? s : undefined;
}

function expandPorts(spec: string): number[] {
  const out: number[] = [];
  const re = /(?:\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]*\]|::):(\d{1,5})(?:-(\d{1,5}))?->/g;
  let m: RegExpExecArray | null = re.exec(spec);
  while (m) {
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    for (let p = lo; p <= hi && p - lo < 64; p++) out.push(p);
    m = re.exec(spec);
  }
  return [...new Set(out)];
}

export async function dockerContainers(): Promise<{ available: boolean; containers: Container[] }> {
  const fmt =
    '{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.service"}}';
  const r = await run('docker', ['ps', '--no-trunc', '--format', fmt], { timeoutMs: 4000 });
  if (r.missing || r.code !== 0) return { available: false, containers: [] };
  const containers: Container[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [id = '', name = '', ports = '', composeProject = '', workingDir = '', service = ''] =
      line.split('\t');
    containers.push({
      id,
      name,
      hostPorts: expandPorts(ports),
      ...(composeProject ? { composeProject } : {}),
      ...(workingDir ? { workingDir } : {}),
      ...(service ? { service } : {}),
    });
  }
  return { available: true, containers };
}

export interface SnapshotOptions {
  /** Serve a cached snapshot if it is at most this old. */
  maxAgeMs?: number;
  skipDocker?: boolean;
  skipEnv?: boolean;
  skipNetstat?: boolean;
}

/** Observe the host. Read-only, no sudo. Results are cached briefly for the dashboard. */
export async function snapshot(opts: SnapshotOptions = {}): Promise<TruthSnapshot> {
  const maxAge = opts.maxAgeMs ?? 0;
  if (maxAge > 0) {
    const cached = readJsonSync<TruthSnapshot | null>(truthCachePath(), null);
    if (cached?.takenAt && Date.now() - Date.parse(cached.takenAt) <= maxAge) return cached;
  }
  const [own, root, docker] = await Promise.all([
    lsofListeners(),
    opts.skipNetstat ? Promise.resolve([] as Listener[]) : netstatListeners(),
    opts.skipDocker
      ? Promise.resolve({ available: false, containers: [] as Container[] })
      : dockerContainers(),
  ]);
  const seen = new Set(own.map((l) => `${l.port}|${l.addr}`));
  const listeners = [...own];
  for (const l of root) {
    if (!seen.has(`${l.port}|${l.addr}`) && !own.some((o) => o.port === l.port)) listeners.push(l);
  }
  const pids = [
    ...new Set(
      listeners.map((l) => l.pid).filter((p): p is number => typeof p === 'number' && p > 0),
    ),
  ];
  const [cwds, markers] = await Promise.all([
    cwdForPids(pids),
    opts.skipEnv
      ? Promise.resolve(new Map<number, { sessionId?: string; claude: boolean }>())
      : sessionMarkers(pids),
  ]);
  for (const l of listeners) {
    if (l.pid === undefined) continue;
    const cwd = cwds.get(l.pid);
    if (cwd) l.cwd = cwd;
    const mk = markers.get(l.pid);
    if (mk) {
      if (mk.sessionId) l.sessionId = mk.sessionId;
      l.claudeMarker = mk.claude;
    }
  }
  const colima =
    docker.available &&
    (listeners.some((l) => l.cmd === 'limactl') || existsSync(path.join(os.homedir(), '.colima')));
  const snap: TruthSnapshot = {
    takenAt: nowIso(),
    listeners: listeners.sort((a, b) => a.port - b.port),
    containers: docker.containers,
    dockerAvailable: docker.available,
    colima,
  };
  try {
    atomicWriteSync(truthCachePath(), JSON.stringify(snap));
  } catch {
    // cache is optional
  }
  return snap;
}
