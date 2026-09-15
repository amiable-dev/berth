import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { detectComposeFlavour } from '../compose.js';
import { readSessions, worktreeSlots } from '../ledger.js';
import { policyPath, stateDir } from '../paths.js';
import { lintPolicy, loadPolicy, type Policy, policyExists } from '../policy.js';
import { ownerDesc } from '../reconcile.js';
import { buildReport } from '../report.js';
import { containerHolderEvidence, inspectContainer, snapshot } from '../truth.js';
import type { CheckReport, PortRecord, State } from '../types.js';
import {
  colourState,
  contractHome,
  ensureDir,
  padLeft,
  padRight,
  parsePort,
  run,
  shortId,
} from '../util.js';
import { VERSION } from '../version.js';

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
}

function holderText(r: PortRecord): string {
  if (!r.live) return r.lease ? '(not bound)' : '';
  const bits = [r.live.holder];
  if (r.live.pid !== undefined && !r.live.container) bits.push(`pid ${r.live.pid}`);
  return bits.join(' ');
}

function sessionText(r: PortRecord): string {
  const sid = r.lease?.owner.session_id ?? r.live?.sessionId;
  if (sid) return shortId(sid);
  if (r.lease) return r.lease.owner.tool;
  return '';
}

function row(r: PortRecord, indent: string): string {
  return [
    indent,
    padLeft(String(r.port), 6),
    '  ',
    padRight((r.role ?? '—').slice(0, 11), 12),
    padRight(colourState(r.state), 11 + (colourState(r.state).length - r.state.length)),
    padRight(holderText(r).slice(0, 30), 32),
    padRight(sessionText(r), 10),
    padRight(r.age ?? '', 5),
    r.url ?? '',
  ]
    .join('')
    .trimEnd();
}

export function renderLs(
  report: CheckReport,
  opts: { project?: string; all?: boolean; state?: State },
): string {
  const lines: string[] = [];
  let ports = report.ports;
  if (opts.state) ports = ports.filter((p) => p.state === opts.state);
  if (!opts.all)
    ports = ports.filter((p) => !(p.kind === 'declared' && p.state === 'idle' && !p.live));
  const byProject = new Map<string, PortRecord[]>();
  const shared: PortRecord[] = [];
  const legacy: PortRecord[] = [];
  for (const p of ports) {
    if (p.kind === 'shared') shared.push(p);
    else if (p.project && report.policy.projects.some((x) => x.name === p.project)) {
      if (!byProject.has(p.project)) byProject.set(p.project, []);
      byProject.get(p.project)?.push(p);
    } else legacy.push(p);
  }
  const projects = report.policy.projects.filter((x) => !opts.project || x.name === opts.project);
  for (const proj of projects) {
    const rows = byProject.get(proj.name) ?? [];
    if (rows.length === 0 && opts.project === undefined) continue;
    lines.push(
      `${proj.name}  P=${proj.P} · ${proj.base}–${proj.base + 999}  ${contractHome(proj.path)}`,
    );
    const byW = new Map<number, PortRecord[]>();
    for (const r of rows) {
      const w = r.worktree ?? 0;
      if (!byW.has(w)) byW.set(w, []);
      byW.get(w)?.push(r);
    }
    for (const w of [...byW.keys()].sort((a, b) => a - b)) {
      const slot = w === 0 ? 'main' : (worktreeSlots(proj.name).find((s) => s.W === w)?.name ?? '');
      lines.push(`  W${w} ${slot}`);
      for (const r of byW.get(w) ?? []) lines.push(row(r, '  '));
    }
  }
  if (!opts.project && shared.length > 0) {
    lines.push('shared');
    for (const r of shared) lines.push(row(r, '  '));
  }
  if (!opts.project && legacy.length > 0) {
    lines.push('legacy / unmanaged (1024–9999)');
    for (const r of legacy) lines.push(row(r, '  '));
  }
  if (lines.length === 0) lines.push('no ports to show');
  return lines.join('\n');
}

export async function cmdLs(args: ParsedArgs, io: IO): Promise<number> {
  const report = await buildReport();
  if (flagBool(args.flags, 'json')) {
    io.out(JSON.stringify(report.ports, null, 2));
    return 0;
  }
  const state = flagString(args.flags, 'state') as State | undefined;
  io.out(
    renderLs(report, {
      project: flagString(args.flags, 'project'),
      all: flagBool(args.flags, 'all'),
      ...(state ? { state } : {}),
    }),
  );
  return 0;
}

