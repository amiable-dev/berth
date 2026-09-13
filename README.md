# berth

**Advisory port registry for machines that run many agent sessions at once.**

When thirty Claude Code sessions, a few worktrees and a Docker stack all start dev servers on one Mac, ports collide and every session loses track of which port it was given. berth gives each project a permanent, decodable block of ports, records who holds what, checks the ledger against what is actually listening (including containers behind Colima and processes spawned by a Claude session), and shows the result in a terminal table and a local dashboard. It never blocks a command and never kills a process on its own: it tells you, and your agents, the truth.

```
$ berth who 13204
13204  ok  (block)
  decode   10000 + 1000·3 + 100·2 + 04  →  breach-resolve · W2 · smtp
  lease    breach-resolve W2 smtp · block · created 2026-09-13T10:12:04.101Z
  owner    session 4122e12b… pid 48121
  live     mailpit pid 48210 · ~/projects/amiable/breach-resolve/.claude/worktrees/feat-x
  how we know
    › lsof: mailpit pid 48210 cwd ~/projects/amiable/breach-resolve/.claude/worktrees/feat-x
    › ps -E: CLAUDE_CODE_SESSION_ID=4122e12b…
    › lease: block breach-resolve W2 smtp by session 4122e12b… since 2026-09-13T10:12:04.101Z
    › block: breach-resolve P=3 W2 smtp
  advisory none
```

## The port number is the rule

```
port = 10000 + 1000·P + 100·W + R
```

| Part | Meaning | Range |
|---|---|---|
| **P** | project number, hand-assigned and permanent | 0–29 → blocks 10000–39999 |
| **W** | worktree: 0 is the main checkout, 1–9 additional worktrees | 0–9 |
| **R** | role slot | 00 web · 01 api · 02 db · 03 cache · 04 smtp · 05 mail-ui · 06 docs · 07 worker · 08 otlp-grpc · 09 otlp-http · 10–99 project-named extras |

Reading a port is decoding it: 13204 is project 3, worktree 2, smtp. Nothing common defaults into the block range; the few well-known ports that do (11211, 15672, 16686, 27017 …) sit on a lint list and are never handed to a canonical role. Ad-hoc servers get a TTL lease from a dynamic pool (40000–41999 by default), legacy hardcoded ports are registered as `declared` so conflicts are visible before any migration, and a shared observability stack is declared once with an owner so other projects connecting to it is fine.

## Install

```bash
npm install -g @amiable-dev/berth     # Node 20 or newer; zero runtime dependencies
berth doctor                           # what works on this machine
```

