import { flagBool, flagString, type ParsedArgs, parseArgs, UsageError } from './args.js';
import { cmdAdopt, cmdClaim, cmdEnv, cmdFree, cmdRelease } from './commands/allocate.js';
import { cmdCompact, cmdLaunchJson, cmdNames, cmdWorktrees } from './commands/edges.js';
import { cmdContext, cmdHooks, cmdSessionEnd } from './commands/hooks.js';
import { cmdInit, cmdProject } from './commands/project.js';
import { cmdCheck, cmdDoctor, cmdLs, cmdWho, type IO } from './commands/query.js';
import { cmdScan } from './commands/scan.js';
import { cmdShellInit } from './commands/shell.js';
import { cmdTidy } from './commands/tidy.js';
import { addClaim, LockTimeoutError, releaseLease } from './ledger.js';
import { serveStdio } from './mcp.js';
import { auditLogPath } from './paths.js';
import {
  decodePort,
  loadPolicy,
  PolicyError,
  policyExists,
  projectByP,
  roleName,
} from './policy.js';
import { currentSession } from './session.js';
import { startUi } from './ui/server.js';
import { appendFileSafe, nowIso, parsePort, run } from './util.js';
import { VERSION } from './version.js';

export const HELP = `berth ${VERSION} — advisory port registry for concurrent agent sessions

usage: berth <command> [options]

  ls [--project X] [--all] [--state S] [--json]   ports grouped by project → worktree → role
  who <port> [--json]                             lease, live holder, evidence, advisory
  check [--json] [--no-docker]                    reconcile ledger with reality; exit 0 always
  env [--shell|--dotenv|--compose-override|--json] [--unset] [--strict] [--worktree N] [--cwd DIR]
  shell-init zsh|bash|fish                        prints a cd-aware ports snippet for your rc file
  claim --role R | --extra NAME | --dynamic N | --port P [--note T] [--force] [--json]
  release --port P | --all [--force] [--json]
  adopt <port> --owner human|session [--project X] [--role R] [--json]
  free <port> [--force] [--json]                  SIGTERM an own-user listener (refuses others')
  tidy [--project X] [--dry-run] [--json]         release stale/orphan leases, list unmanaged ports
  init [--base N]                                 write a starting policy (no projects)
  project add [path] [--name N] [--number P]      register a repo: next free P, declared ports, extras
  project list [--json]                           registered projects and their blocks
  scan [--write] [--project X] [--json]           find ports hardcoded in repo configs
  compact [--json]                                fold per-session claim files into the ledger
  context | session-end                           Claude Code hook entry points (read stdin JSON)
  hooks install|uninstall|print [--settings PATH] manage ~/.claude/settings.json hooks
  launch-json [--write] [--cwd DIR] [--no-exclude] .claude/launch.json for the desktop preview pane
  names list|sync [--all] [--dry-run] [--json]    portless aliases for http leases
  worktrees list|remove|prune [--project X --w N] [--json]
  mcp                                             MCP server over stdio
  ui [--port N] [--open]                          dashboard on 127.0.0.1 (default 10000)
  doctor [--json]                                 environment checks
  version | help

env: BERTH_POLICY, BERTH_CONFIG_DIR, BERTH_STATE_DIR, NO_COLOR, BERTH_ALLOW_DESTRUCTIVE.
free, --force, hooks install/uninstall, worktrees prune, init --force, adopt --owner human and tidy without
--dry-run need a human at an interactive terminal (refused from agent sessions and non-interactive shells unless
BERTH_ALLOW_DESTRUCTIVE=1).
Exit codes: 0 ok, 1 refused/failed, 2 usage.`;

