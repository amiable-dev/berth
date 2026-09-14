# ADR-009: Port Migration Recipes: How a Registered Repository Stops Hardcoding Ports

**Status:** Proposed 2026-09-14 (becomes Accepted when the tracking issues land)
**Date:** 2026-09-14
**Decision Makers:** Chris (@amiable-dev), LLM Council
**Council Review:** 2026-09-14 — quick tier, two of four reviewers responded (two timed out; an earlier balanced-tier attempt timed out entirely), chairman synthesis used, see "Council Review" below
**Related:** ADR-001 (advisory, never kills), ADR-002 (the decodable port scheme), ADR-006 (self-configuring CLI), ADR-007 (plugin, skills, MCP), ADR-008 (agent guardrails)

---

## Context

Registering a repository (`berth project add`, ADR-006) gives it a permanent
block and records the ports its configs already hardcode as `declared`. That
makes collisions visible; it does not remove them. On the machine this was
designed on, 21 projects are registered and the legacy declarations still
collide: four sites declare 3000, four Vite apps declare 5173, four projects
declare 5432, two Wrangler workers declare 8787. Every one of those is a
collision the moment two of them run at once, and the dashboard says so, but
nothing changes until each repository's own run configuration reads berth's
numbers instead of a literal.

The `berth-onboard` skill (ADR-007) already has a step for this: "point the
code at the numbers, with the human's approval; propose the diff, apply it
only when asked". It gives no per-tool guidance, so each session re-derives
the recipe, and the results vary: some fall back to the old literal, some
forget strict mode, some rewrite Compose files by hand, some leave the CORS
allowlist on the old number. A migration that is re-invented per session is
not a migration.

Constraints the recipes inherit:

- berth is advisory and language-agnostic (ADR-001). It does not rewrite
  application code; it tells sessions the numbers.
- The policy is edited additively by the CLI and never by hand from an agent
  session (ADR-006). Anything that reduces what berth can see is a human
  decision (ADR-008).
- `P` is permanent (ADR-002): a project's W0 numbers never change. Worktrees
  W1–W9 get their own hundred, and dynamic claims live in 40000–41999. A
  migrated repository must work in all three cases.
- Many of these repositories are public. Contributors and CI run them
  without berth, so a migrated config must still start with no environment
  at all, and the migration diff is a pull request the upstream maintainer
  may decline.

## Decision

1. **Target state per config: environment first, project default second,
   strict bind.** A migrated setting reads its role variable (`PORT`,
   `API_PORT`, `DB_PORT`, …); when the variable is absent it falls back to the
   project's own W0 canonical port, never to the legacy literal; and the
   server binds strictly (Vite `strictPort`, or the equivalent) so a taken
   port stops the process instead of incrementing. Environment first is what
   makes W1–W9 and dynamic claims work; the W0 default is decodable and
   collision-free on the owner's machine and is simply an unusual free port
   anywhere else; strict bind keeps the rule "if the port is taken, stop and
   report". Four conditions travel with the default:
   - `P` is never reassigned. The committed default is only honest because
     ADR-002 makes the number permanent; this ADR restates that as an
     invariant the policy tooling must keep.
   - The number is documented as arbitrary but stable, with its provenance:
     the README line reads like "local ports: `PORT`, default 13000 (berth
     project 3, web; any free port works, set `PORT` to override)".
   - Upstream may decline. For a repository the human does not own, the diff
     is a pull request like any other; if it is not merged, the local
     checkout still works through `berth env`, never through a local edit
     that is kept out of git.
   - Collateral moves with the port. Everything that names the old number
     is in scope: CORS allowlists, OAuth callback URLs, proxy targets,
     Playwright `baseURL` and `webServer.url`, devcontainer `forwardPorts`,
     `.vscode/launch.json`, and links in docs. A recipe that changes the
     default and leaves one of these behind has produced a broken
     repository.

2. **A separate skill, `berth-migrate`, with one recipe per tool.** The
   skill carries `recipes/<tool>.md` files loaded on demand: `vite`, `next`,
   `docusaurus`, `wrangler`, `compose`, `dotenv`, `procfile`, `python`
   (uvicorn, Django, Flask), `storybook`, `playwright` (which also covers
   Cypress and Vitest UI as test-runner web servers), `monorepo`,
   `shared-stack` and `generic-cli` for anything that takes `--port`. The
   role map that decision 5 describes lives once, in `recipes/_roles.md`,
   and `berth-onboard` step 4 refers to it and hands off to this skill. The
   trigger is distinct from onboarding: "migrate this repo's ports", "stop
   hardcoding ports", or a session context that reports declared legacy
   ports for the current project. Onboarding is additive registration;
   migration is a code change that wants review. Separate descriptions keep
   both triggers precise, and the shared role map keeps the two skills from
   forking.

