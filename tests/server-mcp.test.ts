import { describe, expect, it } from 'vitest';
import { handleMessage } from '../src/mcp.js';
import type { CheckReport } from '../src/types.js';
import { startUi } from '../src/ui/server.js';

const report: CheckReport = {
  version: 't',
  generatedAt: new Date().toISOString(),
  cacheAgeMs: 0,
  host: { platform: 'darwin', user: 'u', dockerAvailable: false, colima: false },
  policy: {
    scheme: { base: 10000, projectMax: 29, worktreeMax: 9, roles: { web: 0 } },
    pools: { dynamic: [40000, 41999], ttlHours: 8 },
    reserved: { ranges: [], ports: [], lint: [] },
    shared: {},
    projects: [],
  },
  ports: [],
  sessions: [],
  summary: {
    ports: 0,
    attention: 0,
    liveSessions: 0,
    byState: {
      ok: 0,
      idle: 0,
      stale: 0,
      orphan: 0,
      unmanaged: 0,
      squatter: 0,
      conflict: 0,
      drift: 0,
    },
  },
};

describe('ui server', () => {
  it('serves the page with a nonce CSP, JSON state, and refuses the rest', async () => {
    const ui = await startUi({ port: 0, reportFn: async () => report });
    try {
      const page = await fetch(ui.url);
      expect(page.status).toBe(200);
      const csp = page.headers.get('content-security-policy') ?? '';
      expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      const state = await fetch(`${ui.url}api/state`);
      expect(state.status).toBe(200);
      expect(((await state.json()) as CheckReport).summary.ports).toBe(0);
      expect((await fetch(`${ui.url}nope`)).status).toBe(404);
      expect((await fetch(`${ui.url}api/state`, { method: 'POST' })).status).toBe(405);
      const cross = await fetch(`${ui.url}api/state`, {
        headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
      });
      expect(cross.status).toBe(403);
      expect((await fetch(`${ui.url}healthz`)).status).toBe(200);
    } finally {
      await ui.close();
    }
  });
});

describe('mcp', () => {
  it('handles initialize, tools/list and validates tool input', async () => {
    const init = await handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(init).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'berth' } },
    });
    const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (list as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name,
    );
    expect(tools).toEqual([
      'berth_check',
      'berth_who',
      'berth_ls',
      'berth_claim',
      'berth_release',
      'berth_env',
    ]);
    const bad = await handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'berth_who', arguments: { port: 'x' } },
    });
    expect(bad).toMatchObject({ id: 3, result: { isError: true } });
    expect(
      await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeUndefined();
    expect(await handleMessage({ jsonrpc: '2.0', id: 4, method: 'nope' })).toMatchObject({
      error: { code: -32601 },
    });
  });
});
