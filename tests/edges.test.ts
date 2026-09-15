import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { aliasName, buildLaunchConfigs, cmdLaunchJson } from '../src/commands/edges.js';
import { fixturePolicy, tempDir, useTempState, writePolicy } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Create a real git repository at `dir` (not just a `.git` marker): our exclude logic shells
 *  out to `git`, so fixtures need a working repo, not the fake `.git` directory other tests use. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
}

describe('buildLaunchConfigs', () => {
  it('builds entries from package scripts with their allocated ports', () => {
    const { policy } = fixturePolicy(tempDir());
    const cfg = buildLaunchConfigs(policy, 'alpha', 0, { dev: 'vite', 'dev:api': 'node api' });
    expect(cfg.map((c) => c.port)).toEqual([13000, 13001]);
    expect(cfg[0]?.env?.PORT).toBe('13000');
  });

  it('omits cwd when no repo-root-relative path is given', () => {
    const { policy } = fixturePolicy(tempDir());
    const cfg = buildLaunchConfigs(policy, 'alpha', 0, { dev: 'vite' }, undefined);
    expect(cfg[0]?.cwd).toBeUndefined();
  });

  it('carries a repo-root-relative cwd through unchanged', () => {
    const { policy } = fixturePolicy(tempDir());
    const cfg = buildLaunchConfigs(policy, 'alpha', 0, { dev: 'vite' }, 'apps/web');
    expect(cfg[0]?.cwd).toBe('apps/web');
  });

  it('names aliases per project, role and worktree', () => {
    expect(aliasName('chancery', 'web')).toBe('chancery');
    expect(aliasName('chancery', 'api')).toBe('chancery-api');
    expect(aliasName('chancery', 'web', 'feat/x')).toBe('feat-x.chancery');
  });
});

