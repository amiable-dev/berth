import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (p: string) => JSON.parse(readFileSync(path.join(root, p), 'utf8'));

describe('claude code plugin packaging', () => {
  it('has a manifest whose version tracks package.json', () => {
    const manifest = read('.claude-plugin/plugin.json');
    const pkg = read('package.json');
    expect(manifest.name).toBe('berth');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.description).toMatch(/port/i);
  });

  it('ships SessionStart and SessionEnd hooks that call the bundled CLI and always exit 0', () => {
    const hooks = read('hooks/hooks.json');
    const events = hooks.hooks ?? hooks;
    for (const [event, sub] of [
      ['SessionStart', 'context'],
      ['SessionEnd', 'session-end'],
    ] as const) {
      const entries = events[event];
      expect(Array.isArray(entries), event).toBe(true);
      const cmds = entries.flatMap(
        (e: { hooks: { command: string; timeout?: number }[] }) => e.hooks,
      );
      expect(
        cmds.some(
          (h: { command: string }) =>
            h.command.includes('${CLAUDE_PLUGIN_ROOT}') && h.command.includes(`${sub} --hook`),
        ),
        event,
      ).toBe(true);
      for (const h of cmds) expect(h.timeout ?? 60).toBeLessThanOrEqual(10);
    }
  });

  it('registers the MCP server from the plugin root', () => {
    const mcp = read('.mcp.json');
    const berth = mcp.mcpServers?.berth;
    expect(berth).toBeTruthy();
    expect(JSON.stringify(berth)).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(berth.args?.at(-1)).toBe('mcp');
  });

  it('ships skills with frontmatter and no destructive instructions', () => {
    const skillsDir = path.join(root, 'skills');
    const names = readdirSync(skillsDir).filter((n) =>
      existsSync(path.join(skillsDir, n, 'SKILL.md')),
    );
    expect(names.sort()).toEqual(['berth-onboard', 'berth-ports']);
    for (const n of names) {
      const text = readFileSync(path.join(skillsDir, n, 'SKILL.md'), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
      expect(fm, n).toMatch(/^name: /m);
      expect(fm, n).toMatch(/^description: /m);
      expect(text, n).not.toMatch(/berth free|--force/);
      expect(text.length, n).toBeLessThan(12000);
    }
  });

  it('is its own marketplace', () => {
    const m = read('.claude-plugin/marketplace.json');
    expect(m.plugins.some((p: { name: string }) => p.name === 'berth')).toBe(true);
  });

  it('publishes the plugin files in the npm package', () => {
    const pkg = read('package.json');
    for (const f of ['dist', '.claude-plugin', 'hooks', 'skills', '.mcp.json'])
      expect(pkg.files, f).toContain(f);
  });
});
