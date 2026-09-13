# ADR-007: Ship a Claude Code Plugin; Skills Teach, MCP Executes, Hooks Inform

**Status:** Accepted 2026-09-13
**Date:** 2026-09-13
**Decision Makers:** Chris (@amiable-dev), LLM Council
**Council Review:** 2026-09-13 — balanced tier, four reviewers (chairman synthesis unavailable that day; raw opinions used), see "Council Review" below
**Related:** ADR-001 (advisory), ADR-005 (single bundle), ADR-006 (self-configuring CLI), ADR-008 (agent guardrails); `docs/DESIGN.md` §5.6; `README.md` "Quick start"

---

## Context

Wiring berth into Claude Code by hand took three steps (`berth hooks
install`, appending rules to `~/.claude/CLAUDE.md`, `claude mcp add`), and
none of them taught a session *when* to use berth or how to register the
repository it is working in. The MCP server alone does not solve this: MCP
tools are verbs with typed inputs, they carry no procedure, and their
definitions cost context in every session whether or not ports come up.

Claude Code plugins package hooks (`hooks/hooks.json`), an MCP server
(`.mcp.json`) and skills (`skills/<name>/SKILL.md`) under one manifest
(`.claude-plugin/plugin.json`) and install with one command from a
marketplace. A marketplace entry may name an **npm package** as the plugin
source, and plugin installs never run package lifecycle scripts, so a
plugin installed from git would have to commit its compiled bundle, whereas
the published npm tarball already carries `dist/berth.js` (ADR-005).
`${CLAUDE_PLUGIN_ROOT}` is expanded in hook commands and MCP args.

## Decision

1. **The npm package is the plugin.** `package.json#files` adds
   `.claude-plugin`, `hooks`, `skills` and `.mcp.json`; the repository's
   `.claude-plugin/marketplace.json` lists one plugin, `berth`, with source
   `{ "source": "npm", "package": "@amiable-dev/berth" }`. Users run
   `claude plugin marketplace add amiable-dev/berth` then
   `claude plugin install berth@berth`. Nothing compiled is committed.
2. **Three layers with distinct jobs.**
   - *Hooks inform.* `SessionStart` runs `berth context` (read-only, hard
     deadline, exit 0 — ADR-003) and `SessionEnd` runs `berth session-end`,
     both through `hooks/run.sh`, a POSIX launcher that finds `node` on
     PATH or in the common version-manager locations, checks the bundle
     exists, and exits 0 with a stderr diagnostic rather than failing the
     session when either is missing. The MCP server uses the same launcher. This is the layer that makes a session right by default.
   - *Skills teach.* `berth-ports` (before binding anything, on "address
     already in use", when asked which port) and `berth-onboard` (register
     this repository: `doctor` → `init` if needed → `project add .` →
     `env` / `--compose-override` / `launch-json --write` → `check`).
     Skills load on demand, so they cost nothing until ports come up, and
     they replace the need to append rules to `CLAUDE.md`.
   - *MCP executes.* `.mcp.json` registers `berth mcp` for clients that
     prefer tools to a shell, exposing only the self-scoped operations
     (ADR-008). For Claude Code, which has Bash, the CLI's `--json` output
     is the primary interface and MCP is a convenience.
3. **One version.** The build syncs `.claude-plugin/plugin.json#version`
   to `package.json#version`; a test fails if they differ.
4. **Validated in CI and locally.** `claude plugin validate . --strict`
   must pass; `tests/plugin.test.ts` checks the manifest, hook commands
   (bundle path, `--hook`, timeouts ≤ 10 s), the MCP entry, skill
   frontmatter, the marketplace entry, and that skills never instruct a
   human-only command.
5. **Manual wiring stays supported** (`berth hooks install`,
   `claude mcp add --scope user berth -- berth mcp`,
   `examples/CLAUDE.ports.md`) for people who install the CLI without the
   plugin or use other agents.

## Consequences

- Installing berth into Claude Code is two commands and no file editing,
  and the agent can onboard its own repository through the skill and
  ADR-006's `project add`.
- The plugin's hooks are equivalent to the manual ones; installing both
  runs `berth context` twice per session start. `berth doctor` reports the
  manual hooks so a user can remove them after adopting the plugin.
- A plugin release is an npm release: the first version carrying the
  plugin files is 0.1.2, published through the staged release flow.
- Skills are prose the agent follows; the enforcement of "never kill,
  never force" is the CLI rail in ADR-008, not the skill text.

## Alternatives Considered

- **MCP only.** No session-start context, no procedure, no onboarding;
  manual registration remains.
- **Plugin from git with a committed bundle.** Works, but puts a build
  artefact in every commit and diverges from the npm artefact that CI
  signs with provenance.
- **Slash commands instead of skills.** Commands are user-invoked; the
  value here is the agent deciding to consult berth before it binds a
  port, which is what a skill's description triggers.

## Compliance / Validation

- `tests/plugin.test.ts` (see Decision 4); `claude plugin validate . --strict`
  in CI; `npm pack --dry-run` lists the plugin files; the build's version
  sync (`scripts/build.mjs`).

## Council Review

All four reviewers: accept with changes. Shared finding: a hook that runs
bare `node` fails silently when the hook environment lacks the
version-manager shims (nvm, fnm, mise, volta), which is exactly the case
ADR-005 guarded against with an absolute path. **Adopted:** hooks and the
MCP server run through `hooks/run.sh`, a POSIX launcher that takes `node`
from PATH or from the common install locations (Homebrew, mise, volta,
fnm, asdf, nvm), checks that the bundle exists, and for hook subcommands
exits 0 with a one-line diagnostic on stderr rather than failing the
session. **Adopted:** the packaging test inspects the real `npm pack`
file list rather than `package.json#files`. **Documented:** the marketplace
install needs one network fetch from npm; afterwards the plugin runs from
the local install, and `claude --plugin-dir` on a checkout works fully
offline. Reviewers also asked that `dist/` be built before publishing,
which the release workflow already does.
