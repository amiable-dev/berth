# CLI reference

Every read command accepts `--json`; that output is the contract for the dashboard, scripts and other agents. Exit codes: 0 ok, 1 refused or failed, 2 usage. `check` always exits 0.

Environment: `BERTH_POLICY` (policy file), `BERTH_CONFIG_DIR`, `BERTH_STATE_DIR`, `NO_COLOR`, `BERTH_ALLOW_DESTRUCTIVE`.

## Setup

### `berth init [--base N] [--force] [--json]`

Writes a generic policy to `~/.config/berth/policy.toml` (scheme, pools, reserved ranges and ports, lint list, default `ignore_processes`, no projects). Refuses to overwrite an existing policy; `--force` replaces it and is human-only. `--base` changes the block base (1024–60000).

### `berth project add [path] [--name N] [--number P] [--no-scan] [--allow-non-git] [--note T] [--json]`

Registers a repository: name from the directory, lowest free permanent number (or `--number`, which errors if taken), `declared` ports from a read-only scan, `extras` for Compose services without a canonical role. Appends one `[projects.<name>]` table; idempotent by path; errors on a name that already points elsewhere. The path must be a git repository root unless `--allow-non-git`.

### `berth project list [--json]`

Registered projects with number, block, path, declared ports and extras.

### `berth doctor [--json]`

Environment checks. Exit 1 if a hard requirement fails (Node version, policy parse, state directory).

## Reading

### `berth check [--json] [--no-docker]`

Reconciles the ledger with what is listening: a summary line, counts per state, then every port that needs attention with its advisory command. `--json` returns the full report ([shape](./json)). `--no-docker` skips container attribution.

### `berth ls [--project X] [--all] [--state S] [--json]`

Ports grouped Project → Worktree → Role, then shared services, then legacy and unmanaged ports. Idle declared ports are hidden unless `--all`.

### `berth who <port> [--json]`

One port: decoded number, lease, owner, live holder, URL, evidence lines, advisory.

### `berth env [--shell | --dotenv | --compose-override | --json] [--worktree N] [--cwd DIR] [--project X]`

This checkout's ports. `--shell` (default) prints `export` lines; `--dotenv` prints `KEY=value`; `--compose-override` writes an `!override` Compose file under `~/.local/state/berth/overrides/` and prints the `COMPOSE_FILE` export. Assigns a worktree slot the first time it runs in a new worktree.

### `berth scan [--write] [--project X] [--json]`

Ports found in each project's configs (Compose, Vite, Next, Astro, Docusaurus, `wrangler.toml`, Procfile, `.env*`, `mise.toml`) compared with the policy's `declared` lists. `--write` adds the missing ones, editing only the `declared` line of each table.

## Allocation

### `berth claim --role R | --extra NAME | --dynamic N | --port P [--note T] [--force] [--json]`

Records that this session owns a port. `--role` and `--extra` compute the port from the project block and this worktree; `--dynamic N` takes N free ports from the pool with a TTL; `--port` claims an explicit port inside this worktree's range or the pool. Refuses a port leased by another session or bound by another process unless `--force` (human-only). If compaction drops the claim because an older claim holds the port, exits 1 and names the holder.

### `berth release --port P | --all [--force] [--json]`

Releases this session's lease on a port (or all of them), from the ledger and from any claim file. Another session's lease needs `--force`.

### `berth adopt <port> --owner human|session [--project X] [--role R] [--note T] [--json]`

Turns an unmanaged listener into a lease. `--owner session` attributes it to the calling session; `--owner human` attributes it to the user and is human-only.

### `berth free <port> [--force] [--json]`

Human-only. Sends SIGTERM to the own-user process bound to the port, waits three seconds, and with `--force` follows with SIGKILL. Never signals containers or VM proxies, and refuses ports held by another live session unless forced.

### `berth compact [--json]`

Folds per-session claim files into `leases.json` under the ledger lock. Reads do this opportunistically; the command exists for scripts.

### `berth worktrees list | remove --project X --w N | prune --project X --w N [--json]`

Worktree slots and tombstones. `remove` marks a slot removed and keeps the number reserved; `prune` frees the number and is human-only.

## Integration

### `berth context` and `berth session-end`

The Claude Code hook entry points; they read the hook JSON on stdin and always exit 0. Not meant to be run by hand.

### `berth hooks install | uninstall | print [--settings PATH]`

Manage the manual SessionStart/SessionEnd hooks in `~/.claude/settings.json` (human-only; the plugin makes this unnecessary). `print` shows the entries.

### `berth launch-json [--write] [--cwd DIR]`

`.claude/launch.json` entries for the desktop preview pane with the allocated ports, derived from `package.json` scripts; existing non-berth entries are kept.

### `berth names list | sync [--all] [--dry-run] [--json]`

portless aliases for http leases: `<project>` for the web role, `<project>-<role>` otherwise, `<worktree>.<project>` for worktrees. berth allocates; portless only proxies.

### `berth mcp`

The MCP server over stdio; see [JSON and MCP](./json).

### `berth ui [--port N] [--open]`

The dashboard, bound to 127.0.0.1, default port 10000.
