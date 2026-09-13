import { parseArgs } from './args.js';
import { cmdClaim, cmdEnv, cmdRelease } from './commands/allocate.js';
import { renderCheck, renderWho } from './commands/query.js';
import { buildReport } from './report.js';
import { isValidPort } from './util.js';
import { VERSION } from './version.js';

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), no SDK.
 * Exposes the same operations as the CLI so any MCP client can ask "who holds 5432?".
 */

interface Req {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'berth_check',
    description:
      'Reconcile the port ledger with what is actually listening. Returns the full report (ports, states, sessions, policy).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'boolean', description: 'Return the human summary instead of JSON' },
      },
    },
  },
  {
    name: 'berth_who',
    description: 'Explain one port: lease, live holder, evidence and advisory.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'integer', minimum: 1, maximum: 65535 } },
      required: ['port'],
    },
  },
  {
    name: 'berth_ls',
    description: 'List ports grouped by project, worktree and role.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, all: { type: 'boolean' } },
    },
  },
  {
    name: 'berth_claim',
    description:
      'Claim a port for the calling session: by role, extra name, explicit port, or N dynamic ports.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        extra: { type: 'string' },
        port: { type: 'integer' },
        dynamic: { type: 'integer', minimum: 1, maximum: 20 },
        cwd: { type: 'string' },
        project: { type: 'string' },
        note: { type: 'string' },
        session: { type: 'string' },
      },
    },
  },
  {
    name: 'berth_release',
    description: 'Release a port leased by the calling session (or all of its leases).',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer' },
        all: { type: 'boolean' },
        session: { type: 'string' },
      },
    },
  },
  {
    name: 'berth_env',
    description: 'The port assignments for a directory (project block, worktree, role ports).',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } },
  },
] as const;

function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

async function captureCli(
  fn: (
    args: ReturnType<typeof parseArgs>,
    io: { out: (s: string) => void; err: (s: string) => void },
  ) => Promise<number>,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await fn(parseArgs(argv), { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

export async function callTool(
  name: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'berth_check': {
      const report = await buildReport();
      return textResult(params.text === true ? renderCheck(report) : JSON.stringify(report));
    }
    case 'berth_who': {
      const port = params.port;
      if (!isValidPort(port)) return textResult('port must be an integer 1..65535', true);
      const report = await buildReport();
      const rec = report.ports.find((p) => p.port === port);
      return textResult(
        `${renderWho(rec, port, report.policy.scheme.base)}\n\n${JSON.stringify(rec ?? null)}`,
      );
    }
    case 'berth_ls': {
      const report = await buildReport();
      const project = typeof params.project === 'string' ? params.project : undefined;
      const ports = report.ports
        .filter((p) => !project || p.project === project)
        .filter(
          (p) => params.all === true || !(p.kind === 'declared' && p.state === 'idle' && !p.live),
        );
      return textResult(JSON.stringify(ports));
    }
    case 'berth_claim': {
      const argv = ['claim'];
      for (const k of ['role', 'extra', 'cwd', 'project', 'note', 'session'] as const)
        if (typeof params[k] === 'string') argv.push(`--${k}`, params[k] as string);
      if (isValidPort(params.port)) argv.push('--port', String(params.port));
      if (typeof params.dynamic === 'number') argv.push('--dynamic', String(params.dynamic));
      argv.push('--json');
      const r = await captureCli(cmdClaim, argv);
      return textResult(r.code === 0 ? r.out : r.err || r.out, r.code !== 0);
    }
    case 'berth_release': {
      const argv = ['release', '--json'];
      if (isValidPort(params.port)) argv.push('--port', String(params.port));
      if (params.all === true) argv.push('--all');
      if (typeof params.session === 'string') argv.push('--session', params.session);
      const r = await captureCli(cmdRelease, argv);
      return textResult(r.code === 0 ? r.out : r.err || r.out, r.code !== 0);
    }
    case 'berth_env': {
      const argv = ['env', '--json'];
      if (typeof params.cwd === 'string') argv.push('--cwd', params.cwd);
      const r = await captureCli(cmdEnv, argv);
      return textResult(r.code === 0 ? r.out : r.err || r.out, r.code !== 0);
    }
    default:
      return textResult(`unknown tool ${name}`, true);
  }
}

export async function handleMessage(msg: Req): Promise<Record<string, unknown> | undefined> {
  const id = msg.id;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const error = (code: number, message: string) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  switch (msg.method) {
    case 'initialize': {
      const requested =
        typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : undefined;
      const protocolVersion =
        requested && PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-06-18';
      return reply({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'berth', version: VERSION },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string') return error(-32602, 'tools/call needs a name');
      try {
        return reply(await callTool(name, args));
      } catch (e) {
        return reply(textResult((e as Error).message, true));
      }
    }
    default:
      if (id === undefined) return undefined;
      return error(-32601, `method not found: ${msg.method}`);
  }
}

export async function serveStdio(): Promise<void> {
  process.stdin.setEncoding('utf8');
  let buf = '';
  const write = (obj: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };
  for await (const chunk of process.stdin) {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line) continue;
      let msg: Req;
      try {
        msg = JSON.parse(line) as Req;
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      const res = await handleMessage(msg);
      if (res) write(res);
    }
  }
}
