import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { cmdEnv } from '../src/commands/allocate.js';
import { cmdShellInit } from '../src/commands/shell.js';
import { fixturePolicy, tempDir, useTempState, writePolicy } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

function hasShell(shell: string): boolean {
  try {
    execFileSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('env --shell outside a registered project', () => {
  let outside = '';
  beforeEach(() => {
    const t = useTempState();
    const fx = fixturePolicy(t.root);
    writePolicy(process.env.BERTH_POLICY as string, fx.text);
    outside = tempDir('berth-outside-');
  });

  it('exits 0, prints only the shared exports and a comment, and writes nothing to stderr', async () => {
    const c = capture();
    const code = await cmdEnv(parseArgs(['env', '--shell', '--cwd', outside]), c.io);
    expect(code).toBe(0);
    expect(c.err).toEqual([]);
    const text = c.out.join('\n');
    expect(text).toContain('export BERTH_SHARED_OBSERVABILITY_GRAFANA=3000');
    expect(text).toContain('export BERTH_SHARED_OBSERVABILITY_PROMETHEUS=9090');
    expect(text).toContain(
      `# berth: ${outside} is not inside a registered project (berth project add .)`,
    );
    expect(text).not.toMatch(/\bPORT=/);
    expect(text).not.toMatch(/BERTH_PROJECT/);
  });

  it('the default (no --strict) is exactly as quiet with no shared services declared', async () => {
    // A minimal policy with no [shared.*] tables at all: the quiet path must still exit 0 and
    // print only the comment line, never a blank line for the (empty) exports.
    const bare =
      '[scheme]\nbase = 10000\n[pools]\ndynamic = "40000-41999"\nttl_hours = 8\n[reserved]\n';
    writePolicy(process.env.BERTH_POLICY as string, bare);
    const c = capture();
    const code = await cmdEnv(parseArgs(['env', '--shell', '--cwd', outside]), c.io);
    expect(code).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out).toEqual([
      `# berth: ${outside} is not inside a registered project (berth project add .)`,
    ]);
  });

  it('--strict restores the loud failure', async () => {
    const c = capture();
    const code = await cmdEnv(parseArgs(['env', '--shell', '--strict', '--cwd', outside]), c.io);
    expect(code).toBe(1);
    expect(c.out).toEqual([]);
    expect(c.err.join(' ')).toMatch(/is not inside any project/);
  });

  it('--dotenv keeps failing loudly', async () => {
    const c = capture();
    const code = await cmdEnv(parseArgs(['env', '--dotenv', '--cwd', outside]), c.io);
    expect(code).toBe(1);
    expect(c.err.join(' ')).toMatch(/is not inside any project/);
  });

  it('--compose-override keeps failing loudly', async () => {
    const c = capture();
    const code = await cmdEnv(parseArgs(['env', '--compose-override', '--cwd', outside]), c.io);
    expect(code).toBe(1);
    expect(c.err.join(' ')).toMatch(/is not inside any project/);
  });

  it('--json keeps failing loudly', async () => {
    const c = capture();
    const code = await cmdEnv(parseArgs(['env', '--json', '--cwd', outside]), c.io);
    expect(code).toBe(1);
    expect(c.err.join(' ')).toMatch(/is not inside any project/);
  });

  it('an explicit --project that is unknown is still a loud error, quiet default or not', async () => {
    const c = capture();
    const code = await cmdEnv(
      parseArgs(['env', '--shell', '--cwd', outside, '--project', 'ghost']),
      c.io,
    );
    expect(code).toBe(1);
    expect(c.err.join(' ')).toMatch(/unknown project ghost/);
  });

  it('--unset outside a project unsets only the shared exports, and nothing else', async () => {
    const c = capture();
    const code = await cmdEnv(parseArgs(['env', '--shell', '--unset', '--cwd', outside]), c.io);
    expect(code).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out.join('\n').split('\n').sort()).toEqual(
      [
        'unset BERTH_SHARED_OBSERVABILITY_GRAFANA',
        'unset BERTH_SHARED_OBSERVABILITY_PROMETHEUS',
      ].sort(),
    );
  });
});

