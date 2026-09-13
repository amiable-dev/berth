# Contributing to berth

Thank you for your interest in contributing to berth! This document explains how to set up a development environment, the conventions the project follows, and how changes are reviewed and released.

berth is small on purpose: a zero-dependency TypeScript CLI bundled to one file, a daemonless ledger, and a local dashboard. Read [docs/DESIGN.md](docs/DESIGN.md) before proposing anything structural; the decisions it records are summarised in [docs/adr/](docs/adr/).

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

### Prerequisites

- Node.js 20.10 or later. `.nvmrc` pins the major version; CI runs Node 20 and 22 on Ubuntu and macOS.
- npm 10 or later (bundled with Node 20).
- Git.
- Optional, for exercising the reconciler end to end: Docker via Colima, Docker Desktop or OrbStack, and Claude Code. Neither is needed to run the test suite.

berth is macOS-first because that is where the attribution problem it solves lives (Colima tunnels, AirPlay on 5000 and 7000, `lsof` and `ps -E` semantics). Linux is tested in CI and is expected to work wherever the truth sources have an equivalent.

### Development Setup

1. **Fork and clone the repository:**
   ```bash
   git clone https://github.com/YOUR-USERNAME/berth.git
   cd berth
   ```

2. **Select Node 20.** Any version manager that reads `.nvmrc` works:
   ```bash
   nvm use            # reads .nvmrc
   mise use node@20   # or enable idiomatic version files for node in mise
   ```

3. **Install dependencies:**
   ```bash
   npm ci
   ```
   Use `npm ci`, not `npm install`, when setting up: the lockfile is the contract. The published package has no runtime dependencies and must stay that way (see [ADR-005](docs/adr/ADR-005-node20-single-bundle-zero-runtime-deps.md)); everything under `devDependencies` is build tooling.

4. **Run the full check to verify setup:**
   ```bash
   npm run check      # lint (Biome) + typecheck (tsc) + test (Vitest) + build (esbuild)
   ```

### Running berth from source

`npm run build` writes the single-file bundle to `dist/berth.js`. Run it directly with Node:

```bash
npm run build
node dist/berth.js --help
node dist/berth.js check            # reconcile the ledger against what is listening
node dist/berth.js ls               # grouped Project → Worktree → Role table
node dist/berth.js who 13204        # lease, live holder, and how berth knows
```

To experiment without touching your real policy and ledger, point `HOME` at a scratch directory. berth reads `~/.config/berth/policy.toml` and writes only under `~/.local/state/berth/`:

```bash
export HOME="$(mktemp -d)"
mkdir -p "$HOME/.config/berth"
cp examples/policy.example.toml "$HOME/.config/berth/policy.toml"
node dist/berth.js check --json
```

### Running the dashboard

```bash
node dist/berth.js ui               # http://127.0.0.1:10000
```

berth is project 0 in the port scheme, so its own dashboard is port 10000 (`--port` overrides it). It binds `127.0.0.1` only and polls `berth check --json` every five seconds; the reconcile is cached for one second so polling cannot cause `lsof` storms. Front-end changes need a rebuild (`npm run build`) and a browser refresh.

### Wiring the Claude Code hooks to a source checkout

Hook environments do not see nvm or mise shims, so the hook command must use an absolute interpreter path and an absolute path to the bundle ([DESIGN.md §5.6](docs/DESIGN.md)). Resolve the interpreter once, when you configure the hook:

```bash
command -v node     # e.g. /opt/homebrew/bin/node
```

and use that path in `~/.claude/settings.json`, for example `/opt/homebrew/bin/node /ABS/PATH/TO/berth/dist/berth.js context --session "$CLAUDE_CODE_SESSION_ID" --cwd "$PWD"` for `SessionStart`. Rebuild after each change; the next session start picks up the new bundle. Hooks never write allocation state (they only record their own session file), must always exit 0, and SessionStart has a hard 180 ms budget ([ADR-001](docs/adr/ADR-001-advisory-registry-not-enforcement.md), [ADR-003](docs/adr/ADR-003-daemonless-ledger-and-lock-free-claims.md)).

## Development Workflow

### Creating a Branch

Create a feature branch from `main`:

```bash
git checkout main
git pull origin main
git checkout -b feature/your-feature-name
```

Branch naming conventions:
- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `refactor/` - Code refactoring
- `test/` - Test additions or fixes

