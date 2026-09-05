# Saksham — Backend (Module) + SDK + Experiment Runner

> **For the `sdd-engine` agent** (`sdd-engine/agents/sdd-engine.md`): this file is the gate spec
> for owner `saksham`. Trigger a gate with `"Saksham Gate <N> go"`. Every RED test ID below is
> defined in `sdd-engine/acceptance/test-cases.md` — look it up there for exact expected
> behavior before writing the test. Every GREEN target traces to `sdd-engine/techspec/LLD.md` —
> follow its exact shapes. Do not start a gate whose prerequisite gate's DoD isn't met.

Traces: `techspec/HLD.md` §12 (Engineer A), `techspec/LLD.md` §13–§14.
Owned paths: `fair-drop-db/spacetimedb/**` (the module), `clients/sdk/**`,
`integration/experiment/**`. You are the **sole authority** on tables, reducers, allocation
math, wallet debit, and invariants C1–C5. If a UI or bot-runner need exposes a fact the module
doesn't publish, that's a new/changed subscription or reducer here — never client-side math, and
never an edit to `clients/web/**` or `services/bot-runner/**` (that's Vaibhav's; a test that
seems to need it is an escalation, not a workaround).

**Your two "extra" assignments**, split evenly with Vaibhav so no one carries the whole
non-backend/non-UI bucket alone:
1. **Client SDK** (`clients/sdk/FairDropClient`) — you own the module contract, so you own its
   wrapper.
2. **Experiment runner** (`integration/experiment/`) — port the existing prototype at
   `integration/experiment/sim.py` (LLD §10: "port it rather than rewriting").

---

## Gate 0 — Contract (with Vaibhav, human-run, not agent-run)

Not a gate the agent executes. Freeze in writing, together: table shapes (LLD §1), reducer
signatures (LLD §2), error semantics, the wallet-debit contract, the derived-inventory rule.
Do not trigger `"Saksham Gate 1 go"` until this is done and both task files reflect it.

---

## Gate 1 — Hello-world integration

**Branch:** `saksham/gate-1-schema-join` off `staging`.
**Prereq:** Gate 0 contract frozen.

### RED
| TC ID | Test file | Notes |
|---|---|---|
| TC-SCH-01 | `module/tests/schema.test.ts` | All tables from LLD §1 exist with the right columns after publish |
| TC-EVT-01 | `module/tests/lifecycle.test.ts` | Queue-mode `create_event` persists correctly |
| TC-EVT-02 | `module/tests/lifecycle.test.ts` | Turn-mode `create_event` persists 5 slot rows, quota=0 |
| TC-JOIN-01 | `module/tests/lifecycle.test.ts` | `join("Asha","human")` → wallet drawn from U[20k,150k], not fixed |
| TC-SDK-01 | `clients/sdk/tests/client.test.ts` | Every method in LLD §6's `FairDropClient` signature exists |

No test runner exists yet in this repo — **this gate decides it**: `vitest` for
`fair-drop-db/spacetimedb` and `clients/sdk`. Wire `package.json`'s `test` script. Note the
choice in your report; don't ask, this is exactly the kind of non-testable-invariant detail the
agent instructions say to just pick.

### GREEN
- Replace the scaffold `fair-drop-db/spacetimedb/src/index.ts` (currently a `person` table +
  `add`/`sayHello` demo) with the real schema per LLD §1c: `event`, `slot`, `participant`,
  `bid`, `allocation`, `slot_result`, `slot_schedule`, `countdown_schedule`.
- Implement `create_event` (LLD §2, guards from TC-EVT-03/04/05/06/08 — cover these too, they're
  P0/P1 and cost nothing extra once `create_event` exists) and `join` (LLD §2, TC-JOIN-02..10).
- `spacetime generate --lang typescript` the bindings.
- Stand up `clients/sdk/FairDropClient` per LLD §6's signature — implement `join`, `listEvents`,
  `createEvent` first; stub the rest to throw "not implemented" until their gate.

### Definition of Done
- [ ] All RED tests green, full `module` + `sdk` suites green.
- [ ] `spacetime generate` produces bindings with no manual edits downstream.
- [ ] **Milestone check:** on `staging` (once merged), `create_event()` + `join()` return
      authoritative state via subscription. No UI required to verify this — a script or the
      test suite itself is the check.

