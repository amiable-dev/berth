import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../src/args.js';
import { envLines, envName, rolePorts } from '../src/commands/allocate.js';
import { aliasName, buildLaunchConfigs } from '../src/commands/edges.js';
import { isBerthHook, mergeHooks } from '../src/commands/hooks.js';
import { extractPorts, updateDeclared } from '../src/commands/scan.js';
import { composeServicesFromText, inferRole, renderOverride } from '../src/compose.js';
import { fixturePolicy, proj, tempDir } from './helpers.js';

describe('args', () => {
  it('parses commands, value flags, booleans and negations', () => {
    const a = parseArgs([
      'claim',
      '--role',
      'api',
      '--json',
      '--no-docker',
      '--note=hi there',
      '--dynamic',
      '2',
    ]);
    expect(a.cmd).toBe('claim');
    expect(a.flags).toEqual({
      role: 'api',
      json: true,
      docker: false,
      note: 'hi there',
      dynamic: '2',
    });
    expect(parseArgs(['who', '5432']).positional).toEqual(['5432']);
    expect(parseArgs([]).cmd).toBe('help');
    expect(() => parseArgs(['ls', '--port'])).toThrow(UsageError);
    expect(() => parseArgs(['ls', '-x'])).toThrow(UsageError);
  });
});

describe('compose', () => {
  const text = `
services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
  cache:
    image: redis:7
    ports: ["6380:6379"]
  web:
    build: .
    ports:
      - 3000:3000
      - "127.0.0.1:9229:9229"
`;
  it('parses services and published ports without a compose CLI', () => {
    const s = composeServicesFromText(text);
    expect(s.map((x) => x.name)).toEqual(['db', 'cache', 'web']);
    expect(s[0]?.ports).toEqual([{ host: 5432, container: 5432 }]);
    expect(s[1]?.ports).toEqual([{ host: 6380, container: 6379 }]);
    expect(s[2]?.ports).toEqual([
      { host: 3000, container: 3000 },
      { host: 9229, container: 9229 },
    ]);
  });
  it('infers roles and renders an !override file', () => {
    const { policy } = fixturePolicy(tempDir());
    const alpha = proj(policy, 'alpha');
    expect(inferRole(policy, alpha, { name: 'db', image: 'postgres:16', ports: [] }, 5432)).toBe(
      'db',
    );
    expect(inferRole(policy, alpha, { name: 'cache', image: 'redis:7', ports: [] }, 6379)).toBe(
      'cache',
    );
    expect(inferRole(policy, alpha, { name: 'gateway', ports: [] }, 8000)).toBe('gateway');
    expect(
      inferRole(policy, alpha, { name: 'mailpit', image: 'axllent/mailpit', ports: [] }, 1025),
    ).toBe('smtp');
    const out = renderOverride([{ service: 'db', host: 13002, container: 5432, role: 'db' }]);
    expect(out).toContain('ports: !override');
    expect(out).toContain('- "13002:5432"  # db');
  });
});

describe('scan', () => {
  it('extracts ports from compose, configs and env files', () => {
    expect(
      extractPorts('/x/docker-compose.yml', 'ports:\n  - "5432:5432"\n  - "3001:3000"').map(
        (h) => h.port,
      ),
    ).toEqual([5432, 3001]);
    expect(extractPorts('/x/vite.config.ts', 'server: { port: 5173 }').map((h) => h.port)).toEqual([
      5173,
    ]);
    expect(
      extractPorts('/x/package.json', '"dev": "eleventy --serve --port 3000"').map((h) => h.port),
    ).toEqual([3000]);
    expect(
      extractPorts('/x/.env', 'DATABASE_URL=postgres://u@localhost:5433/db\nPORT=3002')
        .map((h) => h.port)
        .sort(),
    ).toEqual([3002, 5433]);
  });
  it('rewrites declared lists in place without touching other tables', () => {
    const toml = `[projects.alpha]\nP = 3\npath = "~/a"\ndeclared = [3000]\n\n[projects.beta]\nP = 4\npath = "~/b"\n`;
    const out = updateDeclared(toml, 'beta', [5173, 8787]);
    expect(out).toContain('path = "~/b"\ndeclared = [5173, 8787]');
    expect(updateDeclared(toml, 'alpha', [3000, 5432])).toContain(
      'declared = [3000, 5432]\n\n[projects.beta]',
    );
    expect(() => updateDeclared(toml, 'ghost', [1])).toThrow(/not found/);
  });
});

describe('hooks', () => {
  it('installs and removes berth hooks idempotently, preserving others', () => {
    const base = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '/x/other' }] }],
        Stop: [{ hooks: [{ type: 'command', command: '/x/stop' }] }],
      },
      permissions: { allow: [] },
    };
    const once = mergeHooks(base, true);
    const twice = mergeHooks(once, true);
    expect(twice.hooks?.SessionStart?.length).toBe(2);
    expect(twice.hooks?.SessionEnd?.length).toBe(1);
    expect(isBerthHook(twice.hooks?.SessionStart?.[1]?.hooks[0]?.command ?? '')).toBe(true);
    expect(twice.hooks?.Stop).toEqual(base.hooks.Stop);
    const removed = mergeHooks(twice, false);
    expect(removed.hooks?.SessionStart).toEqual(base.hooks.SessionStart);
    expect(removed.hooks?.SessionEnd).toBeUndefined();
    expect(removed.permissions).toEqual({ allow: [] });
  });
});

describe('env, launch.json and names', () => {
  const { policy, paths } = fixturePolicy(tempDir());
  it('produces role ports and exports', () => {
    const ports = rolePorts(policy, proj(policy, 'alpha'), 1);
    expect(ports.find((p) => p.role === 'web')?.port).toBe(13100);
    expect(ports.find((p) => p.role === 'gateway')?.port).toBe(13110);
    expect(envName('otlp-grpc')).toBe('OTLP_GRPC_PORT');
    const lines = envLines(
      policy,
      { cwd: paths.alpha, project: proj(policy, 'alpha'), W: 0, via: 'path' },
      'shell',
    );
    expect(lines).toContain('export PORT=13000');
    expect(lines).toContain('export DB_PORT=13002');
    expect(lines).toContain('export BERTH_BLOCK=13000-13099');
    expect(lines).toContain('export BERTH_SHARED_OBSERVABILITY_GRAFANA=3000');
  });
  it('builds launch.json entries from package scripts', () => {
    const cfg = buildLaunchConfigs(
      policy,
      'alpha',
      0,
      { dev: 'vite', 'dev:api': 'node api' },
      paths.alpha,
    );
    expect(cfg.map((c) => c.port)).toEqual([13000, 13001]);
    expect(cfg[0]?.env?.PORT).toBe('13000');
  });
  it('names aliases per project, role and worktree', () => {
    expect(aliasName('chancery', 'web')).toBe('chancery');
    expect(aliasName('chancery', 'api')).toBe('chancery-api');
    expect(aliasName('chancery', 'web', 'feat/x')).toBe('feat-x.chancery');
  });
});
