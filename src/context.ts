import path from 'node:path';
import { assignWorktreeSlot, findWorktreeSlot } from './ledger.js';
import { normalizeDir, type Policy, type Project, projectForPath } from './policy.js';
import { run } from './util.js';

export interface ResolvedContext {
  cwd: string;
  project?: Project;
  /** undefined means the main checkout (W0). */
  worktreeName?: string;
  worktreePath?: string;
  /** null when the project's worktree slots are exhausted or unassigned (assign=false). */
  W: number | null;
  via: 'path' | 'git' | 'none';
}

const WORKTREE_DIRS = ['.claude/worktrees', '.worktrees', 'worktrees'];

export function worktreeNameUnder(
  projectPath: string,
  cwd: string,
): { name: string; path: string } | undefined {
  const base = normalizeDir(projectPath);
  const rel = path.relative(base, normalizeDir(cwd));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  for (const wd of WORKTREE_DIRS) {
    const prefix = `${wd}${path.sep}`;
    if (rel.startsWith(prefix)) {
      const name = rel.slice(prefix.length).split(path.sep)[0];
      if (name) return { name, path: path.join(base, wd, name) };
    }
  }
  return undefined;
}

/**
 * Work out which project and worktree a directory belongs to. Prefix match on policy
 * paths first; then git's common dir for worktrees that live outside the project path.
 */
export async function resolveContext(
  policy: Policy,
  cwd: string,
  opts: { assign?: boolean; git?: boolean; gitTimeoutMs?: number } = {},
): Promise<ResolvedContext> {
  const real = normalizeDir(cwd);
  let project = projectForPath(policy, real);
  let wt: { name: string; path: string } | undefined;
  let via: 'path' | 'git' | 'none' = 'none';
  if (project) {
    via = 'path';
    wt = worktreeNameUnder(project.path, real);
  } else if (opts.git !== false) {
    const common = await run(
      'git',
      ['-C', real, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        timeoutMs: 1500,
      },
    );
    if (common.code === 0) {
      const commonDir = common.stdout.trim();
      const mainRepo = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
      project = projectForPath(policy, mainRepo);
      if (project) {
        via = 'git';
        const top = await run('git', ['-C', real, 'rev-parse', '--show-toplevel'], {
          timeoutMs: 1500,
        });
        const topDir = top.code === 0 ? normalizeDir(top.stdout.trim()) : real;
        if (topDir !== normalizeDir(project.path))
          wt = { name: path.basename(topDir), path: topDir };
      }
    }
  }
  if (!project) return { cwd: real, W: null, via };
  if (!wt) return { cwd: real, project, W: 0, via };
  const slot =
    findWorktreeSlot(project.name, wt.name) ??
    (opts.assign ? assignWorktreeSlot(policy, project.name, wt.name, wt.path) : undefined);
  return {
    cwd: real,
    project,
    worktreeName: wt.name,
    worktreePath: wt.path,
    W: slot ? slot.W : null,
    via,
  };
}