export function renderWho(r: PortRecord | undefined, port: number, base: number): string {
  if (!r) return `${port}: nothing known — not leased, not declared, not bound`;
  const lines: string[] = [];
  lines.push(`${r.port}  ${colourState(r.state)}${r.kind ? `  (${r.kind})` : ''}`);
  if (r.decoded) {
    lines.push(
      `  decode   ${base} + 1000·${r.decoded.P} + 100·${r.decoded.W} + ${String(r.decoded.R).padStart(2, '0')}  →  ${r.project ?? `P=${r.decoded.P} (unassigned)`} · W${r.decoded.W} · ${r.role ?? `slot ${r.decoded.R}`}`,
    );
  } else {
    lines.push('  decode   — (outside the block range)');
  }
  if (r.lease) {
    const o = r.lease.owner;
    lines.push(
      `  lease    ${r.lease.project} W${r.lease.worktree} ${r.lease.role} · ${r.lease.kind} · created ${r.lease.created}${r.lease.expires ? ` · expires ${r.lease.expires}` : ''}`,
    );
    lines.push(`  owner    ${ownerDesc(r.lease)}${o.session_id && o.pid ? ` pid ${o.pid}` : ''}`);
    lines.push(`  cwd      ${contractHome(r.lease.cwd)}`);
  }
  if (r.live) {
    lines.push(
      `  live     ${holderText(r)}${r.live.cwd ? ` · ${contractHome(r.live.cwd)}` : ''}${r.live.sessionId ? ` · session ${shortId(r.live.sessionId)}…` : ''}`,
    );
  } else lines.push('  live     nothing bound');
  if (r.url) lines.push(`  url      ${r.url}`);
  lines.push('  how we know');
  for (const e of r.evidence) lines.push(`    › ${e}`);
  if (r.advisory) {
    lines.push(`  advisory ${r.advisory.text}`);
    if (r.advisory.command) lines.push(`           ${r.advisory.command}`);
  }
  lines.push('  berth never kills or reassigns. Exit code is always 0.');
  return lines.join('\n');
}

export async function cmdWho(args: ParsedArgs, io: IO): Promise<number> {
  const port = parsePort(args.positional[0]);
  if (port === null) {
    io.err('usage: berth who <port> [--json]');
    return 2;
  }
  const report = await buildReport();
  const rec = report.ports.find((p) => p.port === port);
  if (rec?.live?.container) {
    const truth = await snapshot({ maxAgeMs: 1000 });
    const c = truth.containers.find((x) => x.name === rec.live?.container);
    if (c) {
      const inspect = await inspectContainer(c.id);
      rec.evidence.push(...containerHolderEvidence(c, inspect));
    }
  }
  if (flagBool(args.flags, 'json')) {
    io.out(JSON.stringify(rec ?? { port, state: null, note: 'nothing known' }, null, 2));
    return 0;
  }
  io.out(renderWho(rec, port, report.policy.scheme.base));
  return 0;
}

