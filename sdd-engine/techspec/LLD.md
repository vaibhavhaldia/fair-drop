# Fair Drop — Low-Level Design

Status: Draft v2 — revised for wallet, multi-event, per-slot pricing, and bot spawning
Companion to `HLD.md`. Source material: `sdd-engine/context/fair-drop-brief.pdf`,
`sdd-engine/context/chat.md`, and the demo-flow walkthrough (2026-09-05).

Open assumption carried from HLD §3.3 / §11 — **confirm before building `close_slot`**: unsold
quota in a slot rolls forward and is added to the next slot's quota. If wrong, `close_slot`'s
quota math (§3) changes but nothing else does.

## 1. Schema

Target stack: **TypeScript module on SpacetimeDB**, TypeScript bot processes, **React** client
(event list, phone view, admin dashboard).

```ts
Event {                        // was "Sale" in v1 — renamed to match the product surface
  id: EventId                  // PK
  name: string
  mode: "queue" | "turn"
  state: "created" | "countdown" | "open" | "settled"
  totalTickets: u32
  ticketsRemaining: u32
  startTime: Timestamp
  endTime: Timestamp | null

  // queue mode only
  ticketPrice: number | null

  // turn mode only — fixed schedule set at creation, per HLD §3.3 clarification
  slots: Slot[] | null
  currentSlotIndex: u32
  currentSlotEndsAt: Timestamp | null
}

Slot {                         // embedded/child rows, indexed by (eventId, slotIndex)
  eventId: EventId
  slotIndex: u32
  floor: number
  quota: u32                   // effective quota AFTER any rollover from the prior slot (§3)
  filled: u32
  cutoffPrice: number | null   // lowest winning bid this slot, informational only — NOT what
                                // losers or the marginal winner necessarily paid (pay-as-bid, §3)
}
// UNIQUE (eventId, slotIndex)

Participant {
  identity: Identity           // PK — module-issued
  displayName: string
  origin: "human" | "bot"      // drives the dashboard's human-vs-bot split — first-class, not inferred
  walletBalance: number        // session-scoped; credited 500000 at join for BOTH origins —
                                // bots get the same balance and the same guards as humans,
                                // so a bot's win is a genuine wallet-backed win, not a freebie
  // simulated paying capacity — populated for every participant, but only read for bots;
  // a human's real bid comes from UI input, gated by walletBalance/slot floor, not by this
  ceiling: number              // randomUniform(20_000, 150_000) at join — see LLD §1a. A bot's
                                // per-slot bid is a fresh random draw up to this ceiling each
                                // slot (§5) — this field is a hard cap, not a fixed target.
}

Bid {
  id: BidId                    // PK
  eventId: EventId             // FK, indexed
  slotIndex: u32               // indexed — turn mode only; 0 for queue mode
  participant: Identity        // FK, indexed
  price: number                // queue mode: must equal ticketPrice; turn mode: participant's own bid
  qty: u32                     // fixed at 1 for this build — see §1b
  seq: u64                     // server-assigned arrival sequence, retained for audit only —
                                // MUST NOT be read by the turn allocator (that's the point, C1)
  state: "pending" | "won" | "lost" | "rejected"
}
// UNIQUE (eventId, slotIndex, participant)  -- this is C2, enforced at the schema level

Allocation {
  eventId: EventId             // indexed
  slotIndex: u32
  participant: Identity
  pricePaid: number            // = the participant's own winning bid (pay-as-bid) or ticketPrice (queue)
}

SlotResult {                   // was "TurnResult" in v1
  eventId: EventId             // indexed
  slotIndex: u32
  cutoffPrice: number          // lowest winning bid this slot (display only)
  allocated: u32
  quotaRemainingAfterRollover: u32  // feeds into next slot's effective quota
}
```

Index every column used in a filter or join (`eventId`, `slotIndex`, `participant`).
`slotIndex` is a data column, not a schema variant — re-running the demo produces new rows,
never a migration.

