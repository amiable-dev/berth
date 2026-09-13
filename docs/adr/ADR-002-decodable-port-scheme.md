# ADR-002: Decodable Port Scheme

**Status:** Accepted 2026-09-13
**Date:** 2026-09-13
**Decision Makers:** Chris (@amiable-dev), LLM Council
**Council Review:** 2026-09-13 — round two replaced the draft formula with the one below, moving the middle digits from worktrees to roles (`docs/DESIGN.md` §5.2, §6)
**Related:** ADR-001 (advisory), ADR-003 (the ledger is authoritative over the formula); `docs/DESIGN.md` §5.2, §7; `docs/RESEARCH.md` "Named-host proxies and port managers"

---

## Context

A port number is the one thing every participant sees: the agent that binds
it, the human reading `lsof`, the compose file, the browser tab. If the number
itself states which project, worktree and service it belongs to, most
coordination questions answer themselves, and a wrong number is visibly wrong.

The alternatives found in the landscape do not have this property:

- **Hashed ports** (outport, portree, `claude-worktree-hooks`): deterministic
  but opaque. No human can read one, and for thirty-odd allocations in a
  thousand-port span the collision rate is roughly forty percent.
- **Sequential ten-port blocks** (Conductor): readable only with a table,
  and ten slots per workspace is tight once a repository has web, api, db,
  cache and mail services.
- **Memorable 4xxx blocks** of one hundred: collide with conventional dev
  ports (4000–4999 is portless's own allocator) and run out.

The council's round-one draft spent the middle digits on worktrees; round two
corrected it: ten worktrees per repository is plenty, ten roles per worktree
was not (breach-resolve alone has eight microservices plus the canonical set).

## Decision

```
port = 10000 + 1000·P + 100·W + R
P  project number, hand-assigned and permanent, 0–29   → blocks 10000–39999
W  worktree, 0 = main checkout, 1–9 = additional worktrees
R  role slot, 00–09 canonical, 10–99 project-named extras
```

Canonical roles: 00 web, 01 api, 02 db, 03 cache, 04 smtp, 05 mail-ui,
06 docs/storybook, 07 worker/metrics, 08 otlp-grpc, 09 otlp-http.

Reading a port is decoding it: 13204 is project 3, worktree 2, role 04 (smtp).

1. **P is permanent.** Project numbers are assigned by hand in `policy.toml`
   and never reused. The initial assignment (berth 0, skills-telemetry 1, …,
   kpm 20) is recorded in `docs/DESIGN.md` §7 and is a compatibility promise.
2. **No per-project overrides of the formula.** A repository with more than
   ten services names extras in slots 10–99.
3. **Tombstones.** Deleting a worktree or a project keeps its ID in
   `tombstones.json`, so a neighbour is never renumbered and a stale lease
   can still be decoded.
4. **The formula is a suggestion; the ledger is authoritative** (ADR-003).
   `declared` legacy ports (3000, 5432, …) are registered as-is so conflicts
   are visible before any migration and participate in collision validation.
5. **Other ranges.** Dynamic pool 40000–41999 with an 8 h TTL, kept below
   48000 so a changed `net.inet.ip.portrange.first` cannot reach it.
   Reserved: 0–1023, 4000–4999 (portless), 49152–65535 (macOS ephemeral),
   5000 and 7000 (AirPlay). A lint list of well-known defaults inside the
   block range (11211, 11434, 15672, 16686, 19999, 27017) is never handed to
   a canonical role and is flagged if a project's extras land on one.
6. **Shared services** (one observability stack and, optionally, one
   Postgres) are declared once with an owner, so other projects connecting
   to them is `ok`, not `conflict`.
7. **berth is project 0**, so its own dashboard is port 10000.

## Consequences

**Positive.** Zero collisions by construction inside the managed range; any
port is readable without a tool; compose overrides and `.env` values are
generated mechanically from `(P, W, R)`; the range map is the formula drawn.

**Negative.** Thirty projects and ten worktrees per project are hard caps; a
thirty-first project needs a new formula, which would be its own ADR. Extras
slots 10–99 are project-named and so not decodable without the policy file.
The well-known-defaults lint list is maintained by hand.

**Neutral.** Nothing in the scheme is macOS-specific except the reserved
ranges, which live in the policy file rather than in code.

## Compliance / Validation

- Property tests: encode/decode round-trips for every `(P, W, R)`; no
  canonical role ever lands on the lint list; every reserved range is
  disjoint from the block range and the dynamic pool.
- `berth check` reports a repository whose config declares a port outside its
  allocation as `drift` (ADR-004); that is how the formula is audited.