describe('env --shell --unset inside a registered project', () => {
  let alpha = '';
  beforeEach(() => {
    const t = useTempState();
    const fx = fixturePolicy(t.root);
    writePolicy(process.env.BERTH_POLICY as string, fx.text);
    alpha = fx.paths.alpha;
  });

  it('unsets exactly the variable names --shell would export, and nothing else', async () => {
    const shellC = capture();
    expect(await cmdEnv(parseArgs(['env', '--shell', '--cwd', alpha]), shellC.io)).toBe(0);
    const exported = shellC.out
      .join('\n')
      .split('\n')
      .map((l) => l.match(/^export (\w+)=/)?.[1])
      .filter((x): x is string => Boolean(x));
    expect(exported).toContain('PORT');
    expect(exported).toContain('BERTH_PROJECT');

    const unsetC = capture();
    const code = await cmdEnv(parseArgs(['env', '--shell', '--unset', '--cwd', alpha]), unsetC.io);
    expect(code).toBe(0);
    expect(unsetC.err).toEqual([]);
    const unset = unsetC.out
      .join('\n')
      .split('\n')
      .map((l) => l.match(/^unset (\w+)$/)?.[1])
      .filter((x): x is string => Boolean(x));
    expect(unset.sort()).toEqual(exported.sort());
  });
});

describe('shell-init', () => {
  it('refuses an unknown shell with exit 2 and a one-line message', async () => {
    const c = capture();
    const code = await cmdShellInit(parseArgs(['shell-init', 'powershell']), c.io);
    expect(code).toBe(2);
    expect(c.out).toEqual([]);
    expect(c.err.length).toBe(1);
    expect(c.err[0]).toMatch(/unknown shell/);
  });

  it('refuses with no shell named', async () => {
    const c = capture();
    expect(await cmdShellInit(parseArgs(['shell-init']), c.io)).toBe(2);
  });

  it('prints a zsh snippet with a chpwd hook that calls berth env --shell and --unset', async () => {
    const c = capture();
    expect(await cmdShellInit(parseArgs(['shell-init', 'zsh']), c.io)).toBe(0);
    const text = c.out.join('\n');
    expect(text).toContain('chpwd_functions');
    expect(text).toContain('berth env --shell --cwd');
    expect(text).toContain('berth env --shell --unset --cwd');
  });

  it('prints a bash snippet with a PROMPT_COMMAND hook', async () => {
    const c = capture();
    expect(await cmdShellInit(parseArgs(['shell-init', 'bash']), c.io)).toBe(0);
    const text = c.out.join('\n');
    expect(text).toContain('PROMPT_COMMAND');
    expect(text).toContain('berth env --shell --cwd');
  });

  it('prints a fish snippet with an --on-variable PWD hook', async () => {
    const c = capture();
    expect(await cmdShellInit(parseArgs(['shell-init', 'fish']), c.io)).toBe(0);
    const text = c.out.join('\n');
    expect(text).toContain('--on-variable PWD');
    expect(text).toContain('berth env --shell --cwd');
  });
});

