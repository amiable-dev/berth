import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(path.resolve(__dirname, '..', 'ui', 'index.html'), 'utf8');
const css = readFileSync(path.resolve(__dirname, '..', 'ui', 'styles.css'), 'utf8');

/**
 * The dashboard client is a plain browser module with no imports and no build step; it guards
 * its own bootstrap so that importing it here, under vitest's `node` environment, only defines
 * its functions. It has no type declarations, hence the suppression.
 */
// @ts-expect-error - untyped browser module, checked by `// @ts-check` in place
const app = () => import('../ui/app.js');

describe('dashboard header links', () => {
  it('links to the docs site and the repository, safely, left of the search box', () => {
    const links = html.indexOf('class="links"');
    const search = html.indexOf('id="search"');
    expect(links).toBeGreaterThan(-1);
    expect(links).toBeLessThan(search);
    for (const href of [
      'https://amiable-dev.github.io/berth/',
      'https://github.com/amiable-dev/berth',
    ]) {
      const i = html.indexOf(`href="${href}"`);
      expect(i, href).toBeGreaterThan(-1);
      const tag = html.slice(i, html.indexOf('>', i));
      expect(tag).toContain('target="_blank"');
      expect(tag).toContain('rel="noopener noreferrer"');
      expect(tag).toMatch(/aria-label="/);
    }
  });
});

// A cell prints the part of its port that its position does not already imply: a role cell
// nothing (base + W + cell index), an extra its two-digit slot (position gives ordering only,
// because renderMap sorts extras by slot), a legacy cell the whole port (no P/W/R at all).
describe('map cell labels', () => {
  it('labels a legacy cell with its full port', async () => {
    const { cellLabel } = await app();
    expect(cellLabel(5432, { legacy: true })).toBe('5432');
    expect(cellLabel(8025, { legacy: true })).toBe('8025');
  });

  it('labels an extra cell with its two-digit slot', async () => {
    const { cellLabel } = await app();
    expect(cellLabel(31010, { extra: true })).toBe('10');
    expect(cellLabel(13042, { extra: true })).toBe('42');
    expect(cellLabel(13199, { extra: true })).toBe('99');
  });

  it('leaves a role cell unlabelled, because base plus worktree plus index gives its port', async () => {
    const { cellLabel } = await app();
    expect(cellLabel(12002, {})).toBeNull();
    expect(cellLabel(10000, {})).toBeNull();
    expect(cellLabel(31009, { tick: true })).toBeNull();
  });
});

describe('map cell label styling', () => {
  it('carries the label typography and the hatched-state colour on the shared .cell.num', () => {
    const num = css.slice(css.indexOf('.cell.num {'), css.indexOf('.cell.has {'));
    expect(num).toContain('font-size: 9px');
    expect(num).toContain('color: var(--bg)');
    // an unoccupied extra still names its slot, but quietly
    expect(num).toContain('.cell.num:not(.has)');
    for (const state of ['stale', 'overstay', 'orphan', 'squatter', 'conflict']) {
      expect(num, state).toContain(`.cell.num.s-${state}`);
    }
    expect(css).not.toContain('.cell.lg.s-');
  });

  it("gives an extra a role cell's width, enough for two digits", () => {
    expect(css.slice(css.indexOf('.cell.x {'))).toMatch(/^\.cell\.x \{\s*width: 22px;/);
  });
});

describe('version label', () => {
  it('names the running berth next to the bound port', async () => {
    const { boundLabel } = await app();
    expect(boundLabel('10000', '0.1.10')).toBe('ui :10000 · v0.1.10');
  });

  it('shows the port alone until a report has arrived', async () => {
    const { boundLabel } = await app();
    expect(boundLabel('10000', undefined)).toBe('ui :10000');
  });
});