### Escalate if
- The SpacetimeDB TS module test harness can't run reducers without a live `spacetime start`
  instance and CI/local setup for that isn't already decided — this affects how *every* future
  module test runs, so it's a one-time decision worth a human sign-off, not a silent default.

---

## Gate 2 — ROUND 1: Queue mode (FCFS baseline)

**Branch:** `saksham/gate-2-queue-mode`.
**Prereq:** Gate 1 DoD met.

Full build-out of Round 1's server side (HLD §3.2) — the baseline the whole demo exists to
indict. It needs to actually work, not just exist.

### RED
| TC ID | Test file | Notes |
|---|---|---|
| TC-LC-01 | `lifecycle.test.ts` | New event: `created`, `totalTickets==0` |
| TC-LC-02 | `lifecycle.test.ts` | `start_countdown`: sizes inventory, schedules `open_event` |
| TC-LC-03 | `lifecycle.test.ts` | Scheduled `open_event` fires → `open` |
| TC-EVT-10 | `inventory.test.ts` | `totalTickets = round(0.4 × headcount)` at 250/500/750/1250 |
| TC-Q-01 | `queue.test.ts` | Valid buy → allocation + debit + `hasWon` + decrement, one call |
| TC-Q-02 | `queue.test.ts` | `price != ticketPrice` rejected |
| TC-Q-03 | `queue.test.ts` | Buy at `ticketsRemaining==0` rejected, never negative |
| TC-Q-04 | `queue.test.ts` | Buy under-balance rejected pre-write |
| TC-Q-07 | `queue.test.ts` | **C5 inverted from v2**: second buy by a winner rejected even with inventory left |
| TC-WAL-03 | `wallet.test.ts` | Debit exactly once, reads the participant's own join-time draw |

### GREEN
- `start_countdown`, `open_event`, and the **queue branch** of `submit_bid` (LLD §2). Full path:
  create → join → start_countdown → (60s) → open → submit_bid (arrival-order resolution) →
  allocation + wallet debit, atomically, same reducer call.
- Wallet debit and C5 guard (`participant.hasWon`) exactly as LLD §2 specifies — don't reorder
  the guard checks; TC-BID-08-style "conjunction not two independent checks" reasoning applies
  here too.

### Definition of Done
- [ ] All RED tests green; **if this gate doesn't pass, do not start Gate 3** (LLD §13 explicit
      instruction — queue mode is the foundation, not a warm-up).
- [ ] **Milestone check:** one human, one queue event, buy → ticket + debited wallet, verifiable
      via the test suite or a manual `spacetime call`.

### Escalate if
- TC-EVT-12 (zero-participant `start_countdown`) — LLD §2 doesn't say whether to reject or allow
  a `totalTickets==0` event. Pick a behavior, but flag it in your report since test-cases.md
  itself flags this as "specify which."

---

## Gate 3 — ROUND 1 at scale (before any turn-mode work)

**Branch:** `saksham/gate-3-queue-scale`.
**Prereq:** Gate 2 DoD met.

Highest-risk item in the whole project (HLD §11), deliberately scheduled early per LLD §13.

### RED
| TC ID | Test file | Notes |
|---|---|---|
| TC-Q-05 | `queue.test.ts` | Inventory 5, A..H in order → A..E win, arrival-ordered |
| TC-Q-06 | `queue.test.ts` | 50 concurrent submissions, inventory 5 → exactly 5 allocations, no double-alloc |
| TC-Q-09 | `queue.test.ts` | Demo scale: 1,250 participants, 500 tickets → bots take overwhelming majority |
| TC-NFR-01 | `integration/scale.spec.ts` | **Joint with Vaibhav's bot pool** — 1,250 concurrent subscribers, one slot, no drops |

### GREEN
- No new reducer — this gate is about correctness *under concurrency* for what Gate 2 built.
  If TC-Q-06 exposes a race (e.g. a check-then-write gap), fix it here; SpacetimeDB's serialized
  reducer execution (HLD §7) should make this a non-issue if `submit_bid` doesn't do anything
  cute with async/deferred writes — if you find yourself needing a lock or a retry loop, that's
  a sign something is structured wrong, not a sign you need a lock.

