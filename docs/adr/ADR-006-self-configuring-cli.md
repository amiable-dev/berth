# ADR-006: A Self-Configuring CLI (`berth init`, `berth project add`)

**Status:** Accepted 2026-09-13
**Date:** 2026-09-13
**Decision Makers:** Chris (@amiable-dev), LLM Council
**Council Review:** 2026-09-13 — balanced tier, four reviewers (chairman synthesis unavailable that day; raw opinions used), see "Council Review" below
**Related:** ADR-002 (permanent project numbers), ADR-007 (plugin packaging), ADR-008 (agent guardrails); `docs/DESIGN.md` §5.2, §5.5; `README.md` "Quick start"

---

## Context

The first release asked a new user to copy `examples/policy.example.toml`
and edit it by hand. That file is one machine's policy (its repos, its
project numbers, its shared observability stack), not a template, so the
"copy and edit" step was the single largest source of friction in the
README and the one step an agent could not do for its own repository.

The policy is deliberately human-edited TOML with comments (ADR-002), and
project numbers are permanent once used. Any tool that writes the policy
must therefore be additive: it may append, it may never renumber, reorder
or rewrite tables it did not create. `berth scan --write` already follows
this rule by editing only the `declared = [...]` line of one table.

Everything needed to register a repository already exists in the CLI:
`scan` finds hardcoded ports, `compose.ts` infers roles from Compose
services, and `policy.ts` validates the result.

## Decision

1. **`berth init`** writes a generic policy to `~/.config/berth/policy.toml`
   (scheme, pools, reserved ranges and ports, lint list, default
   `ignore_processes`, no projects). It refuses to overwrite an existing
   policy; `--force` exists for humans and is refused inside an agent
   session (ADR-008). The template contains nothing machine-specific.
2. **`berth project add [path]`** registers a repository: name from the
   directory (sanitised to the policy's name grammar, `--name` to override),
   the **lowest free P** (`--number` to choose one; a taken number is an
   error, never a renumber), the path contracted to `~`, `declared` from a
   read-only scan of the repo's configs, and `extras` for Compose services
   whose inferred role is not canonical, assigned slots 10, 11, … in
   service order. The result is validated with the full policy parser
   before it is written, atomically, with a `.bak` of the previous file.
3. **Serialised, idempotent and additive.** Every writer of `policy.toml`
   (`project add`, `scan --write`) takes `policy.toml.lock` (the ledger's
   rename-safe lock) and decides the free number and all collisions after
   re-reading the file inside it. The path must be a git repository root
   (`.git` directory or worktree file) unless `--allow-non-git` is passed.
   Adding a path that is already registered
   returns the existing entry unchanged. A name that already exists with a
   different path is an error. The command appends exactly one
   `[projects.<name>]` table at the end of the file and touches nothing
   else, so comments and ordering survive.
4. **`berth project list`** reports the registered projects with their
   blocks, in text or `--json`.
5. **The example policy becomes an example**, not the onboarding path. The
   README quick start is `init` → `project add .` → `check`.

## Consequences

- An agent can onboard the repository it is working in with one command
  and no human editing, which is what the `berth-onboard` skill (ADR-007)
  does.
- Project numbers are still permanent and still assigned once; automation
  cannot change them, only humans editing the file can, and the reconciler
  reports the resulting `drift`.
- Inferred `extras` names come from Compose service names, so a repo with
  unusual service names gets slots it may want to rename; the table is
  appended in plain TOML precisely so that is a one-line edit.
- The scan is heuristic (ADR-004's `scan` limits apply): ports found in
  configs are recorded as `declared`, which only makes conflicts visible;
  nothing is allocated from them.

## Alternatives Considered

- **Keep hand-editing with a better template.** Removes the wrong example
  but leaves the agent unable to register its own repo.
- **Rewrite the whole policy from a data model** (parse → mutate →
  stringify). Loses comments and ordering, which the design treats as part
  of the policy's job as the human-readable statement of the agreed rules.
- **Auto-register on first `berth env` in an unknown directory.** Silent
  allocation of a permanent number from a read command is exactly the kind
  of side effect ADR-003 keeps out of the read path.

## Compliance / Validation

- `tests/project.test.ts`: the template parses with defaults and mentions
  no machine-specific names; `init` refuses to overwrite; `appendProjectTable`
  leaves the existing text byte-identical as a prefix; lowest free P and
  exhaustion; scan-derived `declared` and Compose-derived `extras`;
  idempotent re-add; taken `--number` and conflicting `--name` errors;
  the `.bak` exists after a write.

## Council Review

All four reviewers: accept with changes. Shared finding: a lowest-free-number
allocation plus a read-validate-write of `policy.toml` races when several
sessions run `project add` at once, and `.bak` plus atomic rename does not
prevent two writers from each appending a different table with the same
number. **Adopted:** every writer of `policy.toml` (`project add`,
`scan --write`) serialises on `~/.config/berth/policy.toml.lock` using the
ledger's lock (rename-based stale break, pid start time); collisions and
the free number are decided inside the lock, after re-reading the file.
**Adopted:** the path must be a git repository root (`.git` directory or
worktree file) unless `--allow-non-git` is passed, so a stray
subdirectory cannot become a permanent project. **Adopted:** the scan is
best-effort and runs outside the lock; a scan failure never blocks
registration. A test registers four repositories concurrently and asserts
four distinct numbers and no lock left behind.