From source: `npm ci && npm run build && npm link` (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Quick start

1. **Write the policy.** Copy [`examples/policy.example.toml`](examples/policy.example.toml) to `~/.config/berth/policy.toml` and give each repo a permanent `P`. `berth scan` finds the ports your repos already hardcode; `berth scan --write` records them as `declared`.
2. **See what is going on.**
   ```bash
   berth check          # 34 ports · 2 need attention · 3 live sessions, then the attention list
   berth ls             # Project → Worktree → Role table
   berth who 5432       # lease, live holder, evidence, advisory
   berth ui             # dashboard on http://127.0.0.1:10000
   ```
3. **Use the numbers.**
   ```bash
   eval "$(berth env --shell)"        # PORT, API_PORT, DB_PORT … for this checkout
   berth env --dotenv > .env.ports    # or a dotenv file
   eval "$(berth env --compose-override)"   # COMPOSE_FILE with an !override file: no repo edits
   berth claim --role api             # record that this session owns 13001
   berth claim --dynamic 1            # a scratch port with an 8 h TTL
   berth release --port 13001
   ```
4. **Let agents in.**
   ```bash
   berth hooks install                # SessionStart / SessionEnd hooks in ~/.claude/settings.json
   cat examples/CLAUDE.ports.md >> ~/.claude/CLAUDE.md    # the rules every session reads
   berth launch-json --write          # .claude/launch.json for the desktop preview pane
   ```

## What the reconciler says about a port

| State | Meaning | Advisory |
|---|---|---|
| `ok` | leased and bound by the expected owner, or a shared service | none |
| `idle` | leased, nothing bound, owner alive | shown dimmed |
| `stale` | leased, nothing bound, owner pid gone | `berth release --port N`; never auto-killed |
| `orphan` | lease cwd no longer exists (worktree removed) | release; the tombstone keeps the slot |
| `unmanaged` | bound inside a managed range with no lease | `berth adopt N --owner human` |
| `squatter` | bound inside another project's block by a different project or session | `berth who N`; do not kill |
| `conflict` | lease owner differs from the live holder | `berth who N --json`; the owning session's belief is wrong |
| `drift` | config declares a port outside its allocation, or a shared stack is partially up | `berth scan --write`; never reassigned |

Truth comes from four read-only sources, none of which need sudo: `lsof` for own-user listeners and their working directories, `netstat` for other users' listeners, `docker ps` compose labels to attribute container ports (Colima and Docker Desktop publish them through a proxy process that is never treated as the owner), and `ps -E` to read the `CLAUDE_CODE_SESSION_ID` marker from a listener's environment, which attributes a server to the session that started it even when nobody claimed anything. Liveness beats the clock: a lease whose pid is alive and whose port is bound stays `ok` whatever its TTL says.

## Claude Code integration

- **SessionStart** runs `berth context`: read-only, budgeted at 200 ms, always exit 0. It injects the project's block, current leases, shared services and any live conflict touching this project (not the global table), and appends `PORT`, `<ROLE>_PORT` and `BERTH_*` exports to `CLAUDE_ENV_FILE` so every later Bash call has them.
- **SessionEnd** runs `berth session-end`: marks the session ended and soft-releases its dynamic leases; they stay visible as `stale` until released.
- **Rules** in `~/.claude/CLAUDE.md` ([`examples/CLAUDE.ports.md`](examples/CLAUDE.ports.md)) make strict-port non-negotiable, which is what makes an advisory registry work: frameworks may not silently increment, and `berth who` gives a session a way to discover that it is wrong.
- **MCP**: `berth mcp` is a stdio server with `berth_check`, `berth_who`, `berth_ls`, `berth_claim`, `berth_release` and `berth_env`. Register it once for every project:
  ```bash
  claude mcp add --scope user berth -- berth mcp
  ```
- **Names**: `berth names sync` turns http leases into [portless](https://github.com/vercel-labs/portless) aliases (`chancery.localhost`, `feat-x.chancery.localhost`). berth allocates; portless only proxies.

Any other agent or a human uses the same CLI; `--json` is the boundary on every read command.

## Commands

```
ls [--project X] [--all] [--state S] [--json]   ports grouped by project → worktree → role
who <port> [--json]                             lease, live holder, evidence, advisory
check [--json] [--no-docker]                    reconcile ledger with reality; exit 0 always
env [--shell|--dotenv|--compose-override|--json] [--worktree N] [--cwd DIR]
claim --role R | --extra NAME | --dynamic N | --port P [--note T] [--force] [--json]
release --port P | --all [--session ID] [--force]
adopt <port> --owner human|session [--project X] [--role R]
free <port> [--force]                           SIGTERM an own-user listener; refuses others'
scan [--write] [--project X] [--json]           ports hardcoded in repo configs vs policy
compact                                         fold per-session claim files into the ledger
context | session-end                           Claude Code hook entry points
hooks install|uninstall|print                   manage ~/.claude/settings.json hooks
launch-json [--write] [--cwd DIR]               .claude/launch.json for the desktop preview pane
names list|sync [--all] [--dry-run]             portless aliases for http leases
worktrees list|remove|prune                     worktree slots and tombstones
mcp                                             MCP server over stdio
ui [--port N] [--open]                          dashboard on 127.0.0.1 (default 10000)
doctor [--json]                                 environment checks
```

Environment: `BERTH_POLICY`, `BERTH_CONFIG_DIR`, `BERTH_STATE_DIR`, `NO_COLOR`. Exit codes: 0 ok, 1 refused or failed, 2 usage. `check` always exits 0: the point is information, not gates.

## How it stays safe

- No daemon. Reads never lock; each session writes its own claim file; the single lock guards compaction and explicit writes, records the holder's pid start time, and is only broken when that pid is provably gone.
- No shell. Every external command runs through `execFile` with an argument array and a timeout. Only three Claude marker variables are read from process environments; nothing else is retained.
- The dashboard binds 127.0.0.1, serves GET only, never touches the file system, and uses a per-response nonce CSP with `frame-ancestors 'none'`. Cross-site requests to `/api/state` are refused.
- `free` signals only pids you own, never containers or VM proxies, and refuses ports held by another live session unless you force it.
- State lives in `~/.local/state/berth` as 0600 files in a 0700 directory. The published package has no runtime dependencies and ships with npm provenance.

See [SECURITY.md](SECURITY.md) for the disclosure policy.

## Design

- [docs/DESIGN.md](docs/DESIGN.md): the council-reviewed design, decisions and rollout.
- [docs/RESEARCH.md](docs/RESEARCH.md): the OSS landscape it was measured against.
- [docs/adr/](docs/adr/): ADR-001 advisory not enforcement · ADR-002 the decodable port scheme · ADR-003 daemonless ledger and lock-free claims · ADR-004 truth sources and attribution · ADR-005 Node 20 single bundle.
- [design_handoff_berth_ui/](design_handoff_berth_ui/): the dashboard design pack and prototype the UI was built to.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md), the [code of conduct](CODE_OF_CONDUCT.md) and [SUPPORT.md](SUPPORT.md). `npm run check` runs lint, typecheck, tests and the build.

## Licence

[MIT](LICENSE) © 2026 Amiable Dev
