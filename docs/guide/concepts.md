# Concepts

## The port number is the rule

```
port = 10000 + 1000·P + 100·W + R
```

| Part | Meaning | Range |
|---|---|---|
| **P** | project number, hand-assigned and permanent | 0–29 → blocks 10000–39999 |
| **W** | worktree: 0 is the main checkout, 1–9 additional git worktrees | 0–9 |
| **R** | role slot | 00 web · 01 api · 02 db · 03 cache · 04 smtp · 05 mail-ui · 06 docs · 07 worker · 08 otlp-grpc · 09 otlp-http · 10–99 project-named extras |

Reading a port is decoding it. 13204 is project 3, worktree 2, smtp. Humans can remember the rule; agents can compute it; nobody needs the allocation table. The base (10000), the number of projects and the dynamic pool are configurable in the [policy](../reference/policy), but the shape is fixed on purpose: hashed schemes cannot be read, and per-tool sequential blocks always need a lookup.

## Worktrees

A git worktree of a registered project gets its own hundred-port slice (W1–W9) the first time `berth env` or `berth claim` runs inside it. Slots are assigned with an exclusive file create, so two worktrees created at the same moment cannot receive the same number, and a removed worktree leaves a tombstone: its number is never reused unless a human prunes it (`berth worktrees prune`). The SessionStart hook never assigns a slot; it only reports that one is needed.

## Kinds of port

| Kind | What it is |
|---|---|
| `block` | a port inside a project's block, computed from P, W and R |
| `dynamic` | a port from the dynamic pool (40000–41999 by default) with a TTL lease, for scratch servers |
| `declared` | a legacy port a repository still hardcodes, recorded so conflicts are visible before migration |
| `shared` | a service declared once with an owner (an observability stack, one Postgres for several projects); other projects connecting to it is `ok`, not a conflict |

Reserved ranges (privileged ports, the portless range, the macOS ephemeral range) and reserved ports (macOS AirPlay on 5000 and 7000) are never handed out. A lint list of well-known defaults that fall inside the block range (11211, 15672, 16686, 27017 …) keeps them away from canonical roles.

## Leases, claims and the ledger

A **lease** records that a session holds a port: project, worktree, role, kind, owner (session id, tool, pid), working directory, creation time and, for dynamic ports, an expiry. Leases live in `leases.json`.

Sessions never write that file directly. `berth claim` writes the session's own **claim file**; the next read folds claim files into the ledger under one lock. Thirty sessions starting at once contend on nothing, and the single lock is taken only for compaction and explicit writes. It records the holder's pid and start time and is broken only when that pid is provably gone.

## Truth

The ledger is what sessions believe. The reconciler compares it with what is actually listening:

- `lsof` for your own listeners and their working directories,
- `netstat` for other users' listeners,
- `docker ps` compose labels, which attribute a container's published ports to its repository. Colima and Docker Desktop publish container ports through a proxy process (`ssh`, `limactl`, `com.docker.backend`); that process is never treated as the owner,
- `ps -E`, which reads the `CLAUDE_CODE_SESSION_ID` marker from a listener's environment and attributes a server to the Claude session that started it, even when nobody claimed anything.

Liveness beats the clock: a lease whose pid is alive and whose port is bound stays `ok` whatever its TTL says.

## The eight states

| State | Meaning | Advisory |
|---|---|---|
| `ok` | leased and bound by the expected owner, a shared service, or a holder already attributed to the block's own project | none |
| `idle` | leased or declared, nothing bound, owner alive | shown dimmed |
| `stale` | leased, nothing bound, owner pid gone | `berth release --port N`; never auto-killed |
| `orphan` | lease directory no longer exists (worktree removed) | release; the tombstone keeps the slot |
| `unmanaged` | bound inside a managed range with no lease and no attribution | `berth adopt N --owner human` |
| `squatter` | bound inside another project's block by a different project or session | `berth who N`; do not kill |
| `conflict` | lease owner differs from the live holder | `berth who N --json`; the owning session's belief is wrong |
| `drift` | config declares a port outside its allocation, or a shared stack is partially up | `berth scan --write`; never reassigned |

Every state comes with exactly one advisory command. berth prints it; a human or an agent decides.

A port inside a project's block is `ok` without a lease when its live holder is already attributed to that same project — by the compose `working_dir` label or by process cwd; the report calls this `attribution: "evidence"` to distinguish it from a leased `ok` (`attribution: "lease"`). Only a holder with no attribution at all is `unmanaged`; a container started with `docker run` instead of `docker-compose` is one such case, and the advisory says so instead of implying berth just declined to adopt it.

## Advisory, always

berth never blocks a command and never kills a process on its own. `berth free` exists for humans and only signals processes you own; it refuses ports held by another live session unless forced, and it refuses to run from an agent session at all. That posture is what makes the design safe to put in front of thirty autonomous sessions: the worst a wrong belief can do is be reported.
