import { describe, expect, it } from 'vitest';
import {
  blockRange,
  decodePort,
  inDynamicPool,
  isReserved,
  lintPolicy,
  PolicyError,
  parsePolicy,
  portFor,
  projectForPath,
  roleName,
  roleNumber,
  sharedFor,
  summarizePolicy,
  worktreeRange,
} from '../src/policy.js';
import { fixturePolicy, proj, tempDir } from './helpers.js';

describe('port scheme', () => {
  const { policy, paths } = fixturePolicy(tempDir());
  it('encodes 10000 + 1000P + 100W + R', () => {
    expect(portFor(policy, 3, 2, 4)).toBe(13204);
    expect(blockRange(policy, 3)).toEqual([13000, 13999]);
    expect(worktreeRange(policy, 3, 2)).toEqual([13200, 13299]);
  });
  it('decodes ports inside the block range and rejects others', () => {
    expect(decodePort(policy, 13204)).toEqual({ P: 3, W: 2, R: 4 });
    expect(decodePort(policy, 13099)).toEqual({ P: 3, W: 0, R: 99 });
    expect(decodePort(policy, 9999)).toBeNull();
    expect(decodePort(policy, 40000)).toBeNull();
  });
  it('knows roles, extras and reserved ranges', () => {
    const alpha = proj(policy, 'alpha');
    expect(roleNumber(policy, alpha, 'api')).toBe(1);
    expect(roleNumber(policy, alpha, 'gateway')).toBe(10);
    expect(roleNumber(policy, alpha, 'nope')).toBeUndefined();
    expect(roleName(policy, alpha, 11)).toBe('search');
    expect(roleName(policy, alpha, 42)).toBe('slot-42');
    expect(isReserved(policy, 5000).reserved).toBe(true);
    expect(isReserved(policy, 4500).reserved).toBe(true);
    expect(isReserved(policy, 13000).reserved).toBe(false);
    expect(inDynamicPool(policy, 40010)).toBe(true);
  });
  it('matches the longest project path prefix', () => {
    expect(projectForPath(policy, paths.alpha)?.name).toBe('alpha');
    expect(projectForPath(policy, `${paths.alpha}/src/deep`)?.name).toBe('alpha');
    expect(projectForPath(policy, '/nowhere')).toBeUndefined();
  });
  it('finds shared services and summarises', () => {
    expect(sharedFor(policy, 9090)).toEqual({
      name: 'observability',
      service: 'prometheus',
      owner: 'obs',
    });
    const s = summarizePolicy(policy);
    expect(s.projects.map((p) => p.P)).toEqual([1, 3, 4]);
    expect(s.projects[1]?.base).toBe(13000);
  });
  it('lints extras that land on well-known ports', () => {
    const p = parsePolicy(`
[reserved]
lint = [11211]
[projects.x]
P = 1
path = "/tmp/x"
extras = { memcache = 11 }
`);
    // 10000 + 1000*1 + 100*2 + 11 = 11211 at W2
    expect(lintPolicy(p).some((w) => w.includes('11211'))).toBe(true);
  });
});

describe('policy validation', () => {
  it('rejects duplicate P, bad extras, overlapping pools, unknown shared owners', () => {
    expect(() =>
      parsePolicy('[projects.a]\nP = 1\npath = "/a"\n[projects.b]\nP = 1\npath = "/b"\n'),
    ).toThrow(PolicyError);
    expect(() => parsePolicy('[projects.a]\nP = 1\npath = "/a"\nextras = { web = 12 }\n')).toThrow(
      /collides/,
    );
    expect(() => parsePolicy('[projects.a]\nP = 1\npath = "/a"\nextras = { x = 5 }\n')).toThrow(
      /between 10 and 99/,
    );
    expect(() => parsePolicy('[pools]\ndynamic = "12000-12999"\n')).toThrow(/overlaps/);
    expect(() => parsePolicy('[shared.o]\nowner = "ghost"\nports = { a = 1 }\n')).toThrow(
      /not a project/,
    );
    expect(() => parsePolicy('this is = not toml = at all')).toThrow(PolicyError);
  });
  it('applies defaults', () => {
    const p = parsePolicy('');
    expect(p.scheme.base).toBe(10000);
    expect(p.pools.dynamic).toEqual([40000, 41999]);
    expect(Object.keys(p.scheme.roles)).toContain('otlp-http');
    expect(p.names.provider).toBe('portless');
  });
});
