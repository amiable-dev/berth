# ADR-008: What Agents May Do, and the Rail That Enforces It

**Status:** Accepted 2026-09-13
**Date:** 2026-09-13
**Decision Makers:** Chris (@amiable-dev), LLM Council
**Council Review:** 2026-09-13 — balanced tier, four reviewers (chairman synthesis unavailable that day; raw opinions used), see "Council Review" below
**Related:** ADR-001 (advisory, never kills), ADR-006 (self-configuration), ADR-007 (plugin, skills, MCP); `SECURITY.md`

---

## Context

berth is advisory: it never blocks a command and never kills a process on
its own (ADR-001). Two commands nonetheless have teeth. `berth free`
signals a process, and `--force` overrides an ownership refusal on
`claim`, `release` and `free`. `hooks install|uninstall` rewrites
`~/.claude/settings.json`; `worktrees prune` frees a permanent slot;
`init --force` replaces the policy.

With the plugin (ADR-007) every Claude Code session gets berth's skills
and MCP tools automatically. Skills can say "do not run `berth free`", and
the skills shipped here do, but prose is not a control: a session that has
been told by a hostile file to "free port 5432" would still be able to
type the command. The rule "berth never kills" should hold for a session
even when the session is wrong.

Every process a Claude Code session spawns carries `CLAUDECODE=1` and
`CLAUDE_CODE_SESSION_ID` in its environment (`docs/RESEARCH.md`, "Claude
Code platform facts"). berth already reads these markers to attribute
listeners (ADR-004); the CLI can read them about itself.

## Decision

1. **Two tiers of commands.**
   - *Self-scoped or read-only, available to agents:* `env`, `who`,
     `check`, `ls`, `scan` (read), `claim` (own session), `release` (own
     leases), `adopt --owner session`, `launch-json --write` (a file in the
     repo being worked on), `project add` for the repository the session is
     in, `worktrees list`, `names list|sync`, `doctor`, `compact`.
   - *Human-only:* `free`, any command with `--force`, `hooks install` and
     `hooks uninstall`, `worktrees prune`, `init --force`, `adopt --owner human`
     (it attributes a port to a person), and changing an existing project's
     number or another project's table (which berth has no command for at
     all).
2. **A rail in the CLI that fails closed.** A human-only command runs
   only when a human is demonstrably at the keyboard: stdin and stdout are
   an interactive terminal and neither `CLAUDECODE` nor
   `CLAUDE_CODE_SESSION_ID` is in the environment. Otherwise it is refused
   with exit 1 and a message that names the command and says a human
   should run it. The check happens in `main()` before any command code
   runs, so a skill, an MCP call or a Bash tool call all hit the same
   rail, and an agent that unsets the marker still has no terminal. This
   is protection against accidental misuse, not a security boundary: a
   determined operator can always run the same command from a real shell.
3. **An explicit override for humans working through an agent.**
   `BERTH_ALLOW_DESTRUCTIVE=1` disables the rail for that invocation. It is
   an environment variable rather than a flag so that a skill cannot pass
   it by accident from a tool call: the operator has to set it deliberately.
   Refused and allowed destructive invocations are appended to
   `~/.local/state/berth/audit.log` with the argv, the agent marker and the
   TTY state.
4. **The MCP server exposes only tier-one operations** (`check`, `who`,
   `ls`, `claim`, `release`, `env`). There is no MCP tool for `free`,
   `hooks`, `prune` or `init`, and tool inputs are validated (port range,
   string types) before they reach the CLI functions.
5. **Skills never instruct a human-only command.** `tests/plugin.test.ts`
   fails if a shipped skill mentions `berth free` or `--force`.

## Consequences

- An agent can do everything it needs day to day (learn its ports, claim,
  release, register its repo, check the truth) and nothing that removes a
  process, a slot or a hook.
- A human who works through Claude and wants to run `berth free` from that
  session sets `BERTH_ALLOW_DESTRUCTIVE=1` once for the command; the
  message says so.
- The rail is only as good as the marker: a process started with a
  scrubbed environment is not recognised as an agent. That is the same
  limit ADR-004 accepts for attribution, and the failure mode is the
  status quo (a human-equivalent invocation), not a new capability.
- `hooks install` refused inside an agent means the plugin's own hooks are
  the supported way to wire Claude Code (ADR-007); the manual install
  remains for humans.

## Alternatives Considered

- **Prose only in skills and CLAUDE.md.** Cheapest, and already present,
  but not a control.
- **A Claude Code `PreToolUse` hook that blocks `berth free`.** Blocking
  hooks were rejected for the registry itself (ADR-001, the owner's
  decision); a blocking hook for berth's own commands would reintroduce the
  mechanism through the back door and would only cover Claude Code.
- **Separate binaries or a `--yes-i-am-human` flag.** A flag is passable
  by a tool call; an environment variable is set by the operator's shell.

## Compliance / Validation

- `tests/project.test.ts` ("agent guard"): with `CLAUDECODE=1`, `free`,
  `hooks install`, `worktrees prune`, `release --force` and `init --force`
  all return 1 with a message naming the agent session and write nothing;
  with `BERTH_ALLOW_DESTRUCTIVE=1` the same `hooks install` succeeds;
  `version` is unaffected.
- `tests/plugin.test.ts`: shipped skills contain neither `berth free` nor
  `--force`; the MCP tool list in `tests/server-mcp.test.ts` is exactly the
  six tier-one tools.

## Council Review

All four reviewers: accept with changes. Shared finding: an environment
variable is not a security boundary (`env -u CLAUDECODE berth free`
defeats it), and the original design failed open on ambiguity. **Adopted:**
the rail is defined as protection against accidental misuse and fails
closed: a human-only command runs only when stdin and stdout are an
interactive terminal and no Claude marker is present, or when
`BERTH_ALLOW_DESTRUCTIVE=1` is set deliberately. An agent's Bash tool has
no terminal, so unsetting the marker no longer helps. **Adopted:**
`adopt --owner human` is human-only (it attributes a port to a person);
`adopt --owner session` remains available and still refuses a port that
already has a lease. **Kept:** `release --all` stays agent-usable because
without `--force` it only ever touches the caller's own leases.
**Adopted:** refused and allowed destructive invocations are appended to
`~/.local/state/berth/audit.log` with the argv, the agent marker and the
TTY state. **Declined:** a human-only marker file or OS-level approval;
for an advisory tool the TTY rule plus an explicit override is
proportionate, and the failure mode remains "a human-equivalent
invocation", never a new capability.