describe.skipIf(!hasShell('zsh'))('zsh shell-init snippet (requires zsh on PATH)', () => {
  it('passes zsh -n', async () => {
    const c = capture();
    await cmdShellInit(parseArgs(['shell-init', 'zsh']), c.io);
    const dir = tempDir('berth-zsh-syntax-');
    const file = path.join(dir, 'init.zsh');
    writeFileSync(file, c.out.join('\n'));
    expect(() => execFileSync('zsh', ['-n', file], { stdio: 'pipe' })).not.toThrow();
  });

  it('finds the project root when .git is a file, not a directory (a real git worktree)', async () => {
    // A git worktree's `.git` is a plain file containing a `gitdir:` pointer, not a directory —
    // this is the actual shape wherever this snippet runs inside a checked-out worktree (this
    // repository's own .claude/worktrees/* included). The ancestor walk must use `-e`, not `-d`.
    const base = tempDir('berth-zsh-gitfile-');
    const project = path.join(base, 'repo');
    const sub = path.join(project, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(project, '.git'), 'gitdir: /somewhere/else/.git/worktrees/x\n');

    const binDir = path.join(base, 'bin');
    mkdirSync(binDir, { recursive: true });
    const countFile = path.join(base, 'count');
    writeFileSync(countFile, '');
    const shim = `#!/usr/bin/env bash
echo x >> ${JSON.stringify(countFile)}
if [[ "$1" == "env" && "$2" == "--shell" ]]; then
  echo "export BERTH_PROJECT=repo"
fi
exit 0
`;
    writeFileSync(path.join(binDir, 'berth'), shim, { mode: 0o755 });

    const initC = capture();
    await cmdShellInit(parseArgs(['shell-init', 'zsh']), initC.io);
    const snippetFile = path.join(base, 'init.zsh');
    writeFileSync(snippetFile, initC.out.join('\n'));
    const driverFile = path.join(base, 'driver.zsh');
    writeFileSync(driverFile, ['source "$1"', 'cd "$2"', 'print "${BERTH_PROJECT-}"'].join('\n'));

    const stdout = execFileSync('zsh', ['-f', driverFile, snippetFile, sub], {
      cwd: base,
      env: { PATH: `${binDir}:/bin:/usr/bin` },
      encoding: 'utf8',
    });
    expect(stdout.trim()).toBe('repo');
    const invocations = readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length;
    expect(invocations).toBe(1);
  });

  it('follows cd: sets PORT/BERTH_PROJECT entering a project, runs berth once for two dirs in it, unsets leaving', async () => {
    const base = tempDir('berth-zsh-e2e-');
    const project = path.join(base, 'alpha');
    const sub1 = path.join(project, 'sub1');
    const sub2 = path.join(project, 'sub2');
    const outside = path.join(base, 'outside');
    mkdirSync(path.join(project, '.git'), { recursive: true });
    mkdirSync(sub1, { recursive: true });
    mkdirSync(sub2, { recursive: true });
    mkdirSync(outside, { recursive: true });

    // A counting `berth` shim first on PATH: real enough to answer `env --shell [--unset]
    // --cwd <dir>` for the fixture project, and it counts every invocation.
    const binDir = path.join(base, 'bin');
    mkdirSync(binDir, { recursive: true });
    const countFile = path.join(base, 'count');
    writeFileSync(countFile, '');
    const shim = `#!/usr/bin/env bash
echo x >> ${JSON.stringify(countFile)}
if [[ "$1" == "env" ]]; then
  shift
  unset_mode=0
  cwd=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --unset) unset_mode=1 ;;
      --cwd) cwd="$2"; shift ;;
    esac
    shift
  done
  if [[ "$cwd" == ${JSON.stringify(project)}* ]]; then
    if [[ "$unset_mode" == "1" ]]; then
      echo "unset PORT"
      echo "unset BERTH_PROJECT"
    else
      echo "export PORT=13100"
      echo "export BERTH_PROJECT=alpha"
    fi
  fi
fi
exit 0
`;
    const shimPath = path.join(binDir, 'berth');
    writeFileSync(shimPath, shim, { mode: 0o755 });

    const initC = capture();
    await cmdShellInit(parseArgs(['shell-init', 'zsh']), initC.io);
    const snippetFile = path.join(base, 'init.zsh');
    writeFileSync(snippetFile, initC.out.join('\n'));

    const driverFile = path.join(base, 'driver.zsh');
    writeFileSync(
      driverFile,
      [
        'source "$1"',
        'cd "$2"',
        'print "1:${PORT-}:${BERTH_PROJECT-}"',
        'cd "$3"',
        'print "2:${PORT-}:${BERTH_PROJECT-}"',
        'cd "$4"',
        'print "3:${PORT-}:${BERTH_PROJECT-}"',
      ].join('\n'),
    );

    const stdout = execFileSync('zsh', ['-f', driverFile, snippetFile, sub1, sub2, outside], {
      cwd: outside,
      env: { PATH: `${binDir}:/bin:/usr/bin` },
      encoding: 'utf8',
    });
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toBe('1:13100:alpha'); // entered the project: berth ran
    expect(lines[1]).toBe('2:13100:alpha'); // same project root: unchanged, no new run
    expect(lines[2]).toBe('3::'); // left the project: unset

    const invocations = readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length;
    expect(invocations).toBe(2); // entering once, leaving once — never for the sub1->sub2 move
  }, 20000);
});

describe.skipIf(!hasShell('bash'))('bash shell-init snippet (requires bash on PATH)', () => {
  it('passes bash -n', async () => {
    const c = capture();
    await cmdShellInit(parseArgs(['shell-init', 'bash']), c.io);
    const dir = tempDir('berth-bash-syntax-');
    const file = path.join(dir, 'init.bash');
    writeFileSync(file, c.out.join('\n'));
    expect(() => execFileSync('bash', ['-n', file], { stdio: 'pipe' })).not.toThrow();
  });
});
