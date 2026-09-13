# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

Security fixes ship as patch releases on the latest minor. Before 1.0 there is
one supported minor at a time; upgrade to the latest release to receive fixes.

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report vulnerabilities via one of these methods:

1. **GitHub Private Vulnerability Reporting** (Preferred)
   - Go to the [Security tab](https://github.com/amiable-dev/berth/security)
   - Click "Report a vulnerability"
   - Fill out the private security advisory form

2. **Email**
   - Send details to: chris@amiable.dev with `berth security` in the subject
   - Ask for a PGP key if you need to send sensitive material

Private vulnerability reporting is enabled on this repository, so option 1 opens
a private channel visible only to maintainers.

### What to Include

Please include:

- A description of the vulnerability and which component it is in: a CLI
  command, the SessionStart/SessionEnd hooks, the reconciler and its parsers,
  the ledger and lock protocol, the dashboard, the policy parser, `berth scan`,
  or the release pipeline
- Steps to reproduce, ideally a minimal `policy.toml`, ledger state and command
- Affected versions (`berth --version`), Node version, OS and Docker runtime
- Potential impact: what an attacker gains and what they need first (another
  process on the machine? a crafted container name or compose label? a crafted
  repository config that `berth scan` reads? a hostile policy file?)
- Any suggested fixes (optional)
- Whether you would like to be credited

### Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Resolution Target**: Within 90 days (depending on severity)

### Disclosure Policy

- We will acknowledge your report within 48 hours
- We will provide a more detailed response within 7 days
- We will work with you to understand and resolve the issue
- We will credit you in the security advisory (unless you prefer anonymity)
- We ask that you give us reasonable time to address the issue before public disclosure

## Threat Model

berth is a local developer tool. It coordinates TCP ports between the
processes, containers and agent sessions of **one user on one machine**. It is
not a network service and it has no server-side component.

### What berth does

- **Reads** process and socket state with `lsof`, `netstat`, `docker ps` and
  `ps -E`, all as the invoking user, all read-only, none requiring sudo
  ([ADR-004](docs/adr/ADR-004-truth-sources-and-attribution.md)). `berth scan`
  additionally reads repository config files (compose files, Vite and Next
  config, `.env`) to find declared ports; it records port numbers only and
  must never store or print any other value from those files.
- **Writes** only under `~/.local/state/berth/` (ledger, claim files,
  tombstones, lock, generated compose overrides) and, when running as a hook,
  the file named by `CLAUDE_ENV_FILE`. It never edits a repository.
- **Opens one socket**, and only when asked: `berth ui` binds `127.0.0.1` on
  port 10000 (or `--port`). Nothing else listens, and berth makes no outbound
  connections: no telemetry, no update checks.
- **Never terminates a process on its own.** The only command that can is
  `berth free <port>`, which acts solely on explicit invocation and refuses a
  live lease held by another session unless `--force` is given. `stale`,
  `orphan`, `squatter` and `conflict` states produce advice, never action
  ([ADR-001](docs/adr/ADR-001-advisory-registry-not-enforcement.md)).
- **Ships as one file with zero runtime dependencies**, published to npm with
  provenance ([ADR-005](docs/adr/ADR-005-node20-single-bundle-zero-runtime-deps.md)).
  `npm audit` on the installed package is empty by construction.
- **Hooks are read-only**, always exit 0, and give up after 200 ms
  ([ADR-003](docs/adr/ADR-003-daemonless-ledger-and-lock-free-claims.md)).

### Trust boundaries

- **Trusted:** the user, their shell, `~/.config/berth/policy.toml`, and the
  files under `~/.local/state/berth/`. All are written by processes running as
  the user.
- **Untrusted data that berth parses:** process names, command lines, working
  directories, container names, compose labels, environment markers of other
  own-user processes, repository config files read by `berth scan`, and lease
  `note` fields. berth treats these as data: they are displayed, emitted as
  strings in `--json`, escaped in the dashboard, and never interpolated into
  a shell command or executed. A bug that lets any of them influence a command
  berth runs is in scope and high severity.
- **Content that reaches an agent's prompt:** the SessionStart hook injects
  scoped context (this project's block, its leases, shared services, and any
  live conflict touching this project) into the agent's context. When it
  names the holder of a conflicting port, that name (a container name, a
  session ID, a pid and command) originates outside berth. This is a
  low-bandwidth prompt-injection channel into any agent session on the
  machine; reports of a field that carries more than an identifier are in
  scope.

### Out of scope

- **A hostile process running as the same user.** It can already read and
  write everything berth can, including forging claim files or the lock.
  berth does not defend against it; such reports are welcome as hardening
  suggestions, not as vulnerabilities.
- **Multi-user machines.** The ledger is per user by construction. Note that
  the dashboard has no authentication: `127.0.0.1` is reachable by every
  local user, so do not run `berth ui` on a machine you share with people you
  would not show your process list to.
- **Misattribution.** berth may name the wrong owner for a port (the known
  weak paths are listed in `docs/DESIGN.md` §5.11). That is a bug, and it
  never causes an unrequested action, because there are none.
- **Anything a `--force` did.** `berth free --force` does what it says.

## Security Best Practices for Users

- Install from npm and verify provenance after installing:
  `npm audit signatures`.
- Hooks in `~/.claude/settings.json` run with your privileges at every
  session start. Use an absolute interpreter path and an absolute path to the
  bundle, and review the command after upgrading.
- `policy.toml` is trusted input; keep it in your dotfiles under review.
- Redact `berth check --json` and `berth who --json` output before posting it
  publicly: working directories, session IDs and process command lines can
  identify you and your projects.
- Do not run the dashboard on a shared machine.

## Automated Security Scanning

- **CodeQL** (`javascript-typescript`, `security-extended`) on every push and
  PR to `main`, and weekly.
- **Dependency Review** on every PR. berth has no runtime dependencies, so
  this covers the dev toolchain and GitHub Actions.
- **Dependabot** weekly for npm and GitHub Actions, with a 7-day cooldown so
  a freshly published (and possibly compromised) release is never adopted on
  day one.
- **OpenSSF Scorecard** weekly, with results published
  ([view score](https://scorecard.dev/viewer/?uri=github.com/amiable-dev/berth)).
- Every third-party GitHub Action is pinned to a full commit SHA, and every
  workflow declares least-privilege `permissions:`.
- Releases are published to npm through **trusted publishing** (OIDC). There
  is no long-lived npm token in the repository, and every release carries a
  Sigstore provenance attestation.

## Security Updates

Security updates are released as patch versions. Subscribe to:

- [GitHub Releases](https://github.com/amiable-dev/berth/releases) (Watch > Custom > Releases)
- [Security Advisories](https://github.com/amiable-dev/berth/security/advisories)

## Acknowledgments

We thank the security researchers who have helped improve the security of berth:

- (Your name could be here!)
