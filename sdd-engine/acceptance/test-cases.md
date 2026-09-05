# Fair Drop — Acceptance Test Cases


> ## ⚠ SCOPE CUT — 2026-09-05 · target 3.5–4h, build-and-test at each stage
>
> The 8-gate, 30–35h-per-engineer plan is **abandoned**. This document remains the *design
> reasoning* and is correct as written, but much of it is **not being built today**. The build
> plan is `sdd-engine/tasks/saksham.md` and `.../vaibhav.md`; the frozen interface is
> `docs/CONTRACT.md`.
>
> **In scope:** 7 tables · `create_event`/`join`/`start_countdown`/`open_event` ·
> `submit_bid` (both branches) · `close_slot` with a **pure** draw · `settle` · a bot script
> (40 bots) · one display.
>
> **Out of scope:** the bot-runner HTTP service · QR onboarding · phone view · dashboard
> polish · the TS port of `sim.py` (run the existing Python) · the enforced `clients/sdk`
> layer · all Playwright/E2E · the 1,250-participant load test · ~200 of the 219 test cases.
>
> **Cut in the 4h re-plan specifically:** two of the three scheduled tables. Only
> `slot_schedule` survives — turn mode genuinely needs slots to auto-advance. `open_event` and
> `settle` become **admin-triggered**, which removes `countdown_schedule` and
> `settle_schedule` along with their two dead-event failure modes. The bounded connection pool
> is also deferred: at 40 bots, one connection each is fine. **The schema does not change** —
> `participant.id` stays the PK and `identity` stays non-unique, so re-introducing the pool
> later needs no migration.
>
> **Two tests are being written**, both against the pure draw: TC-INV-01 (shuffled order →
> identical allocations) and TC-CLR-09 (recompute the draw outside the module). Reducers
> **cannot** be unit-tested — `spacetimedb/server` imports `spacetime:sys@2.0`, a host-only
> module scheme vitest cannot load. Everything else is verified by running the demo.

Status: Draft v2 — derived from `techspec/HLD.md` (v3) and `techspec/LLD.md` (v3)
Purpose: the checkpoint that decides whether the build is working as intended. Every case here
is written to be executable three ways — as an automated test (unit / integration / Playwright
E2E) or by a human running the demo by hand. Nothing ships until the P0 set is green.

## How to read this document


| Field      | Meaning                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ID**     | `TC-<MODULE>-<n>`. Stable — reference it from test code (`// TC-BID-07`) and from bug reports.                                                                                                           |
| **Level**  | `UT` unit (pure function / single reducer, no network) · `IT` integration (real module on local SpacetimeDB, multiple actors) · `E2E` Playwright against the real UI · `MAN` manual, run on the demo rig |
| **P**      | `P0` blocks the demo · `P1` blocks "done" · `P2` nice to have                                                                                                                                            |
| **Traces** | Source requirement in HLD/LLD                                                                                                                                                                            |


**Modules**

