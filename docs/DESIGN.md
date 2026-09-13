# Berth: advisory port coordination for concurrent agent sessions

Design document, 2026-09-13. Reviewed by the LLM council in two rounds (see "Council review"); the five open decisions were closed the same day (section 7). "Berth" is the tool's name: a berth is the numbered place a vessel is allocated in a port.

## 1. Recommendation in one paragraph

Build a thin, zero-dependency core and adopt the edges. The core is a human-edited policy file that states the agreed rules, a daemonless lease ledger that records who holds which port, a reconciler that compares the ledger with what is actually listening (including Docker containers behind Colima and processes spawned by Claude sessions), a CLI that agents and humans both use, and a small local dashboard with a port-range map. Claude Code gets the richest integration through a read-only SessionStart hook that tells each session its allocation. Named `*.localhost` URLs come from portless in alias mode, and a terminal view for humans is available today from lsoff. Nothing off the shelf does the ledger-plus-reconciler-plus-map job (see `RESEARCH.md`), and the two alpha tools that come closest model ports by hashing, which no human can decode.

## 2. The problem, as measured on this machine

- Thirty-four Claude Code project contexts, several of them parallel worktrees of one repo, plus Codex sessions, each starting dev servers with framework defaults. Nine repos declare port 3000, five declare 5432, four declare 5173 and 9090, three declare 4317/4318.
- Frameworks auto-increment silently (Vite 5173 → 5174, Next 3000 → 3001). The agent's belief about its port diverges from reality and it enters a connection-refused loop with no signal that it is wrong.
- Docker runs through Colima, so every published container port appears in `lsof` under one `ssh` process whose cwd is the repo that happened to run `colima start`. Human and agent attribution is wrong by default.
- Four repos each ship an observability stack (Grafana 3000, Prometheus 9090, OTel 4317/4318, Tempo 3200). Only one can run; nobody records which.
- macOS itself squats 5000 and 7000 (AirPlay). Sessions that lose their port leave nothing behind for the next session to find.

## 3. Requirements and decisions already made

| Decision | Choice |
|---|---|
| Enforcement | Advisory only: registry, injected context and written rules. No hook blocks a command. |
| Allocation models | Per-project blocks with role slots; dynamic TTL leases; optional named hosts over a local proxy. |
| Visualization | Local web dashboard plus a terminal table. No menubar app. |
| Consumers | Tool-agnostic CLI first (Codex and humans), Claude Code hooks as the richest integration. |
| This session | Design doc, council-reviewed. Build follows. |

## 4. Options considered

**A. Adopt only, no registry.** portless for HTTP names, lsoff for humans, a global CLAUDE.md/AGENTS.md convention, env-templated compose ports. Zero code to maintain. Fails on agent behaviour: with no record of ownership there is nothing to tell a session its belief is wrong, and databases and gRPC stay uncovered.

**B. Adopt a young registry plus A.** outport, portmarshal or port-selector as the ledger. Fast start, but each is under thirty stars and single-maintainer, none models per-project blocks with role slots, and none reconciles against Docker or Colima labels, which is the specific attribution problem this machine has. Adopting outport's hashed allocator was examined separately as a hybrid and rejected: hashing contradicts decodable numbers, its `.test` proxy duplicates portless, and it has no lease or session attribution, which is the actual product. The allocator is roughly three hundred lines; the alpha dependency would cost more than it saves.

**C. Build a thin core, adopt the edges.** Recommended. Ranked first by the council in both rounds. Details follow.

## 5. Design

### 5.1 Components

```
policy.toml (rules, hand-edited)        truth sources
        │                                 lsof / netstat ─┐
        ▼                                 docker ps labels ┼─▶ reconciler ─▶ per-port state
   allocator ──▶ claims/<session>.json    ps -E env markers┘        ▲
                     │ (O_EXCL, no lock)                            │
                     ▼                                              │
              compact (under lock) ──▶ leases.json ─────────────────┘
                                             │
              ┌──────────────────────────────┼──────────────────────────┐
              ▼                              ▼                          ▼
     berth ls / who / check         SessionStart hook            berth ui (polled)
     (CLI, --json boundary)         additionalContext +          grouped table, range
                                    CLAUDE_ENV_FILE exports      grid, policy, sessions
```

Everything lives in the user's home: `~/.config/berth/policy.toml` (versioned with dotfiles) and `~/.local/state/berth/` for `leases.json`, `claims/`, `tombstones.json` and the lock file. There is no daemon. The dashboard is an ordinary process you start when you want it.

### 5.2 The port number is the rule

```
port = 10000 + 1000·P + 100·W + R
P  project number, hand-assigned and permanent, 0–29   → blocks 10000–39999
W  worktree, 0 = main checkout, 1–9 = additional worktrees
R  role slot, 00–09 canonical, 10–99 project-named extras
```

