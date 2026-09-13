import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { cmdContext, cmdSessionEnd } from '../src/commands/hooks.js';
import { readSession } from '../src/ledger.js';
import { fixturePolicy, useTempState, writePolicy } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

describe('hooks', () => {
  let state = '';
  let alpha = '';
  beforeEach(() => {
    const t = useTempState();
    state = t.state;
    const fx = fixturePolicy(t.root);
    writePolicy(process.env.BERTH_POLICY as string, fx.text);
    alpha = fx.paths.alpha;
  });

  it('context injects the block and exports, exits 0, and writes only its session file', async () => {
    const c = capture();
    const wt = path.join(alpha, '.claude', 'worktrees', 'feature-z');
    const code = await cmdContext(
      parseArgs(['context', '--session', 'sess-hook-1', '--cwd', wt, '--hook']),
      c.io,
    );
    expect(code).toBe(0);
    const payload = JSON.parse(c.out.join('')) as {
      hookSpecificOutput: { additionalContext: string };
    };
    const text = payload.hookSpecificOutput.additionalContext;
    expect(text).toContain('## Ports (berth)');
    expect(text).toContain('no W slot yet');
    // read-only against allocation state: no ledger, no claims, no worktree slot assigned
    expect(existsSync(path.join(state, 'leases.json'))).toBe(false);
    expect(existsSync(path.join(state, 'claims'))).toBe(false);
    expect(existsSync(path.join(state, 'worktrees'))).toBe(false);
    expect(readdirSync(path.join(state, 'sessions'))).toEqual(['sess-hook-1.json']);
    expect(readSession('sess-hook-1')?.project).toBe('alpha');
  });

  it('context for the main checkout lists the role ports', async () => {
    const c = capture();
    await cmdContext(parseArgs(['context', '--session', 'sess-hook-2', '--cwd', alpha]), c.io);
    const text = (
      JSON.parse(c.out.join('')) as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext;
    expect(text).toContain('owns 13000–13999');
    expect(text).toContain('api 13001');
    expect(text).toContain('gateway 13010');
  });

  it('session-end records the end and never touches the ledger', async () => {
    const c = capture();
    await cmdContext(parseArgs(['context', '--session', 'sess-hook-3', '--cwd', alpha]), c.io);
    expect(await cmdSessionEnd(parseArgs(['session-end', '--session', 'sess-hook-3']), c.io)).toBe(
      0,
    );
    expect(readSession('sess-hook-3')?.ended).toBeTruthy();
    expect(existsSync(path.join(state, 'leases.json'))).toBe(false);
  });
});