### 1a. Recommended default demo parameters

Locked in as defaults rather than illustrative placeholders — change via `create_event` config,
not by editing the module. These are tuned for *drama*, not just legibility: Round 1 should
look unambiguously unfair, and Round 2's flip should be visible but not total — some bots
should still win the last, most expensive slot, and some humans should still miss out
entirely. That partial flip is the honest version of the thesis (§10 of `HLD.md`: this doesn't
fix scarcity, it fixes *who* scarcity selects against).

**Scaling rule** (preserve these ratios if the actual headcount differs from the example below):
- Bots = 4 × humans (fixed per HLD §6).
- `totalTickets` ≈ 13–15% of (humans + bots) — scarce enough that Round 1 starves most
  participants, loose enough that a short demo still produces a legible sample.
- Turn-mode quota per slot **decreases** across slots rather than splitting evenly — it makes
  the final, most expensive slot visibly the hardest to win, which is the moment worth building
  tension toward.
- Floor ramp widens in the back half rather than staying purely linear — the early jump filters
  out casual bidders, the late jump is the scarcity crunch.

**Concrete example, sized for ~30 humans on stage:**

| Parameter | Value | Rationale |
|---|---|---|
| Humans / Bots / Total participants | 30 / 120 / 150 | 4:1 bot ratio (HLD §6) |
| `walletBalance` (both `origin: human` and `origin: bot`) | ₹5,00,000 | Covers the worst case of one participant winning the queue ticket *and* every turn-mode slot in the same session: 15,000 + (15,000+30,000+50,000+75,000+1,00,000) = ₹2,85,000 — leaves ~1.75x headroom above any single bot's ceiling draw (capped at ₹1,50,000). Bots get the identical amount so a bot's win is wallet-backed, not free. |
| `ticketPrice` (queue mode) | ₹15,000 | Equal to Slot 1's floor, so Round 1 and Round 2 start from the same face value — the only variable that changes between rounds is the clearing rule. |
| `totalTickets` | 20 (≈13% of 150 participants) | Scarce enough that Round 1 clearly starves most of the room — the "who wins" contrast only reads as dramatic if most people don't win. |
| `slots` (turn mode, 5 slots) | floors ₹15,000 / 30,000 / 50,000 / 75,000 / 1,00,000; quota 6 / 5 / 4 / 3 / 2 | Back-loaded floor ramp + shrinking quota: cheap early slots absorb casual bids, the last slot (2 tickets at ₹1,00,000) is the visible crunch point where the mechanism is under the most pressure to prove itself. |
| Bot `ceiling` range | Uniform(₹20,000, ₹1,50,000) at join, fixed for the session | Simulates heterogeneous real paying capacity (LLD §2 `join`). Deliberately extends past the top floor (₹1,00,000) — if the ceiling range topped out exactly at the top floor, ~no one would clear it by chance, and Slot 5 would go empty. At this range, ~38% of the population can still contest the last slot. |
| Bot per-slot bid | `randomUniform(slot.floor, ceiling)`, redrawn every slot | Not a fixed personality trait (no separate "aggression" field) — the ceiling is the only thing fixed per bot; where within `[floor, ceiling]` it bids is re-rolled each slot. Spreads bids out (fewer accidental exact ties, on top of the seeded tiebreak in LLD §2) without weakening any individual bot's effort (HLD §6). |