### Definition of Done
- [ ] All RED tests green, including the joint 1,250-subscriber load test with Vaibhav's pool
      running (coordinate timing — his Gate 3 must be far enough along to have bots to run).
- [ ] **Milestone check:** 10 humans / 40 bots race queue mode, fast bots disproportionately
      win — Round 1 is *supposed* to look unfair. Load test passes at 1,250.

### Escalate if
- TC-NFR-01 fails and the bottleneck is on the module side (e.g. subscription fan-out latency)
  rather than the bot pool — this is the single highest-risk finding in the project; report
  immediately with numbers, don't spend the whole gate silently tuning.

---

## Gate 4 — ROUND 2: Turn mode (Fair Drop)

**Branch:** `saksham/gate-4-turn-mode`.
**Prereq:** Gate 3 DoD met.

### RED
| TC ID | Test file | Notes |
|---|---|---|
| TC-EVT-07 | `lifecycle.test.ts` | Non-strictly-increasing floors **rejected** (not warned) |
| TC-EVT-09 | `inventory.test.ts` | `sum(slot.quota) == totalTickets` exactly, by construction |
| TC-BID-01..13 | `turn.test.ts` | Full `submit_bid` turn branch — see test-cases.md §6 for each |
| TC-CLR-01..07 | `turn.test.ts` | `close_slot` core: seeded draw, pay-the-floor, debit, slot_result |
| TC-ROLL-01 | `turn.test.ts` | Unfilled quota rolls into next slot |

### GREEN
- `close_slot` (LLD §2) — your most important reducer. `drawSeed = hash(eventId, slotIndex,
  sorted(entry ids))`; rank by `hash(drawSeed, entry.id)` ascending; walk the ranking allocating
  1 ticket + debit `slot.floor` per entry until quota spent; mark winners `hasWon`; roll unfilled
  quota forward.
- Turn branch of `submit_bid`: opt-in at `slot.floor` only, no chosen amount, C2 check-then-
  insert, C5 guard.

### Definition of Done
- [ ] All RED tests green.
- [ ] **Milestone check:** same population, `mode: "turn"` → 5 slots clear in sequence, every
      winner in a slot pays exactly that slot's floor, unfilled quota rolls forward.

### Escalate if
- **The hash function for `drawSeed` is unspecified in LLD** (`hash(...)` is written generically,
  §5/§2). Per the agent's "underspecified detail" rule: since no test asserts a *specific* seed
  value — only determinism (TC-CLR-08), reproducibility (TC-CLR-09), and independence from
  arrival order (TC-CLR-10) — pick any stable hash (e.g. a documented string hash or SHA-256 over
  the sorted ID list) and state the choice in your report. Do **not** escalate this one; it's the
  canonical example of a safe autonomous choice.
- TC-CLR-13 (mid-close balance shortfall) — LLD says this should be unreachable under C5; if your
  implementation makes it reachable, that's a sign C5 isn't actually enforced upstream — stop and
  report rather than patching around it defensively.

---

## Gate 5 — C1 invariance + verifiability (the section the project is judged on)

**Branch:** `saksham/gate-5-invariance`.
**Prereq:** Gate 4 DoD met.

### RED
| TC ID | Test file | Notes |
|---|---|---|
| TC-INV-01 | `invariance.test.ts` | Shuffled insertion order (≥100 permutations, ≥20 entries) → identical `Allocation` rows |
| TC-INV-02 | `invariance.test.ts` | Winning subset stable across shuffled order |
| TC-INV-03 | `invariance.test.ts` | Mechanically enforce: randomize every `seq` before `close_slot`, outcome unchanged |
| TC-INV-05 | `invariance.test.ts` | Entry at second 2 vs second 59 → identical outcome |
| TC-CLR-09 | `verifiability.test.ts` | Recompute draw **outside** the module from `drawSeed` + committed entries → exact match |
| TC-INV-11 | `verifiability.test.ts` | Same, at full-event scope |

