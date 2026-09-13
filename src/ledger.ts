import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
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
    {
      backup: true,
    },
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

const startCache = new Map<number, string | undefined>();

/** `ps -o lstart` for a pid, memoised per process (a pid's start time never changes). */
export function pidStartSync(pid: number): string | undefined {
  if (startCache.has(pid)) return startCache.get(pid);
  const out = runSync('ps', ['-o', 'lstart=', '-p', String(pid)], 1500);
  const s = out?.trim() || undefined;
  startCache.set(pid, s);
  return s;
}

/**
 * A lock is stale only when its holder is provably gone: pid dead, or pid reused
 * (start time differs). A live pid is never broken. Unreadable metadata is stale after 30 s.
 */
export function lockIsStale(
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
  return { stale: false, reason: `held by pid ${meta.pid} (${meta.cmd}) since ${meta.ts}` };
}

/**
 * Break a stale lock without a TOCTOU: rename it to a unique name first. Only one waiter's
 * rename succeeds; a lock re-created by another waiter in the meantime is never removed.
 */
function breakLock(file: string): boolean {
  const tomb = `${file}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(file, tomb);
  } catch {
    return false;
  }
  try {
    unlinkSync(tomb);
  } catch {
    // already gone
  }
  return true;
}

/**
 * Read a lock file's metadata. Returns undefined when the file is gone (the holder released it
 * between our failed create and this read), and undefined metadata when it is unreadable.
 */
function readLockMeta(
  file: string,
  fallbackSince: number,
): { meta: LockMeta | undefined; ageMs: number } | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const meta = JSON.parse(raw) as LockMeta;
    return { meta, ageMs: Date.now() - Date.parse(meta.ts) };
  } catch {
    return { meta: undefined, ageMs: Date.now() - fallbackSince };
  }
}

export interface LockOptions {
  deadlineMs: number;
  cmd: string;
  /** Lock file; defaults to the ledger lock. Claim files use a per-session lock. */
  file?: string;
}

/**
 * Run `fn` while holding a lock file. Reads never need the ledger lock; it guards
 * compaction and explicit writes to leases.json. Claim files take their own per-session lock.
 */
export async function withLock<T>(opts: LockOptions, fn: () => T | Promise<T>): Promise<T> {
  const file = opts.file ?? lockPath();
  ensureDir(path.dirname(file));
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
      const held = readLockMeta(file, started);
      if (!held) continue; // the lock vanished between the failed open and the read: retry
      const verdict = lockIsStale(held.meta, held.ageMs);
      holder = verdict.reason;
      if (verdict.stale) {
        breakLock(file);
        continue;
      }
      if (Date.now() - started >= opts.deadlineMs)
        throw new LockTimeoutError(`lock busy: ${holder}`);
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

// ---- per-session claim files ---------------------------------------------------
// Sessions never contend with each other; a session's own parallel commands serialise on
// a tiny per-session lock so two claims in flight cannot overwrite each other's file.

export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

function claimFile(sessionId: string): string {
  return path.join(claimsDir(), `${safeName(sessionId)}.json`);
}

function claimLock(sessionId: string): string {
  return path.join(claimsDir(), `.${safeName(sessionId)}.lock`);
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

function writeOwnClaimsUnlocked(sessionId: string, leases: Lease[]): void {
  ensureDir(claimsDir());
  const data: ClaimFile = { version: 1, sessionId, updated: nowIso(), leases };
  atomicWriteSync(claimFile(sessionId), `${JSON.stringify(data, null, 2)}\n`);
}

async function withClaimLock<T>(sessionId: string, cmd: string, fn: () => T): Promise<T> {
  ensureDir(claimsDir());
  return withLock({ deadlineMs: 3000, cmd, file: claimLock(sessionId) }, fn);
}

export async function addClaim(sessionId: string, lease: Lease): Promise<void> {
  await withClaimLock(sessionId, 'claim', () => {
    const own = readOwnClaims(sessionId);
    const leases = own.leases.filter((l) => l.port !== lease.port);
    leases.push(lease);
    writeOwnClaimsUnlocked(sessionId, leases);
  });
}

export async function removeOwnClaim(sessionId: string, port: number): Promise<boolean> {
  return withClaimLock(sessionId, 'release', () => {
    const own = readOwnClaims(sessionId);
    const leases = own.leases.filter((l) => l.port !== port);
    if (leases.length === own.leases.length) return false;
    writeOwnClaimsUnlocked(sessionId, leases);
    return true;
  });
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

function hasClaimFiles(): boolean {
  const dir = claimsDir();
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => f.endsWith('.json') && !f.startsWith('.'));
}

/** Fold claim files into leases.json under the lock. Cheap when there is nothing to fold. */
export async function compact(opts: { deadlineMs?: number } = {}): Promise<CompactResult> {
  const result: CompactResult = { folded: 0, dropped: [] };
  if (!hasClaimFiles()) return result;
  return withLock({ deadlineMs: opts.deadlineMs ?? 3000, cmd: 'compact' }, () => {
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

export interface ReleaseResult {
  released: boolean;
  refused?: string;
}

/**
 * Release one port everywhere it can live: leases.json (under the ledger lock) and every
 * claim file that still carries it. Only the owning session may release unless forced.
 */
export async function releaseLease(
  port: number,
  opts: { sessionId: string; force?: boolean },
): Promise<ReleaseResult> {
  let released = false;
  let refused: string | undefined;
  const allowed = (l: Lease) => opts.force === true || l.owner.session_id === opts.sessionId;
  await withLock({ deadlineMs: 3000, cmd: 'release' }, () => {
    const ledger = readLeases();
    const keep: Lease[] = [];
    for (const l of ledger.leases) {
      if (l.port !== port) {
        keep.push(l);
        continue;
      }
      if (!allowed(l)) {
        refused = `${port} is leased by ${ownerKey(l)}; pass --force to release it`;
        keep.push(l);
        continue;
      }
      released = true;
    }
    if (released) {
      ledger.leases = keep;
      writeLeases(ledger);
    }
  });
  for (const c of readClaims()) {
    const mine = c.leases.filter((l) => l.port === port);
    if (mine.length === 0) continue;
    if (!mine.every(allowed)) {
      refused = refused ?? `${port} is claimed by ${c.sessionId}; pass --force to release it`;
      continue;
    }
    if (await removeOwnClaim(c.sessionId, port)) released = true;
  }
  return { released, ...(refused && !released ? { refused } : {}) };
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

export function stateDirPath(): string {
  return stateDir();
}
