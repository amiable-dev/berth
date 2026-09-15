import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { isDestructive, main } from '../src/cli.js';
import {
  addProject,
  appendProjectTable,
  cmdInit,
  cmdProject,
  nextFreeP,
  renderInitPolicy,
} from '../src/commands/project.js';
import { parsePolicy } from '../src/policy.js';
import { fixturePolicy, tempDir, useTempState, writePolicy } from './helpers.js';

void execFileSync;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

describe('berth init', () => {
  let policyFile = '';
  beforeEach(() => {
    policyFile = useTempState().config + '/policy.toml';
    process.env.BERTH_POLICY = policyFile;
  });

  it('renders a generic policy with no projects that parses with the defaults', () => {
    const text = renderInitPolicy({});
    const p = parsePolicy(text);
    expect(Object.keys(p.projects)).toEqual([]);
    expect(p.scheme.base).toBe(10000);
    expect(p.pools.dynamic).toEqual([40000, 41999]);
    expect(p.reserved.ports).toContain(5000);
    expect(p.reserved.ignoreProcesses).toContain('Code Helper (Plugin)');
    expect(text).not.toMatch(/amiable|skills-telemetry/); // nothing machine-specific
  });

  it('creates the policy once and refuses to overwrite it', async () => {
    const c = capture();
    expect(await cmdInit(parseArgs(['init']), c.io)).toBe(0);
    expect(existsSync(policyFile)).toBe(true);
    const again = capture();
    expect(await cmdInit(parseArgs(['init']), again.io)).toBe(1);
    expect(again.err.join(' ')).toMatch(/already exists/);
  });
});