export function renderCheck(report: CheckReport): string {
  const s = report.summary;
  const lines = [
    `${s.ports} ports · ${s.attention} need attention · ${s.liveSessions} live session${s.liveSessions === 1 ? '' : 's'}`,
    `  ${Object.entries(s.byState)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${colourState(k)} ${n}`)
      .join(' · ')}`,
  ];
  const attention = report.ports.filter((p) => p.state !== 'ok' && p.state !== 'idle');
  if (attention.length > 0) {
    lines.push('');
    for (const r of attention) {
      lines.push(
        `${padLeft(String(r.port), 6)}  ${padRight(colourState(r.state), 11 + (colourState(r.state).length - r.state.length))}${padRight((r.project ?? '').slice(0, 20), 22)}${padRight(holderText(r).slice(0, 30), 32)}${r.advisory?.command ?? ''}`,
      );
    }
  }
  if (report.summary.ignored) {
    lines.push(
      `  (${report.summary.ignored} listener${report.summary.ignored === 1 ? '' : 's'} from ignored processes not shown)`,
    );
  }
  if (!report.host.dockerAvailable)
    lines.push('\n(docker not reachable: container ports are attributed by process only)');
  return lines.join('\n');
}

export async function cmdCheck(args: ParsedArgs, io: IO): Promise<number> {
  const report = await buildReport({
    ...(args.flags.docker === false ? { skipDocker: true } : {}),
  });
  io.out(flagBool(args.flags, 'json') ? JSON.stringify(report, null, 2) : renderCheck(report));
  return 0;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
}

/** Version of the berth Claude Code plugin when it is installed for this user. */
function installedPluginVersion(): string | undefined {
  const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      plugins?: Record<string, { version?: string } | { version?: string }[]>;
    };
    const entry = data.plugins?.['berth@berth'];
    const first = Array.isArray(entry) ? entry[0] : entry;
    return first ? (first.version ?? 'unknown') : undefined;
  } catch {
    return undefined;
  }
}

export async function doctorChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node',
    ok: nodeMajor >= 20,
    detail: `${process.version} at ${process.execPath}`,
  });
  let policy: Policy | undefined;
  if (policyExists()) {
    try {
      policy = loadPolicy();
      const warnings = lintPolicy(policy);
      checks.push({
        name: 'policy',
        ok: true,
        warn: warnings.length > 0,
        detail: `${policyPath()} · ${Object.keys(policy.projects).length} projects${warnings.length ? ` · ${warnings.join('; ')}` : ''}`,
      });
    } catch (e) {
      checks.push({ name: 'policy', ok: false, detail: (e as Error).message });
    }
  } else {
    checks.push({
      name: 'policy',
      ok: false,
      detail: `missing: ${policyPath()} (copy examples/policy.example.toml)`,
    });
  }
  try {
    ensureDir(stateDir());
    checks.push({ name: 'state dir', ok: true, detail: stateDir() });
  } catch (e) {
    checks.push({ name: 'state dir', ok: false, detail: `${stateDir()}: ${(e as Error).message}` });
  }
  for (const [tool, args] of [
    ['lsof', ['-v']],
    ['netstat', ['-h']],
    ['ps', ['-o', 'pid=', '-p', String(process.pid)]],
  ] as [string, string[]][]) {
    const r = await run(tool, args, { timeoutMs: 3000 });
    checks.push({
      name: tool,
      ok: !r.missing,
      detail: r.missing ? 'not found on PATH' : 'available',
    });
  }
  const psE = await run('ps', ['-E', '-o', 'command=', '-p', String(process.pid)], {
    timeoutMs: 3000,
  });
  checks.push({
    name: 'ps -E',
    ok: psE.code === 0,
    detail:
      psE.code === 0
        ? 'session markers readable for own processes'
        : 'unavailable; session attribution limited',
    warn: psE.code !== 0,
  });
  const docker = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 4000,
  });
  checks.push({
    name: 'docker',
    ok: true,
    warn: docker.missing || docker.code !== 0,
    detail: docker.missing
      ? 'not installed (container ports attributed by process only)'
      : docker.code === 0
        ? `server ${docker.stdout.trim()}`
        : 'installed but not reachable',
  });
  const compose = await detectComposeFlavour();
  checks.push({
    name: 'compose',
    ok: true,
    warn: compose.kind === 'none',
    detail:
      compose.kind === 'plugin'
        ? `docker compose plugin ${compose.version}`
        : compose.kind === 'standalone'
          ? `standalone docker-compose ${compose.version}`
          : 'no docker compose plugin or docker-compose on PATH',
  });
  checks.push({
    name: 'colima',
    ok: true,
    detail: existsSync(path.join(os.homedir(), '.colima'))
      ? 'detected (~/.colima)'
      : 'not detected',
  });
  const portless = await run('portless', ['--version'], { timeoutMs: 4000 });
  checks.push({
    name: 'portless',
    ok: true,
    warn: portless.missing,
    detail: portless.missing
      ? 'not installed (names sync disabled)'
      : portless.stdout.trim() || 'installed',
  });
  const settings = path.join(os.homedir(), '.claude', 'settings.json');
  let hooks = false;
  if (existsSync(settings)) {
    try {
      const text = readFileSync(settings, 'utf8');
      hooks = /context --hook/.test(text) || /berth\.js"? context/.test(text);
    } catch {
      hooks = false;
    }
  }
  const plugin = installedPluginVersion();
  checks.push({
    name: 'claude hooks',
    ok: true,
    warn: !hooks && !plugin,
    detail: plugin
      ? `berth plugin ${plugin} installed${hooks ? ' (manual hooks also in settings.json: run berth hooks uninstall so context does not run twice)' : ''}`
      : hooks
        ? `installed in ${contractHome(settings)}`
        : 'not installed (claude plugin marketplace add amiable-dev/berth && claude plugin install berth@berth, or berth hooks install)',
  });
  const claudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const rules = existsSync(claudeMd) && /## Ports/.test(readFileSync(claudeMd, 'utf8'));
  checks.push({
    name: 'claude rules',
    ok: true,
    warn: !rules,
    detail: rules
      ? `Ports section present in ${contractHome(claudeMd)}`
      : 'no Ports section in ~/.claude/CLAUDE.md (see examples/CLAUDE.ports.md)',
  });
  checks.push({ name: 'sessions', ok: true, detail: `${readSessions().length} recorded` });
  checks.push({ name: 'version', ok: true, detail: VERSION });
  return checks;
}

export async function cmdDoctor(args: ParsedArgs, io: IO): Promise<number> {
  const checks = await doctorChecks();
  if (flagBool(args.flags, 'json')) {
    io.out(JSON.stringify(checks, null, 2));
  } else {
    for (const c of checks) {
      const mark = !c.ok ? 'FAIL' : c.warn ? 'warn' : ' ok ';
      io.out(`[${mark}] ${padRight(c.name, 14)} ${c.detail}`);
    }
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}