### GREEN
- No new module code expected — if any of these fail, the bug is in Gate 4's `close_slot`, fix
  it there. This gate is primarily about proving the property, not adding one.
- Extend your **experiment runner** task here (LLD §10): port `integration/experiment/sim.py`
  into `integration/experiment/`, wire `npm run experiment`. Use it to sanity-check statistical
  uniformity (TC-CLR-11) fast, before committing to the module-level test.

### Definition of Done
- [ ] All RED tests green.
- [ ] `npm run experiment` runs and produces output shaped like LLD §10's example.
- [ ] **Milestone check:** TC-INV-04 (bots at near-zero delay vs. humans at second 58 →
      indistinguishable win rates) — this needs Vaibhav's UI/bot pool to fully exercise; if his
      side isn't ready, verify at the module level only and note the UI-level check as
      outstanding, don't block your own gate on it.

### Escalate if
- TC-INV-01 fails on a genuine order-dependency after 3 fix attempts — this is the single most
  important test in the repo per LLD §11; don't let this one linger past the 3-attempt rule.

---

## Gate 6 — Subscription correctness (C3/C4) + wallet atomicity

**Branch:** `saksham/gate-6-atomicity`.
**Prereq:** Gate 5 DoD met.

### RED
| TC ID | Test file | Notes |
|---|---|---|
| TC-WAL-01 | `wallet.test.ts` | Balance never negative, swept globally after every test |
| TC-WAL-02 | `wallet.test.ts` | Losing entry leaves balance byte-identical |
| TC-WAL-04 | `wallet.test.ts` | No allocation without matching debit or vice versa |
| TC-WAL-05 | `wallet.test.ts` | No reservation/hold state anywhere in schema |
| TC-INV-07 | `integration/subscriptions.spec.ts` | All clients observe the same `slot_result` |
| TC-INV-08 | `integration/subscriptions.spec.ts` | No client acts before committed state; win correlation ≈0 |

### GREEN
- Nothing new to build — this gate proves the existing writes are structurally sound (one
  serialized reducer call, wallet debit riding inside it). TC-INV-07/08 are joint with Vaibhav's
  client instrumentation (`{slot_result_id, state_version, received_at}`); you confirm from the
  module side there's only ever one committed `slot_result` per slot.

### Definition of Done
- [ ] All RED tests green.

### Escalate if
- TC-WAL-04's cross-table reconciliation ever fails, even once, even in a flaky-looking way —
  this is a money-correctness invariant; do not retry-until-green and move on, report the exact
  failing case.

---

## Gate 7 & 8 — Support, not build

By now the module should be feature-complete. Trigger these individually as
`"Saksham Gate 7 go"` / `"Saksham Gate 8 go"` once Vaibhav reaches the corresponding gate and
needs your reducer surface exercised live.

### RED / GREEN (whatever remains)
- Sweep `acceptance/test-cases.md` §1–§10 for any P0/P1 `TC-SCH-*`, `TC-LC-*`, `TC-EVT-*`,
  `TC-JOIN-*` not yet covered by an earlier gate's tests — write and close them out.
- Experiment runner remaining capabilities (LLD §10): turnout sweep (TC-EXP-04), rule-comparison
  arm retaining the retired pay-as-bid comparator (TC-EXP-06), delay sweep (TC-EXP-07), seeded
  determinism (TC-EXP-05).
- Be on call for bugs Vaibhav's integration surfaces that trace back to a module guard or
  missing subscription field.

### Definition of Done
- [ ] `module/tests/` fully green, `npm run experiment` reproduces HLD §5a's table.
- [ ] `clients/sdk` has no consumer reaching past it into generated bindings (TC-SDK-02).
- [ ] `npm run test:core` (LLD §11) passes end to end once Vaibhav's side exists to drive it.

---

## Test ownership reference

`TC-SCH-*`, `TC-LC-*`, `TC-EVT-*`, `TC-JOIN-*`, `TC-Q-*` (Round 1), `TC-BID-*`/`TC-CLR-*`/
`TC-ROLL-*` (Round 2), `TC-WAL-*`, `TC-INV-*`, `TC-SDK-*`, `TC-EXP-*`.
