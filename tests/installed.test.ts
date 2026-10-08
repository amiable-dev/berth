import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, newerInstalled } from '../src/ui/installed.js';
import { tempDir } from './helpers.js';

function install(root: string, version: string, name = '@amiable-dev/berth'): string {
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version }));
  const bundle = path.join(root, 'dist', 'berth.js');
  writeFileSync(bundle, '');
  return bundle;
}

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBeLessThan(0);
  });
});

describe('newerInstalled', () => {
  it('npm global install replaced in place: the package.json beside the bundle is newer', () => {
    const bundle = install(path.join(tempDir(), 'node_modules', '@amiable-dev', 'berth'), '0.1.11');
    expect(newerInstalled('0.1.10', bundle)).toBe('0.1.11');
  });

  it('plugin cache: a newer sibling version directory', () => {
    const cache = path.join(tempDir(), 'cache', 'berth', 'berth');
    const bundle = install(path.join(cache, '0.1.9'), '0.1.9');
    install(path.join(cache, '0.1.10'), '0.1.10');
    install(path.join(cache, '0.1.8'), '0.1.8');
    expect(newerInstalled('0.1.9', bundle)).toBe('0.1.10');
  });

  it('nothing newer: same version, an older sibling, or a directory that is not berth', () => {
    const cache = path.join(tempDir(), 'cache', 'berth', 'berth');
    const bundle = install(path.join(cache, '0.1.10'), '0.1.10');
    install(path.join(cache, '0.1.9'), '0.1.9');
    install(path.join(cache, '0.2.0'), '0.2.0', 'someone-else');
    expect(newerInstalled('0.1.10', bundle)).toBeUndefined();
  });

  it('only scans siblings in a versioned-directory layout', () => {
    const parent = tempDir();
    const bundle = install(path.join(parent, 'berth'), '0.1.10');
    install(path.join(parent, '0.9.0'), '0.9.0');
    expect(newerInstalled('0.1.10', bundle)).toBeUndefined();
  });

  it('is undefined, never throws, when there is no package.json', () => {
    expect(newerInstalled('0.1.10', path.join(tempDir(), 'dist', 'berth.js'))).toBeUndefined();
  });
});
