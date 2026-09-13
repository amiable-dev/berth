# ADR-003: Daemonless Ledger and Lock-Free Claims

**Status:** Accepted 2026-09-13
**Date:** 2026-09-13
**Decision Makers:** Chris (@amiable-dev), LLM Council
**Council Review:** 2026-09-13 — round one endorsed the daemonless ledger; round two specified the claim files, lock metadata, retry policy and hook deadline (`docs/DESIGN.md` §5.3, §6)
**Related:** ADR-001 (hooks are read-only), ADR-004 (the reconciler consumes the ledger), ADR-005 (hook budget); `docs/DESIGN.md` §5.1, §5.3, §5.11

---

## Context

The ledger is written by many short-lived processes (thirty `SessionStart`
hooks can fire within the same second when a laptop wakes) and read by more
(every `berth ls`, every dashboard poll). The registries surveyed in
`docs/RESEARCH.md` take one of three shapes, each with a cost:

- **A daemon behind an HTTP or MCP API** (port-daddy, hotel): an always-on
  process, its own port to coordinate, one more thing to be down when a hook
  runs.
- **One JSON file behind one lock** (portmarshal, porta): simple, but thirty
  hooks contend on the lock, and a hook that waits past its budget delays
  the session start it is meant to inform.
- **SQLite**: correct concurrency, but `node:sqlite` is absent on the Node
  20.20 installed here, and a native module contradicts the zero-dependency
  bundle (ADR-005).

Two further facts shape the design: a hook must finish in about 200 ms to be
invisible to the user, and pid reuse makes "is the lock owner alive?" a
question a bare pid cannot answer.

## Decision

There is no daemon. State lives in `~/.local/state/berth/`: `leases.json`,
`claims/`, `tombstones.json`, the lock file and a `.bak`. Policy lives in
`~/.config/berth/policy.toml`, versioned with dotfiles.

1. **Reads never lock.** `leases.json` is written by temp-file plus `rename`
   with the directory fsynced, so a reader always sees a complete document.
   A `.bak` copy survives a torn write.
2. **Claims are lock-free.** A session writes its own
   `claims/<session_id>.json` with `O_EXCL`. Thirty sessions starting at
   once contend on nothing. The reconciler, or an explicit `berth compact`,
   folds claim files into `leases.json` under the single lock.
3. **One lock, on compaction only.** The lock file records
   `{pid, pid_start_time, host, cmd, ts}`. A lock is broken only when its
   owner's pid *and* start time are dead (start time defeats pid reuse). If
   that cannot be verified, the lock is stale after 30 s. If the owner is
   alive, the command warns and never breaks it.
4. **Jittered retry with a hard hook deadline.** Retry is jittered
   exponential from 10 ms to 250 ms. A hook gives up after 200 ms and exits
   0 with an advisory warning; an interactive command waits 2–5 s.
5. **Lease shape.** `{port, project, worktree, role, kind:
   block|dynamic|declared|shared, owner: {session_id, tool, pid, pid_start},
   cwd, created, expires, note}`.
6. **Liveness beats wall-clock.** A lease whose pid is alive and whose port
   is bound is `ok` regardless of TTL, so a laptop asleep for a weekend does
   not wake to mass expiry. After a reconcile gap longer than the TTL, every
   lease gets one TTL of grace.
7. **Per user by construction.** The ledger lives in the user's home; two
   humans on one machine are out of scope (§5.11).

## Consequences

**Positive.** Nothing to start, stop or keep alive; a hook that finds the
ledger locked still delivers context. Claim files make session attribution
explicit before compaction ever runs. Atomic rename plus `.bak` means a
crash mid-write loses at most the claim being folded, never the ledger.

**Negative.** Until compaction, `leases.json` may lag the claim files, so a
reader that wants the freshest view merges both (the CLI and dashboard do).
The pid-start-time check is platform-specific (`ps -o lstart` on macOS,
`/proc/<pid>/stat` on Linux). Claim files from sessions that never ran
`SessionEnd` accumulate until compaction marks them `stale`.

**Neutral.** Moving to SQLite later would be contained behind the `--json`
boundary (ADR-005) and would not change any command's output.

## Compliance / Validation

- Concurrency test: N parallel claim writers produce N claim files and zero
  errors; one compaction then produces exactly N leases.
- A lock owned by a dead pid with a mismatched start time is broken; a lock
  owned by a live pid is never broken; an unverifiable lock is broken only
  after 30 s.
- Hook path: with the lock held by another process, `berth context` returns
  within 200 ms and exits 0.
- Torn-write test: killing the writer between temp file and rename leaves a
  parseable `leases.json`.
