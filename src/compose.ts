import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Policy, Project } from './policy.js';
import { type ContainerInspect, handRunContainerAt } from './truth.js';
import type { Container } from './types.js';
import { run } from './util.js';

export interface ComposeService {
  name: string;
  image?: string;
  /** published host port -> container port */
  ports: { host: number; container: number }[];
}

const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'docker-compose.dev.yml',
];

export function findComposeFile(dir: string): string | undefined {
  for (const f of COMPOSE_FILES) {
    const p = path.join(dir, f);
    if (existsSync(p)) return p;
  }
  return undefined;
}

interface ConfigJson {
  services?: Record<string, { image?: string; ports?: unknown }>;
}

function parsePortEntry(v: unknown): { host: number; container: number } | undefined {
  if (typeof v === 'string' || typeof v === 'number') {
    const s = String(v);
    const m = /^(?:[\d.:[\]]+:)?(\d{1,5}):(\d{1,5})(?:\/\w+)?$/.exec(s) ?? /^(\d{1,5})$/.exec(s);
    if (!m) return undefined;
    const host = Number(m[1]);
    const container = m[2] !== undefined ? Number(m[2]) : host;
    if (host < 1 || host > 65535 || container < 1 || container > 65535) return undefined;
    return { host, container };
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as { published?: unknown; target?: unknown };
    const host = Number(o.published);
    const container = Number(o.target);
    if (Number.isInteger(host) && Number.isInteger(container) && host > 0 && container > 0)
      return { host, container };
  }
  return undefined;
}

