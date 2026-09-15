import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { renderCheck } from '../src/commands/query.js';
import { applyTidyPlan, buildTidyPlan, cmdTidy, type TidyPlan } from '../src/commands/tidy.js';
import { addClaim, allLeases } from '../src/ledger.js';
import { reconcile } from '../src/reconcile.js';
import type { Lease, SessionFile, TruthSnapshot } from '../src/types.js';
import { fixturePolicy, tempDir, useTempState, writePolicy } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

const NOW = Date.parse('2026-09-15T12:00:00Z');

describe('buildTidyPlan', () => {
  const root = tempDir();
  const { policy, paths } = fixturePolicy(root);

  function lease(port: number, over: Partial<Lease> = {}): Lease {
    return {
      port,
      project: 'alpha',
      worktree: 0,
      role: 'api',
      kind: 'block',
      owner: { session_id: 'sess-alpha-1', tool: 'claude-code', pid: 999999 },
      cwd: paths.alpha,
      created: '2026-09-15T10:00:00Z',
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
  function report(leases: Lease[], t: TruthSnapshot, sessions: SessionFile[] = []) {
    return reconcile({ policy, leases, sessions, truth: t, version: 'test', now: NOW });
  }

  it('releases stale and orphan leases from any owner, and never ok/idle/conflict ones', () => {
    const stale = lease(13001, {
      owner: { session_id: 'human-someone', tool: 'human', pid: 999999 },
    });
    const orphan = lease(13002, { role: 'db', cwd: path.join(root, 'gone-worktree') });
    const idle = lease(13003, {
      role: 'cache',
      owner: { session_id: 's', tool: 'claude-code', pid: process.pid },
    });
    const r = report([stale, orphan, idle], truth());
    const plan = buildTidyPlan(r);
    expect(plan.release.map((x) => x.port).sort((a, b) => a - b)).toEqual([13001, 13002]);
    const staleRow = plan.release.find((x) => x.port === 13001);
    expect(staleRow).toMatchObject({ state: 'stale', project: 'alpha' });
    expect(staleRow?.owner).toMatch(/human-so/); // owned by a different session than the caller; tidy still plans to release it
    expect(staleRow?.command).toBe('berth release --port 13001');
    const orphanRow = plan.release.find((x) => x.port === 13002);
    expect(orphanRow).toMatchObject({ state: 'orphan', command: 'berth release --port 13002' });
  });

  it('lists unmanaged ports as a suggestion only, never as something to release', () => {
    // no cwd: the holder cannot be attributed to alpha by evidence, so it stays unmanaged
    // (an attributed holder inside its own block's project is `ok`, not unmanaged).
    const t = truth({
      listeners: [{ port: 13006, addr: '*:13006', pid: 2, cmd: 'python', source: 'lsof' }],
    });
    const r = report([], t);
    const plan = buildTidyPlan(r);
    expect(plan.release).toEqual([]);
    expect(plan.unmanaged).toMatchObject([
      { port: 13006, project: 'alpha', command: 'berth adopt 13006 --owner human' },
    ]);
  });

  it('--project scopes both release and unmanaged rows; a dynamic-pool port with no project is excluded once scoped', () => {
    const alphaStale = lease(13001);
    const betaStale = lease(14001, { project: 'beta', cwd: paths.beta });
    const t = truth({
      listeners: [
        // unattributed (no cwd): both stay unmanaged rather than becoming ok
        { port: 13006, addr: '*:13006', pid: 2, cmd: 'python', source: 'lsof' },
        { port: 14006, addr: '*:14006', pid: 3, cmd: 'python', source: 'lsof' },
        { port: 40001, addr: '*:40001', pid: 4, cmd: 'bun', source: 'lsof' }, // unattributed: no project
      ],
    });
    const r = report([alphaStale, betaStale], t);

    const all = buildTidyPlan(r);
    expect(all.release.map((x) => x.port).sort((a, b) => a - b)).toEqual([13001, 14001]);
    expect(all.unmanaged.map((x) => x.port).sort((a, b) => a - b)).toEqual([13006, 14006, 40001]);

    const alphaOnly = buildTidyPlan(r, 'alpha');
    expect(alphaOnly.release.map((x) => x.port)).toEqual([13001]);
    // 40001 has no project attribution once it's live, so scoping to a project drops it too
    expect(alphaOnly.unmanaged.map((x) => x.port)).toEqual([13006]);
  });
});

describe('applyTidyPlan', () => {
  let root = '';
  let stateDir = '';
  beforeEach(() => {
    const t = useTempState();
    root = t.root;
    stateDir = t.state;
  });

  it('releases every row from any owner with --force, writes one audit line per release, and is idempotent', async () => {
    const cwd = path.join(root, 'alpha');
    mkdirSync(cwd, { recursive: true });
    const stale: Lease = {
      port: 13001,
      project: 'alpha',
      worktree: 0,
      role: 'api',
      kind: 'block',
      owner: { session_id: 'human-other', tool: 'human', pid: 999999 },
      cwd,
      created: '2026-09-15T10:00:00Z',
      expires: null,
    };
    await addClaim('human-other', stale);
    const plan: TidyPlan = {
      release: [{ port: 13001, project: 'alpha', state: 'stale', owner: 'human-other' }],
      unmanaged: [],
    };

    // the caller running tidy ("agent-session-1") is not the lease owner ("human-other")
    const first = await applyTidyPlan(plan, 'agent-session-1');
    expect(first.released).toEqual([13001]);
    expect(allLeases().some((l) => l.port === 13001)).toBe(false);
    const audit = readFileSync(path.join(stateDir, 'audit.log'), 'utf8');
    expect(audit.match(/tidy release port=13001/g)?.length).toBe(1);

    const second = await applyTidyPlan(plan, 'agent-session-1');
    expect(second.released).toEqual([]);
    const auditAfter = readFileSync(path.join(stateDir, 'audit.log'), 'utf8');
    expect(auditAfter.match(/tidy release port=13001/g)?.length).toBe(1); // no duplicate line
  });

  it('never acts on unmanaged rows: applying a plan with an unmanaged suggestion creates no lease for it', async () => {
    const cwd = path.join(root, 'alpha');
    mkdirSync(cwd, { recursive: true });
    const stale: Lease = {
      port: 13001,
      project: 'alpha',
      worktree: 0,
      role: 'api',
      kind: 'block',
      owner: { session_id: 'human-other', tool: 'human', pid: 999999 },
      cwd,
      created: '2026-09-15T10:00:00Z',
      expires: null,
    };
    await addClaim('human-other', stale);
    // a real plan built from a reconciled report would carry an unmanaged suggestion alongside
    // the release row; applying it must only ever act on `release`, never `unmanaged`.
    const plan: TidyPlan = {
      release: [{ port: 13001, project: 'alpha', state: 'stale', owner: 'human-other' }],
      unmanaged: [
        {
          port: 13006,
          project: 'alpha',
          state: 'unmanaged',
          command: 'berth adopt 13006 --owner human',
        },
      ],
    };
    const result = await applyTidyPlan(plan, 'agent-session-1');
    expect(result.released).toEqual([13001]); // only the release row was acted on
    expect(allLeases().some((l) => l.port === 13006)).toBe(false); // no lease was ever created for the suggestion
  });
});

describe('cmdTidy', () => {
  let root = '';
  let alphaDir = '';
  let betaDir = '';
  beforeEach(() => {
    const t = useTempState();
    root = t.root;
    const fx = fixturePolicy(root);
    writePolicy(process.env.BERTH_POLICY as string, fx.text);
    alphaDir = fx.paths.alpha;
    betaDir = fx.paths.beta;
  });

  it('reports nothing to tidy on an empty ledger', async () => {
    // scoped to alpha's own block: the host this test runs on may have unrelated real listeners
    // elsewhere (other projects, other sessions), which is exactly what --project exists to filter.
    const c = capture();
    expect(await cmdTidy(parseArgs(['tidy', '--dry-run', '--project', 'alpha']), c.io)).toBe(0);
    expect(c.out.join('\n')).toBe('nothing to tidy (project alpha)');
  });

  it('refuses an unknown --project', async () => {
    const c = capture();
    expect(await cmdTidy(parseArgs(['tidy', '--project', 'ghost', '--dry-run']), c.io)).toBe(1);
    expect(c.err.join(' ')).toMatch(/unknown project ghost/);
  });

  it('--dry-run shows the plan and writes nothing; applying releases it and is then idempotent', async () => {
    const stale: Lease = {
      port: 13001,
      project: 'alpha',
      worktree: 0,
      role: 'api',
      kind: 'block',
      owner: { session_id: 'human-other', tool: 'human', pid: 999999 },
      cwd: alphaDir,
      created: '2026-09-15T10:00:00Z',
      expires: null,
    };
    await addClaim('human-other', stale);

    const dry = capture();
    expect(
      await cmdTidy(parseArgs(['tidy', '--dry-run', '--json', '--project', 'alpha']), dry.io),
    ).toBe(0);
    const plan = JSON.parse(dry.out.join('')) as { dryRun: boolean; release: { port: number }[] };
    expect(plan.dryRun).toBe(true);
    expect(plan.release.map((r) => r.port)).toEqual([13001]);
    expect(allLeases().some((l) => l.port === 13001)).toBe(true); // dry-run touches nothing

    // apply mode's --json mirrors the plan too, plus which ports were actually released
    const applied = capture();
    expect(await cmdTidy(parseArgs(['tidy', '--project', 'alpha', '--json']), applied.io)).toBe(0);
    const appliedPlan = JSON.parse(applied.out.join('')) as {
      dryRun: boolean;
      released: number[];
      release: { port: number }[];
    };
    expect(appliedPlan).toMatchObject({ dryRun: false, released: [13001] });
    expect(appliedPlan.release.map((r) => r.port)).toEqual([13001]); // the plan that was applied
    expect(allLeases().some((l) => l.port === 13001)).toBe(false);

    const again = capture();
    expect(await cmdTidy(parseArgs(['tidy', '--project', 'alpha']), again.io)).toBe(0);
    expect(again.out.join('\n')).toBe('nothing to tidy (project alpha)');
  });

  it('--project limits scope; live (idle) leases and other projects are never touched', async () => {
    const alphaStale: Lease = {
      port: 13001,
      project: 'alpha',
      worktree: 0,
      role: 'api',
      kind: 'block',
      owner: { session_id: 'human-other', tool: 'human', pid: 999999 },
      cwd: alphaDir,
      created: '2026-09-15T10:00:00Z',
      expires: null,
    };
    const betaStale: Lease = {
      port: 14001,
      project: 'beta',
      worktree: 0,
      role: 'api',
      kind: 'block',
      owner: { session_id: 'human-other2', tool: 'human', pid: 999999 },
      cwd: betaDir,
      created: '2026-09-15T10:00:00Z',
      expires: null,
    };
    const alphaIdle: Lease = {
      port: 13003,
      project: 'alpha',
      worktree: 0,
      role: 'cache',
      kind: 'block',
      owner: { session_id: 'sess-x', tool: 'claude-code', pid: process.pid },
      cwd: alphaDir,
      created: '2026-09-15T10:00:00Z',
      expires: null,
    };
    await addClaim('human-other', alphaStale);
    await addClaim('human-other2', betaStale);
    await addClaim('sess-x', alphaIdle);

    const c = capture();
    expect(await cmdTidy(parseArgs(['tidy', '--project', 'alpha']), c.io)).toBe(0);
    const ports = allLeases()
      .map((l) => l.port)
      .sort((a, b) => a - b);
    expect(ports).toEqual([13003, 14001]); // alpha's stale lease gone; beta's stale and alpha's idle lease remain
  });
});

describe("check's attention summary points at tidy", () => {
  const root = tempDir();
  const { policy, paths } = fixturePolicy(root);

  function lease(port: number, over: Partial<Lease> = {}): Lease {
    return {
      port,
      project: 'alpha',
      worktree: 0,
      role: 'api',
      kind: 'block',
      owner: { session_id: 'sess', tool: 'claude-code', pid: 999999 },
      cwd: paths.alpha,
      created: '2026-09-15T10:00:00Z',
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

  it('ends with one "run: berth tidy --project <name>" line per project that has a release-worthy lease', () => {
    const alphaStale = lease(13001);
    const betaStale = lease(14001, { project: 'beta', cwd: paths.beta });
    const r = reconcile({
      policy,
      leases: [alphaStale, betaStale],
      sessions: [],
      truth: truth(),
      version: 'test',
      now: NOW,
    });
    const lines = renderCheck(r).trimEnd().split('\n');
    expect(lines.at(-2)).toBe('  run: berth tidy --project alpha');
    expect(lines.at(-1)).toBe('  run: berth tidy --project beta');
  });

  it('says nothing about tidy when there is nothing stale or orphan', () => {
    const r = reconcile({
      policy,
      leases: [],
      sessions: [],
      truth: truth(),
      version: 'test',
      now: NOW,
    });
    expect(renderCheck(r)).not.toMatch(/run: berth tidy/);
  });

  it('does not suggest tidy for unmanaged-only attention (tidy cannot act on it)', () => {
    // no cwd: an attributed holder inside its own block's project is `ok`, not unmanaged
    const t = truth({
      listeners: [{ port: 13006, addr: '*:13006', pid: 2, cmd: 'python', source: 'lsof' }],
    });
    const r = reconcile({ policy, leases: [], sessions: [], truth: t, version: 'test', now: NOW });
    expect(r.ports.find((p) => p.port === 13006)?.state).toBe('unmanaged');
    expect(renderCheck(r)).not.toMatch(/run: berth tidy/);
  });
});