3. **Each recipe has the same shape.** Eleven sections: *applies-to* (tool
   and the version range the recipe was validated against), *detect* (which
   files and patterns mark this tool, and which generated or vendored paths
   it must never touch), *map* (which hardcoded port becomes which role,
   with the ambiguous cases named), *edit* (the exact before/after for config
   files and for `package.json` scripts, in a form that re-running leaves
   unchanged, and in a cross-platform form where the repository has Windows
   contributors: reads inside the config file, or `cross-env`/`dotenv-cli`,
   never `${PORT:-13000}` in an npm script), *default* (the W0 form for that
   tool), *strict* (how to fail on a taken port), *side-channels*
   (HMR/websocket ports, `hmr.clientPort` behind a proxy, preview servers,
   inspector ports; allocated from `extras`, and never asserting a universal
   HMR number), *collateral* (the references from decision 1 that must move
   with the port), *host-binding* (`localhost` versus `127.0.0.1` versus
   `0.0.0.0`, which decides whether a strict bind that says "free" is
   reachable from the browser, WSL or a container), *verify* (the command
   that proves the expected process, not merely something, is listening on
   the berth port: `berth who <port>`), and *rollback* (what to revert). A
   recipe that cannot fill a section writes `N/A: <reason>`; a recipe with a
   section missing is not shipped.

4. **Compose is migrated in the file, with the override as the fallback.**
   The in-file form `"${DB_PORT:-15002}:5432"` is the default recipe:
   Compose reads interpolation from the shell and from `.env`, the form is
   idiomatic, and a plain `git clone && docker compose up` lands on the
   project's own number instead of reproducing the four-Postgres collision.
   The override file printed by `berth env --compose-override` remains the
   migration for Compose files that cannot take interpolation (secrets,
   runtime templating, files the human does not want touched). The recipe
   states the hand-off: in a berth session the variables are already in the
   environment; in a plain terminal `berth env --shell` or a `.env` line
   supplies them; otherwise the default applies.

5. **Role mapping is by tool semantics, confirmed by the human.** A Vite or
   Next dev server is `web`; Wrangler is `api` unless it is the only server,
   in which case `web`; Postgres is `db`, Redis is `cache`, an SMTP sink is
   `smtp` and its UI `mail-ui`, an OTLP collector `otlp-grpc`/`otlp-http`;
   Storybook, a docs site or a test-runner web server is an `extras` slot
   named after the tool. Anything else becomes an `extras` slot named after
   the service. A monorepo with several dev servers maps them to distinct
   roles and extras within the same `P`; it never borrows the worktree
   dimension, and a package that is a separate product registers as its own
   project. The skill states its mapping and the human corrects it before
   any edit.

6. **The agent proposes, the human applies, berth verifies; pruning is a
   rail-guarded, audited exception to "additive only".** The skill produces
   one diff per file with its evidence (file and line of the literal, the
   role it maps to, the new default), including the README and
   `.env.example` lines of decision 9, applies them only on explicit
   approval, then runs `berth check` and a re-scan. It never edits the
   policy. Removing entries from `declared` is the one subtractive policy
   change the CLI performs, and ADR-009 records it as a narrow carve-out
   from ADR-006 with this protocol:
   - `berth project declared [path]` lists each entry with the current
     scan's evidence (file and line) or marks it `stale`. It is read-only and
     agent-available; `--add <port>` is additive and agent-available.
   - `berth project declared --prune` removes only entries that are absent
     from the same fresh scan it prints; it never prunes from a cached
     result, and `--dry-run` shows the outcome without writing.
   - `--prune` and `--remove <port>` are human-only under the ADR-008 rail:
     they run for a human at a terminal without Claude markers, or when
     `BERTH_ALLOW_DESTRUCTIVE=1` is set deliberately for that invocation.
     The rail is the approval mechanism: an agent that has been told "yes"
     still cannot run it without the human setting the variable.
   - Every prune appends what was removed and why to
     `~/.local/state/berth/audit.log`, and the policy's `.bak` is written
     first, so the file's history stays additive even when its content
     shrinks.

