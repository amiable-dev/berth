import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PACKAGE = '@amiable-dev/berth';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Numeric semver order; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const [ca = '', pa] = a.split('-', 2);
  const [cb = '', pb] = b.split('-', 2);
  const na = ca.split('.').map(Number);
  const nb = cb.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}

function berthVersionAt(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    return pkg.name === PACKAGE && typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The newest berth installed where the running bundle came from, if it is newer than `running`.
 * Two layouts are covered: an npm install replaced in place (the package.json beside
 * `dist/berth.js` has moved on), and a versioned-directory cache such as the Claude Code plugin
 * cache, where each version gets a sibling directory named after it. Reads package.json files
 * only; never throws.
 */
export function newerInstalled(running: string, bundlePath: string): string | undefined {
  const root = path.dirname(path.dirname(bundlePath));
  const own = berthVersionAt(root);
  let best = own;
  if (own && path.basename(root) === own) {
    const parent = path.dirname(root);
    let siblings: string[] = [];
    try {
      siblings = readdirSync(parent);
    } catch {
      siblings = [];
    }
    for (const name of siblings) {
      if (!SEMVER.test(name)) continue;
      const v = berthVersionAt(path.join(parent, name));
      if (v === name && (best === undefined || compareVersions(v, best) > 0)) best = v;
    }
  }
  return best && compareVersions(best, running) > 0 ? best : undefined;
}
