import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimsDir,
  compactLogPath,
  leasesPath,
  lockPath,
  sessionsDir,
  stateDir,
  worktreesDir,
} from './paths.js';
import type { Policy } from './policy.js';
import type { Lease, SessionFile } from './types.js';
import {
  appendFileSafe,
  atomicWriteSync,
  ensureDir,
  nowIso,
  pidAlive,
  readJsonSync,
  runSync,
  sleep,
} from './util.js';

export interface LeasesFile {
  version: 1;
  updated: string;
  leases: Lease[];
}

export interface ClaimFile {
  version: 1;
  sessionId: string;
  updated: string;
  leases: Lease[];
}

export interface WorktreeSlot {
  W: number;
  name: string;
  path: string;
  created: string;
  removed?: string | null;
}

export class LockTimeoutError extends Error {
  override name = 'LockTimeoutError';
}

/** Always returns a fresh object: callers mutate the result before writing it back. */
export function readLeases(): LeasesFile {
  const f = readJsonSync<LeasesFile | null>(leasesPath(), null);
  if (!f || !Array.isArray(f.leases)) return { version: 1, updated: '', leases: [] };
  return {
    version: 1,
    updated: typeof f.updated === 'string' ? f.updated : '',
    leases: [...f.leases],
  };
}

/** Caller must hold the ledger lock. */
export function writeLeases(data: LeasesFile): void {
  atomicWriteSync(
    leasesPath(),
    `${JSON.stringify({ ...data, version: 1, updated: nowIso() }, null, 2)}\n`,
    { backup: true },
  );
}

// ---- lock -------------------------------------------------------------------

interface LockMeta {
  pid: number;
  pid_start?: string;
  host: string;
  cmd: string;
  ts: string;
}

export function pidStartSync(pid: number): string | undefined {
  const out = runSync('ps', ['-o', 'lstart=', '-p', String(pid)], 1500);
  const s = out?.trim();
  return s ? s : undefined;
}

function lockIsStale(
  meta: LockMeta | undefined,
  ageMs: number,
): { stale: boolean; reason: string } {
  if (!meta || typeof meta.pid !== 'number')
    return { stale: ageMs > 30_000, reason: 'unreadable lock metadata' };
  if (!pidAlive(meta.pid)) return { stale: true, reason: `holder pid ${meta.pid} is gone` };
  const start = pidStartSync(meta.pid);
  if (start && meta.pid_start && start !== meta.pid_start) {
    return { stale: true, reason: `pid ${meta.pid} was reused (start time differs)` };
  }
  if (!start && ageMs > 30_000) return { stale: true, reason: 'holder unverifiable for 30s' };
  return { stale: false, reason: `held by pid ${meta.pid} (${meta.cmd}) since ${meta.ts}` };
}

/**
 * Run `fn` while holding the single ledger lock. Reads never need it; it guards
 * compaction and explicit claim/release writes to leases.json.
 */
export async function withLock<T>(
  opts: { deadlineMs: number; cmd: string },
  fn: () => T | Promise<T>,
): Promise<T> {
  ensureDir(stateDir());
  const file = lockPath();
  const started = Date.now();
  let delay = 10;
  let holder = '';
  for (;;) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        const meta: LockMeta = {
          pid: process.pid,
          pid_start: pidStartSync(process.pid),
          host: os.hostname(),
          cmd: opts.cmd,
          ts: nowIso(),
        };
        writeSync(fd, JSON.stringify(meta));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let meta: LockMeta | undefined;
      let ageMs = 0;
      try {
        meta = JSON.parse(readFileSync(file, 'utf8')) as LockMeta;
        ageMs = Date.now() - Date.parse(meta.ts);
      } catch {
        meta = undefined;
        ageMs = Date.now() - started;
      }
      const verdict = lockIsStale(meta, ageMs);
      holder = verdict.reason;
      if (verdict.stale) {
        try {
          unlinkSync(file);
        } catch {
          // someone else broke it first
        }
        continue;
      }
      if (Date.now() - started >= opts.deadlineMs) {
        throw new LockTimeoutError(`ledger lock busy: ${holder}`);
      }
      await sleep(delay + Math.floor(Math.random() * delay * 0.5));
      delay = Math.min(250, delay * 2);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
}

// ---- per-session claim files (lock-free) ------------------------------------

function claimFile(sessionId: string): string {
  return path.join(claimsDir(), `${safeName(sessionId)}.json`);
}

export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

export function readClaims(): ClaimFile[] {
  const dir = claimsDir();
  if (!existsSync(dir)) return [];
  const out: ClaimFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const c = readJsonSync<ClaimFile | null>(path.join(dir, f), null);
    if (c && Array.isArray(c.leases)) out.push(c);
  }
  return out;
}

export function readOwnClaims(sessionId: string): ClaimFile {
  return readJsonSync<ClaimFile>(claimFile(sessionId), {
    version: 1,
    sessionId,
    updated: '',
    leases: [],
  });
}