7. **Scanner zones: three, stated exactly.** A project's block is
   `[10000 + 1000·P, 10000 + 1000·P + 999]`; the W0 slice is its first
   hundred. `berth project add` and `berth scan --write` classify every
   literal they find:
   - *outside the block*, including the dynamic pool 40000–41999: legacy;
     recorded in `declared`, takes part in collision checks. A hardcoded
     pool number is a stale artefact, not a claim, and stays visible.
   - *inside the W0 slice, read environment-first*: canonical; silent,
     never written to `declared`.
   - *inside the block but not environment-first* (a bare `13000`, or any
     W1–W9 number in a committed file): reported by `berth scan` as
     "canonical literal, needs the environment-first form", never written
     to `declared`. A bare W0 literal is right for one worktree and wrong
     for the other nine; the report keeps that visible without turning the
     project's own number into a legacy cell.
   Without this, a migrated default would be re-declared on the next scan
   and the map would show a legacy cell forever. `berth scan --help` states
   the zones. What counts as "inside" for a monorepo sub-package is decided
   by the recipe's *map* section, not by the scanner.

8. **Shared stacks: point at the exports, gate the duplicate, defer the
   lifecycle.** A repository that runs its own copy of a shared service
   (Grafana, Prometheus, an OTLP collector) gets the `shared-stack` recipe,
   limited to what berth provides today: its exporter or OTLP endpoint reads
   `BERTH_SHARED_<STACK>_<SERVICE>` (exported by `berth env` from the
   policy's `[shared.<name>]` table), and the duplicate service moves behind
   a Compose profile so a plain `docker compose up` no longer starts it. The
   owner project is exempt. What happens when an owner project is removed,
   who validates a shared port, and what a contributor without berth should
   see are open questions for a later ADR; the recipe does not answer them.

9. **The numbers are written down where contributors look.** The migration
   adds one line to the repository's README (the provenance sentence of
   decision 1) and the defaults to `.env.example`. These are code changes
   and ride in the same one-diff-per-file approval as the config edits; they
   are never written silently after the config diff is approved.

## Consequences

- Each repository is reviewed once, by its owner, with a diff that names
  every literal it replaces and every reference that moves with it. After
  that, sessions, worktrees and dynamic claims all work without further
  edits, and `berth check` for that block reads `ok` or `idle`.
- The W0 default puts a number chosen by one machine's policy into a
  repository other people clone. That number is arbitrary to them, the same
  way 3000 was, less likely to be occupied on their machine than 3000 or
  5432, and stable because `P` is permanent.
- Compose files change in place. The `${VAR:-default}` form is harmless
  without berth and idiomatic with it; the override file becomes the
  exception rather than the rule, which reverses the onboard skill's current
  wording.
- The scanner change (decision 7) alters `scan --write` and `project add`:
  literals inside the block are no longer `declared` entries. Existing
  entries are not removed automatically; `declared --prune` does that with
  evidence, and only for a human.
- `declared --prune` is the first subtractive policy command. The rail, the
  dry run, the same-scan rule and the audit line are what make it
  acceptable under ADR-006 and ADR-008; a future subtractive command needs
  the same four.
- The recipe list is longer than the scanner's file patterns today
  (Storybook, Playwright, devcontainers, VS Code launch files are not
  scanned). The scanner grows to match as recipes ship, so that *verify*
  and *detect* agree.

## Alternatives Considered

- **Fall back to the legacy literal.** Rejected. The collisions return the
  moment a terminal has not run `berth env`, which is exactly the situation
  the registry was built to make visible. A migration that keeps the old
  number as the default has not migrated. One council reviewer proposed the
  variant "public defaults in the repository, W0 as a local override";
  declined for the same reason, and because a local override kept out of
  git is invisible to the next session.
- **No fallback; fail when the variable is unset.** Rejected. It is hostile
  to contributors and CI, and strict bind already gives the fail-fast that
  matters (a taken port). A missing variable is an environment gap, not a
  collision.
- **Keep the recipes inline in `berth-onboard`.** Rejected. The skill
  would carry a dozen tools' worth of before/after and its description
  would have to trigger on two different intents. Skills are cheapest when
  their descriptions are precise and their bodies short; recipe files
  loaded on demand keep both.
- **`berth migrate --write`: berth rewrites the files itself.** Rejected.
  berth would need a codemod per framework, per language, kept current with
  each tool's config format, for an advisory tool that otherwise never
  touches application code. The agent already has the editing tools and the
  human already has the review loop; the recipe is what was missing.
- **Override file as the Compose default.** Rejected after council review.
  A fresh clone would reproduce the collision until the cloner learned
  about the override, which contradicts decisions 1 and 9.
- **"Inside the block means canonical" as a single rule.** Rejected after
  council review. It would hide a bare W0 literal that breaks every other
  worktree, and it would bless a hardcoded pool number that is a stale
  artefact. Three zones keep both visible.
