import { allLeases, compact, readSessions } from './ledger.js';
import { truthCachePath } from './paths.js';
import { loadPolicy, type Policy } from './policy.js';
import { reconcile } from './reconcile.js';
import { type SnapshotOptions, snapshot } from './truth.js';
import type { CheckReport, TruthSnapshot } from './types.js';
import { readJsonSync } from './util.js';
import { VERSION } from './version.js';

export interface ReportOptions extends SnapshotOptions {
  policy?: Policy;
  /** Try to fold claim files first (skipped silently if the lock is busy). */
  compact?: boolean;
}

export async function buildReport(opts: ReportOptions = {}): Promise<CheckReport> {
  const policy = opts.policy ?? loadPolicy();
  let dropped: { port: number; sessionId: string }[] = [];
  if (opts.compact !== false) {
    try {
      const r = await compact({ deadlineMs: 250 });
      dropped = r.dropped.map((d) => ({ port: d.port, sessionId: d.sessionId }));
    } catch {
      // lock busy: read the un-compacted view instead
    }
  }
  const truth = await snapshot({
    maxAgeMs: opts.maxAgeMs ?? 1000,
    ...(opts.skipDocker ? { skipDocker: true } : {}),
    ...(opts.skipEnv ? { skipEnv: true } : {}),
    ...(opts.skipNetstat ? { skipNetstat: true } : {}),
  });
  return reconcile({
    policy,
    leases: allLeases(),
    sessions: readSessions(),
    truth,
    version: VERSION,
    droppedClaims: dropped,
  });
}

/**
 * A report from the cached truth snapshot only: no process is spawned and nothing is written.
 * Returns undefined when there is no full snapshot younger than `maxAgeMs`. Used by hooks.
 */
export function buildReportFromCache(policy: Policy, maxAgeMs: number): CheckReport | undefined {
  const cached = readJsonSync<TruthSnapshot | null>(truthCachePath(), null);
  if (!cached?.full || !cached.takenAt || Date.now() - Date.parse(cached.takenAt) > maxAgeMs)
    return undefined;
  return reconcile({
    policy,
    leases: allLeases(),
    sessions: readSessions(),
    truth: cached,
    version: VERSION,
  });
}
