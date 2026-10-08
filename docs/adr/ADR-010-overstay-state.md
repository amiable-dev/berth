# ADR-010: An `overstay` State for Dynamic Leases Held Past Their TTL

**Status:** Proposed 2026-10-08
**Date:** 2026-10-08
**Decision Makers:** Chris (@amiable-dev)
**Related:** ADR-001 (advisory, never kills), ADR-002 (the decodable port scheme and the dynamic pool), ADR-003 §6 (liveness beats wall-clock), ADR-004 (truth sources and attribution)

---

## Context

The dynamic pool (40000–41999, ADR-002) is for scratch servers that need no
name. `berth claim --dynamic N` grants a lease with an eight-hour TTL
(`pools.ttlHours`); permanent services belong in a project's block.

On 2026-10-08 a session working in `sightline` found a listener on 40002 that
it had not started, and stopped to ask whose it was. `berth who 40002` showed:

- a dynamic lease taken on 2026-10-06 by a session working in `~/tax-calc`,
  which is not a registered project, so the lease belongs to `scratch`;
- the lease expired at 18:11 that day, about 40 hours earlier;
- the process that claimed it (pid 66886) had exited, and the session was
  later resumed under a new pid; its `python3 -m http.server 40002` was still
  running and carried the session marker;
- state **`ok`**, advisory **none**.

Nothing collided. `berth claim --dynamic` skips every leased or bound port,
so 40002 was never granted twice, and the sightline session did the right
thing: it read the evidence and left the port alone. What failed is the label.
In `reconcile.ts` the live-holder check (`liveMatchesLease` → `ok`) runs before
expiry is considered, so a lease is `ok` for as long as its server runs,
however far past its TTL. The consequences:

- `berth check` reports "0 need attention" while a scratch port is being used
  as a permanent one. The TTL is never enforced or even reported.
- Agents that find the listener have to read lease timestamps to tell a
  healthy scratch server from leftovers.
- `berth tidy` only acts on `stale` and `orphan`, so the port never shows up
  in a plan.

The opposite case is already covered: a listener in the pool with **no** lease
is `unmanaged` and needs attention. This ADR is only about leases that were
taken properly and then outlived their TTL.

## Decision

Add a ninth state, **`overstay`**: a dynamic lease past its `expires`, whose
claiming process is gone, while its port is still bound by a holder that
matches the lease.

1. **Trigger.** `lease.kind === 'dynamic'`, `lease.expires < now`, the pid
   that claimed the lease (`lease.owner.pid`) is not running, a live listener
   on the port, and `liveMatchesLease` is true.
   - **Liveness is the claiming pid, not the session.** ADR-003 §6 says *a
     lease whose pid is alive* and whose port is bound is `ok` regardless of
     TTL, so a laptop asleep for a weekend does not wake to mass expiry; the
     Claude Code process survives sleep with its pid, so that still holds.
     The reconciler's general `ownerAlive` also accepts a live session file,
     and that is what kept 40002 `ok`: the claiming pid (66886) was gone, but
     the tax-calc session had been resumed the next day under a new pid
     (83974). A resumed session is a new process; the scratch claim belonged
     to the one that exited. A lease that recorded no pid falls back to the
     session check.
   - Cost, accepted: resuming a session and expecting its old scratch server
     to stay quietly `ok` now shows it under "need attention", with a
     suggestion to give it a permanent home.
   - Block leases have no TTL and are never `overstay`; a dev server
     outliving the session that started it is normal there.
   - A live holder that does not match is still `conflict`; an expired lease
     with nothing bound is still `stale`.

2. **One suggestion, chosen by where the holder lives** (ADR-001: every state
   carries exactly one suggested command, and berth never kills):
   - lease project is `scratch` (the holder is not in a registered project):
     `berth project add <cwd>`, so the service gets a permanent block;
   - lease project is registered: `berth claim --extra <name>` in that
     project, so the service moves onto a named slot in its own block.

   `berth release` is wrong here, because releasing a bound port only turns
   it `unmanaged`, and so is reusing `stale`, whose suggestion is release.

3. **Severity** sits between `orphan` and `stale`: the port works and nothing
   collides, but it is leftovers the human should see. It counts toward
   "need attention" like every state other than `ok` and `idle`.

4. **`tidy` does not release it.** The port is bound; the plan lists
   `overstay` rows next to `unmanaged` ones as needing a decision, and
   releases nothing.

5. **Dashboard.** `ok` colour, hatched, so a long-lived scratch server reads
   as "working, but past its TTL" rather than as a fault.

## Consequences

- `berth check` and `berth who` say what a person reading the lease would
  conclude: this scratch port has turned into something permanent.
- Agents get a state they can act on without parsing timestamps, and the
  suggestion points at the real fix (a block) rather than at the listener.
- The state count goes from eight to nine. The JSON `State` union, the MCP
  summary counts, the dashboard legend and filters, `concepts.md`, the README
  table and the berth-ports skill all list states and change with it.
  Consumers that switch on `state` without a default need the new value.
  Already-published material that says "eight states" (the announcement post
  on amiable.dev) needs a one-line follow-up.
- There is still no way to extend a dynamic lease. The suggestions avoid
  needing one: both lead to a permanent home instead of a longer lease. A
  `--renew` flag can be its own decision if scratch servers that run for
  days turn out to be common.

## Compliance / Validation

- `tests/reconcile.test.ts`: an expired dynamic lease whose claiming pid is
  gone, with a matching live holder, is `overstay` (scratch → `berth project
  add`; registered project → `berth claim --extra`), including when the same
  session is alive again under a new pid; the same lease with its claiming
  pid alive is `ok` (ADR-003 §6); unexpired is `ok`; expired and unbound is
  `stale`; expired with a non-matching holder is `conflict`; an expired block
  lease is never `overstay`.
- `tests/tidy.test.ts`: `overstay` rows are listed and never released.
- The 40002 case above is the motivating fixture.