- **Agent-run prune after a spoken "yes".** Rejected. The CLI cannot see the
  conversation; the rail can see the terminal and the override variable.
  ADR-008's mechanism already expresses "a human decided this" in a way the
  tool can check.
- **A scanner-version stamp on each `declared` entry, with a
  `--recheck`.** Declined. Prune always re-runs the scan it acts on, so a
  stamp adds nothing the same-scan rule does not already give.
- **A local proxy or alias layer so repositories need no change.**
  Deferred, not rejected. Names over ports remain the v1 answer to
  discoverability (portless in alias mode, `docs/DESIGN.md`); hiding the
  numbers behind a proxy does not stop two dev servers from wanting 5173.

## Compliance / Validation

- `tests/plugin.test.ts`: the `berth-migrate` skill exists; every recipe
  file has the eleven sections of decision 3 (an `N/A` carries a reason);
  every recipe names its role variable, its W0 default form and its
  strict-mode setting; `recipes/_roles.md` exists and `berth-onboard`
  refers to it; no recipe or skill mentions a human-only command (`free`,
  `--force`, `hooks`, `declared --prune`, `declared --remove`);
  `claude plugin validate --strict` passes.
- `tests/scan.test.ts`: a classification table for decision 7: a literal
  outside the block is declared; a pool literal is declared; a W0 literal
  in environment-first form is silent; a bare W0 literal and a W3 literal
  are reported as canonical literals and not declared; the same holds for
  `project add` and for `scan --write`.
- `tests/project.test.ts`: `project declared` lists each entry with
  evidence or `stale`; `--add` is additive and idempotent under the policy
  lock; `--prune` removes only stale entries, is idempotent, writes the
  `.bak` and the audit line, and is refused with `CLAUDECODE=1` unless
  `BERTH_ALLOW_DESTRUCTIVE=1`; `--remove` follows the same rail;
  `isDestructive` covers both.
- Manual: migrating one Vite repository and one Docusaurus repository on
  this machine with the recipes, then `berth check` reads `ok`/`idle` for
  both blocks and the map rows show no legacy cells.

## Council Review

Two reviewers responded on the quick tier (two timed out) and the chairman
synthesised; the balanced-tier attempt earlier the same day timed out
before synthesis. Findings, and what this ADR did with them:

**Accepted as proposed:** the environment-first, W0-default, strict-bind
target state (decision 1), with the reviewers noting a contributor's
machine is likelier to have 3000 or 5432 occupied than 13000; the separate
skill (decision 2, unanimous); human-confirmed role mapping (decision 5);
README and `.env.example` lines (decision 9).

**Adopted:** the four conditions on the default (`P` permanence as an
invariant, documented provenance, upstream may decline, collateral in
scope). **Adopted:** the Compose default inverted to the in-file
`${VAR:-default}` form, the override kept as the fallback. **Adopted:**
decision 7 rewritten as three exact zones, with a bare in-block literal
reported rather than silenced and pool literals kept visible; the block
range stated as `[10000 + 1000·P, +999]`. **Adopted:** decision 6 rewritten
as an explicit carve-out from ADR-006: dry run, same-scan rule, audit line,
`.bak`; and, going one step further than the synthesis, `--prune` placed
under the ADR-008 rail rather than trusting a conversational approval,
since one reviewer wanted prune restricted to humans and the rail is how
berth already expresses that. **Adopted:** the recipe sections
*applies-to*, *side-channels*, *collateral*, *host-binding*, idempotent
*edit*, exclusions inside *detect*, ownership-checking *verify*, and
`N/A: <reason>`. **Adopted:** Storybook, Playwright and test runners,
monorepos (distinct roles within one `P`, never the worktree dimension),
devcontainer and VS Code launch files as collateral, and the Windows
guidance (`cross-env`/`dotenv-cli` forms, host binding for WSL).
**Adopted in part:** decision 8 narrowed to what berth already provides
(`BERTH_SHARED_*` exports, the duplicate behind a Compose profile); owner
lifecycle and validation deferred to a later ADR as the council asked, but
not removed, because the shared table and its exports exist today.

**Declined:** "public defaults in the repository, W0 as a local override"
(see Alternatives); a scanner-version stamp with `--recheck` (the same-scan
rule covers it); making the dynamic pool configurable for Hyper-V excluded
port ranges (noted for a Windows host, no Windows host exists yet).

**Dissent recorded:** one reviewer held that a machine-derived number does
not belong in a public repository's defaults. The ADR keeps the number and
answers with provenance in the README line and the observation that every
default is machine-derived somewhere; the reviewer's concern is the reason
decision 1 now carries conditions.
