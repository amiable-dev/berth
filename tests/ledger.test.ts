import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addClaim,
  allLeases,
  assignWorktreeSlot,
  compact,
  findWorktreeSlot,
  LockTimeoutError,
  lockIsStale,
  readLeases,
  releaseLease,
  removeOwnClaim,
  withLock,
  worktreeSlots,
  writeLeases,
} from '../src/ledger.js';
import { leasesPath, lockPath } from '../src/paths.js';
import type { Lease } from '../src/types.js';
import { atomicWriteSync, readJsonSync } from '../src/util.js';
import { fixturePolicy, tempDir, useTempState } from './helpers.js';

function lease(port: number, session: string, created = '2026-09-13T10:00:00.000Z'): Lease {
  return {
    port,
    project: 'alpha',
    worktree: 0,
    role: 'api',
    kind: 'block',
    owner: { session_id: session, tool: 'claude-code', pid: process.pid },
    cwd: '/tmp',
    created,
    expires: null,
  };
}

describe('ledger', () => {
  beforeEach(() => {
    useTempState();
  });

  it('writes atomically with a backup and survives a torn file', () => {
    writeLeases({ version: 1, updated: '', leases: [lease(13001, 's1')] });
    writeLeases({ version: 1, updated: '', leases: [lease(13001, 's1'), lease(13002, 's1')] });
    expect(existsSync(`${leasesPath()}.bak`)).toBe(true);
    writeFileSync(leasesPath(), '{"version":1,"leases":[{"po');
    expect(readLeases().leases.map((l) => l.port)).toEqual([13001]);
  });

  it('claims are lock-free per session and fold into the ledger on compact', async () => {
    await addClaim('s1', lease(13001, 's1', '2026-09-13T10:00:00Z'));
    await addClaim('s2', lease(13001, 's2', '2026-09-13T10:00:01Z'));
    await addClaim('s2', lease(13005, 's2', '2026-09-13T10:00:02Z'));
    expect(allLeases().map((l) => `${l.port}:${l.owner.session_id}`)).toEqual([
      '13001:s1',
      '13005:s2',
    ]);
    const r = await compact();
    expect(r.folded).toBe(2);
    expect(r.dropped).toEqual([{ port: 13001, sessionId: 's2', reason: 'already leased by s1' }]);
    expect(readLeases().leases.map((l) => l.port)).toEqual([13001, 13005]);
    expect(allLeases().length).toBe(2);
  });

  it('release removes from the own claim file', async () => {
    await addClaim('s1', lease(13001, 's1'));
    expect(await removeOwnClaim('s1', 13001)).toBe(true);
    expect(await removeOwnClaim('s1', 13001)).toBe(false);
    expect(allLeases()).toEqual([]);
  });

  it('parallel claims within one session do not overwrite each other', async () => {
    await Promise.all([
      addClaim('s1', lease(13001, 's1')),
      addClaim('s1', lease(13002, 's1')),
      addClaim('s1', lease(13003, 's1')),
    ]);
    expect(allLeases().map((l) => l.port)).toEqual([13001, 13002, 13003]);
  });

  it("releaseLease reaches leases.json and other sessions' claim files, honouring ownership", async () => {
    writeLeases({ version: 1, updated: '', leases: [lease(13001, 's1')] });
    await addClaim('s2', lease(13002, 's2'));
    expect((await releaseLease(13001, { sessionId: 's2' })).refused).toMatch(/leased by s1/);
    expect((await releaseLease(13001, { sessionId: 's1' })).released).toBe(true);
    expect((await releaseLease(13002, { sessionId: 's1' })).refused).toMatch(/claimed by s2/);
    expect((await releaseLease(13002, { sessionId: 's1', force: true })).released).toBe(true);
    expect(allLeases()).toEqual([]);
  });

  it('never breaks a lock whose holder is alive, even when its start time is unknown', () => {
    expect(
      lockIsStale(
        {
          pid: process.pid,
          host: 'x',
          cmd: 'me',
          ts: new Date(Date.now() - 120_000).toISOString(),
        },
        120_000,
      ).stale,
    ).toBe(false);
    expect(
      lockIsStale({ pid: 999999, host: 'x', cmd: 'ghost', ts: new Date().toISOString() }, 0).stale,
    ).toBe(true);
    expect(lockIsStale(undefined, 31_000).stale).toBe(true);
    expect(lockIsStale(undefined, 1_000).stale).toBe(false);
  });

  it('lock is exclusive, retries with jitter, and breaks a dead holder', async () => {
    const order: string[] = [];
    const a = withLock({ deadlineMs: 2000, cmd: 'a' }, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 150));
      order.push('a-end');
    });
    await new Promise((r) => setTimeout(r, 20));
    const b = withLock({ deadlineMs: 2000, cmd: 'b' }, () => {
      order.push('b');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    // a stale lock left by a dead pid is broken
    atomicWriteSync(
      lockPath(),
      JSON.stringify({ pid: 999999, host: 'x', cmd: 'ghost', ts: new Date().toISOString() }),
    );
    await expect(withLock({ deadlineMs: 500, cmd: 'c' }, () => 'ok')).resolves.toBe('ok');
    // a live holder is respected until the deadline
    atomicWriteSync(
      lockPath(),
      JSON.stringify({
        pid: process.pid,
        pid_start: readJsonSync(lockPath(), {}) && undefined,
        host: 'x',
        cmd: 'me',
        ts: new Date().toISOString(),
      }),
    );
    await expect(withLock({ deadlineMs: 120, cmd: 'd' }, () => 'no')).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
  });

  it('assigns worktree slots with O_EXCL and never reuses a tombstone', () => {
    const { policy } = fixturePolicy(tempDir());
    const s1 = assignWorktreeSlot(policy, 'alpha', 'feature-a', '/tmp/a');
    const s2 = assignWorktreeSlot(policy, 'alpha', 'feature-b', '/tmp/b');
    expect(s1?.W).toBe(1);
    expect(s2?.W).toBe(2);
    expect(assignWorktreeSlot(policy, 'alpha', 'feature-a', '/tmp/a')?.W).toBe(1);
    expect(findWorktreeSlot('alpha', 'feature-b')?.W).toBe(2);
    const dir = path.dirname(
      path.join(process.env.BERTH_STATE_DIR ?? '', 'worktrees', 'alpha', 'W1.json'),
    );
    const w1 = JSON.parse(readFileSync(path.join(dir, 'W1.json'), 'utf8'));
    expect(w1.name).toBe('feature-a');
    expect(worktreeSlots('alpha').length).toBe(2);
  });
});
