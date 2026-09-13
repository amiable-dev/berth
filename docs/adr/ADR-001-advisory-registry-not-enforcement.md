# ADR-001: Advisory Registry, Not Enforcement

**Status:** Accepted 2026-09-13
**Date:** 2026-09-13
**Decision Makers:** Chris (@amiable-dev), LLM Council
**Council Review:** 2026-09-13 (two rounds; `docs/DESIGN.md` §6) — option C ranked first in both rounds; the advisory stance was a stated requirement (§3) and was not contested
**Related:** ADR-003 (ledger), ADR-004 (truth sources and states); `docs/DESIGN.md` §2, §3, §5.4, §5.6, §5.11

---

## Context

One machine runs thirty-four Claude Code project contexts, several of them
parallel worktrees of one repository, plus servers started by hand from VS
Code or a terminal (`docs/DESIGN.md` §2). Nine repositories declare port 3000
and five declare 5432. Frameworks auto-increment silently (Vite 5173 → 5174,
Next 3000 → 3001), so an agent's belief about its port diverges from reality
and it loops on connection-refused with no signal that it is wrong. Docker
runs through Colima, so every published container port appears in `lsof`
under one `ssh` process whose cwd is whichever repository happened to run
`colima start`; attribution is wrong by default.

Claude Code offers a `PreToolUse` hook that can deny a command with a reason
(`docs/RESEARCH.md`, "Claude Code platform facts"), so blocking is available.
The forces against using it:

- Attribution is imperfect: Colima proxies, unlabelled `docker run`
  containers, human-started servers. A gate built on imperfect attribution
  produces false denials, and a false denial costs a session far more than a
  port collision does.
- A gate needs a decision on every tool call, which puts a daemon or a lock
  on the hot path of thirty concurrent sessions (ADR-003 explains why the
  ledger is daemonless).
- Enforcement only reaches tools that expose a deny hook. Humans, scripts and
  other agents would stay unmanaged, so the registry would be authoritative
  for some consumers and advisory for the rest.
- The requirement was fixed before design began: "Advisory only: registry,
  injected context and written rules. No hook blocks a command." (§3).

## Decision

berth is an advisory registry. It records who may use which port and reports
who actually holds it. It never prevents a bind and never terminates a
process on its own initiative.

1. **No hook blocks a command.** The Claude Code integration is a read-only
   `SessionStart` hook that injects scoped context and exports `PORT`-style
   variables, and a `SessionEnd` hook that soft-releases dynamic leases
   (§5.6). Neither writes the ledger; both always exit 0.
2. **`berth check` always exits 0.** The states in ADR-004 are information,
   not gates. Each carries an advisory response (suggest `berth release`,
   offer `berth adopt`, name the squatter) and none carries an action.
3. **The only destructive command is explicit.** `berth free <port>` acts
   only when a human or agent invokes it, and refuses a live lease held by
   another session unless `--force` is given (§5.5). `stale` and `orphan`
   leases are never auto-killed and never auto-released.
4. **Strict port is the non-negotiable rule.** The rules installed in
   `~/.claude/CLAUDE.md` require passing the port explicitly and using strict
   mode (`vite --strictPort`), because advisory coordination only works when
   a framework cannot drift silently (§5.6).
5. **Discovery replaces prevention.** Injected context, `berth who <port>`
   and the `conflict` state give a session a way to learn that its belief is
   wrong. That is how a mistaken session recovers.

## Consequences

**Positive.** No daemon and no lock on the hot path; thirty hooks at once
contend on nothing. No false denials from imperfect attribution. The same
CLI and rules serve humans, scripts, Claude Code and any agent adopted later,
so the registry is equally authoritative, which is to say equally advisory,
for all of them. A later port to a compiled binary changes nothing here.

**Negative.** A session that ignores the rules can still squat a port; berth
will name it, not stop it. Correctness depends on the rules being present in
the agent's context, on strict port being honoured, and on the human reading
the dashboard. Detection is only as good as the truth sources in ADR-004.

**Neutral.** A `PreToolUse` deny hook remains possible as an opt-in later.
It is out of scope for v1 and would need its own ADR, because it reverses
this one's central trade-off.

## Compliance / Validation

- Tests assert that `berth check` exits 0 in every one of the eight states.
- Tests assert that `berth context` (the hook entry point) performs no write
  under `~/.local/state/berth/` and exits 0 on lock timeout.
- Code review rejects any process-termination call outside `berth free`.
- `docs/DESIGN.md` §5.4 ("`berth check` always exits 0") is the reference.
