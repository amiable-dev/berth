# Claude Code and agents

berth was built for machines where many Claude Code sessions run at once. Three layers make a session right by default; none of them requires a human to type a port.

## Install the plugin

```bash
claude plugin marketplace add amiable-dev/berth
claude plugin install berth@berth
```

The marketplace entry points at the npm package, so the plugin carries the compiled CLI. Update with `claude plugin update berth@berth`. The manual route (`berth hooks install`, `claude mcp add --scope user berth -- berth mcp`, the rules text in `examples/CLAUDE.ports.md`) still works for people who prefer a global install; `berth doctor` tells you which is active and warns if both are, because that runs the SessionStart hook twice.

## What a session gets

**Hooks inform.** At session start (startup, resume, clear, compact) the plugin runs `berth context`. It is read-only against allocation state, races a hard 180 ms deadline and always exits 0. It injects a "Ports (berth)" section scoped to this project:

```
## Ports (berth)
Project cith-watch (P=4) owns 14000–14999. This checkout is W0 (main) → 14000–14099.
Ports: web 14000 · api 14001 · db 14002 · cache 14003 · smtp 14004 · mail-ui 14005 · docs 14006 · worker 14007 · otlp-grpc 14008 · otlp-http 14009.
Exported for this session: PORT (web) and WEB_PORT, API_PORT, DB_PORT, …; BERTH_BLOCK=14000-14099.
Legacy ports this repo still hardcodes: 5173, 8787, 5439, 6380 (migrate with `berth env --compose-override` or `berth env --dotenv`).
No conflicts touching this project in the last check.
Shared observability (owned by skills-telemetry; do not start another): grafana 3000 · prometheus 9090 · …
Rules: pass the port explicitly (--port $PORT, vite --strictPort); never let a framework pick one. …
```

and appends the role-port exports, `BERTH_*` variables and the plugin's `bin/` directory to the session's environment, so `berth` and `$PORT` work in every Bash call. At session end, `berth session-end` records that the session ended; its unbound leases show as `stale` afterwards.

**Skills teach.** Two skills load on demand:

- `berth-ports` triggers before a dev server, database or Compose stack is started, on "address already in use", or when asked which port a service uses. It walks the agent through `berth env`, the strict-port flag per framework, `berth claim`, `berth who`, and the eight states.
- `berth-onboard` triggers on "register this repo in berth" and similar. It runs `berth doctor`, `berth init` when there is no policy, `berth project add .`, then `env`, the Compose override and `launch-json --write`, and reports the block and ports.

**MCP executes.** The plugin registers `berth mcp`, a stdio server with six tools: `berth_check`, `berth_who`, `berth_ls`, `berth_claim`, `berth_release`, `berth_env`. Clients that prefer tools to a shell use these; for Claude Code, which has Bash, the CLI's `--json` output is the primary interface.

## The agent flow, end to end

1. You install the plugin once (or ask the agent to).
2. In a repository the agent has not seen, you say "register this repo in berth". The skill registers it with the next free permanent number and records its existing ports.
3. From then on, every session in that repository starts with its ports in context and in the environment. The agent binds servers on them, claims what it starts, and reports the URL it actually bound.
4. When something collides, the agent asks `berth who` instead of incrementing or killing, reports the holder, and follows the advisory.

## What an agent may do

Everything self-scoped: learn its ports, claim and release its own leases, adopt a server it started, register the repository it is in, write that repository's `launch.json`, list worktrees, sync names, run `doctor` and `check`.

**Human-only:** `free`, any command with `--force`, `hooks install` and `hooks uninstall`, `worktrees prune`, `init --force`, `adopt --owner human`, and changing an existing project's number. The CLI refuses these unless a human is at an interactive terminal with no Claude marker in the environment, or `BERTH_ALLOW_DESTRUCTIVE=1` is set deliberately. Refusals and overrides are written to `~/.local/state/berth/audit.log`. This is protection against accidental misuse, not a security boundary; see the [safety model](../reference/security).

## Other agents and scripts

Anything that can run a shell uses the same CLI, and `--json` is the contract on every read command. Servers started by a Claude session are attributed to it through the session marker in their environment; servers started elsewhere are attributed by working directory and container labels.
