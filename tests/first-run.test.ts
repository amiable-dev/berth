import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdContext } from '../src/commands/hooks.js';
import { doctorChecks } from '../src/commands/query.js';
import { loadPolicy } from '../src/policy.js';
import { useTempState } from './helpers.js';

/**
 * First run from a bare `npm install -g`: there is no checkout, so nothing may point the user at a
 * file that only exists in the repository. `berth init` writes the policy and needs no files.
 */
describe('first run without a policy', () => {
  beforeEach(() => {
    useTempState();
  });

  it('tells loadPolicy callers to run berth init', () => {
    expect(() => loadPolicy()).toThrow(/berth init/);
    expect(() => loadPolicy()).not.toThrow(/examples\//);
  });

  it('names berth init in the doctor policy row', async () => {
    const rows = await doctorChecks();
    const policy = rows.find((r) => r.name === 'policy');
    expect(policy?.detail).toMatch(/berth init/);
    expect(policy?.detail).not.toMatch(/examples\//);
  });

  // Which branch this row takes depends on the host's own ~/.claude/CLAUDE.md, so the behavioural
  // assertion is the one that holds either way; the advice text itself is checked below.
  it('never cites a repository path in the claude rules row', async () => {
    const rows = await doctorChecks();
    const rules = rows.find((r) => r.name === 'claude rules');
    expect(rules).toBeDefined();
    expect(rules?.detail ?? '').not.toMatch(/examples\//);
  });

  it('names berth init in the SessionStart context text', async () => {
    const out: string[] = [];
    await cmdContext(
      { cmd: 'context', positional: [], flags: {} },
      { out: (s) => out.push(s), err: () => {} },
    );
    const text = out.join('\n');
    expect(text).toMatch(/berth init/);
    expect(text).not.toMatch(/examples\//);
  });
});

describe('runtime output never cites a repository path', () => {
  it('has no `examples/` reference anywhere under src/', () => {
    const root = path.resolve(__dirname, '..', 'src');
    const offenders = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('page.generated.ts'))
      .filter((f) => readFileSync(path.join(root, f), 'utf8').includes('examples/'));
    expect(offenders).toEqual([]);
  });

  it('sends a reader without a checkout to the docs site instead', () => {
    const query = readFileSync(
      path.resolve(__dirname, '..', 'src', 'commands', 'query.ts'),
      'utf8',
    );
    expect(query).toContain('https://amiable-dev.github.io/berth/guide/claude-code');
  });
});