Canonical roles: 00 web, 01 api, 02 db, 03 cache, 04 smtp, 05 mail-ui, 06 docs/storybook, 07 worker/metrics, 08 otlp-grpc, 09 otlp-http.

Reading a port is decoding it: 13204 is project 3, worktree 2, role 04 (smtp). The rule has no per-project overrides; a repo with more than ten services names extras in slots 10–99 (breach-resolve's eight microservices become 10–17). The council's round-two correction was to spend the middle digits on roles rather than worktrees: ten worktrees per repo is plenty, ten roles per worktree was not.

Why not the alternatives: hashed ports (outport, portree) cannot be read by a human and collide at roughly forty percent for thirty-odd allocations in a thousand-port span; sequential ten-port blocks (Conductor) always need a lookup; memorable 4xxx blocks of one hundred collide with conventional dev ports and run out.

Other ranges:

- **Dynamic pool** 40000–41999, TTL 8 hours, for ad-hoc servers. Kept well below 48000 so a changed `net.inet.ip.portrange.first` cannot reach it.
- **Reserved** 0–1023, 4000–4999 (portless's own allocator), 49152–65535 (macOS ephemeral), 5000 and 7000 (AirPlay).
- **Lint list** of well-known defaults that fall inside the block range (11211 memcached, 11434 Ollama, 15672 RabbitMQ, 16686 Jaeger, 19999 netdata, 27017 Mongo): never handed to a canonical role, flagged if a project's extras land on one. With the formula above all of them fall in extras slots.
- **Declared** ports: a project's legacy hardcoded ports (3000, 5432 …) are registered as-is so conflicts are visible before any migration, and they participate in collision validation.
- **Shared** services: one observability stack and, optionally, one Postgres server with per-project databases, declared once with an owner so that other projects connecting to them is `ok`, not `conflict`.

The formula is the default suggestion. The ledger is authoritative, project and worktree IDs are permanent with tombstones, so deleting a worktree never renumbers a neighbour.

### 5.3 Ledger and concurrency

Reads never lock. `leases.json` is written by temp-file plus `rename`, with the directory fsynced, so a reader always sees a complete document; a `.bak` copy survives torn writes.

Claims are lock-free. A session writes its own `claims/<session_id>.json` with `O_EXCL`; thirty sessions starting at once contend on nothing. The reconciler (or `berth compact`) folds claim files into `leases.json` under the single lock.

The lock file records `{pid, pid_start_time, host, cmd, ts}`. Retry is jittered exponential from 10 ms to 250 ms. A hook gives up after 200 ms and always exits 0 with an advisory warning; an interactive command waits 2–5 s. A lock is broken only when its owner's pid and start time are dead (start time defeats pid reuse); if that cannot be verified it is considered stale after 30 s; if the owner is alive the command warns and never breaks it.

A lease: `{port, project, worktree, role, kind: block|dynamic|declared|shared, owner: {session_id, tool, pid, pid_start}, cwd, created, expires, note}`.

Liveness beats wall-clock: a lease whose pid is alive and whose port is bound is `ok` regardless of TTL, so a laptop asleep for a weekend does not wake up to mass expiry. After a reconcile gap longer than the TTL, every lease gets one TTL of grace.

### 5.4 Reconciler and the state of a port

Truth sources, all read-only and all without sudo:

1. `lsof -nP -iTCP -sTCP:LISTEN -F pcn` for own-user listeners, plus a batched `lsof -a -p … -d cwd` for cwd.
2. `netstat -anv -p tcp` to catch root listeners lsof cannot see.
3. `docker ps` with compose labels: `com.docker.compose.project.working_dir` attributes a container to its repo; containers without labels are reported by container name. Listeners named `ssh`, `limactl`, `com.docker.backend` or `OrbStack` are treated as VM proxies, never as owners.
4. `ps -E -p PID -o command=` to read `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE` from a listener's environment, which passively attributes a server to the session that started it even when nobody claimed anything.

States per port:

| State | Meaning | Advisory response |
|---|---|---|
| ok | leased and bound by the expected owner, or a shared service | none |
| idle | leased, nothing bound, owner alive | none; shown dimmed |
| stale | leased, nothing bound, owner pid gone | suggest `berth release`; never auto-kill |
| orphan | lease cwd no longer exists (worktree removed) | suggest release; keep tombstone |
| unmanaged | bound inside a block, no lease, no session marker | offer `berth adopt <port> --owner human` |
| squatter | bound inside another project's block by a different process, container or session | name the holder (container name, session, pid) and the block owner |
| conflict | lease owner differs from the live holder | show both; advise the session that its belief is wrong |
| drift | repo config declares a port outside its allocation, or a labelled service vanished after a Colima restart | suggest `compose up` or a policy update; never reassign |

`berth check` always exits 0. The point is information, not gates.

### 5.5 CLI

```
berth ls [--json] [--project X] [--all]     grouped Project → Worktree → Role table
berth who <port> [--json]                   lease, live holder, and how we know
berth env [--shell|--dotenv|--compose-override] [--worktree N]
berth claim [--role api | --extra name | --dynamic N] [--note …]
berth release [--port N | --all]
berth adopt <port> --owner human|session    register an unmanaged listener
berth free <port> [--force]                 refuses a live lease held by another session unless forced
berth check [--json]                        reconcile; prints states; exit 0
berth scan [--write]                        discover declared ports in compose, vite, next, .env files
berth compact                               fold claim files into the ledger
berth context --session $ID --cwd $PWD      what the SessionStart hook runs
berth ui [--port 10000]                     dashboard; berth is project 0, so its own port is 10000
```

`--json` is the boundary on every command, so a later port to Go is mechanical and other tools (Codex, scripts, the dashboard) consume the same output.

`berth env --compose-override` writes `~/.local/state/berth/overrides/<project>.yml` using the `!override` tag (verified with docker-compose 5.1.4) and prints the `COMPOSE_FILE` export, so a repo's hardcoded `ports:` list is replaced without editing the repo. `${VAR:-default}` templating remains the better long-term shape for repos you actively own, and both are supported; the override is the default path.

### 5.6 Agent integration

**Claude Code** (advisory, read-only):

- SessionStart hook runs `berth context`. It injects `additionalContext` scoped to this project and worktree: the block, current leases, shared services, and any live conflict touching this project. Not the global table; thirty sessions each carrying fifty ports of context is a token tax. It appends `export PORT=…`, `API_PORT=…`, `DB_PORT=…`, `BERTH_BLOCK=…` to `CLAUDE_ENV_FILE` so every later Bash call has them. It never writes the ledger.
- SessionEnd hook soft-releases that session's dynamic leases (kept visible for 24 h as `stale`).
- The hook command uses an absolute interpreter path (`/opt/homebrew/bin/node …/berth.js`) because hook environments do not see nvm or mise shims.
- A global `~/.claude/CLAUDE.md` section carries the rules (below).
- Optional later: a user-scope MCP wrapper over the same CLI; `.claude/launch.json` generation so the desktop preview pane uses the allocated port.

**Codex and humans:** the same CLI and the same rules in `~/.codex/AGENTS.md`. Passive attribution through `ps -E` works for any process spawned from a Claude session; Codex-spawned processes are attributed by cwd and compose labels only.

**The rules** (draft for `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`):

```
## Ports
- Before starting any server, read the Ports section injected at session start or run
  `berth env --shell`. Pass the port explicitly (`--port $PORT`, `-p $PORT`) and use
  strict mode (`vite --strictPort`). Never let a framework pick a port.
- New service or scratch server: `berth claim --role <role>` or `berth claim --dynamic 1`,
  then use the port it prints.
- Check before you assume: `berth who <port>`. Do not kill a listener you do not own.
- Grafana 3000, Prometheus 9090, OTLP 4317/4318 and Tempo 3200 are one shared stack.
  Do not start another; point at the shared one.
- Tell the human the URL you actually bound.
```

Advisory is viable only because strict-port is non-negotiable in the rules: the convention removes the framework's ability to drift silently, and the injected context plus `berth who` give a session a way to discover that it is wrong.

### 5.7 Named hosts

Decided for v1: portless in alias mode. `berth` allocates, `portless alias chancery 17000` proxies, so there is one allocator. portless's own 4000–4999 range is reserved so its wrapper mode still works for repos that prefer it. Generating a Caddyfile from the ledger stays the fallback if portless's proxy proves awkward; Caddy is not installed and portless is turnkey and worktree-aware.

### 5.8 Dashboard

`berth ui` serves one page on port 10000, polls `berth check --json` every 5 s (the reconcile is cached for 1 s so polling cannot cause lsof storms), and shows:

1. **Grouped table** (default): Project → Worktree → Role, with state chip, live holder, session or container, cwd, age, URL. This is the operational view.
2. **Range map**: one row per project block, cells per role, coloured by state, hatched for squatter, stale and conflict; the legacy area (1024–9999) drawn as a strip with declared ports. This is the conflict view, and the one thing no OSS tool provides.
3. **Rules**: the policy rendered, so the agreed ranges are visible to a human without opening TOML.
4. **Sessions**: which Claude or Codex session holds which leases, from claim files and `ps -E` markers.

Static render with a refresh button first; polling is a ten-line addition; server-sent events are not needed.

### 5.9 Implementation

TypeScript on Node 20, bundled with esbuild to a single `berth.js` with zero runtime dependencies. Measured on this machine, `lsof` alone is ≈50 ms and Node startup ≈30–40 ms, so the SessionStart hook lands well inside 200 ms. A Go or Rust binary buys nothing decisive (the `lsof` and `docker` forks dominate in any language) except zero-runtime install, and the `--json` boundary keeps that door open.

### 5.10 Rollout

| Phase | What | Effort |
|---|---|---|
| 0, no code | Write `policy.toml` from `examples/policy.example.toml` (drafted from this machine's repos). Add the Ports rules to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`. Install lsoff for a human view today. skills-telemetry owns the shared observability stack (decided). | an hour |
| 1, core | `policy`, `scan`, `ls`, `who`, `check` (reconciler with Docker labels and `ps -E`), `env` with shell, dotenv and compose override, `context` and the SessionStart / SessionEnd hooks. | 2–3 days |
| 2, ownership | `claim`, `release`, `adopt`, `free` with refusal semantics, claim files and `compact`, tombstones, the dashboard with grouped table and range map. | 2–3 days |
| 3, edges | portless alias sync, `launch.json` generation, MCP wrapper, importer for outport/portmarshal registries, optional Go port. | as needed |

### 5.11 Risks

| Risk | Mitigation |
|---|---|
| `docker run` containers without compose labels | resolved by container name via `docker ps`; reported as `squatter(container:<name>)`, never as `ssh`. Rule: claim before `docker run`. This remains the weakest attribution path. |
| Worktree removed, leases and proxy aliases linger | `check` tests `cwd` existence → `orphan`; tombstone keeps the ID; suggest release. `WorktreeRemove` hook can do it automatically later. |
| Context bloat at SessionStart | scope injection to this project plus shared services. |
| Orphaned child servers after a Stop or Ctrl-C | reconciler names the true holding pid; `free` refuses live leases of other sessions unless forced. |
| Colima restart drops tunnels | `drift`, not `stale`; never reassign; advise `compose up`. |
| Thirty hooks at once | hooks are read-only; claims are per-session files; the only lock is on compaction. |
| Hook interpreter drift (nvm, mise) | absolute interpreter path in the hook command. |
| Two humans | out of scope; the ledger is per user by construction. |

## 6. Council review

Round one (one of four models answered within budget, no peer review) ranked C over a hybrid over A over B, endorsed the daemonless ledger, `!override` generation, `ps -E` attribution and Node 20, and proposed: widen blocks, drop portless for a generated Caddyfile, cut the web UI from v1, bundle with esbuild, scope context injection, check worktree existence. Adopted: esbuild single file, scoped injection, worktree checks. Adjusted: blocks were widened but along the role axis, not the worktree axis (see round two). Declined: dropping the dashboard, which conflicts with the stated requirement and is the one gap versus OSS; dropping portless, which alias mode makes unnecessary; the owner then chose portless alias mode for v1 (section 7).

Round two (three of four models, peer-reviewed, no dissent registered) answered the five open questions: it replaced the block formula with `10000 + 1000·P + 100·W + R` with hand-assigned permanent P and no overrides; specified lock-free per-session claim files compacted under one lock, lock metadata with pid start time, jittered retry and a 200 ms hook deadline; named the detection and response for sleep, missing SessionEnd, worktree removal, Colima restart, unlabelled containers and human-started servers; rejected the outport hybrid; and found nothing decisive between Node and Go beyond pinning the interpreter path and caching the reconcile. All of it is in section 5.

## 7. Decisions taken (2026-09-13)

| Decision | Choice | Consequence |
|---|---|---|
| Project numbers | Draft accepted as-is | The P values in `examples/policy.example.toml` are permanent: berth 0, skills-telemetry 1, 36-inch-platform 2, breach-resolve 3, cith-watch 4, sightline 5, llm-council 6, chancery 7, learnlock-studio 8, learnlock 9, conductor 10, monstrous-conductor 11, standards-telemetry 12, swe-ai-ml-kb 13, docusaurus-plugin-stentorosaur 14, amiable-docusaurus 15, monstrous-media 16, conductor-website 17, heptara 18, sre-agent 19, kpm 20. |
| Shared observability | skills-telemetry owns the one stack | Policy declares it `shared` with that owner. breach-resolve, standards-telemetry and llm-council keep their compose files, but the rules say point at the shared stack, and a second running stack is reported as `drift`. |
| Named hosts | portless in alias mode for v1 | berth allocates, `portless alias <name> <port>` proxies. 4000–4999 stays reserved for portless's wrapper mode. A generated Caddyfile remains the fallback. |
| Name | berth | CLI `berth`, config `~/.config/berth/`, state `~/.local/state/berth/`. |
| Home | `~/port-visualiser`, published as amiable-dev/berth | Git initialised here on 2026-09-13; the GitHub repository is named berth when pushed. The directory may be renamed later without breaking anything. |
