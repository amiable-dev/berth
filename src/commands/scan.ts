import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { policyPath } from '../paths.js';
import { loadPolicy, type Policy, type Project, parsePolicy } from '../policy.js';
import { atomicWriteSync } from '../util.js';
import type { IO } from './query.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.venv',
  'venv',
  'target',
  '.turbo',
  'coverage',
  '.cache',
  'vendor',
  '.worktrees',
  'worktrees',
]);
const FILE_RE =
  /^(docker-compose.*\.ya?ml|compose.*\.ya?ml|package\.json|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|astro\.config\.[cm]?[jt]s|docusaurus\.config\.[cm]?[jt]s|wrangler\.toml|Procfile|\.env(\..+)?|mise\.toml|\.mise\.toml)$/;
const MAX_FILES = 400;

export interface ScanHit {
  file: string;
  port: number;
  how: string;
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 4 || out.length >= MAX_FILES) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name) && !name.startsWith('.claude')) walk(full, depth + 1, out);
    } else if (FILE_RE.test(name) && st.size < 512 * 1024) out.push(full);
  }
}

export function extractPorts(file: string, text: string): ScanHit[] {
  const hits: ScanHit[] = [];
  const seen = new Set<number>();
  const add = (port: number, how: string) => {
    if (port >= 1024 && port <= 65535 && !seen.has(port)) {
      seen.add(port);
      hits.push({ file, port, how });
    }
  };
  const base = path.basename(file);
  if (/compose|\.ya?ml$/.test(base)) {
    for (const m of text.matchAll(/["']?(?:[\d.]+:)?(\d{2,5}):(\d{2,5})(?:\/(?:tcp|udp))?["']?/g))
      add(Number(m[1]), 'compose ports');
    for (const m of text.matchAll(/published:\s*["']?(\d{2,5})/g))
      add(Number(m[1]), 'compose published');
    return hits;
  }
  for (const m of text.matchAll(/(?:--port|-p)[=\s]+["']?(\d{4,5})\b/g))
    add(Number(m[1]), '--port flag');
  for (const m of text.matchAll(/\bport\s*[:=]\s*["']?(\d{4,5})\b/gi))
    add(Number(m[1]), 'port setting');
  for (const m of text.matchAll(/\bPORT\s*=\s*["']?(\d{4,5})\b/g)) add(Number(m[1]), 'PORT env');
  for (const m of text.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})\b/g))
    add(Number(m[1]), 'localhost url');
  return hits;
}

export function scanProject(project: Project): ScanHit[] {
  if (!existsSync(project.path)) return [];
  const files: string[] = [];
  walk(project.path, 0, files);
  const hits: ScanHit[] = [];
  for (const f of files) {
    try {
      hits.push(...extractPorts(f, readFileSync(f, 'utf8')));
    } catch {
      // unreadable file
    }
  }
  return hits;
}

export interface ScanResult {
  project: string;
  declared: number[];
  found: number[];
  missing: number[];
  extra: number[];
  hits: ScanHit[];
}

export function scanAll(policy: Policy, only?: string): ScanResult[] {
  const out: ScanResult[] = [];
  for (const project of Object.values(policy.projects).sort((a, b) => a.P - b.P)) {
    if (only && project.name !== only) continue;
    const hits = scanProject(project);
    const found = [...new Set(hits.map((h) => h.port))].sort((a, b) => a - b);
    const missing = found.filter((p) => !project.declared.includes(p));
    const extra = project.declared.filter((p) => !found.includes(p));
    out.push({ project: project.name, declared: project.declared, found, missing, extra, hits });
  }
  return out;
}

/** Rewrite `declared = [...]` inside `[projects.<name>]` without touching the rest of the file. */
export function updateDeclared(tomlText: string, project: string, declared: number[]): string {
  const header = new RegExp(
    `^\\[projects\\.${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`,
    'm',
  );
  const m = header.exec(tomlText);
  if (!m) throw new Error(`[projects.${project}] not found in policy`);
  const start = m.index + m[0].length;
  const rest = tomlText.slice(start);
  const nextTable = /^\s*\[/m.exec(rest);
  const end = nextTable ? start + nextTable.index : tomlText.length;
  const section = tomlText.slice(start, end);
  const value = `declared = [${declared.join(', ')}]`;
  let newSection: string;
  if (/^\s*declared\s*=.*$/m.test(section))
    newSection = section.replace(/^(\s*)declared\s*=.*$/m, `$1${value}`);
  else newSection = section.replace(/^(\s*path\s*=.*)$/m, `$1\n${value}`);
  if (newSection === section && !/declared\s*=/.test(newSection))
    newSection = `${section.replace(/\s*$/, '')}\n${value}\n`;
  return tomlText.slice(0, start) + newSection + tomlText.slice(end);
}

export async function cmdScan(args: ParsedArgs, io: IO): Promise<number> {
  const policy = loadPolicy();
  const results = scanAll(policy, flagString(args.flags, 'project'));
  if (flagBool(args.flags, 'json')) {
    io.out(
      JSON.stringify(
        results.map((r) => ({ ...r, hits: r.hits.map((h) => ({ ...h, file: h.file })) })),
        null,
        2,
      ),
    );
  } else {
    for (const r of results) {
      if (r.missing.length === 0 && r.extra.length === 0) {
        io.out(
          `${r.project}: declared ${r.declared.length ? r.declared.join(', ') : '(none)'} — matches config`,
        );
        continue;
      }
      io.out(`${r.project}:`);
      if (r.missing.length) io.out(`  found in config but not declared: ${r.missing.join(', ')}`);
      if (r.extra.length) io.out(`  declared but not found in config: ${r.extra.join(', ')}`);
    }
  }
  if (flagBool(args.flags, 'write')) {
    const file = policyPath();
    let text = readFileSync(file, 'utf8');
    let changed = 0;
    for (const r of results) {
      if (r.missing.length === 0) continue;
      const declared = [...new Set([...r.declared, ...r.missing])].sort((a, b) => a - b);
      text = updateDeclared(text, r.project, declared);
      changed++;
    }
    if (changed > 0) {
      parsePolicy(text);
      atomicWriteSync(file, text, { backup: true });
      io.out(
        `updated declared ports for ${changed} project${changed === 1 ? '' : 's'} in ${file} (backup at ${file}.bak)`,
      );
    } else io.out('nothing to write');
  }
  return 0;
}
