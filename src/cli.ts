import { flagBool, flagString, type ParsedArgs, parseArgs, UsageError } from './args.js';
import { cmdAdopt, cmdClaim, cmdEnv, cmdFree, cmdRelease } from './commands/allocate.js';
import { cmdCompact, cmdLaunchJson, cmdNames, cmdWorktrees } from './commands/edges.js';
import { cmdContext, cmdHooks, cmdSessionEnd } from './commands/hooks.js';
import { cmdCheck, cmdDoctor, cmdLs, cmdWho, type IO } from './commands/query.js';
import { cmdScan } from './commands/scan.js';
import { LockTimeoutError } from './ledger.js';
import { serveStdio } from './mcp.js';
import { PolicyError } from './policy.js';
import { run } from './util.js';
import { VERSION } from './version.js';

export const HELP = `berth ${VERSION} — advisory port registry for concurrent agent sessions

usage: berth <command> [options]

  ls [--project X] [--all] [--state S] [--json]   ports grouped by project → worktree → role
  who <port> [--json]                             lease, live holder, evidence, advisory
  check [--json] [--no-docker]                    reconcile ledger with reality; exit 0 always
  env [--shell|--dotenv|--compose-override|--json] [--worktree N] [--cwd DIR]
  claim --role R | --extra NAME | --dynamic N | --port P [--note T] [--force] [--json]
  release --port P | --all [--session ID] [--force]
  adopt <port> --owner human|session [--project X] [--role R]
  free <port> [--force]                           SIGTERM an own-user listener (refuses others')
  scan [--write] [--project X] [--json]           find ports hardcoded in repo configs
  compact                                         fold per-session claim files into the ledger
  context | session-end                           Claude Code hook entry points (read stdin JSON)
  hooks install|uninstall|print [--settings PATH] manage ~/.claude/settings.json hooks
  launch-json [--write] [--cwd DIR]               .claude/launch.json for the desktop preview pane
  names list|sync [--all] [--dry-run]             portless aliases for http leases
  worktrees list|remove|prune [--project X --w N]
  mcp                                             MCP server over stdio
  ui [--port N] [--open]                          dashboard on 127.0.0.1 (default 10000)
  doctor [--json]                                 environment checks
  version | help

env: BERTH_POLICY, BERTH_CONFIG_DIR, BERTH_STATE_DIR, NO_COLOR. Exit codes: 0 ok, 1 refused/failed, 2 usage.`;

async function cmdUi(args: ParsedArgs, io: IO): Promise<number> {
  const { startUi } = await import('./ui/server.js');
  const { addClaim, removeOwnClaim } = await import('./ledger.js');
  const { decodePort, loadPolicy, policyExists, projectByP, roleName } = await import(
    './policy.js'
  );
  const { currentSession } = await import('./session.js');
  const { nowIso } = await import('./util.js');
  const p = flagString(args.flags, 'port');
  const port = p === undefined ? 10000 : Number(p);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    io.err('--port must be 1..65535');
    return 2;
  }
  const ui = await startUi({ port });
  io.err(`berth ui listening on ${ui.url} (Ctrl-C to stop)`);
  // The dashboard leases its own port so it never reports itself as unmanaged.
  let claimed: { session: string; port: number } | undefined;
  if (policyExists()) {
    try {
      const policy = loadPolicy();
      const decoded = decodePort(policy, ui.port);
      const project = decoded ? projectByP(policy, decoded.P) : undefined;
      if (decoded && project) {
        const me = currentSession();
        addClaim(me.id, {
          port: ui.port,
          project: project.name,
          worktree: decoded.W,
          role: roleName(policy, project, decoded.R),
          kind: 'block',
          owner: { session_id: me.id, tool: me.tool, pid: process.pid },
          cwd: process.cwd(),
          created: nowIso(),
          expires: null,
          note: 'berth ui',
        });
        claimed = { session: me.id, port: ui.port };
      }
    } catch {
      // a broken policy must not stop the dashboard from serving (it will show the error)
    }
  }
  if (flagBool(args.flags, 'open') && process.platform === 'darwin')
    await run('open', [ui.url], { timeoutMs: 3000 });
  await new Promise<void>((resolve) => {
    const stop = () => {
      if (claimed) removeOwnClaim(claimed.session, claimed.port);
      ui.close().then(resolve, resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

const COMMANDS: Record<string, (args: ParsedArgs, io: IO) => Promise<number>> = {
  ls: cmdLs,
  who: cmdWho,
  check: cmdCheck,
  env: cmdEnv,
  claim: cmdClaim,
  release: cmdRelease,
  adopt: cmdAdopt,
  free: cmdFree,
  scan: cmdScan,
  compact: cmdCompact,
  context: cmdContext,
  'session-end': cmdSessionEnd,
  hooks: cmdHooks,
  'launch-json': cmdLaunchJson,
  names: cmdNames,
  worktrees: cmdWorktrees,
  doctor: cmdDoctor,
  ui: cmdUi,
  mcp: async () => {
    await serveStdio();
    return 0;
  },
  version: async (_a, io) => {
    io.out(VERSION);
    return 0;
  },
  help: async (_a, io) => {
    io.out(HELP);
    return 0;
  },
};

export async function main(argv: string[]): Promise<number> {
  const io: IO = {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  };
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`berth: ${(e as Error).message}`);
    io.err(HELP);
    return 2;
  }
  if (args.flags.version === true || args.cmd === '--version') {
    io.out(VERSION);
    return 0;
  }
  if (args.flags.help === true) {
    io.out(HELP);
    return 0;
  }
  const fn = COMMANDS[args.cmd];
  if (!fn) {
    io.err(`berth: unknown command "${args.cmd}"`);
    io.err(HELP);
    return 2;
  }
  try {
    return await fn(args, io);
  } catch (e) {
    if (e instanceof PolicyError || e instanceof UsageError) {
      io.err(`berth: ${e.message}`);
      return e instanceof UsageError ? 2 : 1;
    }
    if (e instanceof LockTimeoutError) {
      io.err(`berth: ${e.message}`);
      return 1;
    }
    io.err(`berth: ${(e as Error).stack ?? String(e)}`);
    return 1;
  }
}

if (process.env.BERTH_NO_MAIN !== '1') {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`berth: ${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