/** Ask the compose CLI for the resolved config (handles env substitution and includes). */
export async function composeServicesViaCli(file: string): Promise<ComposeService[] | undefined> {
  const cwd = path.dirname(file);
  const attempts: [string, string[]][] = [
    ['docker', ['compose', '-f', file, 'config', '--format', 'json']],
    ['docker-compose', ['-f', file, 'config', '--format', 'json']],
  ];
  for (const [cmd, args] of attempts) {
    const r = await run(cmd, args, { timeoutMs: 8000, cwd });
    if (r.missing || r.code !== 0) continue;
    try {
      const cfg = JSON.parse(r.stdout) as ConfigJson;
      const out: ComposeService[] = [];
      for (const [name, svc] of Object.entries(cfg.services ?? {})) {
        const ports = Array.isArray(svc.ports)
          ? svc.ports
              .map(parsePortEntry)
              .filter((p): p is { host: number; container: number } => Boolean(p))
          : [];
        out.push({ name, ...(svc.image ? { image: svc.image } : {}), ports });
      }
      return out;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Regex fallback for the common `services:` / `ports:` list shapes; used when no compose CLI works. */
export function composeServicesFromText(text: string): ComposeService[] {
  const lines = text.split('\n');
  const out: ComposeService[] = [];
  let inServices = false;
  let current: ComposeService | undefined;
  let inPorts = false;
  let svcIndent = -1;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    if (indent === 0) {
      inServices = false;
      continue;
    }
    const svcMatch = /^(\s+)([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (svcMatch && (svcIndent < 0 || indent === svcIndent)) {
      svcIndent = indent;
      current = { name: svcMatch[2] ?? '', ports: [] };
      out.push(current);
      inPorts = false;
      continue;
    }
    if (!current) continue;
    const img = /^\s+image:\s*["']?([^"'\s]+)/.exec(line);
    if (img && indent > svcIndent) current.image = img[1];
    const inline = /^\s+ports:\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      for (const item of (inline[1] ?? '').split(',')) {
        const p = parsePortEntry(item.trim().replace(/^["']|["']$/g, ''));
        if (p) current.ports.push(p);
      }
      continue;
    }
    if (/^\s+ports:\s*$/.test(line) && indent > svcIndent) {
      inPorts = true;
      continue;
    }
    if (inPorts) {
      const item = /^\s+-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (item && indent > svcIndent) {
        const p = parsePortEntry(item[1]);
        if (p) current.ports.push(p);
        continue;
      }
      inPorts = false;
    }
  }
  return out;
}

export async function composeServices(file: string): Promise<ComposeService[]> {
  return (await composeServicesViaCli(file)) ?? composeServicesFromText(readFileSync(file, 'utf8'));
}

/** Guess a berth role for a compose service from its name, image and container port. */
export function inferRole(
  policy: Policy,
  project: Project,
  svc: ComposeService,
  containerPort: number,
): string {
  const hay = `${svc.name} ${svc.image ?? ''}`.toLowerCase();
  const extras = Object.keys(project.extras);
  for (const e of extras) if (hay.includes(e.toLowerCase())) return e;
  if (
    /postgres|mysql|mariadb|mongo|clickhouse/.test(hay) ||
    [5432, 3306, 27017, 8123].includes(containerPort)
  )
    return 'db';
  if (/redis|valkey|memcached/.test(hay) || [6379, 11211].includes(containerPort)) return 'cache';
  if (/mailpit|mailhog|smtp/.test(hay) && containerPort === 1025) return 'smtp';
  if (/mailpit|mailhog/.test(hay) || containerPort === 8025) return 'mail-ui';
  if (containerPort === 4317 || /otlp.*grpc/.test(hay)) return 'otlp-grpc';
  if (containerPort === 4318 || /otlp.*http/.test(hay)) return 'otlp-http';
  if (/grafana|prometheus|tempo|jaeger|langfuse|minio|kibana|elastic/.test(hay)) return svc.name;
  if (/worker|queue|celery|sidekiq/.test(hay)) return 'worker';
  if (/api|backend|server|gateway/.test(hay)) return 'api';
  if (/docs|storybook/.test(hay)) return 'docs';
  if (/web|frontend|app|ui|site/.test(hay)) return 'web';
  return svc.name;
}

export interface ComposeFlavour {
  kind: 'plugin' | 'standalone' | 'none';
  /** The command to invoke: `docker compose` (two argv words) or `docker-compose`. */
  command: string;
  version?: string;
}

async function composeVersion(cmd: string, args: string[]): Promise<string | undefined> {
  const r = await run(cmd, args, { timeoutMs: 4000 });
  if (r.missing || r.code !== 0) return undefined;
  const text = r.stdout.trim();
  return text.length > 0 ? text : undefined;
}

/** Which Compose this machine has: the `docker compose` plugin, standalone `docker-compose`, or neither. */
export async function detectComposeFlavour(): Promise<ComposeFlavour> {
  const plugin = await composeVersion('docker', ['compose', 'version', '--short']);
  if (plugin) return { kind: 'plugin', command: 'docker compose', version: plugin };
  const standalone = await composeVersion('docker-compose', ['version', '--short']);
  if (standalone) return { kind: 'standalone', command: 'docker-compose', version: standalone };
  return { kind: 'none', command: 'docker compose' };
}

export interface OverrideMappingEntry {
  service: string;
  /** Host port the compose file currently declares for this container port (pre-override). */
  currentHost: number;
  /** Host port berth assigns; what the override file publishes instead. */
  newHost: number;
  containerPort: number;
  role: string;
}

export interface OverrideWarningPort {
  current: number;
  new: number;
  containerPort: number;
}

export interface OverrideWarning {
  service: string;
  container: string;
  ports: OverrideWarningPort[];
  message: string;
  recreateCommand: string;
  cautions: string[];
}

/** Images that keep state in memory unless a specific env var points them at a file. */
const MEMORY_STATE_IMAGES: { pattern: RegExp; envVar: string; note: string }[] = [
  {
    pattern: /mailpit|mailhog/i,
    envVar: 'MP_DATABASE',
    note: 'keeps received mail in memory; recreating loses it unless MP_DATABASE is set',
  },
];

function memoryStateCaution(image: string | undefined, env: string[]): string | undefined {
  if (!image) return undefined;
  const hit = MEMORY_STATE_IMAGES.find((m) => m.pattern.test(image));
  if (!hit) return undefined;
  if (env.some((e) => e.startsWith(`${hit.envVar}=`))) return undefined;
  return `${image} ${hit.note}`;
}

/**
 * For each mapped service whose currently-declared host port is already held by a container
 * without compose labels, describe why the override will not move it and how to recreate it on
 * the new port. A service with compose labels on its current holder gets no warning.
 */
export function buildOverrideWarnings(
  mapping: OverrideMappingEntry[],
  containers: Container[],
  mounts: Map<string, ContainerInspect>,
): OverrideWarning[] {
  const byService = new Map<string, OverrideMappingEntry[]>();
  for (const m of mapping) {
    if (!byService.has(m.service)) byService.set(m.service, []);
    byService.get(m.service)?.push(m);
  }
  const warnings: OverrideWarning[] = [];
  for (const [service, entries] of byService) {
    let container: Container | undefined;
    const matched: OverrideMappingEntry[] = [];
    for (const e of entries) {
      const c = handRunContainerAt(containers, e.currentHost);
      if (!c) continue;
      container = c;
      matched.push(e);
    }
    const primary = matched[0];
    if (!container || !primary) continue;
    const inspect = mounts.get(container.id);
    const volFlags = (inspect?.mounts ?? []).map((m) => `-v ${m.name}:${m.destination}`);
    const portFlags = matched.map((e) => `-p ${e.newHost}:${e.containerPort}`);
    const image = inspect?.image ?? container.name;
    const recreateCommand = [
      `docker stop ${container.name}`,
      `docker rm ${container.name}`,
      `docker run -d --name ${container.name} ${portFlags.join(' ')}${volFlags.length ? ` ${volFlags.join(' ')}` : ''} ${image}`,
    ].join(' && ');
    const cautions: string[] = [];
    for (const m of inspect?.mounts ?? []) {
      if (m.anonymous)
        cautions.push(
          `volume ${m.name} is anonymous; recreating loses it unless you keep this exact name`,
        );
    }
    const memCaution = memoryStateCaution(inspect?.image, inspect?.env ?? []);
    if (memCaution) cautions.push(memCaution);
    warnings.push({
      service,
      container: container.name,
      ports: matched.map((e) => ({
        current: e.currentHost,
        new: e.newHost,
        containerPort: e.containerPort,
      })),
      message: `${container.name} (${primary.currentHost}) was started with docker run; the override will not apply.`,
      recreateCommand,
      cautions,
    });
  }
  return warnings;
}

/** Render one warning as the lines `cmdEnv` prints on stderr. */
export function formatOverrideWarning(w: OverrideWarning): string[] {
  const lines = [
    `${w.message} Recreate it on ${w.ports.map((p) => p.new).join(', ')}: ${w.recreateCommand}`,
  ];
  for (const c of w.cautions) lines.push(`  caution: ${c}`);
  return lines;
}

export function renderOverride(
  mapping: { service: string; host: number; container: number; role: string }[],
): string {
  const byService = new Map<string, { host: number; container: number; role: string }[]>();
  for (const m of mapping) {
    if (!byService.has(m.service)) byService.set(m.service, []);
    byService.get(m.service)?.push(m);
  }
  const lines = [
    '# Generated by `berth env --compose-override`. Do not edit; rerun to refresh.',
    'services:',
  ];
  for (const [svc, ports] of byService) {
    lines.push(`  ${svc}:`);
    lines.push('    ports: !override');
    for (const p of ports) lines.push(`      - "${p.host}:${p.container}"  # ${p.role}`);
  }
  return `${lines.join('\n')}\n`;
}
