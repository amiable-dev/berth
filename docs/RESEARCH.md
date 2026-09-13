# OSS landscape: coordinating local dev ports across agent sessions

Verified 2026-09-13 by fetching each repository or docs page. Stars and dates are as of that day.

## What we looked for

Three capabilities, because the problem has three halves:

1. **Allocation and ownership.** Something an agent can ask "which port may I use?" and "who holds 5432?", that survives across sessions.
2. **Agent integration.** A way for Claude Code (and Codex, and humans) to learn the answer without being told, ideally at session start.
3. **Visualization.** A view for the human of what is listening, who owns it, and what the agreed ranges are.

## Evidence from this Mac

- 34 Claude Code project contexts under `~/.claude/projects`, including parallel `.claude/worktrees` checkouts of chancery, llm-council and swe-ai-ml-kb. VS Code Insiders helper processes also run; their truncated `lsof` name `Codex20-` is `Code -` with an encoded space, not OpenAI Codex, which is not installed.
- Docker runs through Colima 0.10. Every published container port shows up in `lsof` under one `ssh` process (pid 503) whose cwd is whichever repo ran `colima start`. Compose-launched containers carry `com.docker.compose.project.working_dir` labels; `docker run` containers (penguin-mailpit, penguin-platform-db) carry nothing.
- Only the standalone `docker-compose` 5.1.4 is installed. The `docker compose` plugin is absent. `!override` and `${VAR:-default}` both verified with the standalone binary.
- Node 20.20 (no `node:sqlite`), Python via uv, Rust, mise. No Caddy, no direnv, no process-compose.
- macOS ControlCenter listens on 5000 and 7000 (AirPlay receiver). macOS ephemeral ports start at 49152.
- `~/.claude/settings.json` already runs Node-based hooks (graft, iTerm status) on SessionStart, PreToolUse, PostToolUse, Stop and SessionEnd. There is no global `~/.claude/CLAUDE.md`.
- Bash-tool subprocesses inherit `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE=1`, `CLAUDE_PID` and more. For own-user processes, `ps -E -p PID -o command=` exposes that environment without sudo. The Colima VM processes (limactl, pids 478/480) were attributed this way to the skills-telemetry session that started them.

### Port contention declared in repo configs

| Port | Conventional owner | Declared by | Live right now |
|---|---|---|---|
| 3000 | Next, Eleventy, Docusaurus, Grafana | monstrous-media, conductor-website, amiable-docusaurus, amiable-docusaurus-v1, docusaurus-plugin-stentorosaur, breach-resolve (frontend and Grafana), standards-telemetry, skills-telemetry, llm-council observability example | skills-telemetry Grafana (Docker) |
| 3001 | — | skills-telemetry (Langfuse), breach-resolve (Grafana remap), 36-inch-platform (`BASE_URL`) | skills-telemetry Langfuse |
| 5432 | Postgres | learnlock-studio, breach-resolve, 36-inch-platform compose, skills-telemetry, standards-telemetry, sre-agent and heptara DSNs | skills-telemetry Postgres |
| 5433 | — | 36-inch-platform `.env`, breach-resolve test compose | penguin-platform-db |
| 5439 | — | (none) | cith-watch Postgres |
| 5173 | Vite | sightline, cith-watch, conductor-gui (two copies) | — |
| 8000 | FastAPI / uvicorn | llm-council, breach-resolve gateway | — |
| 8001–8005 | — | breach-resolve microservices | — |
| 8787 | wrangler | sightline, cith-watch | — |
| 9090 | Prometheus | breach-resolve (twice), standards-telemetry, skills-telemetry, llm-council example | skills-telemetry |
| 4317 / 4318 | OTLP | breach-resolve, standards-telemetry, skills-telemetry | skills-telemetry |
| 3200 | Tempo | standards-telemetry, skills-telemetry | skills-telemetry |
| 6379 / 6380 | Redis | breach-resolve (6379), breach-resolve test (6380) | cith-watch Redis on 6380 |
| 1025 / 8025 | Mailpit | 36-inch-platform | penguin-mailpit |
| 5000 / 7000 | macOS AirPlay | — | ControlCenter (system) |

Four repos ship a near-identical observability stack (Grafana, Prometheus, OTel collector, Tempo) on the same ports. Only one can run at a time, and whichever session starts it "wins" without anyone recording that.

## Named-host proxies and port managers

