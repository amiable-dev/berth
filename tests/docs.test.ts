import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

/**
 * The port rule is taught by example, and a one-digit P makes the digits line up so neatly
 * (1 | 3 | 2 | 04) that a reader takes the alignment for the rule. It stops holding at P=10, where
 * the thousands carry into the leading digit: 31010 is project 21, not project 1. Every place that
 * explains the rule has to show that case too.
 */
const EXPLAINERS = [
  'README.md',
  'docs/index.md',
  'docs/guide/concepts.md',
  'docs/guide/claude-code.md',
  'examples/CLAUDE.ports.md',
  'docs/images/port-rule.html',
];

describe('the port rule is explained for two-digit project numbers', () => {
  for (const file of EXPLAINERS) {
    it(`${file} works a P >= 10 example`, () => {
      const text = read(file);
      expect(text, `${file} should name a two-digit-P port`).toContain('31010');
    });
  }

  it('describes both panels of the infographic in its alt text', () => {
    // The image gained a second panel; alt text that stops at 13204 no longer describes it.
    for (const alt of read('docs/index.md').match(/alt="Port 13204[^"]*"/g) ?? []) {
      expect(alt).toContain('31010');
    }
    expect(read('README.md')).toMatch(/alt="Port 13204[^"]*31010/);
  });

  it('shows subtracting the base, which is what makes the two-digit case readable', () => {
    for (const file of ['docs/guide/concepts.md', 'docs/images/port-rule.html']) {
      expect(read(file), file).toMatch(/− ?10000|- ?10000|subtract/i);
    }
  });
});