Expected shape (validate with the experiment runner, LLD §10, before it's ever on stage):
Round 1 skews heavily bot (millisecond reaction time against 20 tickets). Round 2 flips toward
humans in the cheap early slots and stays genuinely contested in the last slot — some bots still
win there, which is correct: the fix removes the *speed* advantage, not bot participation
itself.

### 1b. Deliberately fixed for this build (call these out if requirements shift)

- `qty` is always 1 — one ticket per bid. The original brief's `qty` field is kept for schema
  compatibility but the reducer path does not support multi-ticket bids in this revision.
- Turn-mode comparator is fixed to **price-descending, pay-as-bid** — see HLD §10. This is a
  narrower default than v1's "comparator is a parameter" framing; the random-among-qualifying
  branch is not wired up unless requirements ask for it back.
- Wallet is session-scoped: there is no field or reducer for topping up or persisting balance
  across a reset. A "reset demo" operation should recreate participants (and thus wallets) from
  scratch, not attempt to zero out and re-credit existing rows.

### 1c. SpacetimeDB TS module shape

SpacetimeDB TS modules declare tables and reducers via decorators from the server SDK
(`spacetimedb/server` or `@clockworklabs/spacetimedb-sdk`, depending on the pinned version —
**verify the exact import path and decorator names against whatever version lands in
`module/package.json`**, the API has moved between releases).

```ts
import { table, primaryKey, reducer, ReducerContext, Identity, Timestamp } from "spacetimedb/server";

@table({ public: true })
export class Event {
  @primaryKey id!: bigint;
  name!: string;
  mode!: string;              // "queue" | "turn"
  state!: string;             // "created" | "countdown" | "open" | "settled"
  totalTickets!: number;
  ticketsRemaining!: number;
  ticketPrice?: number;
  currentSlotIndex!: number;
  currentSlotEndsAt?: Timestamp;
}

// Turn/slot boundaries AND the queue-mode countdown both use SpacetimeDB's *scheduled table*
// pattern: a table with a `scheduled_at` column plus a same-named reducer the runtime invokes
// automatically. This — not a hand-rolled setTimeout/cron — is what gives close_slot (and
// open_event, once the countdown elapses) their "only the module may invoke this" guarantee
// for free.
@table({ scheduled: "close_slot" })
export class SlotSchedule {
  @primaryKey scheduledId!: bigint;
  scheduledAt!: Timestamp;
  eventId!: bigint;
}

@table({ scheduled: "open_event" })
export class CountdownSchedule {
  @primaryKey scheduledId!: bigint;
  scheduledAt!: Timestamp;
  eventId!: bigint;
}

reducer("join", (ctx: ReducerContext, displayName: string, origin: "human" | "bot") => {
  // creates Participant with walletBalance = 500_000
});
```

Client-visible effect is identical to the pseudocode in §2 regardless of exact decorator
spelling: reducers are the only write path, and every write (including the wallet debit) is
transactional and serialized by the engine — this is what makes C3, and "ticket XOR refund,
never partial," structural rather than something we implement with a saga.

## 2. Reducers

### `create_event(name, mode, totalTickets, startTime, config)`

```
guard: ctx.sender is the admin identity
effect:
  event.state := "created"
  event.ticketsRemaining := totalTickets
  if mode == "queue": event.ticketPrice := config.ticketPrice
  if mode == "turn":
    event.slots := config.slots.map(s => ({ floor: s.floor, quota: s.quota, filled: 0 }))
    event.currentSlotIndex := 0
```

### `open_event(event_id)`

Scheduled (see §1c `CountdownSchedule`) to fire `countdownSeconds` after an admin calls a
`start_countdown(event_id)` reducer. Guarded the same way `close_slot` is (§2, below).

```
guard: ctx.sender == module identity
guard: event.state == "countdown"
effect:
  event.state := "open"
  if mode == "turn":
    event.currentSlotEndsAt := now() + W   // W = 60s
    schedule close_slot(event.id) at event.currentSlotEndsAt
```

### `join(displayName, origin)`

```
effect:
  insert Participant { identity: ctx.sender, displayName, origin,
                        walletBalance: 500_000,
                        ceiling: randomUniform(20_000, 150_000) }   // simulated paying capacity
```

`ceiling` is always populated (not left `null`), but it only *drives* behaviour for
`origin: "bot"` — see the bid formula in §5, which draws a fresh random bid up to this ceiling
every slot. For `origin: "human"`, it's unused: a human's bid is real user input in the UI on
each slot, gated only by the actual guards in `submit_bid` (wallet balance, slot floor) — never
by a randomly assigned ceiling. Simulating "paying capacity" is only meaningful for the
participants who don't have a real preference to express.

Called directly by a human's React client for the human row, and by each spawned bot process
for its own row (see §5) — same reducer, no special-cased "bot join" path in the module.

### `submit_bid(event_id, price)`

Single entrypoint. This branch is the entire difference between the two rounds — nothing else
about the two modes is allowed to diverge, or the comparison is no longer valid.

```
guard: event.state == "open"
guard: ctx.sender is a registered participant
guard: participant.walletBalance >= price      // never allow a bid the wallet can't cover

if event.mode == "queue":
    guard: price == event.ticketPrice
    guard: event.ticketsRemaining > 0           // else reject, wallet untouched
    // allocation + debit happen together, atomically, in this same reducer call
    insert Allocation { eventId, slotIndex: 0, participant: ctx.sender, pricePaid: price }
    participant.walletBalance -= price
    event.ticketsRemaining -= 1

if event.mode == "turn":
    guard: request.slotIndex == event.currentSlotIndex   // reject bids for a stale/future slot
    guard: price >= event.slots[event.currentSlotIndex].floor
    guard: no existing Bid(eventId, event.currentSlotIndex, ctx.sender)   // C2 — reject if present
    insert Bid { ..., seq: next_seq(), state: "pending" }
    // no allocation or debit happens here — return only "accepted"
```

**Acceptance:**
- `ticketsRemaining` cannot go negative
- `queue` mode: allocation order == arrival order (this is the expected, undesirable baseline)
- `turn` mode: identity + slot → max 1 bid persisted; a second attempt is rejected, not queued
- no bid is ever accepted above a participant's current wallet balance, in either mode

### `close_slot(event_id)`

Engineer A's most important reducer — this is where C1 is either satisfied or violated, and
where the wallet debit must be atomic with the allocation write.

```
guard: ctx.sender == module identity              // only the scheduler may invoke this
guard: event.state == "open" and event.mode == "turn"
guard: this slotIndex has not already been closed  // reject double-close

slot := event.slots[event.currentSlotIndex]
bids := all Bid where eventId == event.id and slotIndex == event.currentSlotIndex

// Tie-break seed is computed from data that only exists once the slot is closed — the sorted
// set of bid IDs in this slot — so it cannot be predicted or positioned for in advance (C4),
// and it deliberately does NOT use `seq`, arrival order, or participant identity/join order:
// identities are typically assigned sequentially at join, so "lowest identity wins" would be
// join-order-in-disguise, which is exactly the C1 violation this mechanism exists to remove.
tieSeed := hash(event.id, event.currentSlotIndex, sorted(bids.map(b => b.id)))
ranked := bids.sort(by price DESC, then by hash(tieSeed, bid.id) ASC as tiebreak)

filled := 0
for bid in ranked:
    if filled >= slot.quota: bid.state = "lost"; continue
    // pay-as-bid: winner pays their OWN bid price, not a single clearing price
    insert Allocation { eventId, slotIndex: event.currentSlotIndex,
                         participant: bid.participant, pricePaid: bid.price }
    participant(bid.participant).walletBalance -= bid.price   // same transaction as the write above
    bid.state = "won"
    filled += 1
    event.ticketsRemaining -= 1

unfilled := slot.quota - filled
cutoff := filled > 0 ? min(price among winners) : null

write SlotResult { slotIndex: event.currentSlotIndex, cutoffPrice: cutoff,
                    allocated: filled, quotaRemainingAfterRollover: unfilled }  // single serialized write

nextIndex := event.currentSlotIndex + 1
if nextIndex >= event.slots.length or event.ticketsRemaining == 0:
    call settle(event.id)
else:
    event.slots[nextIndex].quota += unfilled        // rollover — SEE OPEN ASSUMPTION at top of file
    event.currentSlotIndex := nextIndex
    event.currentSlotEndsAt := now() + W
    schedule close_slot(event.id) at event.currentSlotEndsAt
```

**Correctness property (C1), stated as a test:** for the same bid set, running the reducer with
insertion order `A B C D E` and with insertion order `E C A D B` must produce identical
`Allocation` rows (same winners, same `pricePaid` per winner). This is the single most
important automated test in the repository (see §11, Invariance).

### `settle(event_id)`

```
guard: event.state == "open"
effect: event.state := "settled"
        write final scoreboard summary (aggregate Allocation by participant.origin)
```

## 3. Turn state machine

```
CREATED → COUNTDOWN → OPEN → (queue: single race) or (turn: slot 0 → slot 1 → ... → slot N-1) → SETTLED
```

Reject explicitly, don't silently ignore:

| Invalid transition | Guard that catches it |
|---|---|
| bid before `open` (including during `countdown`) | `event.state == "open"` check in `submit_bid` |
| bid after `settle` | same guard — `state` is no longer `"open"` |
| `close_slot` called twice on same slot | check slot not already closed |
| `settle` called twice | `event.state == "open"` guard |
| bid for a stale or future slot | `slotIndex` match check in `submit_bid` |
| bid below current slot's floor | floor guard in `submit_bid` |
| bid exceeding wallet balance | balance guard in `submit_bid` |

Design principle: a correct reducer set should make invalid states difficult to represent, not
just rejected at runtime.

## 4. Allocation algorithms

- **Queue (`allocation/queue.ts`).** `request received → price matches ticketPrice? →
  inventory available? → wallet covers price? → allocate + debit immediately →
  decrement inventory`. O(1) per request.
- **Turn (`allocation/turn.ts`).** `load current-slot bids → ignore seq/arrival order → sort
  price DESC → walk ranking, allocate 1 ticket + debit per bid until quota spent →
  roll unfilled quota into next slot`. O(n log n) over a small n (bids in one slot).

Comparator is fixed to price-descending pay-as-bid for this build (HLD §10). The
random-among-qualifying comparator from v1 is documented but not implemented unless the
"which is fairer" panel discussion comes back into scope.

## 5. Bot-spawner service (new — not part of the module)

Reducers are transactional and cannot run a timer, sleep, or make an outbound decision loop —
so bot behaviour cannot live inside `join` or any other reducer. Per the demo requirement, the
**onboarding action itself** triggers the spawn, as a side effect outside the module:

```
clients/web  --POST /onboard { displayName }-->  services/bot-spawner (Node/Express)
                                                          │
                                     1. calls FairDropClient.join(displayName, "human")
                                        against the module, on behalf of the human
                                     2. fire-and-forget: spawns 4 bot workers
                                        (async tasks or child processes), each of which:
                                          a. calls FairDropClient.join(`Bot-${randomId}`, "bot")
                                          b. starts its own bid loop against whichever event
                                             is currently OPEN (queue: hit buy at
                                             t_open + random(0, δ); turn: bid
                                             per the formula below, gated on ceiling)
                                     3. returns the human's identity/session to the client
                                        immediately — step 2 never blocks the response
```

- Bot spawn failure is logged and retried independently; it must never fail or delay human
  onboarding (HLD §11 risk table).
- Bots use the exact same `FairDropClient` / reducer surface as the React client — the module
  cannot tell a bot's `submit_bid` call from a human's. Only `Participant.origin` distinguishes
  them, and it is set once at `join` time based on which caller invoked it.
- Ratio is hardcoded at 4 bots per human for this build (HLD §6) — make it a config constant
  in the bot-spawner service, not a magic number, so it can be tuned without a redeploy.

**Turn-mode bid formula** (reads the `ceiling` assigned at `join`, §2):

```
for the current slot:
  if participant.ceiling < slot.floor:
      abstain — do not call submit_bid this slot (simulates a real budget dropout, not a
                scripted one; this is what makes inventory visibly "drain" of bots as
                floors rise, per the legibility goal in HLD §11)
  else:
      bid := randomUniform(slot.floor, participant.ceiling)   // fresh draw every slot —
                                                                // NOT a fixed position; a bot
                                                                // that bid low in Slot 1 might
                                                                // bid high in Slot 2, same ceiling
      submitBid(eventId, round_to_nearest_hundred(bid))
```

Re-rolling the draw every slot (rather than a fixed per-bot trait like the earlier
`aggression`-interpolation design) both spreads bids out further — reducing accidental exact
ties on top of the seeded tiebreak in §2 — and is a more honest simulation: a bidder's ceiling
represents their budget cap, not a fixed personality that produces the same relative bid every
time.

This replaces a flat "floor + fixed random increment" rule: individualized, wallet-backed
willingness-to-pay produces more realistic bid spread (fewer accidental exact ties than
floor-hugging) and a genuine drop-out curve across slots — but it does not eliminate ties, so
`close_slot`'s seeded tiebreak (§2) still has to exist regardless.

## 6. Client SDK contract

One shared layer (`clients/sdk`); nothing in React, the bot-spawner, or bot worker code talks
to the generated SpacetimeDB client bindings directly. Under the hood, `FairDropClient` wraps
SpacetimeDB's generated TS client (`DbConnection`): reducer calls become
`connection.reducers.<name>(...)`, and subscriptions become SQL-shaped queries
(`SELECT * FROM event WHERE ...`) whose row callbacks (`onInsert` / `onUpdate` / `onDelete`)
`FairDropClient` translates into the plain callback surface below. Generated bindings come from
`spacetimedb generate --lang typescript` against the published module — **do not hand-write
table/reducer types on the client**, or the two sides will drift silently.

```ts
class FairDropClient {
  join(displayName: string, origin: "human" | "bot"): Identity
  listEvents(): Event[]
  createEvent(config): EventId                    // admin only
  startCountdown(eventId: EventId): void           // admin only
  submitBid(eventId: EventId, price: number): void
  subscribeEvent(eventId: EventId, cb: (e: Event) => void): Unsubscribe
  subscribeAllocations(eventId: EventId, cb: (a: Allocation) => void): Unsubscribe
  subscribeSlotResults(eventId: EventId, cb: (r: SlotResult) => void): Unsubscribe
  getWalletBalance(): number
}
```

React usage is a thin context provider around one `FairDropClient` + `DbConnection` instance,
with components reading table state via a hook (e.g. `useTable(Event)` /
`useTable(SlotResult)`) that subscribes on mount and re-renders on row events — not manual
`useEffect` wiring duplicated across the event list, phone view, and admin dashboard.

This is the seam: Engineer B must never need to know how Engineer A implements allocation or
wallet debit — only `command in → authoritative state change → subscription event out`.

Mock fixture for parallel development before the real module exists:
```json
{ "type": "slot_result", "eventId": "evt-1", "slotIndex": 2,
  "cutoffPrice": 47000, "allocated": 20, "quotaRemainingAfterRollover": 0 }
```

## 7. Module test suite layout

```
module/
├── src/
│   ├── schema/
│   ├── reducers/
│   │   ├── create_event.ts
│   │   ├── open_event.ts
│   │   ├── join.ts
│   │   ├── submit_bid.ts
│   │   ├── close_slot.ts
│   │   └── settle.ts
│   └── allocation/
│       ├── queue.ts
│       └── turn.ts
└── tests/
    ├── queue.test.ts        // arrival-order allocation, ticketsRemaining floor at 0, wallet debit
    ├── turn.test.ts         // one-bid-per-identity-per-slot, price-desc ranking, quota rollover
    ├── wallet.test.ts       // never negative; debit only on win; reject bids over balance
    ├── invariance.test.ts   // C1: shuffled arrival order → identical allocation + pricePaid
    └── lifecycle.test.ts    // state machine guards from §3
```

## 8. Admin dashboard data contract

```
GET (subscription) per event:
  totalTickets, ticketsRemaining
  allocatedTo: { human: number, bot: number }        // aggregate Allocation JOIN Participant.origin
  slots (turn mode): [{ index, floor, quota, filled, cutoffPrice }]
```

This is a pure read-model over `Allocation` + `Participant` + `SlotResult` — no new write path.

## 9. Onboarding + event-list UI data contract

```
POST /onboard { displayName } → { identity, walletBalance }   // via bot-spawner service, §5
GET  (subscription) events → [{ id, name, mode, state, ticketPrice? , slots? }]
```

## 10. Experiment runner (pre-demo validation, not audience-facing)

Retained from v1 for CI/pre-show validation — not part of the live demo UI, but used to prove
the mechanism before it's on stage. `npm run experiment` produces, for a configured population
(e.g. 25 humans → 100 bots via the 4:1 ratio, 100 tickets):

```
=== ROUND 1 — QUEUE (FCFS) ===
Human allocations:   18
Bot allocations:     82

=== ROUND 2 — TURN (FAIR DROP) ===
Human allocations:   61
Bot allocations:     39
```

Sweep bot reaction delay `δ` against a fixed human delay distribution to show latency advantage
collapsing under turn mode vs. persisting under queue mode — same evidentiary purpose as v1's
latency-injection harness, just re-parameterized around the fixed 4:1 bot ratio instead of a
configurable fan/scalper split.

## 11. Test plan mapped to invariants

| Invariant | Test | Mechanism |
|---|---|---|
| C1 | `invariance.test.ts` | Same bid set, shuffled insertion order (`ABCDE` vs `ECADB`) → assert identical `Allocation` rows (same winners, same `pricePaid`) |
| C1 (system-level) | Merge Gate 5 | Bots configured with near-zero reaction delay, humans with realistic delay; assert turn allocator outcome depends only on price rank, not on timing |
| C2 | `turn.test.ts` | Same identity submits twice in one slot → second rejected, exactly one `Bid` row persists |
| C1 (tiebreak) | `invariance.test.ts` | N bidders submit the identical price, quota < N → assert (a) the winning subset is stable across shuffled insertion order, and (b) re-deriving the tiebreak formula from the closed slot's own data reproduces the same winners — i.e. the tiebreak is a pure function of committed post-close state, never of `seq`, arrival order, or participant identity/join order |
| C3 | Merge Gate 6 | Every client records `{slot_result_id, state_version, received_at}`; assert all clients derive their next action from the same committed slot state |
| C4 | Merge Gate 6 | Same as above — verify no client acts on a `SlotResult` before it is the module's committed state |
| Wallet | `wallet.test.ts` | Losing bid → balance unchanged; winning bid → balance -= own bid price, exactly once; bid above balance → rejected pre-write |
| Quota rollover | `turn.test.ts` | Slot with 5 qualifying bids against quota 20 → 15 unfilled roll into next slot's quota (pending confirmation of the assumption at the top of this file) |
| Queue baseline | `queue.test.ts` | inventory=5, bids A/B/C arrive in order → allocation order == arrival order; inventory never negative |
| Bot ratio | integration test | N humans onboarded → exactly 4N bot `Participant` rows exist with `origin == "bot"` |
| Master acceptance | `test:core` (below) | Flip `mode: "queue"` → `"turn"`, same participants/inventory/UI/network → different winners |

`npm run test:core` end-to-end sequence: start local SpacetimeDB → publish module → onboard 25
humans (spawns 100 bots) → open queue-mode event → run bots + scripted human bids → settle →
save result → reset → open turn-mode event with same population → settle → compare outcomes →
verify invariants. This command is the project's definition of done.

## 12. Repository structure

```
fair-drop/
├── module/                   # Engineer A — schema, reducers, allocation, tests
├── services/
│   └── bot-spawner/           # Engineer B — onboarding proxy + bot worker spawn/lifecycle
├── clients/
│   ├── sdk/                   # shared contract (FairDropClient)
│   ├── bots/                  # Engineer B — bot bid-loop logic (queue + turn strategies)
│   └── web/                   # Engineer B — event list, phone view, admin dashboard
├── integration/                # shared — queue/turn/invariance/wallet/experiment specs
└── docs/
    ├── CONTRACT.md
    ├── CORE_LOOP.md
    └── ACCEPTANCE.md
```

Branching: short-lived feature branches (`feat/schema`, `feat/turn-clearing`,
`feat/wallet`, `feat/bot-spawner`, `feat/admin-dashboard`, ...) merged continuously into `main`;
avoid long-lived per-engineer branches. Every merge must leave `main` runnable.

## 13. Merge gates (build sequence)

Do not build in isolation and combine at the end — merge progressively:

1. **Gate 0 — Contract.** Tables, reducers, states, events, IDs, error semantics — including
   the wallet debit contract and the slot floor/quota schedule shape — agreed and frozen (spend
   the first 60–90 minutes on this together, before any independent coding).
2. **Gate 1 — Hello-world integration.** Engineer B calls `create_event()` + `join()`;
   Engineer A's module returns authoritative event + participant state (with wallet balance)
   via subscription. No UI, no bidding round.
3. **Gate 2 — One participant, queue mode.** `create event → join → submit_bid → allocation
   appears → wallet debited`. If this doesn't work, stop adding features until it does.
4. **Gate 3 — Queue mode at scale.** 10 humans, 40 bots (4:1), 5 tickets → fast bots should
   disproportionately win. Round 1 is *supposed* to look unfair; if it doesn't, the baseline
   isn't demonstrating the problem.
5. **Gate 4 — Turn mode.** Same population, only `mode = "turn"`, 5 slots with the fixed floor
   schedule → arrival ordering should no longer determine allocation, and each winner should
   pay their own bid (spot-check `pricePaid` varies by winner within a slot).
6. **Gate 5 — C1 invariance.** Bots at near-zero delay vs. humans at realistic delay → turn
   allocator outcome must track price rank, not timing.
7. **Gate 6 — Subscription correctness (C3/C4) + wallet atomicity.** Record `slot_result_id`,
   `state_version`, `received_at` on every client; verify all clients act from the same
   committed state, and verify no participant is ever debited without a corresponding
   `Allocation` row (or vice versa).
8. **Gate 7 — Bot-spawner + onboarding.** Human onboarding via QR flow → 4 bots appear within
   the service's SLA, all subject to the same reducer guards as the human.
9. **Gate 8 — UI.** Only now wire event list + phone view + admin dashboard together against
   the already-working loop. UI is the last consumer, not a parallel track.

## 14. Execution schedule (reference, ~30–35h/engineer)

| Phase | Engineer A | Engineer B |
|---|---|---|
| 0–2h | Contract + state model (incl. wallet, slots) | Contract + state model |
| 2–6h | Schema + reducer skeleton | SDK + mock server |
| 6–10h | Queue allocator + wallet debit | Bot-spawner service skeleton |
| 10–14h | Turn allocator (price-desc, pay-as-bid) | Bot bid-loop (queue + turn strategies) |
| 14–18h | Slot lifecycle + countdown scheduling | Onboarding flow (QR → join → spawn) |
| 18–22h | Unit/invariant/wallet tests | Admin dashboard read-model |
| 22–26h | Integration fixes | Event list + phone view |
| 26–30h | Load/state tests | Experiment runner (§10) |
| 30–34h | Shared E2E | Shared E2E |

UI intentionally does not start in earnest until ~70% of the core mechanism (including wallet
and slot lifecycle) exists — building it earlier risks building UI around a mechanism that
hasn't proven itself yet.
