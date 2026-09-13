import { execFile, execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** The executable was not found on PATH. */
  missing: boolean;
  timedOut: boolean;
}

interface ExecError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: string;
}

/** Run an executable with an argument array. Never uses a shell, never throws. */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number; stdin?: string; cwd?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? 5000,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        encoding: 'utf8',
        cwd: opts.cwd,
        env: process.env,
      },
      (err, stdout, stderr) => {
        const e = err as ExecError | null;
        let code = 0;
        let missing = false;
        let timedOut = false;
        if (e) {
          if (e.code === 'ENOENT') {
            missing = true;
            code = 127;
          } else if (typeof e.code === 'number') {
            code = e.code;
          } else {
            code = 1;
          }
          if (e.killed && e.signal === 'SIGTERM') timedOut = true;
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code,
          missing,
          timedOut,
        });
      },
    );
    if (opts.stdin !== undefined && child.stdin) child.stdin.end(opts.stdin);
  });
}

/** Synchronous variant for the few places that must stay synchronous (lock metadata). */
export function runSync(cmd: string, args: string[], timeoutMs = 2000): string | undefined {
  try {
    return execFileSync(cmd, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function contractHome(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function humanAge(fromIso: string | undefined, to = Date.now()): string {
  if (!fromIso) return '';
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((to - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export function ensureDir(dir: string, mode = 0o700): void {
  mkdirSync(dir, { recursive: true, mode });
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort (not supported on every filesystem).
  }
}

/** Write a file atomically: temp file in the same directory, fsync, rename, fsync dir. */
export function atomicWriteSync(
  file: string,
  data: string,
  opts: { backup?: boolean; mode?: number } = {},
): void {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const fd = openSync(tmp, 'w', opts.mode ?? 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (opts.backup && existsSync(file)) {
    try {
      copyFileSync(file, `${file}.bak`);
    } catch {
      // A missing backup never blocks the write.
    }
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
  fsyncDir(dir);
}

export function appendFileSafe(file: string, text: string): void {
  try {
    ensureDir(path.dirname(file));
    const fd = openSync(file, 'a', 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  } catch {
    // logging is best-effort
  }
}

/** Read JSON; on a torn or missing file fall back to `.bak`, then to the fallback value. */
export function readJsonSync<T>(file: string, fallback: T): T {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      if (!existsSync(candidate)) continue;
      const text = readFileSync(candidate, 'utf8');
      return JSON.parse(text) as T;
    } catch {
      // try the next candidate
    }
  }
  return fallback;
}

export function shortId(id: string | undefined): string {
  return (id ?? '').slice(0, 8);
}

export function isValidPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function parsePort(s: string | undefined): number | null {
  if (!s || !/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return isValidPort(n) ? n : null;
}

export function hostUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? 'unknown';
  }
}

export function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

/** Whether output may use ANSI colour: honours NO_COLOR and non-TTY stdout. */
export function colourEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return Boolean(process.stdout.isTTY);
}

const ESC = String.fromCharCode(27);
const ANSI: Record<string, string> = {
  ok: `${ESC}[32m`,
  idle: `${ESC}[2m`,
  stale: `${ESC}[33m`,
  orphan: `${ESC}[33m`,
  unmanaged: `${ESC}[36m`,
  squatter: `${ESC}[31m`,
  conflict: `${ESC}[31;1m`,
  drift: `${ESC}[34m`,
};

export function colourState(state: string): string {
  if (!colourEnabled()) return state;
  const code = ANSI[state];
  return code ? `${code}${state}${ESC}[0m` : state;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