1. [Schema & constraints](#1-schema--constraints-tc-sch)
2. [Event lifecycle / state machine](#2-event-lifecycle--state-machine-tc-lc)
3. `create_event` / `start_countdown` [(admin)](#3-create_event--start_countdown-admin-tc-evt)
4. `join` [/ participant](#4-join--participant-tc-join)
5. [Queue mode — Round 1 / FCFS](#5-queue-mode--round-1--fcfs-tc-q)
6. [Turn mode entries —](#6-turn-mode-entries--submit_bid-tc-bid) `submit_bid`
7. `close_slot` [— clearing](#7-close_slot--clearing-tc-clr)
8. [Quota rollover](#8-quota-rollover-tc-roll)
9. [Wallet](#9-wallet-tc-wal)
10. [Invariants C1–C5](#10-invariants-c1c5-tc-inv)
11. [Client SDK (](#11-client-sdk-fairdropclient-tc-sdk)`FairDropClient`[)](#11-client-sdk-fairdropclient-tc-sdk)
12. [Bot-runner service + worker pool](#12-bot-runner-service--worker-pool-tc-pool)
13. [Bot behaviour](#13-bot-behaviour-tc-bot)
14. [Admin dashboard read-model](#14-admin-dashboard-read-model-tc-dash)
15. [Web UI — onboarding, event list, phone view](#15-web-ui--onboarding-event-list-phone-view-tc-ui)
16. [Experiment runner](#16-experiment-runner-tc-exp)
17. [End-to-end scenarios](#17-end-to-end-scenarios-tc-e2e)
18. [Non-functional / demo-rig](#18-non-functional--demo-rig-tc-nfr)

**Decisions resolved in v3** (previously flagged open — do not silently re-open them):

- *Clearing rule*: turn mode is **random among qualifying entries, pay-the-floor**. The
  price-descending pay-as-bid rule from v2 is retired to the experiment runner's comparison
  arm (HLD §5a). All of §7 was rewritten for this.
- *Rollover*: unsold quota **rolls forward** into the next slot (confirmed). §8 stands.
- *One ticket per participant per event* (**C5**): a winner is ineligible for every later slot,
  in both modes. This inverts v2's TC-BID-10 / TC-CLR-09 / TC-Q-07, which asserted the opposite.
- *Inventory*: `totalTickets` is **derived at `start_countdown`** as
  `round(ticketFraction × registered participants)`, default fraction 0.40 — it is not an
  argument to `create_event`. Quotas are derived from it, so overbooking is impossible by
  construction rather than rejected by a guard.
- *Wallet*: `randomUniform(₹20,000, ₹1,50,000)` for both origins. The separate `ceiling` field
  is deleted.

**Decisions frozen at Gate 0** (2026-09-05) — the authority is `docs/CONTRACT.md`; this
document was reconciled against it. The cases most changed:

- *Participant identity*: `participant.id` is the PK; `identity` is indexed and **not** unique,
  because pooled bot connections share one identity across many rows. **TC-JOIN-04 and
  TC-SCH-02 are inverted from v2.**
- *Quota*: split into immutable `baseQuota` and rollover-carrying `effectiveQuota`. Assert
  `sum(baseQuota) == totalTickets` (TC-EVT-09); asserting against `effectiveQuota` passes
  before the first close and fails after it.
- *Remainder*: goes to the **earliest** slots, not the last (TC-EVT-11, TC-EVT-16).
- *Admin*: per-event and self-establishing — the guard is on `start_countdown`, not
  `create_event` (TC-EVT-03, TC-EVT-15).
- *Errors*: 19 stable codes with a **frozen guard order** (TC-BID-15). Tests assert on codes,
  never message text.
- *`settle`*: writes no scoreboard and a second call is a **silent no-op**, not an error
  (TC-LC-09, TC-LC-13).
- *Scheduled reducers*: private by default; there is no `ctx.sender == module identity` guard
  to test (TC-LC-07).

**4h build scope.** Only two cases are written as automated tests: **TC-INV-01** and
**TC-CLR-09**, both against the pure draw module. Everything else is verified by the manual
stage rehearsal in `docs/DEMO-RECIPE.md`, which is written as arrange/act/check against these
case ids — so a failing step names the case it violates. Reducers cannot be unit-tested
(`spacetimedb/server` imports `spacetime:sys@2.0`, unloadable in vitest), so every `UT` marking
on a reducer case in this document should be read as `IT`.

**Scale target (as designed).** Expected turnout is 50–250 humans, so **250–1,250 participants**
at the fixed 4:1 bot ratio. **4h build runs 4 bots per human, H humans, target H = 10 → 50 participants** — §1a's
argument is that every observable is turnout-*invariant*, so small N demonstrates the same
property. **The 4:1 ratio is not optional and H must be ≥ 8:** the human share of allocations
is the headline number, and at H = 1 it can only take the values 0% or ~6% — a shutout on ~64%
of runs, indistinguishable from Round 1. See `docs/DEMO-RECIPE.md` Stage 1.1. Cases that specify a population use the top of that range unless the case is
specifically about small-N behaviour.

---



## 1. Schema & constraints (`TC-SCH`)

Traces: LLD §1, §1c.


| ID        | Level | P   | Case                                                                                                                                                                                                                     |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-SCH-01 | IT    | P0  | **4h scope:** publishing against a clean local SpacetimeDB creates **seven** tables — `event`, `slot`, `participant`, `bid`, `allocation`, `slot_result`, `slot_schedule` — with the column sets in LLD §1. (`countdown_schedule` and `settle_schedule` are cut; `open_event` and `settle` are admin-called. A scheduled table binds to exactly one reducer, which is why they could not have been merged.) |
| TC-SCH-02 | UT    | P0  | `participant.id` is the primary key and `participant.identity` is an indexed, **non-unique** column. One SpacetimeDB identity backs many participant rows — this is what makes the pooled bot connections of LLD §5a possible. Assert by schema inventory that `identity` carries no unique/primaryKey modifier. |
| TC-SCH-03 | UT    | P1  | There is **no** composite unique constraint on `(eventId, slotIndex)` — SpacetimeDB supports single-column uniqueness only. Assert instead that a `by_event_slot` multi-column btree index exists on `slot`, `bid`, `allocation` and `slot_result`. Uniqueness of `(eventId, slotIndex)` on `slot` is a construction invariant of `create_event`, not a constraint. |
| TC-SCH-04 | UT    | P0  | `participant.hasWon` exists, defaults `false`, and is the only field the C5 guard reads. Assert by schema inventory — C5 must not be reconstructed by counting `allocation` rows at request time.                        |
| TC-SCH-05 | UT    | P0  | `bid.seq` is populated and monotonically increasing per event — it exists for audit. Paired with TC-INV-03, which asserts nothing in the turn allocator *reads* it. Keeping it is what lets the demo **show** that arrival order was recorded and ignored, rather than merely asserting C1. |
| TC-SCH-06 | IT    | P1  | Every table the client subscribes to (`event`, `slot`, `participant`, `allocation`, `slot_result`) is declared `public: true`; `slot_schedule` is **not** public.           |
| TC-SCH-07 | UT    | P1  | `event.currentSlotEndsAt`, `event.endTime` and `event.ticketPrice` are declared `t.option(...)` and start `null`; `event.totalTickets`, `event.ticketsRemaining`, `event.participantsAtOpen`, `slot.baseQuota`, `slot.effectiveQuota`, `slot.filled` and `slot.entriesReceived` all start `0`. Assert `.optional()` appears nowhere — it is not a 2.8 modifier. |
| TC-SCH-11 | UT    | P0  | `participant.handle` carries a **unique** constraint and `participant.displayName` does not. Two participants may share a `displayName` (live audiences collide on names); their handles differ by the generated suffix. |
| TC-SCH-12 | UT    | P0  | `participant.initialBalance` exists and is never written after `join` — it is the anchor TC-WAL-04 reconciles against. Assert by inventory that no reducer other than `join` assigns it. |
| TC-SCH-13 | UT    | P0  | `slot.baseQuota` and `slot.effectiveQuota` are **distinct columns**; there is no single `quota` column. Assert by schema inventory, so the rollover cannot be reintroduced as a mutation of the immutable one. |
| TC-SCH-14 | UT    | P0  | **No hold state.** No table carries a column named `reserved`, `held`, `pending`, `locked`, `escrow`, or equivalent (LLD §2b). Serialized reducers make a hold redundant; its presence would signal the wallet debit had been split across calls. |
| TC-SCH-15 | UT    | P1  | `event.slotCount` and `event.adminIdentity` exist. `slotCount` equals `floors.length` after a turn-mode `create_event` and `0` after a queue-mode one. |
| TC-SCH-08 | UT    | P0  | `slot_result` carries `clearingPrice`, `entriesReceived`, `allocated`, `quotaRemainingAfterRollover`, and `drawSeed`. Assert **no** `cutoffPrice` column exists anywhere in the schema — it was removed in v3 because under pay-the-floor it duplicates `slot.floor`. |
| TC-SCH-09 | UT    | P0  | `participant` has **no** `ceiling` column (deleted in v3 — the wallet is the ceiling). Assert by schema inventory so it cannot be reintroduced and drift from `walletBalance`.                                           |
| TC-SCH-10 | IT    | P2  | Re-running the demo creates a **new** event with new rows and requires no migration — `slotIndex` behaves as data, not schema. There is no reset/replay path over an existing event; the only re-run mechanism is `create_event` (LLD §1b). |




## 2. Event lifecycle / state machine (`TC-LC`)

Traces: HLD §3, LLD §2 (`start_countdown`, `open_event`, `settle`), §3.

> Terminology: "countdown" means the **pre-open** window, during which the event is not yet
> accepting anything. The 60s in-slot **entry window** is a different thing and lives in the
> `open` state. TC-LC-04/05 are about the former.


| ID       | Level | P   | Case                                                                                                                                                                                                   |
| -------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-LC-01 | UT    | P0  | A newly created event is in state `created` with `totalTickets == 0` and `ticketsRemaining == 0` — inventory is not known until the countdown starts.                                                  |
| TC-LC-02 | IT    | P0  | `start_countdown` moves `created → countdown`, snapshots `participantsAtOpen`, sets `totalTickets = round(ticketFraction × participants)` and seeds per-slot `baseQuota`. **4h scope:** it schedules nothing — the admin calls `open_event` when the display countdown reaches zero. |
| TC-LC-03 | IT    | P0  | `open_event` moves the event to `open`. In turn mode it also sets `currentSlotIndex = 0`, `currentSlotEndsAt = now + 60s`, and inserts a `slot_schedule` row — the one surviving schedule.    |
| TC-LC-04 | UT    | P0  | `submit_bid` during `created` is rejected (`event.state == "open"` guard). Wallet unchanged, no `bid` row.                                                                                             |
| TC-LC-05 | UT    | P0  | `submit_bid` during the **pre-open** `countdown` state is rejected — the pre-open window accepts nothing. This is the guard that makes the countdown a fairness device rather than a head start. It does **not** restrict the in-slot entry window: once the event is `open`, entries are accepted for the full 60s of each slot and are resolved at t-0 (TC-INV-05). |
| TC-LC-06 | UT    | P0  | `submit_bid` after `settled` is rejected.                                                                                                                                                              |
| TC-LC-07 | IT    | P0  | `close_slot` is **not client-callable** — scheduled reducers are private by default in 2.x. There is deliberately **no** `ctx.sender == module identity` guard anywhere (`ConnectionId` is `None` for scheduler-invoked calls, so such a guard is more likely to be written wrong than to catch anything). |
| TC-LC-15 | IT    | P0  | **4h scope, new hole to close.** `open_event` and `settle` are admin-called and therefore *are* client-callable — they lose the scheduled-private protection. A non-admin calling either is rejected with `E_NOT_ADMIN` — on the exported `settle` reducer only, never inside `settleImpl` (TC-LC-09). Without this guard any participant could open the event early (destroying Round 1's equal-start premise) or end the round mid-flight. This guard exists **only because** the scheduled tables were cut. |
| TC-LC-08 | UT    | P0  | `close_slot` called twice for the same `slotIndex` — the second call is rejected (`E_SLOT_ALREADY_CLOSED`) and produces no second `slot_result` row and no double allocation. The closed-marker is the **existence of the `slot_result` row**, not a flag; assert a slot that closes with `filled == 0` is still correctly treated as closed. |
| TC-LC-09 | UT    | P0  | `settle` is **two functions**: private `settleImpl` (no sender guard, `state == "open"` check is a **silent no-op, not an error** — it must not throw) and the exported `settle` reducer (carries `E_NOT_ADMIN` and nothing else). `submit_bid`/`close_slot` call `settleImpl`. Merging them throws on the queue sell-out path and rolls back the final purchase — assert the last ticket buy succeeds. A second call is a no-op. Queue mode settles on sell-out *and* on a scheduled fallback, so a redundant call is the expected path (LLD §2a), and a throwing guard here would surface a spurious failure on every sold-out queue event. |
| TC-LC-10 | IT    | P0  | Turn mode: after the final slot closes, the event auto-transitions to `settled` without an admin action.                                                                                               |
| TC-LC-11 | UT    | P0  | `start_countdown` on an event already in `countdown` or `open` is rejected (`E_WRONG_STATE`) — inventory is sized exactly once and never resized mid-event.                                              |
| TC-LC-12 | IT    | P0  | Queue mode settles on **either** trigger: `ticketsRemaining` reaching 0 inside `submit_bid` (sell-out), or an **admin call** (replacing the cut scheduled fallback). Assert both paths — a queue event that never sells out must still reach `settled`, and a sold-out one must settle without waiting. Without both, the Round 1 event stays `open` forever and the demo cannot advance to Round 2. |
| TC-LC-13 | UT    | P0  | `settle` writes **only** `event.state = "settled"` and `event.endTime = ctx.timestamp`. Assert there is no scoreboard table and no aggregate written anywhere — the human/bot split is a read-model over `Allocation` JOIN `Participant.origin` (LLD §8). A materialised copy would be a second source of truth free to drift. |
| TC-LC-14 | IT    | P1  | Two events can be `open` concurrently without cross-contamination — entries on event A never appear in event B's clearing (schema permits it even though the demo convention is one at a time; HLD §4.1). |

> **Removed in v3:** v2's TC-LC-11 asserted that turn mode settles early if `ticketsRemaining`
> hits 0 mid-schedule. With quotas derived from inventory (`sum(baseQuota) == totalTickets`) and
> rollover only ever moving quota forward, the maximum sold through slot *k* is strictly less
> than `totalTickets` for every `k < 5`. The case is unreachable and was deleted rather than
> left as a test that can never fail. The `ticketsRemaining == 0` branch in `close_slot`
> remains as a defensive guard.




## 3. `create_event` / `start_countdown` (admin) (`TC-EVT`)

Traces: HLD §4.1, LLD §2.


| ID        | Level | P   | Case                                                                                                                                                              |
| --------- | ----- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-EVT-01 | UT    | P0  | Queue-mode create with `{ name, mode: "queue", startTime, ticketPrice, ticketFraction }` persists an event with `ticketPrice` set and no slot rows.               |
| TC-EVT-02 | UT    | P0  | Turn-mode create with 5 floors persists 5 `slot` rows with the given floors, `baseQuota = 0`, `effectiveQuota = 0`, `filled = 0`, `entriesReceived = 0`, and `currentSlotIndex = 0`. Quotas stay 0 until `start_countdown`. |
| TC-EVT-03 | UT    | P0  | **Admin is per-event and self-establishing:** `create_event` has no admin guard — whoever calls it becomes that event's admin, recorded in `event.adminIdentity` from `ctx.sender`. Assert the column is populated. The authority check lives on `start_countdown` (TC-EVT-15), which is the reducer that can actually be abused. *Changed from v2, which guarded `create_event` against "the admin identity" without defining where that value came from or how the first one is established.* |
| TC-EVT-04 | UT    | P1  | Turn-mode create with an empty or missing `floors` array is rejected.                                                                                             |
| TC-EVT-05 | UT    | P1  | Queue-mode create with a missing or non-positive `ticketPrice` is rejected.                                                                                       |
| TC-EVT-06 | UT    | P0  | `create_event` takes **no** `totalTickets` argument. Assert by reducer signature — inventory is derived (TC-EVT-10), and accepting a caller-supplied total would let it disagree with the quotas. |
| TC-EVT-07 | UT    | P0  | Slot floors that do not strictly increase are **rejected** (changed from v2's warn-don't-block). Under pay-the-floor a later slot priced at or below an earlier one means every remaining participant should rationally skip ahead, which breaks the ladder. Test `[15000, 22000, 22000, 40000, 55000]` and a descending pair. |
| TC-EVT-08 | UT    | P0  | `ticketFraction` outside `(0, 1]` is rejected. Default when omitted is `0.40`.                                                                                    |
| TC-EVT-09 | UT    | P0  | Quotas cannot exceed inventory **by construction**: `sum(slot.baseQuota) == event.totalTickets` exactly — and this holds **at every point in the event's life**, not merely after `start_countdown`, because `baseQuota` is never mutated. Assert it again after a slot with rollover has closed. Do **not** assert it against `effectiveQuota`, which deliberately exceeds `totalTickets` once anything rolls forward; a test written against `effectiveQuota` passes before the first close and fails after it. |
| TC-EVT-10 | UT    | P0  | `start_countdown` sizes inventory from the **per-event** headcount: at 250 / 500 / 750 / 1250 participants with fraction 0.40 → `totalTickets` of 100 / 200 / 300 / 500, and per-slot `baseQuota` of 20 / 40 / 60 / 100. The count must filter on `participant.eventId` — an unqualified count sizes the second event of `test:core` off both populations, silently and undetectably in any single-event test. Assertions read the `participantsAtOpen` **snapshot**, never a re-count at assertion time (a late-registering bot would otherwise break them). |
| TC-EVT-11 | UT    | P1  | Integer-division remainder goes to the **earliest** slots, not the final one: 103 tickets over 5 slots → `baseQuota` of `21, 21, 21, 20, 20`, summing to 103. *Changed from v2's remainder-to-last rule, which is pathological at small N — see TC-EVT-16.* |
| TC-EVT-12 | UT    | P0  | `start_countdown` with zero registered participants is **rejected** with `E_NO_PARTICIPANTS`; no state transition, no schedule row. *Resolved at Gate 0 — this case previously said "specify which."* Allowing it would produce a technically-correct event that opens, sells nothing and settles: a dead event on a projector with no explanation, when the only realistic cause is an admin starting the countdown before anyone joined. |
| TC-EVT-15 | UT    | P0  | `start_countdown` called by an identity other than `event.adminIdentity` is rejected with `E_NOT_ADMIN`; no state transition and no inventory sizing. |
| TC-EVT-16 | UT    | P0  | **Small-turnout quota shape.** At 10 participants (`totalTickets = 4`) over 5 slots, quotas are `1, 1, 1, 1, 0` — not `0, 0, 0, 0, 4`. Under the old remainder-to-last rule the first four slots clear empty and the entire event sells at the top floor (₹55,000), where most of the wallet distribution does not qualify. This fires at every turnout below ~13 participants, which is the range unit tests and rehearsals actually run in. |
| TC-EVT-17 | UT    | P1  | **Rounding mode.** `round` is half-away-from-zero (JS `Math.round`), not banker's rounding: 253 participants × 0.40 → `101.2 → 101`; a headcount yielding exactly `.5` rounds up. Needed because TC-EVT-10's populations all divide exactly, so a wrong rounding mode would ship green. |
| TC-EVT-13 | IT    | P0  | `listEvents` returns past and current events with their state; a settled event still appears.                                                                     |
| TC-EVT-14 | IT    | P1  | Creating a second event while a first is open succeeds — "one active event" is a demo convention, not an enforced constraint (HLD §4.1).                          |




## 4. `join` / participant (`TC-JOIN`)

Traces: HLD §3.1, §6, LLD §2 (`join`), §1a.

> `join` **is** user creation — the QR-scan onboarding flow calls it once per new participant
> (and once per bot). There is no separate registration step.


| ID         | Level | P   | Case                                                                                                                                                                                                   |
| ---------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-JOIN-01 | UT    | P0  | `join(eventId, "Asha", "human")` returns a `ParticipantId` and creates a participant with `origin = "human"`, `hasWon = false`, `eventId` set, and `walletBalance` drawn from `ctx.random.integerInRange(20000, 150000)` — **not** a fixed 500000, and **not** `Math.random()`, which is non-replayable and would make module execution non-deterministic. `initialBalance == walletBalance` at this point. |
| TC-JOIN-02 | UT    | P0  | `join(eventId, "Bot-x9", "bot")` draws `walletBalance` from the **same** distribution — bots are neither privileged nor handicapped by balance.                                                         |
| TC-JOIN-03 | UT    | P0  | Over 500 joins, `walletBalance` is approximately uniform on [20000, 150000] and always an **integer** (rupees, no paise): the minimum draw never falls below Slot 1's floor (15000), and ~73% of draws clear the top floor (55000), so the last slot retains a real field (LLD §1a). |
| TC-JOIN-04 | UT    | P0  | **One identity may join many times, and must.** A second `join` from the same connection creates a *second* participant with its own `id`, own `handle` and own wallet draw. This is what lets the bot pool multiplex hundreds of bots over a bounded set of connections (LLD §5a). *Inverted from v2, which asserted the opposite on the assumption `identity` was the primary key.* |
| TC-JOIN-05 | UT    | P1  | `origin` outside `{"human","bot"}` is rejected.                                                                                                                                                        |
| TC-JOIN-06 | UT    | P1  | Empty / whitespace-only `displayName` is rejected. Duplicate display names **are allowed** and produce distinct `handle` values — two people typing "Asha" both get participants. |
| TC-JOIN-07 | UT    | P0  | There is exactly one `join` path — no bot-specific join exists in the module (assert by source/reducer inventory; the module must not be able to tell a bot from a human except via `origin`). |
| TC-JOIN-08 | IT    | P1  | A participant who joins **after** `start_countdown` is not counted in `participantsAtOpen` and does not change `totalTickets`. They may still enter slots if the event is `open`.                       |
| TC-JOIN-09 | IT    | P1  | `submit_bid` with a `participantId` that does not exist is rejected with `E_UNKNOWN_PARTICIPANT`.                                                                                                       |
| TC-JOIN-11 | UT    | P0  | `submit_bid` with a `participantId` belonging to a **different event** is rejected with `E_WRONG_EVENT`. Participant rows are event-scoped, so this is the guard that keeps C5 honest across the two demo rounds. |
| TC-JOIN-12 | IT    | P1  | `handle` collisions are **retryable, not fatal**: a `join` whose generated handle already exists fails with `E_HANDLE_COLLISION` and the bot pool regenerates the suffix and retries. Assert 1,000 bot registrations all succeed and produce 1,000 distinct handles (this is the schema-level guarantee behind TC-POOL-07). |
| TC-JOIN-13 | UT    | P1  | `join` on a `settled` event is rejected with `E_EVENT_SETTLED`. Joining during `countdown` or `open` is allowed (see TC-JOIN-08).                                                                       |
| TC-JOIN-10 | IT    | P1  | A fresh demo run produces participants with newly drawn wallets; balances from a previous run never carry over (LLD §1b). Pairs with TC-E2E-10.                                                         |




## 5. Queue mode — Round 1 / FCFS (`TC-Q`)

Traces: HLD §3.2, LLD §2, §4.

> This **is** the queue-mode test section. It covers the full Round 1 path: buy, contention,
> inventory exhaustion, and the arrival-ordering property that Round 1 exists to demonstrate.
> Queue mode is also exercised by TC-LC-12, TC-UI-04..07, TC-EXP-02, TC-E2E-01, and TC-INV-10.


| ID      | Level | P   | Case                                                                                                                                                                                                                                                 |
| ------- | ----- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-Q-01 | UT    | P0  | Valid buy with `ticketsRemaining > 0`: an `Allocation` row is written with `pricePaid == ticketPrice`, the wallet is debited by exactly `ticketPrice`, `hasWon` becomes `true`, and `ticketsRemaining` decrements by 1 — all in one reducer call.    |
| TC-Q-02 | UT    | P0  | `price != ticketPrice` is rejected; wallet untouched, no allocation.                                                                                                                                                                                 |
| TC-Q-03 | UT    | P0  | Buy when `ticketsRemaining == 0` is rejected; wallet untouched. `ticketsRemaining` never goes negative.                                                                                                                                              |
| TC-Q-04 | UT    | P0  | Buy when `walletBalance < ticketPrice` is rejected before any write. With wallets drawn from [20000, 150000] and a ₹15,000 price, every participant can afford exactly one — so this fires only after a prior debit, which C5 already prevents. Keep it as a guard test. |
| TC-Q-05 | IT    | P0  | Inventory 5, participants A..H submitting in that arrival order → allocations go to A..E in arrival order. **This is the baseline being indicted, and it must hold** — if queue mode isn't arrival-ordered, Round 1 doesn't demonstrate the problem. |
| TC-Q-06 | IT    | P0  | Inventory 5, 50 concurrent submissions fired as simultaneously as the harness allows → exactly 5 allocations, exactly 5 wallets debited, `ticketsRemaining == 0`, no double-allocation, no negative balance.                                         |
| TC-Q-07 | UT    | P0  | **C5 in queue mode (inverted from v2).** A participant who already bought is rejected on a second buy, even with inventory remaining. v2 permitted repeat buys here; the two rounds must apply the same one-ticket rule or Round 1 and Round 2 are not comparing like with like. |
| TC-Q-08 | IT    | P1  | A rejected buy leaves no `bid` row in state `won`; if a `bid` row is written for audit it is `rejected`.                                                                                                                                             |
| TC-Q-09 | IT    | P0  | At demo scale — 1,250 participants racing for `round(0.4 × 1250) = 500` tickets — exactly 500 allocations occur, bots take the overwhelming majority, and the human share is far below the 20% population share. This is the number Round 2 is measured against. |




## 6. Turn mode entries — `submit_bid` (`TC-BID`)

Traces: HLD §3.3, LLD §2 (`submit_bid`), C2, C5.

> Under pay-the-floor an "entry" is an **opt-in at the posted price**, not a chosen amount.
> `price` is still the argument — it must equal `slot.floor` — which keeps `submit_bid` a
> single entrypoint whose two branches differ only in the clearing rule (TC-BID-12).


| ID        | Level | P   | Case                                                                                                                                                                                        |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-BID-01 | UT    | P0  | Valid entry at `price == slot.floor` with sufficient wallet, current slot → one `bid` row in state `pending`, and `slot.entriesReceived` increments. **No allocation, no wallet debit** happens at submit time. |
| TC-BID-14 | UT    | P0  | **Stale-slot rejection.** `submit_bid` takes `slot_index` as an **explicit argument**; an entry naming a slot other than `event.currentSlotIndex` is rejected with `E_STALE_SLOT` and writes no `bid` row. *The v2 draft guarded on `request.slotIndex` while declaring the signature `submit_bid(event_id, price)` — the value was never passed, so a slow bot's stale entry would silently land in whichever slot happened to be current on arrival.* |
| TC-BID-15 | UT    | P0  | **Guard order.** A participant who has already won, is under-funded, **and** is aiming at a stale slot receives `E_ALREADY_WON` — every time. Assert the frozen order of LLD §2a: `E_EVENT_NOT_OPEN → E_UNKNOWN_PARTICIPANT → E_WRONG_EVENT → E_ALREADY_WON → E_STALE_SLOT → E_PRICE_MISMATCH → E_INSUFFICIENT_BALANCE → E_SOLD_OUT / E_DUPLICATE_ENTRY`. Without a fixed order the UI copy and the tests disagree about what happened. |
| TC-BID-02 | UT    | P0  | **C2** — the same `participantId` submitting a second entry in the same slot is rejected with `E_DUPLICATE_ENTRY`; exactly one `bid` row persists, and it is the first one (the second is not queued and does not overwrite). |
| TC-BID-03 | UT    | P0  | An entry with `price != slot.floor` is rejected — both below (under-paying) and above (there is no such thing as bidding higher; a higher number buys nothing and must not be silently accepted). |
| TC-BID-04 | UT    | P0  | Entry rejected pre-write when `walletBalance < slot.floor`.                                                                                                                                 |
| TC-BID-05 | UT    | P0  | Entry carrying a stale `slotIndex` (already closed) is rejected.                                                                                                                            |
| TC-BID-06 | UT    | P0  | Entry carrying a future `slotIndex` is rejected — you cannot pre-position for a slot that has not opened.                                                                                   |
| TC-BID-07 | UT    | P0  | Entry at exactly `walletBalance == slot.floor` is accepted (boundary, inclusive) — the participant is left with a zero balance and is ineligible for every later slot by wallet as well as by C5. |
| TC-BID-08 | UT    | P0  | The wallet and floor conditions are one conjunction, not two independent checks: an entry is accepted **iff** `price == slot.floor` **and** `walletBalance >= slot.floor`. Assert the cross case explicitly — `walletBalance == price` but `price != slot.floor` is **rejected**. |
| TC-BID-09 | UT    | P1  | Entry with a zero, negative, or non-finite `price` is rejected (subsumed by TC-BID-03, asserted separately as an input-validation guard).                                                   |
| TC-BID-10 | IT    | P0  | **C5 (inverted from v2).** A participant who won in slot 1 is **rejected** when entering slot 2, and in every later slot, regardless of remaining balance. v2 asserted the opposite (multi-win permitted); that behaviour is removed. |
| TC-BID-11 | IT    | P0  | Oversubscription persists correctly: 1,000 eligible participants entering a slot whose quota is 100 → exactly 1,000 `pending` rows, all with `slotIndex == currentSlotIndex`, and `entriesReceived == 1000`. Entries are not capped at quota — 900 losers is the intended shape and is what the dashboard's oversubscription ratio displays. |
| TC-BID-12 | UT    | P0  | `submit_bid` is a **single entrypoint** — queue and turn differ only in the branch inside it. Assert by reducer inventory: there is no `buy_ticket` reducer separate from `submit_bid`, and both branches validate `price` against a server-known value (`ticketPrice` / `slot.floor`). |
| TC-BID-13 | IT    | P0  | Entries are accepted for the **full** 60s window and rejected at and after t-0; the ones already accepted are then resolved by `close_slot`. Assert an entry at t-0.2s is accepted and one at t+0.2s is rejected. |




## 7. `close_slot` — clearing (`TC-CLR`)

Traces: HLD §5, LLD §2 (`close_slot`), §4.

> **Rewritten in v3.** The clearing rule is a seeded uniform draw among qualifying entries,
> with every winner paying `slot.floor`. v2's price-descending pay-as-bid cases (ranking by
> amount, per-winner `pricePaid`, cutoff-as-lowest-winning-bid) are removed, not amended.


| ID        | Level | P   | Case                                                                                                                                                                                                                                                                                     |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-CLR-01 | UT    | P0  | Winners are selected by `hash(drawSeed, entry.id)` ascending, taking the first `quota` entries. With 5 entries and quota 2, exactly 2 win and 3 are marked `lost`.                                                                                                                       |
| TC-CLR-02 | UT    | P0  | **Pay-the-floor**: every winner's `Allocation.pricePaid` equals `slot.floor` exactly — identical for all winners in the slot. There is no per-winner price.                                                                                                                              |
| TC-CLR-03 | UT    | P0  | Every winner's wallet is debited by exactly `slot.floor`, in the same transaction as the allocation write, and `hasWon` is set in that same transaction.                                                                                                                                 |
| TC-CLR-04 | UT    | P0  | Every loser's wallet is unchanged and their entry state is `lost`.                                                                                                                                                                                                                       |
| TC-CLR-05 | UT    | P0  | `slot_result` is written exactly once per slot with `clearingPrice = slot.floor`, `entriesReceived`, `allocated = filled`, `quotaRemainingAfterRollover = quota - filled`, and the `drawSeed` used.                                                                                      |
| TC-CLR-06 | UT    | P0  | A slot with zero entries closes cleanly: no allocations, `allocated == 0`, `slot_result` still written (with its `clearingPrice` still equal to the floor), schedule advances.                                                                                                           |
| TC-CLR-07 | UT    | P0  | `slot.filled` and `event.ticketsRemaining` are updated consistently: `sum(slot.filled) == totalTickets - ticketsRemaining` after every close.                                                                                                                                            |
| TC-CLR-08 | UT    | P0  | **Determinism** — re-running `close_slot` over the same committed entry set reproduces the identical winner set. Run ≥100 times.                                                                                                                                                         |
| TC-CLR-09 | UT    | P0  | **Verifiability** — recompute the draw *outside the module* from the published `drawSeed` and the committed entries, and assert the winner set matches the module's exactly. This is the property the mechanism claims over FCFS (HLD §5) and it must be independently checkable, not merely internally consistent. |
| TC-CLR-10 | UT    | P0  | **Seed independence** — `drawSeed` derives only from `(eventId, slotIndex, sorted(entry ids))`. Assert by construction that `seq`, insertion order, `participantId` and join order are not inputs, and that the allocator never dereferences them for ordering. `entry.id` **is** read — but only as a hash input, never as an ordering, and the seed consumes the sorted *set*. That distinction is the hinge C1 turns on.                     |
| TC-CLR-14 | UT    | P0  | **`close_slot` must never call `ctx.random`.** The allocation draw is a pure function of `drawSeed`, itself a pure function of committed state. Assert by source/AST inventory that the clearing path contains no `ctx.random` reference. This cannot be caught behaviourally: a draw seeded from the module RNG still looks uniform and still passes TC-CLR-08/11, but a third party has no access to that stream, so TC-CLR-09 and TC-INV-11 become impossible and the verifiability claim dies silently. Contrast TC-JOIN-01, where the wallet draw **must** use `ctx.random`. |
| TC-CLR-11 | UT    | P0  | **Uniformity** — over 500 synthetic slots with the same participant set, each participant's win rate is statistically indistinguishable from `quota / entries` (χ² or binomial CI). In particular the earliest-joined participant has no edge — the "join-order-in-disguise" failure HLD §5 calls out. |
| TC-CLR-12 | UT    | P0  | **C5 enforced at clearing** — a participant with `hasWon == true` who somehow has a pending entry is skipped and the ticket passes to the next in draw order. Defensive: `submit_bid` should already prevent this, so also assert it never fires in a normal run.                        |
| TC-CLR-13 | UT    | P1  | A winner whose balance cannot cover the floor at close time is skipped, the ticket passes to the next in the draw, and no negative balance is produced. Under C5 this should be unreachable within one event (LLD §2) — assert both the policy and that it does not fire normally.       |
| TC-CLR-14 | UT    | P1  | Entries in the table for a *different* slot index or a different event are not included in this slot's draw.                                                                                                                                                                             |
| TC-CLR-15 | IT    | P0  | `close_slot` fires automatically from the scheduled table at `currentSlotEndsAt` ±1s — no manual trigger, no hand-rolled timer.                                                                                                                                                          |
| TC-CLR-16 | IT    | P0  | After a non-final slot closes, `currentSlotIndex` advances by 1, `currentSlotEndsAt` is set to `now + 60s`, and the next `close_slot` is scheduled — one scheduled row, not two.                                                                                                         |
| TC-CLR-17 | IT    | P0  | At demo scale: 1,000 entries against quota 100 → exactly 100 allocations, 900 `lost`, `close_slot` completes inside the slot boundary, and the winner set is reproducible from `drawSeed`.                                                                                               |




## 8. Quota rollover (`TC-ROLL`)

Traces: HLD §3.3 (confirmed), LLD §2, §11.

> Rollover is **confirmed**, not assumed. Examples below use the 1,250-participant case:
> `totalTickets = 500`, base quota 100 per slot.


| ID         | Level | P   | Case                                                                                                                       |
| ---------- | ----- | --- | ---------------------------------------------------------------------------------------------------------------------------- |
| TC-ROLL-01 | UT    | P0  | Slot 1 quota 100, only 40 qualifying entries → 60 unfilled roll forward; slot 2's effective quota becomes `100 + 60 = 160`. |
| TC-ROLL-02 | UT    | P0  | `slot_result.quotaRemainingAfterRollover` for slot 1 equals the amount actually added to slot 2's quota.                    |
| TC-ROLL-03 | UT    | P1  | Rollover chains: an empty slot 1 and an empty slot 2 both roll into slot 3 (`quota3 + unfilled1 + unfilled2`).              |
| TC-ROLL-04 | UT    | P0  | Total tickets allocated across all slots never exceeds `totalTickets`, regardless of rollover.                              |
| TC-ROLL-05 | UT    | P1  | Unfilled quota in the **final** slot does not roll anywhere and does not block settle.                                      |
| TC-ROLL-06 | UT    | P1  | A fully filled slot rolls forward 0 and leaves the next slot's configured quota untouched.                                  |
| TC-ROLL-07 | IT    | P1  | Rollover survives the derived-quota path: after `start_countdown` sizes quotas, an under-filled slot still rolls correctly at any turnout (250 / 1250 participants). Rollover adds to the next slot's `effectiveQuota` only — `baseQuota` is never touched, which is what keeps TC-EVT-09 true after the first close. |




## 9. Wallet (`TC-WAL`)

Traces: HLD §3.4, LLD §11.


| ID        | Level | P   | Case                                                                                                                                                                         |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-WAL-01 | UT    | P0  | Balance is never negative on any path — queue buy, turn win, concurrent submissions. Assert as a global invariant swept after every test in the suite.                       |
| TC-WAL-02 | UT    | P0  | Debit happens **only** on a win. A losing entry leaves the balance byte-identical.                                                                                           |
| TC-WAL-03 | UT    | P0  | Debit happens **exactly once** per allocation: `participant.initialBalance - participant.walletBalance == sum(pricePaid of that participant's allocations)`. `initialBalance` is the participant's own join-time draw, not a shared constant — the assertion reads their row, never a global. |
| TC-WAL-04 | UT    | P0  | **Atomicity** — no allocation without a matching debit and no debit without a matching allocation. Swept across **every** participant after every clearing as the single expression in TC-WAL-03. Because C5 caps a participant at one ticket per event, the right-hand side is always either `0` or exactly one slot price — so this reduces to a per-row assertion with two legal outcomes. *This case was unwritable before Gate 0: there is no ledger table, `walletBalance` is mutated in place, and nothing recorded the random starting draw, so no quantity existed to reconcile against. `participant.initialBalance` is what makes it testable.* |
| TC-WAL-05 | UT    | P0  | There is no reservation / hold / escrow / pending-debit state anywhere in the schema (HLD §3.4, LLD §2b) — see TC-SCH-14 for the grep-able column list. Serialized reducers make a hold redundant; its presence would signal the debit had been split across calls. |
| TC-WAL-06 | UT    | P0  | The balance guard reads live balance, not the join-time draw.                                                                                                                |
| TC-WAL-07 | IT    | P0  | Under C5 a participant is debited **at most once per event**: after settle, every participant has 0 or 1 allocations and a correspondingly single debit. This replaces v2's "wins queue + all 5 slots = ₹2,85,000" worst case, which C5 makes impossible. |
| TC-WAL-08 | UT    | P1  | No reducer exists to top up, reset, or transfer balance (session-scoped, LLD §1b). Assert by reducer inventory.                                                              |
| TC-WAL-09 | IT    | P1  | A demo re-run creates fresh participants with freshly drawn wallets rather than mutating existing rows.                                                                      |
| TC-WAL-10 | IT    | P0  | Wallet updates reach the participant's client via subscription — the phone view's displayed balance matches the module row after every clearing (no client-side arithmetic). |




## 10. Invariants C1–C5 (`TC-INV`)

Traces: HLD §2, LLD §11. **This is the section the project is judged on.**


| ID        | Level | P   | Case                                                                                                                                                                                                                                                                                                                                        |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-INV-01 | UT    | P0  | **C1, core.** Same entry set inserted as `A B C D E` and as `E C A D B` → byte-identical `Allocation` rows: same winners, same `pricePaid`. Run over ≥100 random permutations of a ≥20-entry set. *The single most important test in the repo.*                                                                                             |
| TC-INV-02 | UT    | P0  | **C1, the draw.** N entries with quota < N → the winning subset is stable across shuffled insertion order, and re-deriving the draw from the closed slot's committed data reproduces the same winners. Under v3 this is not an edge case — it is how every allocation is made.                                                              |
| TC-INV-03 | UT    | P0  | **C1, structural.** The turn allocator never reads `bid.seq`, insertion order, or `participantId` for ordering. Enforce mechanically: mutate every `seq` to a random value before `close_slot` and assert the outcome is unchanged.                                                                                                  |
| TC-INV-04 | IT    | P0  | **C1, system-level (Merge Gate 5).** Bots at near-zero reaction delay vs. humans entering late in the window, same slot → win rates are indistinguishable. A bot entering at t+50ms has exactly the same odds as a human entering at t+58s — across the whole δ range (0–500ms) and the whole 60s window.                                                                                                 |
| TC-INV-05 | UT    | P0  | **C1, within-window.** An entry submitted at second 2 of the window and the same entry submitted at second 59 produce identical outcomes for the same entry set.                                                                                                                                                                            |
| TC-INV-06 | UT    | P0  | **C2.** One entry per participant per slot — see TC-BID-02; asserted here again as an invariant sweep: `count(bid) grouped by (eventId, slotIndex, participantId) <= 1` after every test. Note this is enforced by check-then-insert in `submit_bid`, **not** by a schema constraint — SpacetimeDB has no composite unique (TC-SCH-03).                                                                                                                                                        |
| TC-INV-07 | IT    | P0  | **C3.** All subscribed clients observe the same `slot_result` for a given slot. Every client records `{slot_result_id, state_version, received_at}`; assert every client's next action derives from the same committed state.                                                                                                               |
| TC-INV-08 | IT    | P0  | **C4.** No client acts on a `slot_result` before it is the module's committed state; the spread in `received_at` across clients is bounded and, critically, **is not correlated with which client wins the next slot** (correlation coefficient near zero over ≥30 runs) — a fan-out advantage would show up here, not in the mean latency. |
| TC-INV-09 | IT    | P1  | **C4, negative control.** Artificially delaying one client's subscription by 5s must not change that client's outcome in the next slot (it can only change what they *see*).                                                                                                                                                                |
| TC-INV-10 | UT    | P0  | **C5.** `allocations(participantId, event) <= 1` swept after every test, in both modes. Participant rows are event-scoped, so this is true by construction rather than by convention. A winner is rejected by `submit_bid` in all later slots and skipped by `close_slot` if an entry somehow persists.                                                                                                                                        |
| TC-INV-11 | IT    | P0  | **Verifiability.** For every slot in a full event, an out-of-module recomputation from the published `drawSeed` reproduces the module's winner set exactly. Pairs with TC-CLR-09 at event scope.                                                                                                                                            |
| TC-INV-12 | IT    | P0  | **Master acceptance.** Flip `mode: "queue" → "turn"` with participants, inventory, UI, and network held constant → the winner set changes, and the human share of allocations rises to ≈ the population share (20% ±3pp). This is the project's definition of done (LLD §11).                                                               |




## 11. Client SDK (`FairDropClient`) (`TC-SDK`)

Traces: LLD §6.


| ID        | Level | P   | Case                                                                                                                                                                                                                         |
| --------- | ----- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-SDK-01 | UT    | P0  | Every method in the LLD §6 signature exists with the stated shape: `join(eventId, displayName, origin): Promise<ParticipantId>`, `listEvents`, `createEvent(config): Promise<EventId>`, `startCountdown`, `submitBid(eventId, participantId, slotIndex, price)`, `subscribeEvent`, `subscribeAllocations`, `subscribeSlotResults`, `getWalletBalance(participantId)`. `join`/`createEvent` return Promises because they are **procedures** — reducers cannot return values at all. |
| TC-SDK-02 | UT    | P0  | Nothing outside `clients/sdk` imports the generated SpacetimeDB bindings directly. Enforce as a lint rule / import-graph test over `clients/web`, `clients/bots`, `services/bot-runner`.                                    |
| TC-SDK-03 | UT    | P0  | Table and reducer types are generated (`spacetimedb generate --lang typescript`), not hand-written; regenerating against the current module produces no diff. Run in CI — this is the drift alarm.                           |
| TC-SDK-04 | UT    | P1  | `subscribeEvent` invokes its callback on insert, update, and delete, and the returned `Unsubscribe` stops further callbacks.                                                                                                 |
| TC-SDK-05 | UT    | P0  | A reducer rejection surfaces as a typed error carrying the module's **stable error code** (LLD §2a) — not a silent no-op, and not a message string. Tests and UI copy key off the code; message text is free to change. |
| TC-SDK-09 | UT    | P0  | `u64` ids cross the SDK boundary as `bigint` and are serialised to **decimal strings** in any JSON (the `/onboard` response, mock fixtures, snapshots) — `bigint` does not survive `JSON.stringify`. Assert no consumer performs this conversion itself. |
| TC-SDK-10 | IT    | P0  | **Procedure return values reach the generated client.** `createEvent` and `join` resolve with the new id. If 2.8's client does not surface procedure returns, this is the trigger for the documented fallback (keep both as reducers, await the committed row by its unique `handle`) — flagged in `docs/CONTRACT.md` §10 as a Gate 1 verification item. |
| TC-SDK-06 | IT    | P1  | Connection drop → automatic reconnect and re-subscribe; state converges to the module's without a page reload.                                                                                                               |
| TC-SDK-07 | UT    | P1  | The mock fixture path (LLD §6) drives the same client surface, so UI can be developed and tested without a live module.                                                                                                      |
| TC-SDK-08 | UT    | P1  | The React `useTable` hook subscribes on mount, re-renders on row events, and unsubscribes on unmount (no leak across route changes).                                                                                         |




## 12. Bot-runner service + worker pool (`TC-POOL`)

Traces: HLD §6, §8, §11, LLD §5, §5a, §9.

> Renamed from `TC-SPAWN`. At 250 humans the 4:1 ratio means **1,000 concurrent bots**, so
> "spawn a process per bot" is not an implementation detail — it is the difference between a
> working rig and a dead one. These cases assert the pooled design, not just the ratio.


| ID         | Level | P   | Case                                                                                                                                                                                                                            |
| ---------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-POOL-01 | IT    | P0  | `POST /onboard { displayName }` returns `{ participantId, handle, walletBalance }` for the human (ids serialised as decimal strings — `u64` is `bigint` and does not survive `JSON.stringify`) and creates exactly one `origin: "human"` participant.                                                                                      |
| TC-POOL-02 | IT    | P0  | Each human onboarding results in exactly 4 additional `origin: "bot"` participants — no more, no fewer. N humans → exactly 4N bots.                                                                                             |
| TC-POOL-03 | IT    | P0  | **Bots are async tasks, never child processes.** With 1,000 bots registered, the OS process count for the bot-runner stays bounded and independent of bot count (assert ≤ a small fixed number, sized to cores). This is the single most important case in the section. |
| TC-POOL-04 | IT    | P0  | **Connections are pooled.** 1,000 bots do not open 1,000 SpacetimeDB WebSocket connections; the open-connection count stays at or below the configured pool size.                                                               |
| TC-POOL-05 | IT    | P0  | The `/onboard` response is returned **before** bot registration completes — it is fire-and-forget and never on the human's critical path. Assert the response latency is unaffected when registration is artificially slowed by 5s. |
| TC-POOL-06 | IT    | P0  | If bot registration throws, the human's onboarding still succeeds and returns 200; the failure is logged and retried independently.                                                                                             |
| TC-POOL-07 | IT    | P1  | Bots join with distinct `Bot-<random>` display names; no collisions across 1,000 registrations.                                                                                                                                 |
| TC-POOL-08 | IT    | P1  | Bots call the same `join` / `submit_bid` reducers as the React client — verified by asserting the module has no bot-specific reducer and by inspecting the call surface.                                                        |
| TC-POOL-09 | UT    | P1  | The 4:1 ratio, pool size, and connection count are named config constants, not literals scattered through the code; changing the ratio to 2 registers 2 bots per human.                                                        |
| TC-POOL-10 | IT    | P1  | Bot workers attach to whichever event is currently `open` and do not act on `created`/`countdown`/`settled` events.                                                                                                             |
| TC-POOL-11 | IT    | P0  | 250 concurrent `/onboard` calls → 250 humans + 1,000 bots, no duplicated identities, no dropped registrations, and the pool stays responsive throughout.                                                                        |
| TC-POOL-12 | IT    | P2  | Bot tasks retire (or idle without entering) once the event settles; no orphaned tasks or leaked connections accumulate across repeated demo runs.                                                                               |




## 13. Bot behaviour (`TC-BOT`)

Traces: HLD §6, LLD §5b.

> **Turn-mode bot behaviour is now trivial, and that is the finding, not a gap.** Under a draw
> at a posted price there is no bid amount for anyone to choose, so there is no strategy to
> encode. v2's cases about bid spread, re-rolled draws, and tie rates are removed because the
> behaviour they tested no longer exists.


| ID        | Level | P   | Case                                                                                                                                                                                                                                     |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-BOT-01 | UT    | P0  | Queue mode: a bot calls buy at `t_open + random(0, δ)` where **δ = 500ms is the bound, not the delay** — each bot draws its own value uniformly on `[0, 500ms]`, independently. Assert over ≥100 draws: never before `t_open`, never after `t_open + 500ms`, the sample mean sits near 250ms, and the values are **spread** rather than clustered at either end (a bug that fixes every bot at 500ms, or at 0, would pass a bound-only check while destroying the realism the demo rests on). δ is a named config constant, not a literal. Bots are deliberately capped at roughly best-case human reaction speed; if they still take all inventory (they will), the finding is that FCFS rewards *reliability at scale*, not superhuman speed — which is a stronger claim than one built on a 0ms bot. |
| TC-BOT-02 | UT    | P0  | Turn mode: when `walletBalance >= slot.floor` and the bot has not won, it submits exactly one entry at `price == slot.floor`. It never submits any other amount.                                                                         |
| TC-BOT-03 | UT    | P0  | Turn mode: when `walletBalance < slot.floor`, the bot **abstains** — no `submit_bid` call for that slot or any later slot (floors strictly increase, so the dropout is permanent).                                                       |
| TC-BOT-04 | UT    | P0  | Turn mode: a bot with `hasWon == true` submits nothing in every later slot (C5 respected client-side; the module guard is the backstop — TC-BID-10).                                                                                     |
| TC-BOT-05 | UT    | P0  | A bot never submits above its `walletBalance`; the module guard is the backstop (TC-WAL-06).                                                                                                                                             |
| TC-BOT-06 | UT    | P0  | A bot submits at most one entry per slot (client-side), and the module rejects a duplicate if it ever tried (TC-BID-02).                                                                                                                 |
| TC-BOT-07 | IT    | P1  | Bot effort is identical across modes — the same reaction speed and same call cadence in queue and turn mode. The demo's claim is that turn mode neutralizes speed *without* the bot behaving differently; a weakened bot invalidates it. |
| TC-BOT-08 | IT    | P1  | Across a full turn-mode event, the count of entering bots strictly decreases as floors rise (the dropout curve, driven by wallet draws) — a legibility requirement from HLD §11.                                                         |
| TC-BOT-09 | IT    | P0  | **Bots hold no edge.** Over a full turn-mode event at demo scale, bots win ≈80% of tickets — matching their 80% population share, not exceeding it. Both a materially higher share (speed advantage survived) and a near-zero share (mechanism over-corrected into excluding bots, which is not the claim) fail this case. |




## 14. Admin dashboard read-model (`TC-DASH`)

Traces: HLD §4.2, LLD §8.


| ID         | Level | P   | Case                                                                                                                                                                     |
| ---------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-DASH-01 | IT    | P0  | Shows `totalTickets`, `ticketsRemaining`, `allocated` — and `allocated + ticketsRemaining == totalTickets` at every observed moment.                                     |
| TC-DASH-02 | IT    | P0  | The **human vs bot split** is computed from `Allocation` joined to `Participant.origin` — not inferred from display name — and the two numbers sum to total allocations. |
| TC-DASH-03 | E2E   | P0  | The split updates live as slots clear, with no manual refresh.                                                                                                           |
| TC-DASH-04 | E2E   | P0  | Turn mode: per-slot rows show index, floor, effective quota (post-rollover), `entriesReceived`, and filled — matching the module's `slot` / `slot_result` rows exactly. There is **no cutoff-price column**: under pay-the-floor the floor is the clearing price, so the two collapsed into one value (LLD §8). |
| TC-DASH-05 | E2E   | P0  | The **oversubscription ratio** (`entriesReceived / quota`) is displayed per slot and visibly changes across the five slots as the eligible field shrinks. This replaces price discovery as the per-slot narrative (HLD §4.2). |
| TC-DASH-06 | E2E   | P1  | `participantsAtOpen` and the derived `totalTickets` are shown, so the room can see inventory was sized from actual turnout rather than fixed in advance.                 |
| TC-DASH-07 | E2E   | P1  | Queue mode: no slot table is rendered; the fixed ticket price is shown instead.                                                                                          |
| TC-DASH-08 | IT    | P0  | The dashboard opens no write path — it issues subscriptions and reducer-free reads only. Assert by call inventory.                                                       |
| TC-DASH-09 | E2E   | P1  | The dashboard renders correctly at projector resolution with the human/bot split as the visually dominant element (HLD §4.2 — "the headline number for the room").       |
| TC-DASH-10 | E2E   | P1  | With zero allocations the dashboard renders 0/0 rather than erroring or showing `NaN`.                                                                                   |
| TC-DASH-11 | E2E   | P1  | Round 1 and Round 2 results are both retrievable after settle, so the two can be shown side by side on stage.                                                            |
| TC-DASH-12 | E2E   | P1  | The published `drawSeed` for each slot is visible (or copyable) from the dashboard, so the draw can be independently verified live if challenged (HLD §5).               |




## 15. Web UI — onboarding, event list, phone view (`TC-UI`)

Traces: HLD §3.1–§3.3, LLD §9. All Playwright unless noted.

> The turn-mode phone view has **no bid-amount input**. An entry is a single confirm action at
> the posted floor price. v2's cases about typing an amount and validating it client-side are
> replaced accordingly.


| ID       | Level | P   | Case                                                                                                                                                                                   |
| -------- | ----- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-UI-01 | E2E   | P0  | QR landing → enter display name → submit → participant created, wallet shows the participant's own drawn balance (a value in ₹20,000–₹1,50,000, not a fixed figure), events list renders. |
| TC-UI-02 | E2E   | P0  | Empty display name cannot be submitted; an inline error is shown.                                                                                                                      |
| TC-UI-03 | E2E   | P0  | The events list shows each event's name, mode, and state, and updates live when the admin creates a new one.                                                                           |
| TC-UI-04 | E2E   | P0  | Queue-mode event page shows the fixed price and a **disabled** Buy button during the 60s pre-open countdown; the countdown ticks visibly.                                              |
| TC-UI-05 | E2E   | P0  | Buy becomes enabled exactly at countdown zero — clicking before zero is impossible and, if forced programmatically, is rejected by the module (TC-LC-05).                              |
| TC-UI-06 | E2E   | P0  | Successful buy → ticket confirmation shown and wallet decreases by the ticket price.                                                                                                   |
| TC-UI-07 | E2E   | P0  | Sold-out buy → clear "not allocated" state, wallet unchanged. The rejection must be legible, not a silent failure.                                                                     |
| TC-UI-08 | E2E   | P0  | Turn-mode event page shows the current slot index, its floor (labelled as the price you will pay), the effective quota, and the slot countdown. The entry control is a **single confirm action at the floor price** — there is no amount to type. |
| TC-UI-09 | E2E   | P0  | The entry control is disabled with an explanatory message when `walletBalance < slot.floor` — the participant can see they have dropped out and why.                                   |
| TC-UI-10 | E2E   | P0  | After entering, the control is locked for that slot and the UI shows "entered" — a second submission is not offered (C2 at the UI layer).                                             |
| TC-UI-11 | E2E   | P0  | Entries are **sealed**: no other participant's entry is visible anywhere in the UI or in the subscribed data before the slot closes, and neither is the running entry count. Assert on both DOM and network payloads. |
| TC-UI-12 | E2E   | P0  | At slot close the phone view shows won/lost, and for a win the price paid equals the slot floor exactly.                                                                               |
| TC-UI-13 | E2E   | P0  | **C5 at the UI layer.** After winning, later slots show a "you already have a ticket" state with no entry control offered.                                                            |
| TC-UI-14 | E2E   | P0  | The next slot's higher floor appears automatically without a refresh.                                                                                                                  |
| TC-UI-15 | E2E   | P1  | The countdown UI does not imply urgency-to-click in turn mode — entering at second 2 and at second 59 both succeed and are presented identically (TC-INV-05 at the UX layer).          |
| TC-UI-16 | E2E   | P1  | Phone view renders correctly on a 390×844 viewport; nothing critical requires horizontal scrolling.                                                                                    |
| TC-UI-17 | E2E   | P1  | A settled event's page shows the final outcome and does not offer an entry or buy control.                                                                                             |
| TC-UI-18 | E2E   | P2  | Reloading mid-slot restores the participant's session, wallet, and "already entered" state from subscriptions.                                                                         |




## 16. Experiment runner (`TC-EXP`)

Traces: LLD §10.

> The runner is the **offline simulation** used to validate parameters before the demo — not
> part of the live event. A working prototype exists at `scratchpad/sim3.py`; port it rather
> than rewriting. Its output is what produced HLD §5a.


| ID        | Level | P   | Case                                                                                                                                                                                  |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-EXP-01 | IT    | P0  | `npm run experiment` runs both rounds over one configured population and prints human/bot allocation counts per round.                                                                |
| TC-EXP-02 | IT    | P0  | Round 1 (queue) shows bots taking a share far above their population share; Round 2 (turn) shows the human share at ≈20%. Assert directionally with a threshold, not against exact numbers. |
| TC-EXP-03 | IT    | P0  | The bot share in turn mode is **non-zero and ≈80%** — a total flip would mean the mechanism went past "removes the speed advantage" into "excludes bots", which is not the claim.      |
| TC-EXP-04 | IT    | P0  | **Turnout sweep.** Running at 50 / 100 / 150 / 250 humans with `ticketFraction = 0.40` holds every observable flat: sells out at every turnout, ~40% of humans win, identical clearing prices. This is the case that protects the derived-inventory decision (HLD §3.3) from regressing to a fixed `totalTickets`. |
| TC-EXP-05 | IT    | P0  | **Determinism under a fixed RNG seed.** The runner takes an explicit seed; the same seed reproduces identical output. An "RNG seed" is the fixed starting value for the pseudo-random generator that drives wallet draws, bot delays, and the draw itself — without it, rehearsal numbers would not match show numbers and a change in the human/bot split could not be attributed to a code change rather than to chance. |
| TC-EXP-06 | IT    | P0  | **Rule comparison arm.** The runner can execute the retired `price-descending pay-as-bid` rule over identical populations and report human share, richest-cohort overlap, average price paid, and floors-binding count — regenerating HLD §5a's tables on demand. This is the only place that comparator may exist (LLD §1b). |
| TC-EXP-07 | IT    | P1  | **Delay sweep.** Sweeping bot reaction delay δ changes the queue-mode outcome substantially and the turn-mode outcome negligibly. This is the evidentiary core of the whole thesis.    |
| TC-EXP-08 | IT    | P1  | The runner respects the 4:1 ratio and the LLD §1a parameters for whatever headcount is configured.                                                                                    |




## 17. End-to-end scenarios (`TC-E2E`)

Full-stack: local SpacetimeDB + module + bot-runner pool + Playwright-driven browsers. These
are the "run the whole demo" checkpoints and double as the manual dry-run script.


| ID        | Level | P   | Scenario                                                                                                                                                                                                                                                                       |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-E2E-01 | E2E   | P0  | **Queue round, happy path.** Admin creates a queue event (₹15,000) → humans onboard (4x bots each) → `start_countdown` sizes inventory from headcount → open → all buy → tickets allocate in arrival order → wallets debited → dashboard shows a bot-skewed split → settle.    |
| TC-E2E-02 | E2E   | P0  | **Turn round, happy path.** Same population, turn event with the 5-floor ladder → each slot: countdown, sealed entries from humans and bots, close, results published simultaneously → 5 slot results → settle → dashboard shows human share ≈ population share.               |
| TC-E2E-03 | E2E   | P0  | **Master acceptance on stage.** Run TC-E2E-01 then TC-E2E-02 back-to-back with the same population, flipping only `mode` → the winner sets differ and the human share rises to ≈20%. Capture both dashboards for side-by-side display.                                         |
| TC-E2E-04 | E2E   | P0  | **Late entrant is not disadvantaged.** A human enters at second 58 of a slot; a bot enters at second 0.05. Over ≥30 repetitions their win rates are indistinguishable. This is the demo's money shot — under a draw it is a statistical claim, not a single scripted win, so it must be demonstrated as a rate rather than a one-off. |
| TC-E2E-05 | E2E   | P0  | **Wallet reconciliation across a full event.** After settle, for every participant: `walletBalance == theirInitialDraw - sum(their pricePaid)`, every allocation has a matching debit, and no participant has more than one allocation (C5). Zero drift.                       |
| TC-E2E-06 | E2E   | P0  | **Rollover visible end to end.** Slot 1 deliberately under-subscribed → the unfilled quota appears added to slot 2 on the dashboard and more tickets clear in slot 2 than its base quota.                                                                                      |
| TC-E2E-07 | E2E   | P0  | **Simultaneity.** Three browsers subscribed to the same event receive the same `slot_result` with bounded skew, and none can act on it before the others (C3/C4 observed through the real UI).                                                                                 |
| TC-E2E-08 | E2E   | P0  | **Verification live.** Take a settled slot's published `drawSeed` and committed entries, recompute the winners with an independent script, and match the dashboard exactly. This is the rebuttal to "how do we know the draw was fair" and must be runnable on stage.          |
| TC-E2E-09 | E2E   | P1  | **Thin final slot.** Few participants clear slot 5's floor → the slot closes with fewer allocations than quota, the dashboard shows the shortfall, and settle still occurs cleanly.                                                                                            |
| TC-E2E-10 | E2E   | P1  | **Re-run.** After settle, create a fresh event and re-onboard → fresh participants, freshly drawn wallets, no residue from the previous run in the dashboard. There is no reset path over the old event.                                                                       |
| TC-E2E-11 | E2E   | P1  | **Bot-runner down.** With the service unavailable, human onboarding surfaces a clear error and the module state stays consistent; bringing it back allows onboarding to proceed.                                                                                               |
| TC-E2E-12 | E2E   | P1  | **Client disconnect mid-slot.** A phone loses connection during a slot, reconnects after close → it shows the correct won/lost result and correct wallet, reconstructed from subscriptions.                                                                                    |
| TC-E2E-13 | MAN   | P0  | **Full manual dry run on the demo rig**, on venue LAN/hotspot, at the **top of the turnout range (250 humans / 1,250 participants)** — run TC-E2E-03 start to finish and time it. Do not dry-run only at small N; the failure modes are all at scale.                          |




## 18. Non-functional / demo-rig (`TC-NFR`)

Traces: HLD §8, §11, LLD §1a, §5a.

> **TC-NFR-01 is the highest-risk item in this document.** It is scheduled at Merge Gate 3, not
> as a polish pass. Sorting 1,250 entries in a reducer is trivial; sustaining 1,250 live
> subscribers on one rig is not, and it is untested.


| ID        | Level | P   | Case                                                                                                                                                            |
| --------- | ----- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-NFR-01 | IT    | P0  | **1,250 participants (250 humans + 1,000 pooled bots) subscribed concurrently**, all entering one slot → every entry lands, `close_slot` completes within the slot boundary, every subscriber receives the `slot_result`, and no entry is dropped. Run at Gate 3. |
| TC-NFR-02 | IT    | P0  | The same at the bottom of the range (250 participants) — the rig must not be tuned so tightly for 1,250 that a small turnout misbehaves.                        |
| TC-NFR-03 | IT    | P0  | Nothing in the critical path makes an outbound network call — the whole demo runs with external connectivity disabled. Assert by running the E2E suite offline. |
| TC-NFR-04 | E2E   | P1  | Slot countdown UI drift stays under 1s against the module's `currentSlotEndsAt` over a 5-slot event, with 1,250 subscribers connected.                          |
| TC-NFR-05 | IT    | P1  | Module logs are sufficient to reconstruct any clearing after the fact: entry set, `drawSeed`, resulting draw order, winners, price paid.                        |
| TC-NFR-06 | MAN   | P1  | Cold start — publish module, start bot-runner, serve client — is documented and takes under 5 minutes from a clean checkout.                                    |
| TC-NFR-07 | IT    | P2  | Repeated demo runs in one session do not degrade clearing latency (no unbounded row growth in the hot path).                                                    |




## Coverage map — invariants to cases


| Invariant                             | Primary                | Supporting                                                     |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| C1 — arrival order has zero weight    | TC-INV-01, TC-INV-03   | TC-INV-02, TC-INV-04, TC-INV-05, TC-CLR-08/10/11, TC-E2E-04     |
| C2 — one entry per participant per slot| TC-BID-02              | TC-INV-06, TC-UI-10, TC-BOT-06                                  |
| C3 — one authoritative clearing state | TC-INV-07              | TC-LC-08, TC-CLR-05, TC-WAL-04, TC-E2E-07                       |
| C4 — fan-out creates no second race   | TC-INV-08              | TC-INV-09, TC-UI-11, TC-E2E-07                                  |
| C5 — one ticket per participant/event  | TC-INV-10              | TC-BID-10, TC-Q-07, TC-CLR-12, TC-UI-13, TC-WAL-07              |
| Verifiability of the draw             | TC-CLR-09              | TC-INV-11, TC-E2E-08, TC-DASH-12                                |
| Derived inventory holds across turnout| TC-EVT-10              | TC-EVT-09/11, TC-EXP-04, TC-LC-02                               |
| Wallet atomicity                      | TC-WAL-04              | TC-WAL-01..03, TC-CLR-03, TC-E2E-05                             |
| Scale survivability                   | TC-NFR-01              | TC-POOL-03, TC-POOL-04, TC-POOL-11, TC-CLR-17, TC-E2E-13        |
| Master acceptance                     | TC-INV-12              | TC-E2E-03, TC-EXP-02                                            |




## Mapping to merge gates (LLD §13)


| Gate                                      | Cases that must pass                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Gate 1 — hello-world                      | TC-EVT-01/02, TC-JOIN-01, TC-SDK-01                                   |
| Gate 2 — one participant, queue           | TC-Q-01, TC-WAL-03, TC-LC-01..03, TC-EVT-10                           |
| Gate 3 — **scale, early**                 | TC-Q-05, TC-Q-06, TC-POOL-02/03/04/11, **TC-NFR-01**, TC-EXP-02 (round 1) |
| Gate 4 — turn mode                        | TC-BID-01..13, TC-CLR-01..07, TC-ROLL-01, TC-EVT-07/09                |
| Gate 5 — C1 invariance + verifiability    | TC-INV-01..05, TC-CLR-09, TC-INV-11                                   |
| Gate 6 — subscriptions + wallet atomicity | TC-INV-07, TC-INV-08, TC-WAL-04, TC-E2E-05                            |
| Gate 7 — bot-runner + onboarding          | TC-POOL-01/05/06, TC-UI-01                                            |
| Gate 8 — UI                               | TC-UI-*, TC-DASH-*, TC-E2E-01..03, TC-E2E-08                          |

Gate 3 carries the load test deliberately. Every other schedule risk in this project is
recoverable; discovering at Gate 8 that the rig cannot hold 1,250 subscribers is not.




## Suggested file placement

```
module/tests/
  queue.test.ts          TC-Q-*, TC-LC-12
  turn.test.ts           TC-BID-*, TC-CLR-*, TC-ROLL-*
  inventory.test.ts      TC-EVT-09..12, TC-LC-02
  onewin.test.ts         TC-INV-10, TC-BID-10, TC-Q-07, TC-CLR-12
  wallet.test.ts         TC-WAL-*
  invariance.test.ts     TC-INV-01..06
  verifiability.test.ts  TC-CLR-09, TC-INV-11
  lifecycle.test.ts      TC-LC-*, TC-EVT-01..08, TC-JOIN-*
  schema.test.ts         TC-SCH-*
integration/
  subscriptions.spec.ts  TC-INV-07..09
  pool.spec.ts           TC-POOL-*
  bots.spec.ts           TC-BOT-*
  experiment.spec.ts     TC-EXP-*
  scale.spec.ts          TC-NFR-01..04, TC-NFR-07, TC-CLR-17
clients/web/e2e/
  onboarding.spec.ts     TC-UI-01..03
  queue-round.spec.ts    TC-UI-04..07, TC-E2E-01
  turn-round.spec.ts     TC-UI-08..18, TC-E2E-02, 04, 06, 09
  dashboard.spec.ts      TC-DASH-*
  acceptance.spec.ts     TC-E2E-03, 05, 07, 08, 10..12
```

Annotate each test with its `TC-` ID in a comment or the test title so coverage against this
document can be checked mechanically rather than by memory.