describe('launch-json: cwd and git exclude', () => {
  let root = '';
  let repo = '';
  let policyFile = '';

  beforeEach(() => {
    const t = useTempState();
    root = t.root;
    policyFile = path.join(t.config, 'policy.toml');
    process.env.BERTH_POLICY = policyFile;
    repo = path.join(root, 'demo');
    initRepo(repo);
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }, null, 2),
    );
    writePolicy(
      policyFile,
      `
[scheme]
base = 10000
project_max = 29
worktree_max = 9

[pools]
dynamic = "40000-41999"
ttl_hours = 8

[projects.demo]
P = 5
path = "${repo}"
`,
    );
  });

  it('writes entries without cwd from the repository root, and excludes the file exactly once', async () => {
    const c1 = capture();
    const code1 = await cmdLaunchJson(parseArgs(['launch-json', '--write', '--cwd', repo]), c1.io);
    expect(code1).toBe(0);

    const launchFile = path.join(repo, '.claude', 'launch.json');
    const written = JSON.parse(readFileSync(launchFile, 'utf8'));
    expect(written.configurations.length).toBeGreaterThan(0);
    expect(written.configurations[0]?.cwd).toBeUndefined();

    const excludeFile = path.join(repo, '.git', 'info', 'exclude');
    expect(existsSync(excludeFile)).toBe(true);
    const excludeText = readFileSync(excludeFile, 'utf8');
    expect(excludeText).toContain('.claude/launch.json');
    expect(c1.out.join('\n')).toMatch(/exclude/i);

    // A second write must not duplicate the exclude line.
    const c2 = capture();
    const code2 = await cmdLaunchJson(parseArgs(['launch-json', '--write', '--cwd', repo]), c2.io);
    expect(code2).toBe(0);
    const lines = readFileSync(excludeFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '.claude/launch.json');
    expect(lines.length).toBe(1);

    // git itself must consider the file clean (excluded), not just our own bookkeeping.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(status).not.toMatch(/launch\.json/);
  });

  it('writes a repository-root-relative cwd when --cwd points at a subdirectory', async () => {
    const sub = path.join(repo, 'sub', 'dir');
    mkdirSync(sub, { recursive: true });
    const c = capture();
    const code = await cmdLaunchJson(parseArgs(['launch-json', '--write', '--cwd', sub]), c.io);
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(path.join(repo, '.claude', 'launch.json'), 'utf8'));
    expect(written.configurations[0]?.cwd).toBe('sub/dir');
  });

  it('preserves existing non-berth launch.json entries', async () => {
    mkdirSync(path.join(repo, '.claude'), { recursive: true });
    writeFileSync(
      path.join(repo, '.claude', 'launch.json'),
      JSON.stringify(
        {
          version: '0.0.1',
          configurations: [
            { name: 'custom entry', runtimeExecutable: 'node', runtimeArgs: ['server.js'] },
          ],
        },
        null,
        2,
      ),
    );
    const c = capture();
    const code = await cmdLaunchJson(parseArgs(['launch-json', '--write', '--cwd', repo]), c.io);
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(path.join(repo, '.claude', 'launch.json'), 'utf8'));
    expect(
      written.configurations.some((cfg: { name: string }) => cfg.name === 'custom entry'),
    ).toBe(true);
    expect(
      written.configurations.some((cfg: { name: string }) => /berth W\d\)$/.test(cfg.name)),
    ).toBe(true);
  });

  it('leaves the exclude file untouched when launch.json is already tracked', async () => {
    mkdirSync(path.join(repo, '.claude'), { recursive: true });
    writeFileSync(path.join(repo, '.claude', 'launch.json'), '{}\n');
    git(repo, ['add', '.claude/launch.json']);
    git(repo, ['commit', '-q', '-m', 'track launch.json']);

    const excludeFile = path.join(repo, '.git', 'info', 'exclude');
    const before = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    const c = capture();
    const code = await cmdLaunchJson(parseArgs(['launch-json', '--write', '--cwd', repo]), c.io);
    expect(code).toBe(0);
    const after = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    expect(after).toBe(before); // git already created an (empty-of-our-line) exclude file at init
    expect(after).not.toContain('.claude/launch.json');
    expect(c.out.join('\n')).not.toMatch(/exclude/i);
  });

  it('leaves the exclude file untouched when launch.json is already gitignored', async () => {
    writeFileSync(path.join(repo, '.gitignore'), '.claude/launch.json\n');
    const excludeFile = path.join(repo, '.git', 'info', 'exclude');
    const before = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    const c = capture();
    const code = await cmdLaunchJson(parseArgs(['launch-json', '--write', '--cwd', repo]), c.io);
    expect(code).toBe(0);
    const after = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    expect(after).toBe(before);
    expect(after).not.toContain('.claude/launch.json');
    expect(c.out.join('\n')).not.toMatch(/exclude/i);
  });

  it('--no-exclude opts out of the git exclude step', async () => {
    const excludeFile = path.join(repo, '.git', 'info', 'exclude');
    const before = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    const c = capture();
    const code = await cmdLaunchJson(
      parseArgs(['launch-json', '--write', '--cwd', repo, '--no-exclude']),
      c.io,
    );
    expect(code).toBe(0);
    const after = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    expect(after).toBe(before);
    expect(after).not.toContain('.claude/launch.json');
    expect(c.out.join('\n')).not.toMatch(/exclude/i);
  });

  it('skips the exclude step silently outside a git repository', async () => {
    const plain = path.join(root, 'plaindir');
    mkdirSync(plain, { recursive: true });
    writeFileSync(
      path.join(plain, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }, null, 2),
    );
    writePolicy(
      policyFile,
      `
[scheme]
base = 10000
project_max = 29
worktree_max = 9

[pools]
dynamic = "40000-41999"
ttl_hours = 8

[projects.demo]
P = 5
path = "${repo}"

[projects.plain]
P = 6
path = "${plain}"
`,
    );
    const c = capture();
    const code = await cmdLaunchJson(parseArgs(['launch-json', '--write', '--cwd', plain]), c.io);
    expect(code).toBe(0);
    expect(existsSync(path.join(plain, '.git'))).toBe(false);
    expect(c.out.join('\n')).not.toMatch(/exclude/i);
  });
});