### Making Changes

1. **Write tests first** (TDD approach encouraged)
2. **Make your changes**
3. **Let Biome fix what it can:**
   ```bash
   npm run lint:fix
   ```
4. **Run the full check:**
   ```bash
   npm run check
   ```
   The individual steps are `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`; `npm run test:watch` keeps Vitest running while you work.

Invariants to keep in mind while changing code:

- `berth check` always exits 0, and hooks never write the ledger and always exit 0 ([ADR-001](docs/adr/ADR-001-advisory-registry-not-enforcement.md)).
- `--json` output is a contract for the dashboard, scripts and other agents ([ADR-005](docs/adr/ADR-005-node20-single-bundle-zero-runtime-deps.md)). Additive changes are fine; anything else needs a CHANGELOG entry and a version note.
- The only command that may terminate a process is `berth free`, and only on explicit invocation.
- Truth sources are read-only and never need sudo ([ADR-004](docs/adr/ADR-004-truth-sources-and-attribution.md)).

### Commit Messages

We follow conventional commit format:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Formatting, no code change
- `refactor`: Code restructuring
- `test`: Adding tests
- `chore`: Maintenance tasks

**Scopes** (use the one that fits): `policy`, `ledger`, `reconcile`, `cli`, `hooks`, `ui`, `scan`, `env`, `ci`, `deps`, `docs`.

**Example:**
```
fix(reconcile): treat limactl as a VM proxy, never an owner

Colima's tunnel process was being reported as the holder of every
published container port. Attribution now falls through to the compose
working_dir label or the container name.

Closes #12
```

### Architecture Decision Records

Significant technical decisions are recorded as ADRs in `docs/adr/`, in the Michael Nygard format. The design in `docs/DESIGN.md` is the historical record of what was accepted on 2026-09-13; record changes to it as ADRs rather than editing it.

Write an ADR when a change would:

- alter a decision in `docs/DESIGN.md` §3 or §7 or in an existing ADR (for example, anything that blocks a command or kills a process automatically);
- change the port formula, the ledger or claim file formats, the lock protocol, or the policy schema;
- add or remove a truth source, or change how a listener is attributed;
- make a breaking change to any `--json` shape or to the hook contract;
- add a runtime dependency.

Process:

1. Copy [`docs/adr/ADR-000-template.md`](docs/adr/ADR-000-template.md) to the next number (`ADR-006-short-title.md`).
2. Open a PR with **Status: Proposed**. Cite the DESIGN.md sections and ADRs it touches.
3. Maintainers review; on merge the status becomes **Accepted**.
4. To change an accepted decision later, write a new ADR that supersedes it and update the old one's header.

Existing ADRs:

| ADR | Decision |
|-----|----------|
| [ADR-001](docs/adr/ADR-001-advisory-registry-not-enforcement.md) | Advisory registry, not enforcement |
| [ADR-002](docs/adr/ADR-002-decodable-port-scheme.md) | Decodable port scheme `10000 + 1000·P + 100·W + R` |
| [ADR-003](docs/adr/ADR-003-daemonless-ledger-and-lock-free-claims.md) | Daemonless ledger and lock-free claims |
| [ADR-004](docs/adr/ADR-004-truth-sources-and-attribution.md) | Truth sources and attribution |
| [ADR-005](docs/adr/ADR-005-node20-single-bundle-zero-runtime-deps.md) | Node 20, single bundle, zero runtime dependencies |

### Pull Requests

1. **Push your branch:**
   ```bash
   git push -u origin feature/your-feature-name
   ```

2. **Create a pull request** via GitHub

3. **Fill out the PR template** with:
   - Summary of changes
   - Related issues
   - Test plan
   - Checklist completion

4. **Address review feedback** promptly

5. **Ensure CI passes** before requesting merge. CI runs the full check on Ubuntu and macOS with Node 20 and 22, smoke-tests the built bundle, and asserts that `package.json` still has no runtime dependencies. CodeQL and Dependency Review also run on every PR.

## Testing

### Running Tests

```bash
npm test                 # run once
npm run test:watch       # watch mode
npx vitest run -t "who"  # tests whose name matches a pattern
```

### Writing Tests

