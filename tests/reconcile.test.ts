import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveByPort, reconcile } from '../src/reconcile.js';
import type { Lease, SessionFile, TruthSnapshot } from '../src/types.js';
import { fixturePolicy, tempDir } from './helpers.js';

const root = tempDir();
const { policy, paths } = fixturePolicy(root);
const NOW = Date.parse('2026-09-13T12:00:00Z');

function lease(port: number, over: Partial<Lease> = {}): Lease {
  return {
    port,
    project: 'alpha',
    worktree: 0,
    role: 'api',
    kind: 'block',
    owner: { session_id: 'sess-alpha-1', tool: 'claude-code', pid: 999999 },
    cwd: paths.alpha,
    created: '2026-09-13T10:00:00Z',
    expires: null,
    ...over,
  };
}

function truth(over: Partial<TruthSnapshot> = {}): TruthSnapshot {
  return {
    takenAt: new Date(NOW).toISOString(),
    full: true,
    listeners: [],
    containers: [],
    dockerAvailable: true,
    colima: true,
    ...over,
  };
}

function run(leases: Lease[], t: TruthSnapshot, sessions: SessionFile[] = []) {
  return reconcile({ policy, leases, sessions, truth: t, version: 'test', now: NOW });
}

describe('live attribution', () => {
  it('maps Colima ssh listeners to containers by compose labels', () => {
    const t = truth({
      listeners: [
        { port: 5439, addr: '*:5439', pid: 503, cmd: 'ssh', cwd: paths.obs, source: 'lsof' },
      ],
      containers: [
        {
          id: 'c1',
          name: 'alpha-postgres-1',
          hostPorts: [5439],
          composeProject: 'alpha',
          workingDir: paths.alpha,
        },
      ],
    });
    const live = liveByPort(policy, t);
    expect(live.get(5439)).toMatchObject({
      holder: 'alpha-postgres-1',
      container: 'alpha-postgres-1',
      project: 'alpha',
      proxy: true,
    });
  });
  it('attributes native listeners by cwd and session marker', () => {
    const t = truth({
      listeners: [
        {
          port: 13001,
          addr: '127.0.0.1:13001',
          pid: 4242,
          cmd: 'node',
          cwd: `${paths.alpha}/apps/api`,
          sessionId: 'sess-alpha-1',
          source: 'lsof',
        },
      ],
    });
    expect(liveByPort(policy, t).get(13001)).toMatchObject({
      holder: 'node',
      pid: 4242,
      project: 'alpha',
      sessionId: 'sess-alpha-1',
      tool: 'claude-code',
    });
  });
});

