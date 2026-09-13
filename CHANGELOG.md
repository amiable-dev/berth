# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/amiable-dev/berth/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/amiable-dev/berth/releases/tag/v0.1.0