- Tests run with [Vitest](https://vitest.dev/) and live under `tests/` as `*.test.ts` (the `include` pattern in `vitest.config.ts`), mirroring the layout of `src/`.
- Parse captured output, not live commands. The reconciler's `lsof`, `netstat`, `docker ps` and `ps -E` parsers should be tested against fixture text; CI runners have neither Colima nor a Claude session.
- Tests must not need sudo, Docker, the network, or your real `~/.local/state/berth/`. Use a temporary `HOME`.
- Time-sensitive logic (TTLs, lock staleness, grace periods) should take an injectable clock.
- Use descriptive names: `test_squatter_names_container_not_ssh`.

## Releasing (maintainers)

1. Move the `[Unreleased]` entries in `CHANGELOG.md` into a new `## [x.y.z] - YYYY-MM-DD` section and update the link references at the bottom of the file.
2. Bump the version: `npm version x.y.z --no-git-tag-version` (updates `package.json` and `package-lock.json`).
3. Open a release PR (`chore(release): vx.y.z`) and merge it to `main`.
4. Tag the merge commit and push the tag:
   ```bash
   git tag vx.y.z && git push origin vx.y.z
   ```
5. `.github/workflows/release.yml` verifies that the tag matches `package.json`, runs the full check, publishes `@amiable-dev/berth` to npm with provenance, and creates a GitHub Release whose notes are the matching CHANGELOG section. A tag with a prerelease suffix (`v0.2.0-rc.1`) is published under the `next` dist-tag and marked as a prerelease.

### One-time setup: npm trusted publishing

The release workflow authenticates to npm with GitHub's OIDC token (`id-token: write`), not a stored secret, so there is no `NPM_TOKEN` anywhere in the repository. This works only once the package's trusted publisher has been configured on npmjs.com:

npm only lets you configure a trusted publisher on a package that already exists, so a brand-new package needs one publish by hand first:

1. **First publish by hand** (once). From a checkout of the release commit: `npm login`, then `npm publish --access public`. `prepack` builds `dist/berth.js`; the tarball is only the bundle, README, LICENSE and CHANGELOG. If your npm account has 2FA on writes, the CLI asks for the one-time code. Create the matching GitHub release afterwards (`gh release create v0.1.0 --notes-from-tag` or from the CHANGELOG section); do not push a `v0.1.0` tag, because the release workflow would try to publish the same version again.
2. **Configure the trusted publisher.** On npmjs.com, open the `@amiable-dev/berth` package → **Settings** → **Trusted Publisher** → **GitHub Actions**. Enter organization/user `amiable-dev`, repository `berth`, workflow filename `release.yml`, environment `npm`, and save.
3. **Every later release** is a version bump in `package.json`, `package-lock.json` and `CITATION.cff`, a new `CHANGELOG.md` section, a commit, and a tag: `git tag -a v0.1.2 -m "berth 0.1.2" && git push origin v0.1.2`. The workflow runs the full check, builds, and **stages** the version on npm over OIDC with a Sigstore provenance attestation (no token anywhere), then creates the GitHub release from the CHANGELOG section.
4. **Approve the staged release.** The trusted publisher allows `npm stage publish` only, so nothing goes live until a maintainer approves it with 2FA:
   ```bash
   npm stage list @amiable-dev/berth      # shows the stage id
   npm stage approve <stage-id>           # prompts for the one-time password
   ```
   The `stage` commands need npm 11; on a machine whose Node ships npm 10, prefix them with `npx -y npm@11`.
   or approve from the package page on npmjs.com. The version is published at the dist-tag chosen at staging time (`latest`, or `next` for prerelease tags). Re-running a release workflow before approval fails on "already staged"; reject the stale stage first if you need to restage.

If the package does not yet exist on the registry, publish the very first version manually from a logged-in machine (`npm publish --access public`), then configure the trusted publisher as above. After that, never publish by hand.

## Issue Labels

| Label | Description |
|-------|-------------|
| `bug` | Something isn't working |
| `enhancement` | New feature or request |
| `documentation` | Documentation improvements |
| `good first issue` | Good for newcomers |
| `help wanted` | Extra attention needed |
| `needs-triage` | Needs maintainer review |
| `attribution` | The reconciler named the wrong owner |
| `dashboard` | `berth ui` |

## Questions?

- Check the [README](README.md) for usage documentation
- See [SUPPORT.md](SUPPORT.md) for support channels
- Open a [Discussion](https://github.com/amiable-dev/berth/discussions) for questions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
