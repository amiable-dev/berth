import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Policy, type Project, parsePolicy } from '../src/policy.js';

export function tempDir(prefix = 'berth-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A synthetic policy whose project paths live inside `root` (created on disk). */
export function fixturePolicy(root: string) {
  const a = path.join(root, 'alpha');
  const b = path.join(root, 'beta');
  const c = path.join(root, 'obs');
  for (const d of [a, b, c]) mkdirSync(d, { recursive: true });
  const text = `
[scheme]
base = 10000
project_max = 29
worktree_max = 9

[pools]
dynamic = "40000-41999"
ttl_hours = 8

[reserved]
ranges = ["0-1023", "4000-4999", "49152-65535"]
ports = [5000, 7000]
lint = [11211, 27017]

[shared.observability]
owner = "obs"
ports = { grafana = 3000, prometheus = 9090 }

[projects.obs]
P = 1
path = "${c}"

[projects.alpha]
P = 3
path = "${a}"
declared = [3000, 5432]
extras = { gateway = 10, search = 11 }

[projects.beta]
P = 4
path = "${b}"
declared = [5173]
`;
  return { text, policy: parsePolicy(text), paths: { alpha: a, beta: b, obs: c } };
}

export function useTempState(): { state: string; config: string; root: string } {
  const root = tempDir();
  const state = path.join(root, 'state');
  const config = path.join(root, 'config');
  mkdirSync(state, { recursive: true });
  mkdirSync(config, { recursive: true });
  process.env.BERTH_STATE_DIR = state;
  process.env.BERTH_CONFIG_DIR = config;
  process.env.BERTH_POLICY = path.join(config, 'policy.toml');
  return { state, config, root };
}

export function writePolicy(file: string, text: string): void {
  writeFileSync(file, text);
}

export function proj(policy: Policy, name: string): Project {
  const p = policy.projects[name];
  if (!p) throw new Error(`no project ${name}`);
  return p;
}

/**
 * Put fake executables on PATH for one test: `run()` always spawns real processes (there is no
 * mocking in this suite), so a command like `docker-compose` is stubbed by writing a small shell
 * script and prepending its directory to `process.env.PATH`. Call the returned `restore()` in
 * `afterEach` to put the real PATH back. `inherit: false` uses only the stub directory, so a
 * real binary elsewhere on PATH cannot leak into the test.
 */
export function stubPath(
  scripts: Record<string, string>,
  opts: { inherit?: boolean } = {},
): { dir: string; restore: () => void } {
  const dir = tempDir('berth-stub-bin-');
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  const prevPath = process.env.PATH;
  process.env.PATH = opts.inherit === false ? dir : `${dir}:${prevPath ?? ''}`;
  return {
    dir,
    restore: () => {
      process.env.PATH = prevPath;
    },
  };
}
