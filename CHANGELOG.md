# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- ADR-009 (proposed, council-reviewed): how a registered repository stops hardcoding ports. Environment first, the project's own W0 port as the default, strict bind; a `berth-migrate` skill with one recipe per tool (#17); three scanner zones so a migrated default is never re-declared, and `berth project declared --prune` as a rail-guarded, audited exception to additive-only policy edits (#16).
- `berth shell-init zsh|bash|fish` prints a directory-change hook for your rc file: entering a registered project's checkout exports its ports, leaving it unsets them, and moving between two directories of the same project costs nothing (no `berth` process spawned unless the project root changed) (#21).
- `berth env --shell --unset` prints `unset` lines for every variable `--shell` would export in the same context, including the shared ones, and nothing else — what `shell-init` evals when leaving a project (#21).
- `berth env --compose-override` detects a mapped service whose currently-declared port is already held by a container without compose labels (started with `docker run`) and prints a per-service warning — the recreate command with its volumes, and a caution for an anonymous volume or an image that keeps state only in memory unless configured — instead of a silently ineffective override; `berth who` adds `started by: compose <project> | docker run` and mounted volume names to a container holder's evidence; `berth doctor` reports the Compose flavour on this machine (`docker compose` plugin, standalone `docker-compose`, or none) and its version, which the override output now names for the next step (#22).
- `berth tidy [--project X] [--dry-run] [--json]`: one human command that applies the leftover-cleanup plan an agent has already shown. `--dry-run` (and `--json`) list `stale`/`orphan` leases it would release, any owner, and `unmanaged` ports it can only suggest adopting; applying — human-only under ADR-008 — releases exactly that plan with one audit line per port and is idempotent. The human-only refusal message now explains why and, when it applies, names the `berth tidy --project <name>` apply path, and `berth check`'s attention summary ends with one `run: berth tidy --project <name>` line per project with something to release (#20).

### Changed

- The npm package's `homepage` is the documentation site (https://amiable-dev.github.io/berth/) instead of the README; npmjs.com and `npm docs` link there from the next release.
- Reconciler: a live holder inside a project's own block that is already attributed by evidence (compose `working_dir` label or process cwd) is now `ok` with no lease required, instead of `unmanaged`. `PortRecord` gains `attribution: 'lease' | 'evidence'`; a holder with no attribution stays `unmanaged`, and a container started outside Compose gets advisory copy that says so instead of the generic adopt text (#19).
- `berth launch-json --write` no longer writes a machine-specific `cwd` for the common case: entries omit `cwd` when it equals the repository root, and write it relative to the repository root when `--cwd` points elsewhere. After writing, `.claude/launch.json` is appended to `.git/info/exclude` (never `.gitignore`) unless it is already tracked or ignored, so it is never committed by accident; `--no-exclude` opts out (#23).
- `berth env --shell` outside a registered project no longer fails: it exits 0, prints only the machine-wide `BERTH_SHARED_*` exports plus a comment naming the fix (`berth project add .`), and writes nothing to stderr, so a shell rc file can `eval` it on every prompt without noise. `--strict` restores the old exit-1 behaviour; `--dotenv`, `--compose-override` and `--json` are unchanged and still fail loudly (#21).

## [0.1.5] - 2026-09-14

**Docs release.** A documentation site for engineers at https://amiable-dev.github.io/berth/, and the dashboard header links to it and to the repository.

### Added

- Documentation site at https://amiable-dev.github.io/berth/ (VitePress in `docs/`, built and deployed by `.github/workflows/docs.yml`): getting started, concepts, day-to-day use, Claude Code and agents, the dashboard, troubleshooting, and CLI, policy, JSON/MCP and safety references, plus the design document and ADRs.
- The dashboard header links to the documentation and the GitHub repository (icons left of the search box).

### Fixed

- Docs site: the theme's own templates (site title, search label, hero buttons, breadcrumb) rendered literally because the Vue delimiters had been changed to protect the Docker `{{.Label}}` examples in the research page. Those tables are now `v-pre` containers instead, and the docs build fails if unrendered templates reach the static HTML.

## [0.1.4] - 2026-09-14

**Process release.** Changelog entries are now enforced per pull request, governance documents the single-maintainer period, and the 0.1.1 release date is corrected.

### Changed

- Every pull request must add a note under `[Unreleased]`: a required CI check fails otherwise (Dependabot PRs and the `skip-changelog` label are exempt). GOVERNANCE.md describes the single-maintainer period and what changes when a second maintainer joins.

## [0.1.3] - 2026-09-14

**Agent sessions need nothing but the plugin.** The plugin now carries `bin/berth` and puts it on each session's PATH, so `berth` works from Claude Code without a global install.

### Added

- `berth doctor` recognises the installed Claude Code plugin and warns when the manual hooks are also present.
- The plugin ships `bin/berth`, and the SessionStart hook puts it on the session's PATH, so `berth` works in every Bash call of a Claude Code session without a global npm install (`BERTH_BIN` is exported either way). The README now documents installation from an agent session and from a terminal separately, with a who-does-what table; the skills mention the MCP tools as an alternative to the CLI.

## [0.1.2] - 2026-09-14

**The plugin release.** berth becomes a Claude Code plugin (hooks, MCP server, two skills) installable from the repository's own marketplace; the CLI configures itself (`berth init`, `berth project add`); human-only commands are fenced off from agent sessions; the repository is hardened and every code-scanning finding is resolved.

### Added

- `berth init` writes a generic starting policy; `berth project add [path]` registers a repository with the next free permanent number, its scanned `declared` ports and Compose-derived `extras`, additively and idempotently; `berth project list` (ADR-006).
- Claude Code plugin in the repository and the npm package: SessionStart/SessionEnd hooks, the MCP server and two skills, `berth-ports` (day-to-day) and `berth-onboard` (register the repo you are in), installable from the repo's own marketplace (ADR-007).
- README quick start: install, `init`, `project add .`, `check`; the example policy is now a worked example rather than the onboarding path.

### Security

- Repository hardening: `main` ruleset (pull request required, six required checks, linear history, squash only, no force-push or deletion, no bypass), private vulnerability reporting, read-only default Actions token, Dependabot security updates and secret-scanning push protection; CodeQL findings resolved (TOCTOU reads, view dispatch, exception text in the dashboard API) and workflow installs pinned.
- Agent guardrail (ADR-008): `free`, any `--force`, `hooks install|uninstall`, `worktrees prune`, `init --force` and `adopt --owner human` run only for a human at an interactive terminal with no Claude marker in the environment, or with `BERTH_ALLOW_DESTRUCTIVE=1` set deliberately; refusals and overrides are logged to `~/.local/state/berth/audit.log`; shipped skills never name those commands and the MCP server exposes only self-scoped tools.
- Writers of `policy.toml` (`project add`, `scan --write`) serialise on a lock; `project add` requires a git repository root unless `--allow-non-git`.
- The plugin's hooks and MCP server start through `hooks/run.sh`, which finds Node in common version-manager locations and never fails a session when it cannot.

## [0.1.1] - 2026-09-14

**Review fixes, a map that shows what is actually running, and a README people can start from.** Everything an eight-angle code review of 0.1.0 found is fixed; the dashboard map now surfaces legacy ports per project; the README leads with the decode plate and a day-to-day guide.

### Added

- Map view: each project row starts with a `legacy` group, one numbered cell per live or declared port outside the block scheme, coloured and hatched by state with the same tooltip and drawer as block cells; rows light up when anything is bound.
- Dashboard deep links: `?view=map|table|sessions|rules|term` and `?theme=light|dark` (a theme from a link is not persisted).
- `--json` on `free`, `names sync`, `worktrees list`; `compact --json`.
- README with the decode plate and real dashboard captures, a plain overview and a day-to-day section; `docs/images/README.md` documents how the captures are made.

### Changed

- The SessionStart hook is read-only against allocation state: it no longer assigns worktree slots or takes truth snapshots, races a hard 180 ms deadline, and always exits 0. SessionEnd only records its session file; the reconciler already treats an ended session's unbound leases as stale.
- `berth claim` and `berth adopt` report exit 1 when compaction dropped the claim because an older claim by another session holds the port; the dynamic pool retries other ports.
- `berth release` reaches leases that still live in another session's un-compacted claim file.
- `berth ui` releases its own lease through the ledger when it stops.
- A session's lease list contains only ports present in the report; ephemeral listeners that merely carry the session marker are attribution evidence.
- Releases are staged on npm for maintainer approval with 2FA (`npm stage publish` over OIDC with provenance); the workflow skips staging when the version is already on the registry, so re-running a tag and the hand-published first release are both safe.
- Dependabot ignores `@types/node` and `vitest` majors; both move with `engines.node`.

### Fixed

- Ledger lock: stale locks are broken by rename, so two waiters can no longer both break a dead holder and one remove the other's live lock; a live pid's lock is never broken, even when its start time cannot be read.
- Parallel `berth claim` calls within one session no longer overwrite each other's claim file (per-session claim lock).
- A lease claimed from a shell is no longer reported as `conflict` when the server it started has a different pid and no session marker.
- `berth free` no longer honours a `--session` override that bypassed the other-session refusal, and validates the pid before signalling.
- Degraded truth snapshots (docker, netstat or session markers skipped) are neither cached nor served from cache.
- `adopt --owner human` records the user, never a Claude session id; human pseudo-sessions count as alive while their lease pids are.
- netstat rows on macOS that carry a `process:pid` token are parsed correctly; `lsof` runs with `+c 0`.
- The dashboard derives the block base, ranges and pools from the report instead of hardcoding 10000/40000, skips re-rendering when the report is unchanged (keeps focus and hover), and composes holder text from fields.

## [0.1.0] - 2026-09-13

**Initial release.** The council-reviewed design in `docs/DESIGN.md`, recorded as ADR-001 to ADR-005, implemented end to end: policy and port scheme, ledger, reconciler, CLI, Claude Code hooks, dashboard, MCP server and the portless / launch.json edges.

### Added

- **Policy** (`~/.config/berth/policy.toml`): the decodable port rule `10000 + 1000·P + 100·W + R` with permanent project numbers, ten canonical roles plus per-project extras, a dynamic TTL pool, reserved ranges and ports, a lint list of well-known defaults, shared services with an owner, legacy `declared` ports, and an `ignore_processes` list for IDE helpers that bind random loopback ports.
- **Ledger** (`~/.local/state/berth/`): atomic `leases.json` with `.bak`, lock-free per-session claim files folded under a single lock whose metadata carries the holder's pid start time, O_EXCL worktree slots with tombstones, per-session records.
- **Reconciler**: lsof, netstat, Docker compose labels and `ps -E` session markers produce one of eight states per port (`ok`, `idle`, `stale`, `orphan`, `unmanaged`, `squatter`, `conflict`, `drift`) with evidence and an advisory. Colima and Docker Desktop proxies are never treated as owners.
- **CLI**: `ls`, `who`, `check`, `env` (`--shell`, `--dotenv`, `--compose-override` with the `!override` tag), `claim` (role, extra, explicit or dynamic), `release`, `adopt`, `free` (refuses other sessions' ports), `scan --write`, `compact`, `worktrees`, `doctor`, `--json` on every read.
- **Claude Code integration**: `context` (SessionStart, read-only, injects the project's block and exports role ports through `CLAUDE_ENV_FILE`), `session-end` (soft-release), `hooks install|uninstall|print`, `launch-json --write` for the desktop preview pane, and the rules text in `examples/CLAUDE.ports.md`.
- **Dashboard** (`berth ui`, 127.0.0.1:10000): sessions, grouped table, range map with legacy strip, rules, terminal mock, and the port drawer, built to the design handoff; polls `/api/state` every 5 s against a 1 s server cache.
- **MCP server** (`berth mcp`): stdio JSON-RPC exposing `berth_check`, `berth_who`, `berth_ls`, `berth_claim`, `berth_release`, `berth_env` without an SDK dependency.
- **Names**: `names sync` creates portless aliases for http leases (`<project>.localhost`, `<worktree>.<project>.localhost`).
- Public-repo scaffolding: MIT licence, Contributor Covenant, contributing / security / support / governance docs, SHA-pinned CI, CodeQL, Scorecard, dependency review, tag-driven release with npm provenance, Dependabot with cooldown.

### Security

- Truth sources are read-only and never need sudo; only three Claude marker variables are extracted from process environments and nothing else is retained.
- No shell is ever spawned: every external command runs through `execFile` with an argument array and a timeout.
- The dashboard binds 127.0.0.1 only, serves GET/HEAD, never touches the file system, and sends a per-response nonce CSP, `frame-ancestors 'none'`, `nosniff` and `no-store`; `/api/state` refuses cross-site requests.
- `free` signals only own-user pids, never containers or VM proxies, and refuses ports held by another live session unless forced.
- State files are created 0600 in a 0700 directory; hook commands use absolute interpreter and script paths.
- Zero runtime dependencies; the single bundle is built with esbuild and published with npm provenance.

[Unreleased]: https://github.com/amiable-dev/berth/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/amiable-dev/berth/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/amiable-dev/berth/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/amiable-dev/berth/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/amiable-dev/berth/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/amiable-dev/berth/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/amiable-dev/berth/releases/tag/v0.1.0