async function cmdUi(args: ParsedArgs, io: IO): Promise<number> {
  const p = flagString(args.flags, 'port');
  const port = p === undefined ? 10000 : parsePort(p);
  if (port === null) {
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
        await addClaim(me.id, {
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
      const done = () => ui.close().then(resolve, resolve);
      if (claimed)
        releaseLease(claimed.port, { sessionId: claimed.session, force: true }).then(done, done);
      else done();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

const HOOK_COMMANDS = new Set(['context', 'session-end']);

const COMMANDS: Record<string, (args: ParsedArgs, io: IO) => Promise<number>> = {
  ls: cmdLs,
  who: cmdWho,
  check: cmdCheck,
  env: cmdEnv,
  'shell-init': cmdShellInit,
  claim: cmdClaim,
  release: cmdRelease,
  adopt: cmdAdopt,
  free: cmdFree,
  tidy: cmdTidy,
  scan: cmdScan,
  init: cmdInit,
  project: cmdProject,
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

/**
 * Commands with teeth (ADR-008): refused unless a human is at an interactive terminal, or the
 * operator sets BERTH_ALLOW_DESTRUCTIVE=1 deliberately. This is protection against accidental
 * misuse by an agent, not a security boundary: it fails closed on ambiguity (no TTY, or a Claude
 * marker present) and can be bypassed only by an explicit environment variable.
 */
export function isDestructive(args: ParsedArgs): boolean {
  if (args.flags.force === true) return true;
  if (args.cmd === 'free') return true;
  if (
    args.cmd === 'hooks' &&
    (args.positional[0] === 'install' || args.positional[0] === 'uninstall')
  )
    return true;
  if (args.cmd === 'worktrees' && args.positional[0] === 'prune') return true;
  if (args.cmd === 'adopt' && args.flags.owner === 'human') return true;
  if (args.cmd === 'tidy' && !flagBool(args.flags, 'dry-run')) return true;
  return false;
}

/** A short, command-specific explanation for the human-only refusal message below. */
function humanOnlyReason(args: ParsedArgs): string {
  if (args.cmd === 'tidy') return 'tidy without --dry-run releases leases';
  if (args.cmd === 'free') return 'free sends SIGTERM to a live process';
  if (args.cmd === 'hooks')
    return `hooks ${args.positional[0] ?? ''} rewrites ~/.claude/settings.json`;
  if (args.cmd === 'worktrees') return 'worktrees prune frees a permanent worktree slot';
  if (args.cmd === 'init') return 'init --force replaces the policy';
  if (args.cmd === 'adopt') return 'adopt --owner human attributes a port to a person';
  if (args.flags.force === true) return `--force on ${args.cmd} overrides an ownership refusal`;
  return `${args.cmd} is a human-only command`;
}

export function inAgentSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.CLAUDECODE === '1' ||
    (typeof env.CLAUDE_CODE_SESSION_ID === 'string' && env.CLAUDE_CODE_SESSION_ID.length > 0)
  );
}

/** A human at a terminal: both stdin and stdout are TTYs and no agent marker is present. */
export function humanAtTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !inAgentSession(env);
}

function audit(line: string): void {
  appendFileSafe(auditLogPath(), `${nowIso()} ${line}\n`);
}

const DEFAULT_IO: IO = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

export async function main(argv: string[], io: IO = DEFAULT_IO): Promise<number> {
  // Hook entry points must never fail the session: any error is reported and exit stays 0.
  const isHook = HOOK_COMMANDS.has(argv[0] ?? '');
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`berth: ${(e as Error).message}`);
    if (isHook) return 0;
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
  if (isDestructive(args)) {
    const allowed = process.env.BERTH_ALLOW_DESTRUCTIVE === '1';
    if (!allowed && !humanAtTerminal()) {
      const why = inAgentSession()
        ? 'an agent session (CLAUDECODE is set)'
        : 'a non-interactive shell';
      io.err(
        `berth: "${argv.join(' ')}" is refused from ${why}: ${humanOnlyReason(args)}; it is a human-only command (ADR-008). Run it from your own terminal, or \`berth tidy --project <name>\` applies the plan berth has shown you. Set BERTH_ALLOW_DESTRUCTIVE=1 to allow it deliberately.`,
      );
      audit(
        `refused argv=${JSON.stringify(argv)} agent=${inAgentSession()} tty=${Boolean(process.stdin.isTTY)}`,
      );
      return 1;
    }
    audit(
      `allowed argv=${JSON.stringify(argv)} agent=${inAgentSession()} tty=${Boolean(process.stdin.isTTY)} override=${allowed}`,
    );
  }
  try {
    return await fn(args, io);
  } catch (e) {
    if (isHook) {
      io.err(`berth: ${(e as Error).message}`);
      return 0;
    }
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
