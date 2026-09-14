import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(path.resolve(__dirname, '..', 'ui', 'index.html'), 'utf8');

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