describe('project add', () => {
  let policyFile = '';
  let root = '';
  beforeEach(() => {
    const t = useTempState();
    root = t.root;
    policyFile = path.join(t.config, 'policy.toml');
    process.env.BERTH_POLICY = policyFile;
    writePolicy(policyFile, fixturePolicy(root).text); // P 1, 3, 4 used
  });

  it('appends a table without touching the rest of the file', () => {
    const before = readFileSync(policyFile, 'utf8');
    const after = appendProjectTable(before, {
      name: 'gamma',
      P: 2,
      path: '/tmp/gamma',
      declared: [3000],
      extras: { grafana: 10 },
    });
    expect(after.startsWith(before)).toBe(true);
    const p = parsePolicy(after);
    expect(p.projects.gamma).toMatchObject({ P: 2, declared: [3000], extras: { grafana: 10 } });
  });

  it('picks the lowest free P and reports exhaustion', () => {
    const p = parsePolicy(readFileSync(policyFile, 'utf8'));
    expect(nextFreeP(p)).toBe(0);
    const full = parsePolicy(
      '[scheme]\nproject_max = 1\n[projects.a]\nP = 0\npath = "/a"\n[projects.b]\nP = 1\npath = "/b"\n',
    );
    expect(nextFreeP(full)).toBeUndefined();
  });

  it('registers a repo, scans its ports, names compose extras, and is idempotent', async () => {
    const repo = path.join(root, 'newrepo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    writeFileSync(path.join(repo, 'vite.config.ts'), 'export default { server: { port: 5173 } }\n');
    writeFileSync(
      path.join(repo, 'docker-compose.yml'),
      'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"\n  grafana:\n    image: grafana/grafana\n    ports:\n      - "3000:3000"\n',
    );
    const first = await addProject(policyFile, { path: repo });
    expect(first).toMatchObject({ name: 'newrepo', P: 0, created: true });
    expect(first.declared).toEqual([3000, 5173, 5432]);
    expect(first.extras).toEqual({ grafana: 10 }); // db is a canonical role; grafana is not
    const p = parsePolicy(readFileSync(policyFile, 'utf8'));
    expect(p.projects.newrepo?.P).toBe(0);
    expect(p.projects.alpha?.P).toBe(3); // untouched
    const second = await addProject(policyFile, { path: repo });
    expect(second).toMatchObject({ name: 'newrepo', P: 0, created: false });
    expect(existsSync(`${policyFile}.bak`)).toBe(true);
  });

  it('honours an explicit free P, refuses a taken one, and refuses a name that points elsewhere', async () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    mkdirSync(path.join(a, '.git'), { recursive: true });
    mkdirSync(path.join(b, '.git'), { recursive: true });
    expect((await addProject(policyFile, { path: a, P: 7, scan: false })).P).toBe(7);
    await expect(addProject(policyFile, { path: b, P: 3, scan: false })).rejects.toThrow(
      /already used/,
    );
    await expect(addProject(policyFile, { path: b, name: 'a', scan: false })).rejects.toThrow(
      /different path/,
    );
    await expect(
      addProject(policyFile, { path: path.join(root, 'missing'), scan: false }),
    ).rejects.toThrow(/does not exist/);
  });

  it('requires a git root unless told otherwise, and serialises concurrent adds on one lock', async () => {
    const plain = path.join(root, 'plain');
    mkdirSync(plain);
    await expect(addProject(policyFile, { path: plain, scan: false })).rejects.toThrow(
      /git repository root/,
    );
    expect(
      (await addProject(policyFile, { path: plain, scan: false, allowNonGit: true })).created,
    ).toBe(true);
    const repos = ['r1', 'r2', 'r3', 'r4'].map((n) => {
      const d = path.join(root, n);
      mkdirSync(path.join(d, '.git'), { recursive: true });
      return d;
    });
    const results = await Promise.all(
      repos.map((d) => addProject(policyFile, { path: d, scan: false })),
    );
    const numbers = results.map((r) => r.P);
    expect(new Set(numbers).size).toBe(4); // no duplicate permanent numbers under concurrency
    const p = parsePolicy(readFileSync(policyFile, 'utf8'));
    expect(Object.keys(p.projects).length).toBe(3 + 1 + 4);
    expect(existsSync(`${policyFile}.lock`)).toBe(false);
  });

  it('cmdProject add and list work through the CLI surface', async () => {
    const repo = path.join(root, 'cli-repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    const c = capture();
    expect(await cmdProject(parseArgs(['project', 'add', repo, '--json']), c.io)).toBe(0);
    expect(JSON.parse(c.out.join(''))).toMatchObject({ name: 'cli-repo', created: true });
    const l = capture();
    expect(await cmdProject(parseArgs(['project', 'list', '--json']), l.io)).toBe(0);
    expect(JSON.parse(l.out.join('')).map((p: { name: string }) => p.name)).toContain('cli-repo');
  });
});

describe('agent guard', () => {
  const saved = {
    CLAUDECODE: process.env.CLAUDECODE,
    BERTH_ALLOW_DESTRUCTIVE: process.env.BERTH_ALLOW_DESTRUCTIVE,
  };
  beforeEach(() => {
    useTempState();
    process.env.CLAUDECODE = '1';
    delete process.env.BERTH_ALLOW_DESTRUCTIVE;
    return () => {
      if (saved.CLAUDECODE === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = saved.CLAUDECODE;
      if (saved.BERTH_ALLOW_DESTRUCTIVE === undefined) delete process.env.BERTH_ALLOW_DESTRUCTIVE;
      else process.env.BERTH_ALLOW_DESTRUCTIVE = saved.BERTH_ALLOW_DESTRUCTIVE;
    };
  });

  it('refuses destructive commands inside an agent session unless explicitly allowed', async () => {
    const settings = path.join(tempDir(), 'settings.json');
    for (const argv of [
      ['free', '1234'],
      ['hooks', 'install', '--settings', settings],
      ['worktrees', 'prune', '--project', 'x', '--w', '1'],
      ['release', '--port', '1234', '--force'],
      ['init', '--force'],
      ['tidy'],
    ]) {
      const c = capture();
      expect(await main(argv, c.io), argv.join(' ')).toBe(1);
      expect(c.err.join(' ')).toMatch(/human-only command/);
    }
    expect(existsSync(settings)).toBe(false);
    // unsetting the marker does not help: a test process has no interactive terminal either
    const savedSid = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const noTty = capture();
    expect(await main(['free', '1234'], noTty.io)).toBe(1);
    expect(noTty.err.join(' ')).toMatch(/non-interactive shell/);
    process.env.CLAUDECODE = '1';
    if (savedSid !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedSid;
    process.env.BERTH_ALLOW_DESTRUCTIVE = '1';
    const ok = capture();
    expect(await main(['hooks', 'install', '--settings', settings], ok.io)).toBe(0);
    expect(existsSync(settings)).toBe(true);
    const audit = readFileSync(
      path.join(process.env.BERTH_STATE_DIR as string, 'audit.log'),
      'utf8',
    );
    expect(audit).toMatch(/refused argv=.*free/);
    expect(audit).toMatch(/allowed argv=.*hooks.*override=true/);
  });

  it('leaves read and self-scoped commands alone', async () => {
    const c = capture();
    expect(await main(['version'], c.io)).toBe(0);
    expect(c.out[0]).toMatch(/\d/);
  });

  it('isDestructive treats bare "tidy" as human-only but "tidy --dry-run" as agent-available', () => {
    expect(isDestructive(parseArgs(['tidy']))).toBe(true);
    expect(isDestructive(parseArgs(['tidy', '--project', 'x']))).toBe(true);
    expect(isDestructive(parseArgs(['tidy', '--dry-run']))).toBe(false);
    expect(isDestructive(parseArgs(['tidy', '--dry-run', '--json']))).toBe(false);
  });

  it('"tidy --dry-run" is refused nowhere: it runs even inside an agent session', async () => {
    const policyFile = process.env.BERTH_POLICY as string;
    writeFileSync(policyFile, fixturePolicy(tempDir()).text);
    const c = capture();
    expect(await main(['tidy', '--dry-run', '--json'], c.io)).toBe(0);
    expect(JSON.parse(c.out.join(''))).toMatchObject({ dryRun: true });
  });

  it('the human-only refusal explains why and names the tidy apply path', async () => {
    const tidy = capture();
    expect(await main(['tidy'], tidy.io)).toBe(1);
    expect(tidy.err.join(' ')).toMatch(/human-only command/);
    expect(tidy.err.join(' ')).toMatch(/without --dry-run releases leases/);
    expect(tidy.err.join(' ')).toMatch(/berth tidy --project <name>/);

    const adopt = capture();
    expect(await main(['adopt', '1234', '--owner', 'human'], adopt.io)).toBe(1);
    expect(adopt.err.join(' ')).toMatch(/human-only command/);
    expect(adopt.err.join(' ')).toMatch(/attributes a port to a person/);
    expect(adopt.err.join(' ')).toMatch(/berth tidy --project <name>/);
  });
});
