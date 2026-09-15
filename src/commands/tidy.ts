import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { releaseLease } from '../ledger.js';
import { auditLogPath } from '../paths.js';
import { loadPolicy, projectByName } from '../policy.js';
import { ownerDesc } from '../reconcile.js';
import { buildReport } from '../report.js';
import { currentSession } from '../session.js';
import type { CheckReport, PortRecord, State } from '../types.js';
import { appendFileSafe, nowIso } from '../util.js';
import type { IO } from './query.js';

/** One row of a tidy plan: either a stale/orphan lease to release, or an unmanaged port to list. */
export interface TidyRow {
  port: number;
  project?: string;
  worktree?: number;
  role?: string;
  state: State;
  /** Who holds the lease being released; absent for unmanaged rows (there is no lease). */
  owner?: string;
  age?: string;
  /** The single advisory command a human would run for this row (reused from `berth check`). */
  command?: string;
}

export interface TidyPlan {
  /** stale or orphan leases, any owner: tidy releases these when applied. */
  release: TidyRow[];
  /** unmanaged ports: listed with the adopt suggestion only, never acted on. */
  unmanaged: TidyRow[];
}

function toRow(r: PortRecord): TidyRow {
  return {
    port: r.port,
    ...(r.project ? { project: r.project } : {}),
    ...(r.worktree !== undefined ? { worktree: r.worktree } : {}),
    ...(r.role ? { role: r.role } : {}),
    state: r.state,
    ...(r.lease ? { owner: ownerDesc(r.lease) } : {}),
    ...(r.age ? { age: r.age } : {}),
    ...(r.advisory?.command ? { command: r.advisory.command } : {}),
  };
}

/**
 * The tidy plan from a fresh `check`: leases in state `stale` or `orphan` (any owner) that tidy
 * will release when applied, and `unmanaged` ports that it can only ever suggest adopting
 * (adoption needs a decision about the owner, so it never becomes an action). Live leases (`ok`,
 * `idle`, `conflict`, `drift`) and `squatter` listeners are never part of the plan.
 */
export function buildTidyPlan(report: CheckReport, project?: string): TidyPlan {
  const inScope = (r: PortRecord) => project === undefined || r.project === project;
  return {
    release: report.ports
      .filter((r) => (r.state === 'stale' || r.state === 'orphan') && inScope(r))
      .map(toRow),
    unmanaged: report.ports.filter((r) => r.state === 'unmanaged' && inScope(r)).map(toRow),
  };
}

function auditTidy(line: string): void {
  appendFileSafe(auditLogPath(), `${nowIso()} tidy ${line}\n`);
}

/**
 * Releases every row in `plan.release`, any owner (force), writing one audit line per port
 * actually released. Idempotent: a row whose lease is already gone (a previous run, or a race
 * with another writer) is silently skipped, not re-audited.
 */
export async function applyTidyPlan(
  plan: TidyPlan,
  sessionId: string,
): Promise<{ released: number[]; refused: string[] }> {
  const released: number[] = [];
  const refused: string[] = [];
  for (const row of plan.release) {
    const r = await releaseLease(row.port, { sessionId, force: true });
    if (r.released) {
      released.push(row.port);
      auditTidy(
        `release port=${row.port} project=${row.project ?? ''} state=${row.state} owner=${row.owner ?? ''}`,
      );
    } else if (r.refused) {
      refused.push(r.refused);
    }
  }
  return { released, refused };
}

function scopeLabel(project: string | undefined): string {
  return project ? `project ${project}` : 'all projects';
}

function renderRow(r: TidyRow, showCommand: boolean): string {
  const bits = [
    String(r.port),
    r.state,
    r.project ?? '',
    r.worktree !== undefined ? `W${r.worktree}` : '',
    r.role ?? '',
    r.owner ?? '',
    r.age ? `age ${r.age}` : '',
  ].filter((b) => b !== '');
  return `  ${bits.join('  ')}${showCommand && r.command ? `  ${r.command}` : ''}`;
}

export function renderTidyPlan(
  plan: TidyPlan,
  project: string | undefined,
  opts: { applied: boolean },
): string {
  const label = scopeLabel(project);
  if (plan.release.length === 0 && plan.unmanaged.length === 0) return `nothing to tidy (${label})`;
  const lines: string[] = [];
  if (plan.release.length > 0) {
    lines.push(opts.applied ? `released (${label})` : `release (${label})`);
    for (const r of plan.release) lines.push(renderRow(r, !opts.applied));
  } else if (opts.applied) {
    lines.push(`nothing to release (${label})`);
  }
  if (plan.unmanaged.length > 0) {
    lines.push(
      `unmanaged (${label}) — listed only; adopting needs a human decision about the owner`,
    );
    for (const r of plan.unmanaged) lines.push(renderRow(r, true));
  }
  return lines.join('\n');
}

export async function cmdTidy(args: ParsedArgs, io: IO): Promise<number> {
  const policy = loadPolicy();
  const projectFlag = flagString(args.flags, 'project');
  let projectName: string | undefined;
  if (projectFlag !== undefined) {
    const p = projectByName(policy, projectFlag);
    if (!p) {
      io.err(`unknown project ${projectFlag}`);
      return 1;
    }
    projectName = p.name;
  }
  const dryRun = flagBool(args.flags, 'dry-run');
  const json = flagBool(args.flags, 'json');
  const report = await buildReport({ policy });
  const plan = buildTidyPlan(report, projectName);

  if (dryRun) {
    if (json) {
      io.out(JSON.stringify({ project: projectName ?? null, dryRun: true, ...plan }, null, 2));
    } else {
      io.out(renderTidyPlan(plan, projectName, { applied: false }));
    }
    return 0;
  }

  const me = currentSession();
  const { released } = await applyTidyPlan(plan, me.id);
  if (json) {
    io.out(
      JSON.stringify({ project: projectName ?? null, dryRun: false, released, ...plan }, null, 2),
    );
  } else {
    io.out(renderTidyPlan(plan, projectName, { applied: true }));
  }
  return 0;
}
