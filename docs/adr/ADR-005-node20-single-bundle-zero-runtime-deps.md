# ADR-005: Node 20, Single Bundle, Zero Runtime Dependencies

**Status:** Accepted 2026-09-13
**Date:** 2026-09-13
**Decision Makers:** Chris (@amiable-dev), LLM Council
**Council Review:** 2026-09-13 — round one endorsed Node 20 and proposed the esbuild single file (adopted); round two found nothing decisive between Node and Go beyond pinning the interpreter path and caching the reconcile (`docs/DESIGN.md` §5.9, §6)
**Related:** ADR-003 (hook deadline), ADR-004 (reconcile cache); `docs/DESIGN.md` §5.5, §5.6, §5.9, §5.11; `SECURITY.md`

---

## Context

berth's hot path is a `SessionStart` hook that must land inside 200 ms
(ADR-003). Measured on this machine, `lsof` alone is ≈ 50 ms and Node startup
≈ 30–40 ms (`docs/DESIGN.md` §5.9), so an interpreted runtime fits the budget
with room to spare; the `lsof` and `docker` forks dominate in any language.
Node 20.20 is what is installed and what the existing Claude Code hooks on
this machine already run (`docs/RESEARCH.md`, "Evidence from this Mac").

Two platform facts constrain packaging. Hook environments do not see nvm or
mise shims, so a hook command that says `node` may find no interpreter or the
wrong one (§5.6, §5.11). And every runtime dependency is a supply-chain
exposure in a tool that reads process lists and Docker metadata and runs at
the start of every session on the machine (`SECURITY.md`).

The policy file is TOML, which Node does not parse natively.

## Decision

1. **TypeScript on Node 20.** `engines.node >= 20.10`; `.nvmrc` pins the
   major; CI tests Node 20 and 22 on Linux and macOS.
2. **One file.** esbuild bundles the CLI, hooks, reconciler and dashboard
   into a single `dist/berth.js`. The package ships `dist/`, `README.md`,
   `LICENSE` and `CHANGELOG.md` and nothing else.
3. **Zero runtime dependencies.** `package.json` has no `dependencies`
   block. `smol-toml` is a devDependency inlined by esbuild at build time;
   its MIT notice must be preserved in the published artefact. Anything that
   would need a native module is out.
4. **Absolute interpreter path in hooks.** The installed hook command is
   `/opt/homebrew/bin/node /abs/path/dist/berth.js context …`, or whatever
   `command -v node` resolves to at install time, never a bare `node`.
5. **`--json` is the boundary.** Every command accepts `--json`, and that
   output is the contract for the dashboard, scripts, other agents and a
   possible later port to Go or Rust. Human-readable output may change;
   `--json` shapes change only with a version note.
6. **The dashboard is served from the same bundle** (`berth ui`, port
   10000), polling `berth check --json`; no separate server, no framework.

Rejected: Go or Rust (nothing decisive; zero-runtime install is the one
advantage, and the `--json` boundary keeps that door open); Bun or Deno (not
what the hooks on this machine run); shipping with runtime dependencies for
convenience; `node:sqlite` (absent on Node 20.20).

## Consequences

**Positive.** `npm install -g @amiable-dev/berth` installs one file and no
transitive tree; `npm audit` on the installed package is empty by
construction; the hook is immune to shell-profile and version-manager drift;
the SessionStart budget is met with margin.

**Negative.** Node 20 left maintenance in April 2026. The floor is what the
reference machine runs and what its hook interpreter path points at; raising
it to 22 is a one-line `engines` change plus a CI matrix edit, and is
expected once that interpreter is upgraded. Bundling means a fix to
`smol-toml` needs a berth release. A single file makes stack traces less
readable; the build can emit a source map alongside the bundle.

**Neutral.** TypeScript is a build-time choice only; nothing in the
published artefact depends on it.

## Compliance / Validation

- CI asserts that `package.json` has no `dependencies` and that
  `node dist/berth.js --version` and `--help` run on a fresh checkout after
  `npm ci && npm run build`.
- Dependency Review and Dependabot cover the dev tree; a PR that adds a
  runtime dependency must cite an ADR that supersedes this one.
- A local (non-gating) timing test runs `berth context` against a fixture
  ledger and reports if wall-clock exceeds 200 ms.