describe('states', () => {
  it('ok: lease bound by its owner session', () => {
    const r = run(
      [lease(13001)],
      truth({
        listeners: [
          {
            port: 13001,
            addr: '*:13001',
            pid: 1,
            cmd: 'node',
            cwd: paths.alpha,
            sessionId: 'sess-alpha-1',
            source: 'lsof',
          },
        ],
      }),
    );
    const p = r.ports.find((x) => x.port === 13001);
    expect(p?.state).toBe('ok');
    expect(p?.url).toBe('http://localhost:13001');
    expect(p?.evidence.some((e) => e.startsWith('ps -E'))).toBe(true);
  });
  it('conflict: lease owner differs from live holder', () => {
    const r = run(
      [lease(13001)],
      truth({
        listeners: [
          {
            port: 13001,
            addr: '*:13001',
            pid: 1,
            cmd: 'node',
            cwd: paths.beta,
            sessionId: 'sess-beta-9',
            source: 'lsof',
          },
        ],
      }),
    );
    const p = r.ports.find((x) => x.port === 13001);
    expect(p?.state).toBe('conflict');
    expect(p?.advisory?.command).toBe('berth who 13001 --json');
  });
  it('idle when owner alive but nothing bound; stale when owner gone', () => {
    const alive = run(
      [lease(13001, { owner: { session_id: 's', tool: 'claude-code', pid: process.pid } })],
      truth(),
    );
    expect(alive.ports.find((x) => x.port === 13001)?.state).toBe('idle');
    const gone = run([lease(13001)], truth());
    expect(gone.ports.find((x) => x.port === 13001)?.state).toBe('stale');
  });
  it('orphan when the lease cwd is missing', () => {
    const r = run([lease(13001, { cwd: path.join(root, 'gone-worktree') })], truth());
    expect(r.ports.find((x) => x.port === 13001)?.state).toBe('orphan');
  });
  it('squatter when another project binds inside a block; unmanaged when the block owner does', () => {
    const t = truth({
      listeners: [
        { port: 13005, addr: '*:13005', pid: 2, cmd: 'python', cwd: paths.beta, source: 'lsof' },
        { port: 13006, addr: '*:13006', pid: 3, cmd: 'python', cwd: paths.alpha, source: 'lsof' },
        { port: 40001, addr: '*:40001', pid: 4, cmd: 'bun', source: 'lsof' },
      ],
    });
    const r = run([], t);
    expect(r.ports.find((x) => x.port === 13005)?.state).toBe('squatter');
    expect(r.ports.find((x) => x.port === 13006)?.state).toBe('unmanaged');
    expect(r.ports.find((x) => x.port === 40001)).toMatchObject({
      state: 'unmanaged',
      kind: 'dynamic',
    });
  });
  it('shared services are ok when bound, drift when a sibling is up and this one is not', () => {
    const t = truth({
      listeners: [{ port: 3000, addr: '*:3000', pid: 503, cmd: 'ssh', source: 'lsof' }],
      containers: [{ id: 'g', name: 'obs-grafana-1', hostPorts: [3000], workingDir: paths.obs }],
    });
    const r = run([], t);
    expect(r.ports.find((x) => x.port === 3000)).toMatchObject({
      state: 'ok',
      kind: 'shared',
      project: 'obs',
      role: 'grafana',
    });
    expect(r.ports.find((x) => x.port === 9090)).toMatchObject({ state: 'drift', kind: 'shared' });
  });
  it('legacy declared ports: ok for a declaring project, squatter for another, idle when unbound', () => {
    const t = truth({
      listeners: [
        { port: 5173, addr: '*:5173', pid: 7, cmd: 'node', cwd: paths.alpha, source: 'lsof' },
      ],
    });
    const r = run([], t);
    expect(r.ports.find((x) => x.port === 5173)?.state).toBe('squatter');
    expect(r.ports.find((x) => x.port === 5432)).toMatchObject({ state: 'idle', kind: 'declared' });
  });
  it('reserved macOS ports are ok, and drift when policy renumbered a leased block', () => {
    const t = truth({
      listeners: [{ port: 5000, addr: '*:5000', pid: 1148, cmd: 'ControlCenter', source: 'lsof' }],
    });
    const r = run([lease(14001, { project: 'alpha' })], t);
    expect(r.ports.find((x) => x.port === 5000)?.state).toBe('ok');
    expect(r.ports.find((x) => x.port === 14001)?.state).toBe('drift');
  });
  it('builds sessions with worst state and liveness', () => {
    const sessions: SessionFile[] = [
      {
        id: 'sess-alpha-1',
        tool: 'claude-code',
        pid: process.pid,
        started: '2026-09-13T09:00:00Z',
        ended: null,
        cwd: paths.alpha,
        project: 'alpha',
        worktree: 0,
      },
    ];
    const t = truth({
      listeners: [
        {
          port: 13001,
          addr: '*:13001',
          pid: 1,
          cmd: 'node',
          cwd: paths.beta,
          sessionId: 'sess-beta-9',
          source: 'lsof',
        },
      ],
    });
    const r = run([lease(13001)], t, sessions);
    const a = r.sessions.find((s) => s.id === 'sess-alpha-1');
    const b = r.sessions.find((s) => s.id === 'sess-beta-9');
    expect(a).toMatchObject({
      alive: true,
      worst: 'conflict',
      project: 'alpha',
      cwdExists: true,
      leases: [13001],
    });
    expect(b).toMatchObject({ alive: true, tool: 'claude-code', leases: [13001] });
    expect(r.summary.attention).toBeGreaterThan(0);
    expect(r.summary.byState.conflict).toBe(1);
  });
  it('ignores ephemeral and privileged live ports that are not leased', () => {
    const t = truth({
      listeners: [
        { port: 65188, addr: '127.0.0.1:65188', pid: 9, cmd: 'Code', source: 'lsof' },
        { port: 22, addr: '*:22', pid: 1, cmd: 'launchd', source: 'netstat' },
      ],
    });
    const r = run([], t);
    expect(r.ports.find((x) => x.port === 65188)).toBeUndefined();
    expect(r.ports.find((x) => x.port === 22)).toBeUndefined();
  });
});
