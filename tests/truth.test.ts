import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { reconcile } from '../src/reconcile.js';
import { snapshot } from '../src/truth.js';
import type { Lease, TruthSnapshot } from '../src/types.js';
import { fixturePolicy, tempDir, useTempState } from './helpers.js';

describe('truth cache', () => {
  let state = '';
  beforeEach(() => {
    state = useTempState().state;
  });
  it('does not cache or serve degraded snapshots', async () => {
    const degraded = await snapshot({ skipDocker: true, skipEnv: true, skipNetstat: true });
    expect(degraded.full).toBe(false);
    expect(existsSync(path.join(state, 'truth.cache.json'))).toBe(false);
    const full = await snapshot({ maxAgeMs: 60_000 });
    expect(full.full).toBe(true);
    expect(existsSync(path.join(state, 'truth.cache.json'))).toBe(true);
    const again = await snapshot({ maxAgeMs: 60_000 });
    expect(again.takenAt).toBe(full.takenAt);
  }, 30_000);
});

describe('lease matching', () => {
  const { policy, paths } = fixturePolicy(tempDir());
  it('a human-claimed lease bound by a server started from that shell is ok, not conflict', () => {
    const lease: Lease = {
      port: 13000,
      project: 'alpha',
      worktree: 0,
      role: 'web',
      kind: 'block',
      owner: { session_id: 'human-chris', tool: 'human', pid: 4242 },
      cwd: paths.alpha,
      created: '2026-09-13T10:00:00Z',
      expires: null,
    };
    const truth: TruthSnapshot = {
      takenAt: new Date().toISOString(),
      full: true,
      listeners: [
        {
          port: 13000,
          addr: '*:13000',
          pid: 5001,
          cmd: 'node',
          cwd: `${paths.alpha}/apps/web`,
          source: 'lsof',
        },
      ],
      containers: [],
      dockerAvailable: false,
      colima: false,
    };
    const r = reconcile({ policy, leases: [lease], sessions: [], truth, version: 't' });
    expect(r.ports.find((p) => p.port === 13000)?.state).toBe('ok');
  });
});