| Tool | Activity | Stars | Assigns ports? | Queryable state? | Non-HTTP? | Verdict |
|---|---|---|---|---|---|---|
| [portless](https://github.com/vercel-labs/portless) (Vercel Labs) | v0.15.6, Aug 2026 | 12.4k | Yes: random `PORT` in 4000–4999, `--port` injected for Vite | `portless list`, `~/.portless/routes.json` | No (HTTPS proxy; `alias name port` for anything else) | Best named-URL layer. Its own allocator conflicts with fixed blocks unless used via `alias`. |
| [outport](https://github.com/steveclarke/outport) | v0.44 alpha, Sep 2026 | 22 | Yes: deterministic per project/instance, written to `.env` | `outport ports --json`, dashboard at `outport.test` | Yes (Postgres/Redis) | Closest end-to-end match, single-maintainer alpha, hash-based not block-based. |
| [portmarshal](https://github.com/worsher/portmarshal) | v0.8.1, Sep 2026 | 4 | Yes: `claim`, `run --prefer` | `list --json`, `whois --json`, `~/.portmarshal/registry.json` | Yes | Best "who owns this port" story; refuses to kill another agent's service. Seven weeks old. |
| [port-selector](https://github.com/dapi/port-selector) | v0.10, Aug 2026 | 4 | Yes: stable per (dir, name), 24 h freeze | `--list` table, YAML registry | Numbers only | Simplest agent-safe allocator; README ships a CLAUDE.md snippet. |
| [portree](https://github.com/fairy-pitta/portree) | v0.5, Aug 2026 | 25 | Yes: FNV32 hash per worktree/service | `ls --json` | Numbers; proxy HTTP | Worktree-specific, `branch.localhost` routing. |
| [portzilla](https://github.com/011010/portzilla) | Sep 2026 | 1 | Yes: lease file with PID and `--session $CLAUDE_CODE_SESSION_ID` | MCP server | Yes | Kill-guard, session-aware. Tiny. |
| [porta / port-authority](https://github.com/happycodelucky/porta) | Jul 2026 | 0 | Yes | Per-user registry, OS file lock, daemonless | Yes | Right shape for a ledger; unused. |
| [PortNanny](https://github.com/mukes555/PortNanny) | Sep 2026 | 3 | Yes | MCP (`reserve_port`, `whois_port`, `free_port`) + menubar | Yes | Attributes servers to agents via `CLAUDECODE=1`; Claude plugin install. |
| [port-daddy](https://github.com/curiositech/port-daddy) | Sep 2026 | 2 | Yes | HTTP API :9876, 180 MCP tools | Yes | Heavy daemon, FSL licence. Overkill. |
| [hotel](https://github.com/typicode/hotel) | Oct 2023 | 10k | Yes | `GET localhost:2000/_/servers` JSON | No | Right shape, dormant three years, PAC-file proxy. |
| [localias](https://github.com/peterldowns/localias) | v3.0, Nov 2025 | 1.5k | No (alias → port you choose) | `localias list`, YAML | No (Caddy) | Manual name map with TLS. |
| [DDEV](https://github.com/ddev/ddev) | v1.25.4, Sep 2026 | 3.8k | Yes, per project on `ddev start` | `ddev list -j`, `describe -j` | Yes | Excellent registry but Docker-only, PHP/Node web. |
| [devenv](https://devenv.sh/processes/) | v2.3.1, Sep 2026 | 7.6k | Yes: `ports.<n>.allocate`, `strict_ports` | Not externally queryable | Yes | Nix-only. |
| [process-compose](https://github.com/F1bonacc1/process-compose) | v1.122, Aug 2026 | 2.8k | No | REST `/processes`, MCP `pc_process_ports` | Reports listeners | Per-project orchestrator; its control port 8080 itself collides. |
| overmind / foreman / hivemind | 2024–2025 | 3.7k / 6.2k / 1.2k | Convention: base 5000 + 100 per Procfile line | None | Numbers | Within one Procfile only. |
| Caddy `*.localhost` | v2.11.4 | 75.7k | No | Admin API `:2019` | With layer4 plugin | Solid manual proxy; auto-trusted local certs. |
| mise / direnv | active | 33.9k / 15.4k | No (glue: `PORT = "{{ … }}"`, `export PORT=$(allocator)`) | `mise env --json` | Numbers | Where to pin a value, not where to allocate one. |
| get-port / portfinder / detect-port | active | 929 / 899 / 392 | Find-a-free-port only | None across processes | Numbers | Building blocks. |
| Tilt | v0.37.7 | 10k | No (declared `port_forwards`) | `tilt get portforwards -o json` | Yes (k8s) | Kubernetes-centric. |
| puma-dev, Laravel Valet | slow / active | 1.8k / 2.6k | No | `valet proxies` | No | Rack / PHP ecosystems. |

## Session managers and orchestrators

| Tool | Port handling |
|---|---|
| [Conductor](https://www.conductor.build/docs/reference/environment-variables) | `CONDUCTOR_PORT` = first of a 10-port block per local workspace; scripts do `pnpm dev --port $CONDUCTOR_PORT`, `$((CONDUCTOR_PORT + 1))` for a second service. Allocation algorithm undocumented. |
| [Superset](https://docs.superset.sh/ports) | Detects ports by scanning process trees; docs suggest you DIY a `~/.superset/port-allocations.json` in setup/teardown scripts. |
| [Vibe Kanban](https://vibekanban.com/docs/workspaces/preview) | Scrapes `http://localhost:NNNN` from the dev-server script's stdout and proxies it; conflicts are yours to solve. Sibling [dev-manager-mcp](https://github.com/BloopAI/dev-manager-mcp) hands out sequential ports from 3010. |
| Crystal → Nimbalyst, claude-squad | Nothing; claude-squad issue #260 requests port isolation hooks. Nimbalyst blog: "assign a port range per worktree" by hand. |
| Sculptor, Cursor cloud agents, Codex cloud | Container per agent; `forwardPorts` / `ports: [{port, name}]`. Isolation removes the problem rather than coordinating it. |
| [tfriedel/claude-worktree-hooks](https://github.com/tfriedel/claude-worktree-hooks) | `WorktreeCreate` hook: md5(branch) % 6900 + 3100 → `DEV_PORT` in `.env.local`. |

## Visualizers

| Tool | Stars / activity | PID | cwd or project | Live | Verdict |
|---|---|---|---|---|---|
| `lsof -nP -iTCP -sTCP:LISTEN` | built in | yes | yes, own-user, no sudo (`lsof -a -p PID -d cwd -Fn`) | poll ≈0.05 s | Backbone. Misses root listeners. |
| `netstat -anv -p tcp` | built in | yes, including root's | no | poll | Merge with lsof for root processes. |
| [lsoff](https://github.com/yutat23/lsoff) | 249, Sep 2026 | yes | `CWD` and `PROJECT` columns | TUI, 2 s | Best OSS CLI/TUI today; no range grouping, no Docker attribution. |
| [procs](https://github.com/dalance/procs) | 6.2k | yes | ports yes, `WorkDir` not on macOS | `--watch` | Partial. |
| [port-light](https://github.com/StepaniaH/port-light) | 54, Sep 2026 | no | compose project names | yes | Only true range/traffic-light grid; Linux/Docker oriented. |
| [port-collision-radar](https://github.com/fran-mora/port-collision-radar) | 2 | yes | no | 4 s | Only tool with owner-change / squatter alarms. |
| [Portsly](https://github.com/ghinkle/portsly), [port-tools](https://github.com/Popcornnnnnnnn/port-tools) | 23 / 0 | yes | yes (port-tools: repo/worktree/branch) | yes | Menubar attempts; zero traction. |
| [Portpal](https://github.com/wisher567/Portpal) | 505, Apr 2026 | yes | manifest crawl | yes | D3 force graph, not a range map. |
| killport, kill-port, fkill | 1.8k / 570 / 7k | some | no | — | Kill-only; killport is Colima/OrbStack aware. |

No OSS tool combines a port-range map, PID, cwd and Docker/Colima attribution on macOS.

## Claude Code platform facts

- [Hooks](https://code.claude.com/docs/en/hooks): common input carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`. SessionStart may return `hookSpecificOutput.additionalContext` and may append `export VAR=…` lines to the file named by `CLAUDE_ENV_FILE`, which then apply to every later Bash call. SessionEnd receives a `reason`. PreToolUse can deny with a reason (not used here by decision). `WorktreeCreate` / `WorktreeRemove` exist since v2.1.50. Hooks configured in `~/.claude/settings.json` apply to all projects.
- [Environment variables](https://code.claude.com/docs/en/env-vars): `CLAUDE_CODE_SESSION_ID` is exported to Bash, hook and stdio-MCP subprocesses (CHANGELOG 2.1.132, 2.1.154) and matches the hook `session_id`.
- [Desktop preview servers](https://code.claude.com/docs/en/desktop#configure-preview-servers): `.claude/launch.json` with `port`, `env`, and `autoPort: true` (finds a free port and passes it as `PORT`). Issue #86039 notes orphaned child servers holding ports after Stop.
- [MCP user scope](https://code.claude.com/docs/en/mcp#user-scope): `claude mcp add --scope user` makes a stdio server available in every project.

## Verified mechanisms (local tests, 2026-09-13)

| Mechanism | Result |
|---|---|
| `docker ps --format '{{.Label "com.docker.compose.project.working_dir"}}'` | Attributes compose containers to their repo directory. `docker run` containers return empty. |
| `ps -E -p PID -o command=` on a Node process from another Claude session | Shows `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE` without sudo. |
| `docker-compose -f base.yml -f override.yml config` with `ports: !override` | Replaces the hardcoded `5432:5432` with `25432:5432`; no repo edit needed. |
| `DB_PORT=25432 docker-compose -f env.yml config` with `"${DB_PORT:-5432}:5432"` | Substitutes correctly. |
| `lsof -nP -iTCP -sTCP:LISTEN` timing | ≈0.05 s; cwd lookup for all listeners ≈0.12 s in two calls. |

## Bottom line

- For **named HTTP URLs** there is one mature option: portless. Use its `alias` command so it proxies without allocating.
- For **cross-session ownership of any TCP port** nothing mature exists. The nearest are alpha, single-maintainer tools that model ports by hashing rather than by human-readable blocks, and none reconciles a registry against Docker/Colima reality.
- For **seeing what is running** lsoff is the best off-the-shelf CLI today, and the only range-map UI (port-light) is Linux/Docker oriented.
- The gap that matters, a ledger plus a reconciler plus a range map with session attribution, is small enough to build and is not on offer anywhere. See `DESIGN.md`.
