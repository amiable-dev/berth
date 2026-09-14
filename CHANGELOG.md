# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-09-14

**Agent sessions need nothing but the plugin.** The plugin now carries `bin/berth` and puts it on each session's PATH, so `berth` works from Claude Code without a global install.

### Added

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

## [0.1.1] - 2026-09-13

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

[Unreleased]: https://github.com/amiable-dev/berth/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/amiable-dev/berth/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/amiable-dev/berth/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/amiable-dev/berth/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/amiable-dev/berth/releases/tag/v0.1.0