export function writeOwnClaims(sessionId: string, leases: Lease[]): void {
  ensureDir(claimsDir());
  const file = claimFile(sessionId);
  const data: ClaimFile = { version: 1, sessionId, updated: nowIso(), leases };
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (!existsSync(file)) {
    // First write: O_EXCL so two processes claiming for the same session id cannot clobber each other.
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  atomicWriteSync(file, text);
}

export function addClaim(sessionId: string, lease: Lease): void {
  const own = readOwnClaims(sessionId);
  const leases = own.leases.filter((l) => l.port !== lease.port);
  leases.push(lease);
  writeOwnClaims(sessionId, leases);
}

export function removeOwnClaim(sessionId: string, port: number): boolean {
  const own = readOwnClaims(sessionId);
  const before = own.leases.length;
  const leases = own.leases.filter((l) => l.port !== port);
  if (leases.length === before) return false;
  writeOwnClaims(sessionId, leases);
  return true;
}

/** leases.json plus not-yet-compacted claims. leases.json wins on a port collision. */
export function allLeases(): Lease[] {
  const byPort = new Map<number, Lease>();
  for (const l of readLeases().leases) byPort.set(l.port, l);
  const pending = readClaims()
    .flatMap((c) => c.leases)
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  for (const l of pending) if (!byPort.has(l.port)) byPort.set(l.port, l);
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export interface CompactResult {
  folded: number;
  dropped: { port: number; sessionId: string; reason: string }[];
}

/** Fold claim files into leases.json under the lock. Safe to run at any time. */
export async function compact(opts: { deadlineMs?: number } = {}): Promise<CompactResult> {
  return withLock({ deadlineMs: opts.deadlineMs ?? 3000, cmd: 'compact' }, () => {
    const result: CompactResult = { folded: 0, dropped: [] };
    const claims = readClaims();
    if (claims.length === 0) return result;
    const ledger = readLeases();
    const byPort = new Map(ledger.leases.map((l) => [l.port, l]));
    const ordered = claims
      .flatMap((c) => c.leases.map((l) => ({ l, sessionId: c.sessionId })))
      .sort((a, b) => Date.parse(a.l.created) - Date.parse(b.l.created));
    for (const { l, sessionId } of ordered) {
      const existing = byPort.get(l.port);
      if (existing && ownerKey(existing) !== ownerKey(l)) {
        result.dropped.push({
          port: l.port,
          sessionId,
          reason: `already leased by ${ownerKey(existing)}`,
        });
        continue;
      }
      byPort.set(l.port, l);
      result.folded++;
    }
    ledger.leases = [...byPort.values()].sort((a, b) => a.port - b.port);
    writeLeases(ledger);
    for (const c of claims) {
      const file = claimFile(c.sessionId);
      const now = readJsonSync<ClaimFile | null>(file, null);
      // Only delete a claim file whose content we actually folded; a concurrent append survives.
      if (now && now.updated === c.updated) {
        try {
          unlinkSync(file);
        } catch {
          // ignore
        }
      }
    }
    if (result.dropped.length > 0) {
      const lines = result.dropped.map(
        (d) => `${nowIso()} drop port=${d.port} session=${d.sessionId} ${d.reason}`,
      );
      appendFileSafe(compactLogPath(), `${lines.join('\n')}\n`);
    }
    return result;
  });
}

export function ownerKey(l: Lease): string {
  return l.owner.session_id ?? (l.owner.pid ? `pid:${l.owner.pid}` : `${l.owner.tool}`);
}

// ---- sessions ----------------------------------------------------------------

function sessionFile(id: string): string {
  return path.join(sessionsDir(), `${safeName(id)}.json`);
}

export function readSession(id: string): SessionFile | undefined {
  return readJsonSync<SessionFile | undefined>(sessionFile(id), undefined);
}

export function writeSession(s: SessionFile): void {
  ensureDir(sessionsDir());
  atomicWriteSync(sessionFile(s.id), `${JSON.stringify(s, null, 2)}\n`);
}

export function readSessions(): SessionFile[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: SessionFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const s = readJsonSync<SessionFile | null>(path.join(dir, f), null);
    if (s?.id) out.push(s);
  }
  return out;
}

// ---- worktree slots (O_EXCL, tombstoned) -----------------------------------

function slotDir(project: string): string {
  return path.join(worktreesDir(), safeName(project));
}

export function worktreeSlots(project: string): WorktreeSlot[] {
  const dir = slotDir(project);
  if (!existsSync(dir)) return [];
  const out: WorktreeSlot[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^W(\d)\.json$/.exec(f);
    if (!m) continue;
    const s = readJsonSync<WorktreeSlot | null>(path.join(dir, f), null);
    if (s && typeof s.W === 'number') out.push(s);
  }
  return out.sort((a, b) => a.W - b.W);
}

export function findWorktreeSlot(project: string, name: string): WorktreeSlot | undefined {
  return worktreeSlots(project).find((s) => s.name === name && !s.removed);
}

/** Assign the lowest free W (1..worktreeMax) to a worktree name; O_EXCL makes concurrent assignment race-free. */
export function assignWorktreeSlot(
  policy: Policy,
  project: string,
  name: string,
  wtPath: string,
): WorktreeSlot | undefined {
  const existing = findWorktreeSlot(project, name);
  if (existing) return existing;
  const dir = slotDir(project);
  ensureDir(dir);
  for (let W = 1; W <= policy.scheme.worktreeMax; W++) {
    const file = path.join(dir, `W${W}.json`);
    if (existsSync(file)) continue;
    const slot: WorktreeSlot = { W, name, path: wtPath, created: nowIso(), removed: null };
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, `${JSON.stringify(slot, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      return slot;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // lost the race for this W; try the next one
    }
  }
  return undefined;
}

export function markWorktreeRemoved(project: string, W: number): boolean {
  const file = path.join(slotDir(project), `W${W}.json`);
  const slot = readJsonSync<WorktreeSlot | null>(file, null);
  if (!slot) return false;
  slot.removed = nowIso();
  atomicWriteSync(file, `${JSON.stringify(slot, null, 2)}\n`);
  return true;
}

export function pruneWorktreeSlot(project: string, W: number): boolean {
  const file = path.join(slotDir(project), `W${W}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
