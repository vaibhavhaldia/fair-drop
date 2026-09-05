# Fair Drop — Acceptance Test Cases

Status: Draft v1 — derived from `techspec/HLD.md` (v2) and `techspec/LLD.md` (v2)
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
3. `create_event` [(admin)](#3-create_event-admin-tc-evt)
4. `join` [/ participant](#4-join--participant-tc-join)
5. `submit_bid` [— queue mode](#5-submit_bid--queue-mode-tc-q)
6. `submit_bid` [— turn mode](#6-submit_bid--turn-mode-tc-bid)
7. `close_slot` [— clearing](#7-close_slot--clearing-tc-clr)
8. [Quota rollover](#8-quota-rollover-tc-roll)
9. [Wallet](#9-wallet-tc-wal)
10. [Invariants C1–C4](#10-invariants-c1c4-tc-inv)
11. [Client SDK (](#11-client-sdk-fairdropclient-tc-sdk)`FairDropClient`[)](#11-client-sdk-fairdropclient-tc-sdk)
12. [Bot-spawner service](#12-bot-spawner-service-tc-spawn)
13. [Bot behaviour](#13-bot-behaviour-tc-bot)
14. [Admin dashboard read-model](#14-admin-dashboard-read-model-tc-dash)
15. [Web UI — onboarding, event list, phone view](#15-web-ui--onboarding-event-list-phone-view-tc-ui)
16. [Experiment runner](#16-experiment-runner-tc-exp)
17. [End-to-end scenarios](#17-end-to-end-scenarios-tc-e2e)
18. [Non-functional / demo-rig](#18-non-functional--demo-rig-tc-nfr)

**Open items that gate specific cases** (flagged inline, do not silently resolve them):

- *Rollover assumption* (HLD §3.3, LLD top): unsold quota rolls into the next slot. All of
§8 assumes this. If the stakeholder says "unsold quota is lost", TC-ROLL-01..05 invert.
- *Multi-win policy*: a participant may win in more than one slot (HLD §3.3). TC-CLR-09 asserts
this is allowed; flip it only on an explicit requirement change.

---



## 1. Schema & constraints (`TC-SCH`)

Traces: LLD §1, §1c.


| ID        | Level | P   | Case                                                                                                                                                                                                                     |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-SCH-01 | UT    | P0  | Publishing the module against a clean local SpacetimeDB creates all tables — `event`, `slot`, `participant`, `bid`, `allocation`, `slot_result`, `slot_schedule`, `countdown_schedule` — with the column sets in LLD §1. |
| TC-SCH-02 | UT    | P0  | `participant.identity` is a primary key: a second `join` from the same identity does not create a second row (see TC-JOIN-04 for the behavioural assertion).                                                             |
| TC-SCH-03 | UT    | P1  | `(eventId, slotIndex)` is unique on `slot`: attempting to insert a duplicate slot index for one event fails.                                                                                                             |
| TC-SCH-04 | UT    | P1  | A multi-column btree index exists on `bid(eventId, slotIndex, participant)`; a lookup by that triple does not table-scan. Verify via the declared `indexes` option, not by timing.                                       |
| TC-SCH-05 | UT    | P0  | `bid.seq` is populated and monotonically increasing per event — it exists for audit. Paired with TC-INV-03, which asserts nothing in the turn allocator *reads* it.                                                      |
| TC-SCH-06 | UT    | P1  | Every table the client subscribes to (`event`, `slot`, `participant`, `allocation`, `slot_result`) is declared `public: true`; `slot_schedule` and `countdown_schedule` are **not** public.                              |
| TC-SCH-07 | UT    | P1  | `slot.cutoffPrice` and `event.currentSlotEndsAt` are optional and start `null`; `slot.filled` starts `0`.                                                                                                                |
| TC-SCH-08 | IT    | P2  | Re-running the demo (new `create_event`) produces new rows and requires no migration — `slotIndex` behaves as data, not schema.                                                                                          |




## 2. Event lifecycle / state machine (`TC-LC`)

Traces: HLD §3, LLD §2 (`open_event`, `settle`), §3.


| ID       | Level | P   | Case                                                                                                                                                                                                   |
| -------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-LC-01 | UT    | P0  | A newly created event is in state `created` with `ticketsRemaining == totalTickets`.                                                                                                                   |
| TC-LC-02 | UT    | P0  | `start_countdown` moves `created → countdown` and schedules `open_event` at `now + countdownSeconds` (60s default) via `countdown_schedule`.                                                           |
| TC-LC-03 | IT    | P0  | When the countdown row fires, `open_event` runs and the event becomes `open`. In turn mode it also sets `currentSlotIndex = 0`, `currentSlotEndsAt = now + 60s`, and inserts a `slot_schedule` row.    |
| TC-LC-04 | UT    | P0  | `submit_bid` during `created` is rejected (`event.state == "open"` guard). Wallet unchanged, no `bid` row.                                                                                             |
| TC-LC-05 | UT    | P0  | `submit_bid` during `countdown` is rejected — the pre-open window accepts nothing. This is the guard that makes the countdown a fairness device and not a head start.                                  |
| TC-LC-06 | UT    | P0  | `submit_bid` after `settled` is rejected.                                                                                                                                                              |
| TC-LC-07 | UT    | P0  | `open_event` invoked by a non-module identity is rejected (`ctx.sender == module identity` guard), and the scheduled reducer is not client-callable at all in v2.0 — assert both layers.               |
| TC-LC-08 | UT    | P0  | `close_slot` called twice for the same `slotIndex` — the second call is rejected and produces no second `slot_result` row and no double allocation.                                                    |
| TC-LC-09 | UT    | P0  | `settle` called twice — second call rejected by the `state == "open"` guard.                                                                                                                           |
| TC-LC-10 | IT    | P0  | Turn mode: after the final slot closes, the event auto-transitions to `settled` without an admin action.                                                                                               |
| TC-LC-11 | IT    | P0  | Turn mode: if `ticketsRemaining` hits 0 mid-schedule (e.g. slot 3 of 5), the event settles immediately and no further slot is opened or scheduled.                                                     |
| TC-LC-12 | IT    | P1  | Queue mode: event settles when `ticketsRemaining == 0` or at `endTime`, whichever comes first.                                                                                                         |
| TC-LC-13 | UT    | P1  | `settle` writes the scoreboard summary aggregating `Allocation` by `participant.origin`; human + bot counts sum to total allocations.                                                                  |
| TC-LC-14 | IT    | P1  | Two events can be `open` concurrently without cross-contamination — bids on event A never appear in event B's clearing (schema permits it even though the demo convention is one at a time; HLD §4.1). |




## 3. `create_event` (admin) (`TC-EVT`)

Traces: HLD §4.1, LLD §2.


| ID        | Level | P   | Case                                                                                                                                                              |
| --------- | ----- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-EVT-01 | UT    | P0  | Queue-mode create with `{ name, mode: "queue", totalTickets, startTime, ticketPrice }` persists an event with `ticketPrice` set and no slot rows.                 |
| TC-EVT-02 | UT    | P0  | Turn-mode create with 5 slots persists 5 `slot` rows with the given floors/quotas, `filled = 0`, and `currentSlotIndex = 0`.                                      |
| TC-EVT-03 | UT    | P0  | `create_event` from a non-admin identity is rejected; no event row is written.                                                                                    |
| TC-EVT-04 | UT    | P1  | Turn-mode create with an empty or missing `slots` array is rejected.                                                                                              |
| TC-EVT-05 | UT    | P1  | Queue-mode create with a missing or non-positive `ticketPrice` is rejected.                                                                                       |
| TC-EVT-06 | UT    | P1  | `totalTickets == 0` is rejected.                                                                                                                                  |
| TC-EVT-07 | UT    | P1  | Slot floors that do not strictly increase are accepted but flagged (warn, don't block) — the mechanism does not require monotonic floors; the demo parameters do. |
| TC-EVT-08 | UT    | P1  | Sum of slot quotas may exceed `totalTickets`; inventory, not quota, is the hard stop (see TC-CLR-08).                                                             |
| TC-EVT-09 | IT    | P0  | `listEvents` returns past and current events with their state; a settled event still appears.                                                                     |
| TC-EVT-10 | IT    | P1  | Creating a second event while a first is open succeeds — "one active event" is a demo convention, not an enforced constraint (HLD §4.1).                          |




## 4. `join` / participant (`TC-JOIN`)

Traces: HLD §3.1, §6, LLD §2 (`join`), §1a.


| ID         | Level | P   | Case                                                                                                                                                                                                   |
| ---------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-JOIN-01 | UT    | P0  | `join("Asha", "human")` creates a participant with `origin = "human"` and `walletBalance = 500000`.                                                                                                    |
| TC-JOIN-02 | UT    | P0  | `join("Bot-x9", "bot")` creates a participant with `origin = "bot"` and the **same** `walletBalance = 500000` — bots are not privileged or handicapped by balance.                                     |
| TC-JOIN-03 | UT    | P0  | `ceiling` is populated for every participant, human and bot, drawn uniformly from [20000, 150000].                                                                                                     |
| TC-JOIN-04 | UT    | P0  | The same identity calling `join` twice does not create a second participant and does not re-credit or reset the wallet (idempotent or rejected — either is acceptable, silent re-credit is not).       |
| TC-JOIN-05 | UT    | P1  | `origin` outside `{"human","bot"}` is rejected.                                                                                                                                                        |
| TC-JOIN-06 | UT    | P1  | Empty / whitespace-only `displayName` is rejected. Duplicate display names across different identities are allowed.                                                                                    |
| TC-JOIN-07 | UT    | P0  | There is exactly one `join` reducer — no bot-specific join path exists in the module (assert by source/reducer inventory; the module must not be able to tell a bot from a human except via `origin`). |
| TC-JOIN-08 | UT    | P1  | Over 200 joins, the `ceiling` distribution is approximately uniform across [20000, 150000] and ~35–42% of draws exceed 100000, matching the "some bots can still contest slot 5" sizing in LLD §1a.    |
| TC-JOIN-09 | UT    | P1  | A human's `ceiling` is never read by any bid path — assert the module's `submit_bid` guards reference only `walletBalance` and `slot.floor`.                                                           |
| TC-JOIN-10 | IT    | P1  | `submit_bid` from an identity that never joined is rejected ("registered participant" guard).                                                                                                          |




## 5. `submit_bid` — queue mode (`TC-Q`)

Traces: HLD §3.2, LLD §2, §4.


| ID      | Level | P   | Case                                                                                                                                                                                                                                                 |
| ------- | ----- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-Q-01 | UT    | P0  | Valid buy with `ticketsRemaining > 0`: an `Allocation` row is written with `pricePaid == ticketPrice`, the wallet is debited by exactly `ticketPrice`, and `ticketsRemaining` decrements by 1 — all in one reducer call.                             |
| TC-Q-02 | UT    | P0  | `price != ticketPrice` is rejected; wallet untouched, no allocation.                                                                                                                                                                                 |
| TC-Q-03 | UT    | P0  | Buy when `ticketsRemaining == 0` is rejected; wallet untouched. `ticketsRemaining` never goes negative.                                                                                                                                              |
| TC-Q-04 | UT    | P0  | Buy when `walletBalance < ticketPrice` is rejected before any write.                                                                                                                                                                                 |
| TC-Q-05 | IT    | P0  | Inventory 5, participants A..H submitting in that arrival order → allocations go to A..E in arrival order. **This is the baseline being indicted, and it must hold** — if queue mode isn't arrival-ordered, Round 1 doesn't demonstrate the problem. |
| TC-Q-06 | IT    | P0  | Inventory 5, 50 concurrent submissions fired as simultaneously as the harness allows → exactly 5 allocations, exactly 5 wallets debited, `ticketsRemaining == 0`, no double-allocation, no negative balance.                                         |
| TC-Q-07 | UT    | P1  | The same participant may buy twice in queue mode if inventory allows (no per-identity cap in queue mode — C2 is a turn-mode/per-slot constraint). Confirm this matches intent before locking.                                                        |
| TC-Q-08 | IT    | P1  | A rejected buy leaves no `bid` row in state `won`; if a `bid` row is written for audit it is `rejected`.                                                                                                                                             |




## 6. `submit_bid` — turn mode (`TC-BID`)

Traces: HLD §3.3, LLD §2 (`submit_bid`), C2.


| ID        | Level | P   | Case                                                                                                                                                                                        |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-BID-01 | UT    | P0  | Valid bid ≥ floor, ≤ wallet, current slot → one `bid` row in state `pending`. **No allocation, no wallet debit** happens at submit time.                                                    |
| TC-BID-02 | UT    | P0  | **C2** — the same identity submitting a second bid in the same slot is rejected; exactly one `bid` row persists, and it is the first one (the second is not queued and does not overwrite). |
| TC-BID-03 | UT    | P0  | Bid below the current slot's floor is rejected.                                                                                                                                             |
| TC-BID-04 | UT    | P0  | Bid exceeding `walletBalance` is rejected pre-write.                                                                                                                                        |
| TC-BID-05 | UT    | P0  | Bid carrying a stale `slotIndex` (already closed) is rejected.                                                                                                                              |
| TC-BID-06 | UT    | P0  | Bid carrying a future `slotIndex` is rejected — you cannot pre-position for a slot that has not opened.                                                                                     |
| TC-BID-07 | UT    | P0  | Bid exactly equal to the floor is accepted (boundary, inclusive).                                                                                                                           |
| TC-BID-08 | UT    | P0  | Bid exactly equal to `walletBalance` is accepted (boundary, inclusive).                                                                                                                     |
| TC-BID-09 | UT    | P1  | Bid of 0, negative, or non-finite is rejected.                                                                                                                                              |
| TC-BID-10 | IT    | P0  | A participant who won in slot 1 may bid again in slot 2 (multi-win permitted — HLD §3.3), subject to the reduced wallet balance from their slot-1 debit.                                    |
| TC-BID-11 | IT    | P0  | 100 participants each bid once in one slot → exactly 100 `pending` rows, all with `slotIndex == currentSlotIndex`.                                                                          |
| TC-BID-12 | UT    | P0  | `submit_bid` is a **single entrypoint** — queue and turn differ only in the branch inside it. Assert by reducer inventory: there is no `buy_ticket` reducer separate from `submit_bid`.     |




## 7. `close_slot` — clearing (`TC-CLR`)

Traces: HLD §5, LLD §2 (`close_slot`), §4.


| ID        | Level | P   | Case                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-CLR-01 | UT    | P0  | Ranking is strictly price-descending. Bids 90k/70k/50k/30k with quota 2 → winners 90k and 70k; 50k and 30k become `lost`.                                                                                                                                                                                                                                                       |
| TC-CLR-02 | UT    | P0  | **Pay-as-bid**: each winner's `Allocation.pricePaid` equals their own bid, not a single clearing price. In TC-CLR-01, `pricePaid` is 90000 and 70000 — never 70000 for both.                                                                                                                                                                                                    |
| TC-CLR-03 | UT    | P0  | Every winner's wallet is debited by their own bid amount, in the same transaction as the allocation write.                                                                                                                                                                                                                                                                      |
| TC-CLR-04 | UT    | P0  | Every loser's wallet is unchanged and their bid state is `lost`.                                                                                                                                                                                                                                                                                                                |
| TC-CLR-05 | UT    | P0  | `slot_result` is written exactly once per slot with `cutoffPrice = min(winning bids)`, `allocated = filled`, `quotaRemainingAfterRollover = quota - filled`.                                                                                                                                                                                                                    |
| TC-CLR-06 | UT    | P0  | `cutoffPrice` is `null` (and `allocated == 0`) when a slot receives zero qualifying bids.                                                                                                                                                                                                                                                                                       |
| TC-CLR-07 | UT    | P0  | `slot.filled` and `event.ticketsRemaining` are updated consistently: `sum(slot.filled) == totalTickets - ticketsRemaining` after every close.                                                                                                                                                                                                                                   |
| TC-CLR-08 | UT    | P0  | Quota 6 but only 3 tickets left in inventory → exactly 3 allocations; `ticketsRemaining` floors at 0 and never goes negative. Inventory beats quota.                                                                                                                                                                                                                            |
| TC-CLR-09 | IT    | P0  | A participant winning in two different slots gets two `Allocation` rows and two debits (multi-win allowed — flip only on a requirement change).                                                                                                                                                                                                                                 |
| TC-CLR-10 | UT    | P0  | **Tiebreak determinism** — 5 bids at the identical price with quota 2: the winning pair is determined by `hash(tieSeed, bid.id)`, and re-running `close_slot` over the same committed bid set reproduces the same pair.                                                                                                                                                         |
| TC-CLR-11 | UT    | P0  | **Tiebreak independence** — the tie seed is derived only from `(eventId, slotIndex, sorted(bid ids))`. Assert by construction that `seq`, insertion order, participant identity, and join order are not inputs. A code-level assertion (the allocator never dereferences `bid.seq` or `participant.identity` for ordering) plus TC-INV-02/03.                                   |
| TC-CLR-12 | UT    | P1  | Tiebreak does not favour low participant IDs: over 500 synthetic tied slots, the win rate of the earliest-joined participant is statistically indistinguishable from uniform (χ² or binomial CI). This is the specific "join-order-in-disguise" failure HLD §5 calls out.                                                                                                       |
| TC-CLR-13 | UT    | P1  | A slot with zero bids closes cleanly: no allocations, `slot_result` written, schedule advances to the next slot.                                                                                                                                                                                                                                                                |
| TC-CLR-14 | UT    | P1  | Bids in the table for a *different* slot index or a different event are not included in this slot's ranking.                                                                                                                                                                                                                                                                    |
| TC-CLR-15 | IT    | P0  | `close_slot` fires automatically from the scheduled table at `currentSlotEndsAt` ±1s — no manual trigger, no hand-rolled timer.                                                                                                                                                                                                                                                 |
| TC-CLR-16 | IT    | P0  | After a non-final slot closes, `currentSlotIndex` advances by 1, `currentSlotEndsAt` is set to `now + 60s`, and the next `close_slot` is scheduled — one scheduled row, not two.                                                                                                                                                                                                |
| TC-CLR-17 | UT    | P0  | A winner whose wallet balance dropped below their bid between submit and close (possible via a win in an earlier slot in the same transaction chain) is handled deterministically: they are skipped and the ticket passes to the next-ranked bid, never producing a negative balance. Specify and assert whichever policy is chosen — **this case must not be left undefined**. |




## 8. Quota rollover (`TC-ROLL`)

Traces: HLD §3.3 (flagged assumption), LLD §2, §11.

> Gated on the open assumption. If the decision flips to "unsold quota is lost", replace this
> section with its inverse — TC-ROLL-01 becomes "next slot quota is unchanged".


| ID         | Level | P   | Case                                                                                                            |
| ---------- | ----- | --- | --------------------------------------------------------------------------------------------------------------- |
| TC-ROLL-01 | UT    | P0  | Slot 1 quota 6, only 2 qualifying bids → 4 unfilled roll forward; slot 2's effective quota becomes `5 + 4 = 9`. |
| TC-ROLL-02 | UT    | P0  | `slot_result.quotaRemainingAfterRollover` for slot 1 equals the amount actually added to slot 2's quota.        |
| TC-ROLL-03 | UT    | P1  | Rollover chains: an empty slot 1 and an empty slot 2 both roll into slot 3 (`quota3 + unfilled1 + unfilled2`).  |
| TC-ROLL-04 | UT    | P0  | Total tickets sold across all slots never exceeds `totalTickets`, regardless of rollover.                       |
| TC-ROLL-05 | UT    | P1  | Unfilled quota in the **final** slot does not roll anywhere and does not block settle.                          |
| TC-ROLL-06 | UT    | P1  | A fully filled slot rolls forward 0 and leaves the next slot's configured quota untouched.                      |




## 9. Wallet (`TC-WAL`)

Traces: HLD §3.4, LLD §11.


| ID        | Level | P   | Case                                                                                                                                                                         |
| --------- | ----- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-WAL-01 | UT    | P0  | Balance is never negative on any path — queue buy, turn win, multi-slot win, concurrent submissions. Assert as a global invariant swept after every test in the suite.       |
| TC-WAL-02 | UT    | P0  | Debit happens **only** on a win. A losing bid leaves the balance byte-identical.                                                                                             |
| TC-WAL-03 | UT    | P0  | Debit happens **exactly once** per allocation: `walletBalance == 500000 - sum(pricePaid of that participant's allocations)` at all times.                                    |
| TC-WAL-04 | UT    | P0  | **Atomicity** — there is no allocation without a matching debit and no debit without a matching allocation. Assert as a cross-table reconciliation after every clearing.     |
| TC-WAL-05 | UT    | P0  | There is no reservation / hold / pending-debit state anywhere in the schema (HLD §3.4). Assert by schema inventory.                                                          |
| TC-WAL-06 | UT    | P0  | A bid exceeding the *current* balance (already reduced by an earlier win) is rejected — the guard reads live balance, not the join-time credit.                              |
| TC-WAL-07 | IT    | P0  | Worst case from LLD §1a: one participant wins the queue ticket and all 5 slots → total 285000 debited, balance 215000, never negative.                                       |
| TC-WAL-08 | UT    | P1  | No reducer exists to top up, reset, or transfer balance (session-scoped, LLD §1b). Assert by reducer inventory.                                                              |
| TC-WAL-09 | IT    | P1  | A demo reset creates fresh participants with fresh wallets rather than mutating existing rows.                                                                               |
| TC-WAL-10 | IT    | P0  | Wallet updates reach the participant's client via subscription — the phone view's displayed balance matches the module row after every clearing (no client-side arithmetic). |




## 10. Invariants C1–C4 (`TC-INV`)

Traces: HLD §2, LLD §11. **This is the section the project is judged on.**


| ID        | Level | P   | Case                                                                                                                                                                                                                                                                                                                                        |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-INV-01 | UT    | P0  | **C1, core.** Same bid set inserted as `A B C D E` and as `E C A D B` → byte-identical `Allocation` rows: same winners, same `pricePaid` per winner, same `cutoffPrice`. Run over ≥100 random permutations of a ≥20-bid set. *The single most important test in the repo.*                                                                  |
| TC-INV-02 | UT    | P0  | **C1, ties.** N bidders at the identical price with quota < N → the winning subset is stable across shuffled insertion order, and re-deriving the tiebreak from the closed slot's committed data reproduces the same winners.                                                                                                               |
| TC-INV-03 | UT    | P0  | **C1, structural.** The turn allocator never reads `bid.seq`, insertion order, or `participant.identity` for ordering. Enforce mechanically: mutate every `seq` to a random value before `close_slot` and assert the outcome is unchanged.                                                                                                  |
| TC-INV-04 | IT    | P0  | **C1, system-level (Merge Gate 5).** Bots at near-zero reaction delay vs. humans at realistic delay, same slot → outcome tracks price rank only. A bot bidding 20k at t+50ms loses to a human bidding 60k at t+58s.                                                                                                                         |
| TC-INV-05 | UT    | P0  | **C1, within-window.** A bid submitted at second 2 of the window and the same bid submitted at second 59 produce identical outcomes for the same bid set.                                                                                                                                                                                   |
| TC-INV-06 | UT    | P0  | **C2.** One bid per identity per slot — see TC-BID-02; asserted here again as an invariant sweep: `count(bid) grouped by (eventId, slotIndex, participant) <= 1` after every test.                                                                                                                                                          |
| TC-INV-07 | IT    | P0  | **C3.** All subscribed clients observe the same `slot_result` for a given slot. Every client records `{slot_result_id, state_version, received_at}`; assert every client's next action derives from the same committed state.                                                                                                               |
| TC-INV-08 | IT    | P0  | **C4.** No client acts on a `slot_result` before it is the module's committed state; the spread in `received_at` across clients is bounded and, critically, **is not correlated with which client wins the next slot** (correlation coefficient near zero over ≥30 runs) — a fan-out advantage would show up here, not in the mean latency. |
| TC-INV-09 | IT    | P1  | **C4, negative control.** Artificially delaying one client's subscription by 5s must not change that client's outcome in the next slot (it can only change what they *see*).                                                                                                                                                                |
| TC-INV-10 | IT    | P0  | **Master acceptance.** Flip `mode: "queue" → "turn"` with participants, strategies, inventory, UI, and network held constant → the winner set changes, and the human share of allocations rises. This is the project's definition of done (LLD §11).                                                                                        |




## 11. Client SDK (`FairDropClient`) (`TC-SDK`)

Traces: LLD §6.


| ID        | Level | P   | Case                                                                                                                                                                                                                         |
| --------- | ----- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-SDK-01 | UT    | P0  | Every method in the LLD §6 signature exists with the stated shape: `join`, `listEvents`, `createEvent`, `startCountdown`, `submitBid`, `subscribeEvent`, `subscribeAllocations`, `subscribeSlotResults`, `getWalletBalance`. |
| TC-SDK-02 | UT    | P0  | Nothing outside `clients/sdk` imports the generated SpacetimeDB bindings directly. Enforce as a lint rule / import-graph test over `clients/web`, `clients/bots`, `services/bot-spawner`.                                    |
| TC-SDK-03 | UT    | P0  | Table and reducer types are generated (`spacetimedb generate --lang typescript`), not hand-written; regenerating against the current module produces no diff. Run in CI — this is the drift alarm.                           |
| TC-SDK-04 | UT    | P1  | `subscribeEvent` invokes its callback on insert, update, and delete, and the returned `Unsubscribe` stops further callbacks.                                                                                                 |
| TC-SDK-05 | UT    | P1  | A reducer rejection surfaces as a typed error with the module's reason string — not a silent no-op. Every guard in LLD §2/§3 maps to a distinguishable error.                                                                |
| TC-SDK-06 | IT    | P1  | Connection drop → automatic reconnect and re-subscribe; state converges to the module's without a page reload.                                                                                                               |
| TC-SDK-07 | UT    | P1  | The mock fixture path (LLD §6) drives the same client surface, so UI can be developed and tested without a live module.                                                                                                      |
| TC-SDK-08 | UT    | P1  | The React `useTable` hook subscribes on mount, re-renders on row events, and unsubscribes on unmount (no leak across route changes).                                                                                         |




## 12. Bot-spawner service (`TC-SPAWN`)

Traces: HLD §6, §11, LLD §5, §9.


| ID          | Level | P   | Case                                                                                                                                                                                                                            |
| ----------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-SPAWN-01 | IT    | P0  | `POST /onboard { displayName }` returns `{ identity, walletBalance }` for the human and creates exactly one `origin: "human"` participant.                                                                                      |
| TC-SPAWN-02 | IT    | P0  | Each human onboarding results in exactly 4 additional `origin: "bot"` participants — no more, no fewer. N humans → exactly 4N bots.                                                                                             |
| TC-SPAWN-03 | IT    | P0  | The `/onboard` response is returned **before** bot spawning completes — spawn is fire-and-forget and never on the human's critical path. Assert the response latency is unaffected when bot spawn is artificially slowed by 5s. |
| TC-SPAWN-04 | IT    | P0  | If bot spawning throws, the human's onboarding still succeeds and returns 200; the failure is logged and retried independently.                                                                                                 |
| TC-SPAWN-05 | IT    | P1  | Bots join with distinct `Bot-<random>` display names; no collisions across 100 spawns.                                                                                                                                          |
| TC-SPAWN-06 | IT    | P1  | Bots call the same `join` / `submit_bid` reducers as the React client — verified by asserting the module has no bot-specific reducer and by inspecting the call surface.                                                        |
| TC-SPAWN-07 | UT    | P1  | The 4:1 ratio is a named config constant, not a literal scattered through the code; changing it to 2 spawns 2 bots per human.                                                                                                   |
| TC-SPAWN-08 | IT    | P1  | Bot workers attach to whichever event is currently `open` and do not act on `created`/`countdown`/`settled` events.                                                                                                             |
| TC-SPAWN-09 | IT    | P1  | 30 concurrent `/onboard` calls → 30 humans + 120 bots, no duplicated identities, no dropped spawns.                                                                                                                             |
| TC-SPAWN-10 | IT    | P2  | Bot workers terminate (or idle without bidding) once the event settles; no orphaned processes accumulate across repeated demo runs.                                                                                             |




## 13. Bot behaviour (`TC-BOT`)

Traces: HLD §6, LLD §5.


| ID        | Level | P   | Case                                                                                                                                                                                                                                     |
| --------- | ----- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-BOT-01 | UT    | P0  | Queue mode: a bot calls buy at `t_open + random(0, δ)` — never before `t_open`, and the delay is bounded by δ.                                                                                                                           |
| TC-BOT-02 | UT    | P0  | Turn mode: when `ceiling >= slot.floor`, the bot bids `randomUniform(floor, ceiling)` rounded to the nearest 100, and the bid is always within `[floor, ceiling]`.                                                                       |
| TC-BOT-03 | UT    | P0  | Turn mode: when `ceiling < slot.floor`, the bot **abstains** — no `submit_bid` call at all for that slot and every later slot (floors are non-decreasing).                                                                               |
| TC-BOT-04 | UT    | P0  | The per-slot draw is re-rolled each slot: across 5 slots, a bot's bid position within `[floor, ceiling]` varies rather than holding a fixed ratio.                                                                                       |
| TC-BOT-05 | UT    | P0  | A bot never bids above its `walletBalance`; after winning an expensive slot it self-limits (and the module guard is the backstop — TC-WAL-06).                                                                                           |
| TC-BOT-06 | UT    | P0  | A bot submits at most one bid per slot (client-side), and the module rejects a duplicate if it ever tried (TC-BID-02).                                                                                                                   |
| TC-BOT-07 | IT    | P1  | Bot effort is identical across modes — the same reaction speed and same call cadence in queue and turn mode. The demo's claim is that turn mode neutralizes speed *without* the bot behaving differently; a weakened bot invalidates it. |
| TC-BOT-08 | IT    | P1  | Across a full turn-mode event, the count of bidding bots strictly decreases as floors rise (the dropout curve) — a legibility requirement from HLD §11.                                                                                  |
| TC-BOT-09 | UT    | P1  | Bot bid amounts are spread, not floor-hugging: over one slot with 100 bots, the exact-tie rate stays low (<10%) — the tiebreak exists anyway (TC-CLR-10) but should not be the primary path.                                             |




## 14. Admin dashboard read-model (`TC-DASH`)

Traces: HLD §4.2, LLD §8.


| ID         | Level | P   | Case                                                                                                                                                                     |
| ---------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-DASH-01 | IT    | P0  | Shows `totalTickets`, `ticketsRemaining`, `allocated` — and `allocated + ticketsRemaining == totalTickets` at every observed moment.                                     |
| TC-DASH-02 | IT    | P0  | The **human vs bot split** is computed from `Allocation` joined to `Participant.origin` — not inferred from display name — and the two numbers sum to total allocations. |
| TC-DASH-03 | E2E   | P0  | The split updates live as slots clear, with no manual refresh.                                                                                                           |
| TC-DASH-04 | E2E   | P0  | Turn mode: per-slot rows show index, floor, quota (post-rollover effective value), filled, and cutoff price, matching the module's `slot` / `slot_result` rows exactly.  |
| TC-DASH-05 | E2E   | P1  | Queue mode: no slot table is rendered; the fixed ticket price is shown instead.                                                                                          |
| TC-DASH-06 | IT    | P0  | The dashboard opens no write path — it issues subscriptions and reducer-free reads only. Assert by call inventory.                                                       |
| TC-DASH-07 | E2E   | P1  | The dashboard renders correctly at projector resolution with the human/bot split as the visually dominant element (HLD §4.2 — "the headline number for the room").       |
| TC-DASH-08 | E2E   | P1  | With zero allocations the dashboard renders 0/0 rather than erroring or showing `NaN`.                                                                                   |
| TC-DASH-09 | E2E   | P1  | Round 1 and Round 2 results are both retrievable after settle, so the two can be shown side by side on stage.                                                            |




## 15. Web UI — onboarding, event list, phone view (`TC-UI`)

Traces: HLD §3.1–§3.3, LLD §9. All Playwright unless noted.


| ID       | Level | P   | Case                                                                                                                                                                                   |
| -------- | ----- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-UI-01 | E2E   | P0  | QR landing → enter display name → submit → participant created, wallet shows ₹5,00,000, and the events list renders.                                                                   |
| TC-UI-02 | E2E   | P0  | Empty display name cannot be submitted; an inline error is shown.                                                                                                                      |
| TC-UI-03 | E2E   | P0  | The events list shows each event's name, mode, and state, and updates live when the admin creates a new one.                                                                           |
| TC-UI-04 | E2E   | P0  | Queue-mode event page shows the fixed price and a **disabled** Buy button during the 60s countdown; the countdown ticks visibly.                                                       |
| TC-UI-05 | E2E   | P0  | Buy becomes enabled exactly at countdown zero — clicking before zero is impossible and, if forced programmatically, is rejected by the module (TC-LC-05).                              |
| TC-UI-06 | E2E   | P0  | Successful buy → ticket confirmation shown and wallet decreases by the ticket price.                                                                                                   |
| TC-UI-07 | E2E   | P0  | Sold-out buy → clear "not allocated" state, wallet unchanged. The rejection must be legible, not a silent failure.                                                                     |
| TC-UI-08 | E2E   | P0  | Turn-mode event page shows the current slot index, floor, quota, and slot countdown; the bid input rejects values below the floor client-side and the module rejects them server-side. |
| TC-UI-09 | E2E   | P0  | After submitting a bid, the input is locked for that slot and the UI shows "bid submitted" — a second submission is not offered (C2 at the UI layer).                                  |
| TC-UI-10 | E2E   | P0  | Bids are **sealed**: no other participant's bid amount is visible anywhere in the UI or in the subscribed data before the slot closes. Assert on both DOM and network payloads.        |
| TC-UI-11 | E2E   | P0  | At slot close, the phone view shows won/lost, and for a win the price paid equals the participant's own bid (pay-as-bid made visible).                                                 |
| TC-UI-12 | E2E   | P0  | The next slot's higher floor appears automatically without a refresh.                                                                                                                  |
| TC-UI-13 | E2E   | P1  | A bid above the wallet balance is blocked client-side with an explanatory message.                                                                                                     |
| TC-UI-14 | E2E   | P1  | The countdown UI does not imply urgency-to-click in turn mode — bidding at second 2 and at second 59 both succeed and are presented identically (TC-INV-05 at the UX layer).           |
| TC-UI-15 | E2E   | P1  | Phone view renders correctly on a 390×844 viewport; nothing critical requires horizontal scrolling.                                                                                    |
| TC-UI-16 | E2E   | P1  | A settled event's page shows the final outcome and does not offer a bid or buy control.                                                                                                |
| TC-UI-17 | E2E   | P2  | Reloading mid-slot restores the participant's session, wallet, and "already bid" state from subscriptions.                                                                             |




## 16. Experiment runner (`TC-EXP`)

Traces: LLD §10.


| ID        | Level | P   | Case                                                                                                                                                                                  |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-EXP-01 | IT    | P0  | `npm run experiment` runs both rounds over one configured population and prints human/bot allocation counts per round.                                                                |
| TC-EXP-02 | IT    | P0  | Round 1 (queue) shows bots taking a disproportionate share; Round 2 (turn) shows the human share materially higher. Assert directionally with a threshold, not against exact numbers. |
| TC-EXP-03 | IT    | P0  | The bot share in turn mode is **non-zero** — a total flip would mean the mechanism went past "removes the speed advantage" into "excludes bots", which is not the claim (HLD §1a).    |
| TC-EXP-04 | IT    | P1  | Sweeping bot reaction delay δ changes the queue-mode outcome substantially and the turn-mode outcome negligibly. This is the evidentiary core of the whole thesis.                    |
| TC-EXP-05 | IT    | P1  | The runner is deterministic under a fixed RNG seed — same seed, same outcome — so pre-show results are reproducible.                                                                  |
| TC-EXP-06 | IT    | P1  | The runner respects the 4:1 ratio and the LLD §1a scaling rule for whatever headcount is configured.                                                                                  |




## 17. End-to-end scenarios (`TC-E2E`)

Full-stack: local SpacetimeDB + module + bot-spawner + Playwright-driven browsers. These are
the "run the whole demo" checkpoints and double as the manual dry-run script.


| ID        | Level | P   | Scenario                                                                                                                                                                                                                                                                       |
| --------- | ----- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-E2E-01 | E2E   | P0  | **Queue round, happy path.** Admin creates a queue event (20 tickets, ₹15,000) → 3 human browsers onboard (12 bots spawn) → countdown → open → all buy → tickets allocate in arrival order → wallets debited → dashboard shows a bot-skewed split → settle.                    |
| TC-E2E-02 | E2E   | P0  | **Turn round, happy path.** Same population, turn event with the 5-slot schedule → each slot: countdown, sealed bids from humans and bots, close, results published simultaneously → 5 slot results → settle → dashboard shows a human-favourable split relative to TC-E2E-01. |
| TC-E2E-03 | E2E   | P0  | **Master acceptance on stage.** Run TC-E2E-01 then TC-E2E-02 back-to-back with the same participants and inventory, flipping only `mode` → the winner sets differ and the human share increases. Capture both dashboards for side-by-side display.                             |
| TC-E2E-04 | E2E   | P0  | **Slow human wins.** A human bids high at second 58 of a slot; a bot bids low at second 0.05. The human wins. This is the demo's money shot — it must be reproducible on command.                                                                                              |
| TC-E2E-05 | E2E   | P0  | **Wallet reconciliation across a full event.** After settle, for every participant: `walletBalance == 500000 - sum(their pricePaid)`, and every allocation has a matching debit. Zero drift.                                                                                   |
| TC-E2E-06 | E2E   | P0  | **Rollover visible end to end.** Slot 1 deliberately under-subscribed (raise the floor above most ceilings) → the unfilled quota appears added to slot 2 on the dashboard and more tickets clear in slot 2 than its configured quota.                                          |
| TC-E2E-07 | E2E   | P0  | **Simultaneity.** Three browsers subscribed to the same event receive the same `slot_result` with bounded skew, and none can act on it before the others (C3/C4 observed through the real UI).                                                                                 |
| TC-E2E-08 | E2E   | P1  | **Inventory exhaustion mid-schedule.** Tickets run out at slot 3 of 5 → event settles immediately, slots 4 and 5 never open, the UI states why.                                                                                                                                |
| TC-E2E-09 | E2E   | P1  | **Empty slot.** No participant clears slot 5's floor → the slot closes with zero allocations, the dashboard shows 0 filled, and settle still occurs cleanly.                                                                                                                   |
| TC-E2E-10 | E2E   | P1  | **Reset and re-run.** After settle, create a fresh event and re-onboard → fresh participants, fresh wallets, no residue from the previous run in the dashboard.                                                                                                                |
| TC-E2E-11 | E2E   | P1  | **Bot-spawner down.** With the spawner unavailable, human onboarding surfaces a clear error and the module state stays consistent; bringing it back allows onboarding to proceed.                                                                                              |
| TC-E2E-12 | E2E   | P1  | **Client disconnect mid-slot.** A phone loses connection during a slot, reconnects after close → it shows the correct won/lost result and correct wallet, reconstructed from subscriptions.                                                                                    |
| TC-E2E-13 | MAN   | P0  | **Full manual dry run on the demo rig**, on venue LAN/hotspot, with the real number of stage participants — run TC-E2E-03 start to finish and time it.                                                                                                                         |




## 18. Non-functional / demo-rig (`TC-NFR`)

Traces: HLD §11, LLD §1a.


| ID        | Level | P   | Case                                                                                                                                                            |
| --------- | ----- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-NFR-01 | IT    | P0  | 150 participants (30 humans + 120 bots) all bidding in one slot → `close_slot` completes within the slot boundary and no bid is dropped.                        |
| TC-NFR-02 | IT    | P0  | Nothing in the critical path makes an outbound network call — the whole demo runs with external connectivity disabled. Assert by running the E2E suite offline. |
| TC-NFR-03 | E2E   | P1  | Slot countdown UI drift stays under 1s against the module's `currentSlotEndsAt` over a 5-slot event.                                                            |
| TC-NFR-04 | IT    | P1  | Module logs are sufficient to reconstruct any clearing after the fact: bid set, ranking, tie seed, winners, prices paid.                                        |
| TC-NFR-05 | MAN   | P1  | Cold start — publish module, start spawner, serve client — is documented and takes under 5 minutes from a clean checkout.                                       |
| TC-NFR-06 | IT    | P2  | Repeated demo runs in one session do not degrade clearing latency (no unbounded row growth in the hot path).                                                    |


---



## Coverage map — invariants to cases


| Invariant                             | Primary              | Supporting                                                |
| ------------------------------------- | -------------------- | --------------------------------------------------------- |
| C1 — arrival order has zero weight    | TC-INV-01, TC-INV-03 | TC-INV-02, TC-INV-04, TC-INV-05, TC-CLR-10..12, TC-E2E-04 |
| C2 — one bid per identity per slot    | TC-BID-02            | TC-INV-06, TC-UI-09, TC-BOT-06                            |
| C3 — one authoritative clearing state | TC-INV-07            | TC-LC-08, TC-CLR-05, TC-WAL-04, TC-E2E-07                 |
| C4 — fan-out creates no second race   | TC-INV-08            | TC-INV-09, TC-UI-10, TC-E2E-07                            |
| Wallet atomicity                      | TC-WAL-04            | TC-WAL-01..03, TC-CLR-03, TC-E2E-05                       |
| Master acceptance                     | TC-INV-10            | TC-E2E-03, TC-EXP-02                                      |




## Mapping to merge gates (LLD §13)


| Gate                                      | Cases that must pass                                    |
| ----------------------------------------- | ------------------------------------------------------- |
| Gate 1 — hello-world                      | TC-EVT-01/02, TC-JOIN-01, TC-SDK-01                     |
| Gate 2 — one participant, queue           | TC-Q-01, TC-WAL-03, TC-LC-01..03                        |
| Gate 3 — queue at scale                   | TC-Q-05, TC-Q-06, TC-SPAWN-02, TC-EXP-02 (round 1 only) |
| Gate 4 — turn mode                        | TC-BID-01..08, TC-CLR-01..07, TC-ROLL-01                |
| Gate 5 — C1 invariance                    | TC-INV-01..05                                           |
| Gate 6 — subscriptions + wallet atomicity | TC-INV-07, TC-INV-08, TC-WAL-04, TC-E2E-05              |
| Gate 7 — spawner + onboarding             | TC-SPAWN-01..04, TC-UI-01                               |
| Gate 8 — UI                               | TC-UI-*, TC-DASH-*, TC-E2E-01..03                       |




## Suggested file placement

```
module/tests/
  queue.test.ts        TC-Q-*, TC-LC-12
  turn.test.ts         TC-BID-*, TC-CLR-*, TC-ROLL-*
  wallet.test.ts       TC-WAL-*
  invariance.test.ts   TC-INV-01..06
  lifecycle.test.ts    TC-LC-*, TC-EVT-*, TC-JOIN-*
  schema.test.ts       TC-SCH-*
integration/
  subscriptions.spec.ts  TC-INV-07..09
  spawner.spec.ts        TC-SPAWN-*
  bots.spec.ts           TC-BOT-*
  experiment.spec.ts     TC-EXP-*
  scale.spec.ts          TC-NFR-01/02/06
clients/web/e2e/
  onboarding.spec.ts     TC-UI-01..03
  queue-round.spec.ts    TC-UI-04..07, TC-E2E-01
  turn-round.spec.ts     TC-UI-08..17, TC-E2E-02, 04, 06, 08, 09
  dashboard.spec.ts      TC-DASH-*
  acceptance.spec.ts     TC-E2E-03, 05, 07, 10..12
```

Annotate each test with its `TC-` ID in a comment or the test title so coverage against this
document can be checked mechanically rather than by memory.