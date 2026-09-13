# ADR-004: Truth Sources and Attribution

**Status:** Accepted 2026-09-13
**Date:** 2026-09-13
**Decision Makers:** Chris (@amiable-dev), LLM Council
**Council Review:** 2026-09-13 — round one endorsed `ps -E` attribution; round two named the detection and response for sleep, missing SessionEnd, worktree removal, Colima restart, unlabelled containers and human-started servers (`docs/DESIGN.md` §5.4, §6)
**Related:** ADR-001 (states are advisory), ADR-003 (the ledger side of the comparison); `docs/DESIGN.md` §2, §5.4, §5.11; `docs/RESEARCH.md` "Evidence from this Mac", "Verified mechanisms"

---

## Context

The ledger says who *may* hold a port. The reconciler's job is to say who
*does*, and to attribute that holder to a project, a worktree and, where
possible, a session. On this machine the naive answer is wrong in three ways:

- Every published Docker port appears in `lsof` under one `ssh` process (the
  Colima tunnel) whose cwd is whichever repository ran `colima start`.
- `lsof` without sudo cannot see root listeners; macOS ControlCenter holds
  5000 and 7000 for AirPlay.
- A server started by a Claude session carries no marker in `lsof`, but its
  environment does: Bash-tool subprocesses inherit `CLAUDE_CODE_SESSION_ID` and
  `CLAUDECODE=1`, which `ps -E` exposes without sudo for own-user processes.

Each mechanism was verified by a local test on 2026-09-13, including timing:
`lsof` ≈ 50 ms, cwd lookup for all listeners ≈ 120 ms in two calls.

## Decision

Four read-only truth sources, none requiring sudo, merged into one state per
port:

1. `lsof -nP -iTCP -sTCP:LISTEN -F pcn` for own-user listeners, plus one
   batched `lsof -a -p <pids> -d cwd` for their working directories.
2. `netstat -anv -p tcp` to catch root listeners that `lsof` cannot see.
3. `docker ps` with compose labels: `com.docker.compose.project.working_dir`
   attributes a container to its repository. Containers without labels are
   reported by container name. Listeners named `ssh`, `limactl`,
   `com.docker.backend` or `OrbStack` are **VM proxies and never owners**.
4. `ps -E -p <pid> -o command=` to read `CLAUDE_CODE_SESSION_ID` and
   `CLAUDECODE`, which passively attributes a server to the session that
   started it even when nothing was claimed.

The reconcile is cached for one second so dashboard polling cannot cause
`lsof` storms. The result is one of eight states:

| State | Meaning | Advisory response |
|---|---|---|
| ok | leased and bound by the expected owner, or a shared service | none |
| idle | leased, nothing bound, owner alive | none; shown dimmed |
| stale | leased, nothing bound, owner pid gone | suggest `berth release`; never auto-kill |
| orphan | lease cwd no longer exists (worktree removed) | suggest release; keep tombstone |
| unmanaged | bound inside a block, no lease, no session marker | offer `berth adopt <port> --owner human` |
| squatter | bound inside another project's block by a different process, container or session | name the holder and the block owner |
| conflict | lease owner differs from the live holder | show both; advise the session its belief is wrong |
| drift | repo config declares a port outside its allocation, or a labelled service vanished after a Colima restart | suggest `compose up` or a policy update; never reassign |

Attribution uses the strongest available signal: compose label, `ps -E` session
marker, claim file, then the listener's cwd. A VM proxy contributes a port only.

Rejected: scanning process trees (Superset) and scraping dev-server stdout
(Vibe Kanban) are fragile and tool-specific; requiring a claim before any
attribution would leave human-started servers permanently `unmanaged`.

## Consequences

**Positive.** Attribution is right by default for compose services and for
anything a Claude session spawned, which covers most of what runs here. Root
listeners are visible. The Colima `ssh` process is never blamed for another
project's container. Every state suggests; none acts (ADR-001).

**Negative.** `docker run` containers without labels are attributed by name
only; this is the weakest path, and the rules say to claim before
`docker run`. Servers started from VS Code or a terminal are attributed by
cwd and labels alone. `ps -E` is macOS-specific; the Linux equivalent reads
`/proc/<pid>/environ`. A Colima restart that drops tunnels shows as `drift`,
not `stale`, and berth deliberately does nothing about it.

**Neutral.** A fifth source (`.claude/launch.json`, portless's `routes.json`)
would be additive: it changes attribution confidence, not the state vocabulary.

## Compliance / Validation

- Parser tests run against captured `lsof -F`, `netstat -anv`, `docker ps` and
  `ps -E` output, never live commands, so CI needs neither Docker nor Claude.
- A fixture with a Colima `ssh` listener and a labelled container must yield
  the container's repository as owner, never `ssh`.
- Each of the eight states has at least one fixture that produces it and
  asserts the advisory text.
