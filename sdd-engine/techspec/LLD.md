# Fair Drop — Low-Level Design

Status: Draft v3 — revised for random-among-qualifying clearing, turnout-scaled inventory,
one-ticket-per-participant, and pooled bot workers
Companion to `HLD.md` (v3). Source material: `sdd-engine/context/fair-drop-brief.pdf`,
`sdd-engine/context/chat.md`, the demo-flow walkthrough (2026-09-05), and the stakeholder
review (2026-09-05).

**Resolved assumptions** (all previously flagged open, all confirmed 2026-09-05):
- Unsold quota in a slot **rolls forward** into the next slot's quota (§3).
- A participant may win **at most one ticket per event** (C5) — this replaces v2's multi-win
  allowance and inverts the tests that asserted it.
- Turn-mode clearing is **random among qualifying entries, pay-the-floor** — not
  price-descending pay-as-bid. See HLD §5a for the simulation evidence.
- `totalTickets` is **derived from turnout** (40% of registered participants) at
  `start_countdown`, not supplied at `create_event`.

## 1. Schema

Target stack: **TypeScript module on SpacetimeDB**, pooled TypeScript bot workers, **React**
client (event list, phone view, admin dashboard).

```ts
Event {
  id: EventId                  // PK
  name: string
  mode: "queue" | "turn"
  state: "created" | "countdown" | "open" | "settled"

  ticketFraction: number       // default 0.40 — see §1a. Inventory is DERIVED from this.
  totalTickets: u32            // 0 until start_countdown computes it from the participant count
  ticketsRemaining: u32
  participantsAtOpen: u32      // headcount snapshot the inventory was derived from (audit)

  startTime: Timestamp
  endTime: Timestamp | null

  // queue mode only
  ticketPrice: number | null

  // turn mode only
  currentSlotIndex: u32
  currentSlotEndsAt: Timestamp | null
}

Slot {                         // child rows, indexed by (eventId, slotIndex)
  eventId: EventId
  slotIndex: u32
  floor: number                // the posted price for this slot — under pay-the-floor this is
                                // also the clearing price every winner pays. Strictly increasing
                                // across slots (enforced in create_event).
  quota: u32                   // effective quota AFTER any rollover from the prior slot (§3);
                                // seeded at start_countdown as totalTickets / 5
  filled: u32
  entriesReceived: u32         // qualifying entries this slot — the oversubscription readout
}
// UNIQUE (eventId, slotIndex)

Participant {
  identity: Identity           // PK — module-issued
  displayName: string
  origin: "human" | "bot"      // drives the dashboard's human-vs-bot split — first-class
  walletBalance: number        // session-scoped; randomUniform(20_000, 150_000) at join, for
                                // BOTH origins. This is the participant's paying capacity —
                                // there is no separate `ceiling` field (deleted in v3, see §1b).
  hasWon: bool                 // C5 — set true on allocation; blocks entry in every later slot
}

Bid {                          // "entry" in turn mode — the name is kept for continuity
  id: BidId                    // PK
  eventId: EventId             // FK, indexed
  slotIndex: u32               // indexed — turn mode only; 0 for queue mode
  participant: Identity        // FK, indexed
  price: number                // queue mode: must equal ticketPrice
                                // turn mode: must equal slot.floor (there is no bid amount to
                                // choose — an entry is an opt-in at the posted price)
  qty: u32                     // fixed at 1 for this build — see §1b
  seq: u64                     // server-assigned arrival sequence, retained for audit only —
                                // MUST NOT be read by the turn allocator (that's the point, C1)
  state: "pending" | "won" | "lost" | "rejected"
}
// (eventId, slotIndex, participant) has no schema-level UNIQUE — SpacetimeDB only supports
// single-column unique/primaryKey constraints (v2.0). C2 is enforced by check-then-insert
// inside submit_bid (§2), which is safe only because reducers execute serially — no other
// call can interleave between the existence check and the insert.

Allocation {
  eventId: EventId             // indexed
  slotIndex: u32
  participant: Identity
  pricePaid: number            // = slot.floor (turn) or ticketPrice (queue). Uniform per slot.
}

SlotResult {
  eventId: EventId             // indexed
  slotIndex: u32
  clearingPrice: number        // = slot.floor. Every winner in the slot paid exactly this.
  entriesReceived: u32
  allocated: u32
  quotaRemainingAfterRollover: u32  // feeds into next slot's effective quota
  drawSeed: string             // the seed the draw was derived from — published so anyone can
                                // recompute the winner set from committed state (HLD §5)
}
```

Index every column used in a filter or join (`eventId`, `slotIndex`, `participant`).
`slotIndex` is a data column, not a schema variant — re-running the demo produces new rows,
never a migration.

**Field removed in v3:** `Slot.cutoffPrice` and `SlotResult.cutoffPrice`. Under pay-as-bid the
cutoff (lowest winning bid) was distinct from the floor; under pay-the-floor they are the same
number, so the field was two names for one value and invited misreading it as a per-winner
price. `SlotResult.clearingPrice` replaces it.

### 1a. Demo parameters

Locked in as defaults rather than illustrative placeholders — change via `create_event` config,
not by editing the module. These are the output of the simulation in HLD §5a, not guesses.

**Turnout is the variable nothing else may depend on.** Expected range is 50–250 humans, so
250–1,250 total participants at the fixed 4:1 bot ratio. Every parameter below is either
turnout-independent or derived from turnout at runtime.

| Parameter | Value | Rationale |
|---|---|---|
| Bots per human | 4 (fixed, HLD §6) | Sets human share of the population at 20%, and therefore the expected human share of allocations in turn mode at 20% — measured 19.6–20.2% across all 24 simulated configurations. This is the demo's headline number and it is ratio-invariant. |
| `ticketFraction` | **0.40** | `totalTickets = round(0.40 × participants)`, computed at `start_countdown`. Holds every observable flat across the turnout range: always sells out exactly, ~40% of humans win, identical clearing prices at 250 and at 1,250 participants. A fixed inventory does not — at 100 tickets the share of humans winning swings 40% → 8% across the range, and 500 tickets against a 250-participant turnout leaves slots 4–5 empty. |
| Slots | 5, quota split evenly (`totalTickets / 5`) | With inventory scaled to turnout there is no reason to shrink quotas across slots; the eligible field shrinks on its own as floors rise past wallets, which is the visible drama. Remainder from the division is added to the final slot. |
| `slots[].floor` | ₹15,000 / 22,000 / 30,000 / 40,000 / 55,000 | Strictly increasing (enforced). Under pay-the-floor every floor binds by construction — the clearing price of slot *k* *is* `floor[k]`. Tuned so the top floor sits well inside the wallet distribution: at ₹55,000, ~73% of the wallet range still qualifies, keeping the last slot genuinely contested rather than empty. |
| `ticketPrice` (queue mode) | ₹15,000 | Equal to Slot 1's floor, so Round 1 and Round 2 start from the same face value — the only variable that changes between rounds is the clearing rule. |
| `walletBalance` (both origins) | `randomUniform(₹20,000, ₹1,50,000)` at join | Replaces v2's flat ₹5,00,000. A flat balance means nobody ever drops out and willingness-to-pay carries no information. The random draw produces a genuine dropout curve as floors rise. Minimum (₹20,000) sits above Slot 1's floor so everyone can contest the first slot; maximum (₹1,50,000) sits well above the top floor so the last slot has a real field. Bots draw from the identical distribution — a bot's win is wallet-backed, not free. |
| Turn-mode entry | Opt-in at `slot.floor`; no amount to choose | Under a draw at a posted price there is no bid amount, for humans or bots. See §5. |
| Countdown / slot window | 60s each | Long enough to read on a projector, short enough for a 5-slot event inside a demo slot. |

**Expected shape** (reproduce with the experiment runner, §10, before it is ever on stage):
Round 1 skews heavily bot — millisecond reaction time against scarce inventory. Round 2 lands
human share at ~20%, matching population share, with ~40% of humans winning something. Bots
still win ~80% of tickets in Round 2, and that is correct: the fix removes the *speed*
advantage, not bot participation. The claim is proportionality, not exclusion.

### 1b. Deliberately fixed for this build (call these out if requirements shift)

- `qty` is always 1 — one ticket per entry, and by C5 one ticket per participant per event.
  Multi-ticket demand ("declare how many you want upfront") was considered and **deferred**:
  it turns the allocator from unit-demand into multi-unit demand and changes the wallet guard
  to `qty × floor`. Not in the MVP.
- Turn-mode rule is fixed to **random-among-qualifying, pay-the-floor** (HLD §5a). The
  price-descending pay-as-bid comparator survives only inside the experiment runner (§10) as
  the comparison arm that produces HLD §5a's table — it is not a production code path.
- `Participant.ceiling` is **deleted**. It existed to cap bot bids below a flat ₹5,00,000
  wallet; with the wallet itself drawn from ₹20,000–₹1,50,000 the wallet *is* the ceiling, and
  a second field would be a redundant copy that could drift out of sync with it.
- Wallet is session-scoped: there is no field or reducer for topping up or persisting balance
  across a reset. A "reset demo" operation creates a new event and new participants (and thus
  new wallets) from scratch, rather than zeroing and re-crediting existing rows.

### 1c. SpacetimeDB TS module shape

SpacetimeDB v2.0 TS modules use a **schema-builder API**, not decorators — tables are values
built with `table()` + the `t.*` type builder, collected into one `schema({...})`, and reducers
are exported members of that schema object (`spacetimedb.reducer(...)`). Import surface is
`spacetimedb/server` for `schema`/`table`/`t`, and `spacetimedb` (note: no `/server`) for
`ScheduleAt` — **verify both paths against whatever version lands in `module/package.json`**,
this has moved across pre-2.0 releases.

```ts
import { schema, table, t } from "spacetimedb/server";
import { ScheduleAt } from "spacetimedb";

const event = table(
  { name: "event", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    mode: t.string(),                 // "queue" | "turn"
    state: t.string(),                // "created" | "countdown" | "open" | "settled"
    ticketFraction: t.f64(),
    totalTickets: t.u32(),          // 0 until start_countdown sizes it (§2)
    ticketsRemaining: t.u32(),
    participantsAtOpen: t.u32(),
    ticketPrice: t.f64().optional(),
    currentSlotIndex: t.u32(),
    currentSlotEndsAt: t.timestamp().optional(),
  }
);

// Turn/slot boundaries AND the queue-mode countdown both use SpacetimeDB's *scheduled table*
// pattern: a table with a `scheduled_at`-typed column (via `t.scheduleAt()`) bound to a reducer
// via `onSchedule`, which the runtime invokes automatically. This — not a hand-rolled
// setTimeout/cron — is what gives close_slot (and open_event, once the countdown elapses) their
// "only the scheduler may invoke this" guarantee for free. In v2.0, scheduled reducers are
// private by default (ordinary clients cannot call them directly), so the `ctx.sender == module
// identity` guard in §2 is defense-in-depth, not the only thing enforcing it.
const slotSchedule = table(
  { name: "slot_schedule" },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    eventId: t.u64(),
  }
);

const countdownSchedule = table(
  { name: "countdown_schedule" },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    eventId: t.u64(),
  }
);

const spacetimedb = schema({ event, slotSchedule, countdownSchedule /*, participant, bid, ... */ });
export default spacetimedb;

export const closeSlot = spacetimedb.reducer(
  { onSchedule: slotSchedule },
  { arg: slotSchedule.rowType },
  (ctx, { arg }) => {
    // invoked automatically by the scheduler; arg.eventId identifies which event's slot closed
  }
);

export const join = spacetimedb.reducer(
  { displayName: t.string(), origin: t.string() },
  (ctx, { displayName, origin }) => {
    // creates Participant with walletBalance = randomUniform(20_000, 150_000), hasWon = false
  }
);
```

There is no schema-level composite `UNIQUE` (single-column `.unique()`/`.primaryKey()` only —
see the `Bid` table comment in §1 and C2 in §2's `submit_bid`); multi-column lookups use a
multi-column btree index instead, declared via the table's `indexes` option.

Client-visible effect is identical to the pseudocode in §2 regardless of the exact builder
syntax: reducers are the only write path, and every write (including the wallet debit) is
transactional and serialized by the engine — this is what makes C3, and "ticket XOR refund,
never partial," structural rather than something we implement with a saga.

## 2. Reducers

### `create_event(name, mode, startTime, config)`

Note there is no `totalTickets` argument — inventory is derived at `start_countdown` (below).

```
guard: ctx.sender is the admin identity
guard: if mode == "turn": config.floors is non-empty and STRICTLY INCREASING
                          (reject, do not warn — v2 accepted non-monotonic floors with a
                           warning; under pay-the-floor a non-increasing ladder means a later
                           slot is cheaper than an earlier one, and every remaining
                           participant would rationally skip ahead to it)
guard: if mode == "queue": config.ticketPrice > 0
guard: 0 < config.ticketFraction <= 1        // default 0.40
effect:
  event.state := "created"
  event.ticketFraction := config.ticketFraction
  event.totalTickets := 0                     // not known yet
  event.ticketsRemaining := 0
  if mode == "queue": event.ticketPrice := config.ticketPrice
  if mode == "turn":
    for i, floor in config.floors:
      insert Slot { eventId, slotIndex: i, floor, quota: 0, filled: 0, entriesReceived: 0 }
    event.currentSlotIndex := 0
```

### `start_countdown(event_id)`

Registration closes here, and this is where inventory is sized — it is the only moment at
which the participant count is both final and known.

```
guard: ctx.sender is the admin identity
guard: event.state == "created"
effect:
  n := count(Participant)                            // headcount snapshot
  event.participantsAtOpen := n
  event.totalTickets := round(event.ticketFraction * n)
  event.ticketsRemaining := event.totalTickets
  if mode == "turn":
    base := floor_div(event.totalTickets, slotCount)
    for i in 0..slotCount-1:
      slot[i].quota := base
    slot[slotCount-1].quota += event.totalTickets - base * slotCount   // remainder to last slot
  event.state := "countdown"
  schedule open_event(event.id) at now() + countdownSeconds   // 60s
```

**Acceptance:** `sum(slot.quota) == event.totalTickets` exactly, at every turnout. There is no
overbooking path — quotas are derived from inventory, so they cannot exceed it by construction.

### `open_event(event_id)`

Scheduled (see §1c `CountdownSchedule`) to fire `countdownSeconds` after `start_countdown`.
Guarded the same way `close_slot` is.

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
guard: event registration is still open (no event in state "countdown"/"open" that this
       participant is joining late — late joiners are allowed but are not counted in an
       already-sized event, since totalTickets is already fixed)
effect:
  insert Participant { identity: ctx.sender, displayName, origin,
                        walletBalance: randomUniform(20_000, 150_000),
                        hasWon: false }
```

The wallet draw is the participant's paying capacity, and it is the *only* such field — v2's
separate `ceiling` is gone (§1b). It applies identically to humans and bots: a human's entry
is gated by their real wallet in exactly the way a bot's is, and neither can enter a slot whose
floor exceeds their balance.

Called directly by a human's React client for the human row, and by each bot worker for its own
row (see §5) — same reducer, no special-cased "bot join" path in the module.

### `submit_bid(event_id, price)`

Single entrypoint. This branch is the entire difference between the two rounds — nothing else
about the two modes is allowed to diverge, or the comparison is no longer valid. Note that both
branches now validate `price` against a server-known value, so the two paths are structurally
identical up to the clearing rule.

```
guard: event.state == "open"
guard: ctx.sender is a registered participant
guard: participant.hasWon == false             // C5 — one ticket per participant per event

if event.mode == "queue":
    guard: price == event.ticketPrice
    guard: participant.walletBalance >= price
    guard: event.ticketsRemaining > 0           // else reject, wallet untouched
    // allocation + debit happen together, atomically, in this same reducer call
    insert Allocation { eventId, slotIndex: 0, participant: ctx.sender, pricePaid: price }
    participant.walletBalance -= price
    participant.hasWon := true
    event.ticketsRemaining -= 1

if event.mode == "turn":
    slot := slot[event.currentSlotIndex]
    guard: request.slotIndex == event.currentSlotIndex   // reject stale/future slot
    guard: price == slot.floor                  // an entry is an opt-in at the posted price;
                                                 // there is no bid amount to choose
    guard: participant.walletBalance >= slot.floor
    guard: no existing Bid(eventId, event.currentSlotIndex, ctx.sender)   // C2 — check-then-insert;
                                                                          // safe only because
                                                                          // reducers run serially
    insert Bid { ..., price: slot.floor, seq: next_seq(), state: "pending" }
    slot.entriesReceived += 1
    // no allocation or debit happens here — return only "accepted"
```

**Acceptance:**
- `ticketsRemaining` cannot go negative
- `queue` mode: allocation order == arrival order (this is the expected, undesirable baseline)
- `turn` mode: identity + slot → max 1 entry persisted; a second attempt is rejected, not queued
- a participant with `hasWon == true` is rejected in both modes (C5)
- no entry is ever accepted from a participant whose wallet cannot cover the floor

### `close_slot(event_id)`

Engineer A's most important reducer — this is where C1 is either satisfied or violated, and
where the wallet debit must be atomic with the allocation write.

```
guard: ctx.sender == module identity              // only the scheduler may invoke this
guard: event.state == "open" and event.mode == "turn"
guard: this slotIndex has not already been closed  // reject double-close

slot := slot[event.currentSlotIndex]
entries := all Bid where eventId == event.id and slotIndex == event.currentSlotIndex

// The draw seed is computed from data that only exists once the slot is closed — the sorted
// set of entry IDs in this slot — so it cannot be predicted or positioned for in advance (C4),
// and it deliberately does NOT use `seq`, arrival order, or participant identity/join order:
// identities are typically assigned sequentially at join, so "lowest identity wins" would be
// join-order-in-disguise, which is exactly the C1 violation this mechanism exists to remove.
drawSeed := hash(event.id, event.currentSlotIndex, sorted(entries.map(e => e.id)))
ranked   := entries.sort(by hash(drawSeed, entry.id) ASC)

// This is the ALLOCATION rule in v3, not a tiebreak. Under v2's pay-as-bid it ran only when
// two bids matched exactly; under pay-the-floor every entry in the slot is at the same price,
// so the draw decides every allocation. The construction is unchanged — its role is promoted.

filled := 0
for entry in ranked:
    if filled >= slot.quota: entry.state = "lost"; continue
    p := participant(entry.participant)
    if p.hasWon: entry.state = "rejected"; continue      // defensive; submit_bid already blocks
    if p.walletBalance < slot.floor: entry.state = "rejected"; continue   // see note below
    insert Allocation { eventId, slotIndex: event.currentSlotIndex,
                         participant: entry.participant, pricePaid: slot.floor }
    p.walletBalance -= slot.floor                  // same transaction as the write above
    p.hasWon := true                                // C5
    entry.state = "won"
    filled += 1
    event.ticketsRemaining -= 1

unfilled := slot.quota - filled
slot.filled := filled

write SlotResult { slotIndex: event.currentSlotIndex, clearingPrice: slot.floor,
                    entriesReceived: slot.entriesReceived, allocated: filled,
                    quotaRemainingAfterRollover: unfilled,
                    drawSeed }                     // single serialized write

nextIndex := event.currentSlotIndex + 1
if nextIndex >= slotCount or event.ticketsRemaining == 0:
    call settle(event.id)
else:
    slot[nextIndex].quota += unfilled              // rollover — CONFIRMED, see header
    event.currentSlotIndex := nextIndex
    event.currentSlotEndsAt := now() + W
    schedule close_slot(event.id) at event.currentSlotEndsAt
```

**On the mid-close wallet check.** Under v2's multi-win rule a winner's balance could fall
below their bid between submit and close, and the policy for that had to be specified. Under
C5 a participant can win at most once per event, so their balance cannot move between
`submit_bid` and `close_slot` within one event. The guard is retained as defense-in-depth and
its policy is stated explicitly — skip the entry, pass the ticket to the next in the draw
order, never produce a negative balance — but it should be unreachable, and a test asserting
it never fires under normal operation is worth more than one exercising it.

**Correctness property (C1), stated as a test:** for the same entry set, running the reducer
with insertion order `A B C D E` and with insertion order `E C A D B` must produce identical
`Allocation` rows (same winners, same `pricePaid`). This is the single most important
automated test in the repository (see §11, Invariance).

**Verifiability property (new in v3):** `SlotResult.drawSeed` is published. Given the committed
entry set and the seed, any third party can recompute `ranked` and confirm the winner list.
This is what the mechanism offers over FCFS and it should be exercised by a test that
recomputes the draw outside the module and asserts an exact match (§11).

### `settle(event_id)`

```
guard: event.state == "open"
effect: event.state := "settled"
        write final scoreboard summary (aggregate Allocation by participant.origin)
```

## 3. Turn state machine

```
CREATED → COUNTDOWN → OPEN → (queue: single race) or (turn: slot 0 → slot 1 → ... → slot N-1) → SETTLED
             ▲
      inventory sized here (start_countdown): totalTickets = round(fraction × participants)
```

Reject explicitly, don't silently ignore:

| Invalid transition | Guard that catches it |
|---|---|
| bid before `open` (including during `countdown`) | `event.state == "open"` check in `submit_bid` |
| bid after `settle` | same guard — `state` is no longer `"open"` |
| entry from a participant who already won | `participant.hasWon == false` guard (C5) |
| `close_slot` called twice on same slot | check slot not already closed |
| `settle` called twice | `event.state == "open"` guard |
| bid for a stale or future slot | `slotIndex` match check in `submit_bid` |
| turn-mode price != current slot floor | `price == slot.floor` guard in `submit_bid` |
| wallet cannot cover the floor | balance guard in `submit_bid` |
| `start_countdown` on an already-sized event | `event.state == "created"` guard |

Design principle: a correct reducer set should make invalid states difficult to represent, not
just rejected at runtime.

## 4. Allocation algorithms

- **Queue (`allocation/queue.ts`).** `request received → price matches ticketPrice? →
  participant has not already won? → inventory available? → wallet covers price? →
  allocate + debit immediately → decrement inventory`. O(1) per request.
- **Turn (`allocation/turn.ts`).** `load current-slot entries → ignore seq/arrival order →
  derive drawSeed from the sorted entry-id set → sort by hash(drawSeed, entry.id) ascending →
  walk the ranking, allocate 1 ticket + debit slot.floor per entry until quota spent →
  mark winners hasWon → roll unfilled quota into next slot`. O(n log n) over n = entries in one
  slot (up to ~1,250 at the top of the turnout range — trivially fast, but see §11 for the load
  case that actually matters, which is subscriber fan-out, not sort cost).

The rule is fixed to random-among-qualifying pay-the-floor for this build (HLD §5a). The
price-descending pay-as-bid comparator lives on only in the experiment runner (§10) as the
comparison arm.

## 5. Bot-runner service (not part of the module)

Reducers are transactional and cannot run a timer, sleep, or make an outbound decision loop —
so bot behaviour cannot live inside `join` or any other reducer. Per the demo requirement, the
**onboarding action itself** triggers bot registration, as a side effect outside the module:

```
clients/web  --POST /onboard { displayName }-->  services/bot-runner (Node/Express)
                                                          │
                                     1. calls FairDropClient.join(displayName, "human")
                                        against the module, on behalf of the human
                                     2. fire-and-forget: registers 4 bots into the SHARED
                                        WORKER POOL (async tasks — never child processes),
                                        each of which:
                                          a. calls FairDropClient.join(`Bot-${randomId}`, "bot")
                                          b. runs its own entry loop against whichever event
                                             is currently OPEN (queue: hit buy at
                                             t_open + random(0, δ); turn: enter per §5's rule)
                                     3. returns the human's identity/session to the client
                                        immediately — step 2 never blocks the response
```

### 5a. The worker pool is a hard constraint, not a tuning preference

At the top of the expected turnout range (250 humans) the 4:1 ratio means **1,000 concurrent
bots**. v2's "async tasks or child processes" phrasing left the door open to one OS process per
bot; at this scale that is not survivable on a demo rig, and it is the single most likely way
the demo dies. The design is therefore pinned:

- Bots are **async tasks** in one bounded worker pool inside a single Node process (or a small
  fixed number of processes sized to CPU cores — never sized to bot count).
- The pool owns a **bounded set of SpacetimeDB connections** and multiplexes bot logic over
  them. 1,000 bots must not mean 1,000 WebSocket connections.
- Pool size, connection count, and the 4:1 ratio are config constants in the bot-runner
  service, not magic numbers, so they can be tuned without a redeploy.
- Bot registration failure is logged and retried independently; it must never fail or delay
  human onboarding (HLD §11 risk table).
- Bots use the exact same `FairDropClient` / reducer surface as the React client — the module
  cannot tell a bot's `submit_bid` call from a human's. Only `Participant.origin` distinguishes
  them, and it is set once at `join` time based on which caller invoked it.

### 5b. Turn-mode bot behaviour

```
for the current slot:
  if participant.hasWon:
      do nothing — ineligible (C5)
  else if participant.walletBalance < slot.floor:
      abstain — do not call submit_bid this slot, and abstain for the rest of the event
                (floors only rise, so this is a permanent, genuine budget dropout; it is what
                 makes the eligible field visibly thin out as the ladder climbs)
  else:
      submitBid(eventId, slot.floor)      // opt-in at the posted price; nothing to choose
```

**This is deliberately trivial, and that is the finding.** v2 had bots drawing a fresh random
bid in `[floor, ceiling]` every slot, with the spread tuned to avoid accidental ties. Under a
draw at a posted price there is no bid amount for anyone — human or bot — to select, so there
is no strategy left to encode. A bot cannot out-think, out-spend, or out-run a human into a
uniform random draw; the only thing that separates participants is whether their wallet clears
the floor. That is exactly the property the mechanism is claiming, so the bot code getting
simpler is evidence the design is working, not a gap in the simulation.

The consequence for the demo narrative: Round 2's interest is no longer "watch the bots bid
smarter" but "watch the eligible field shrink while allocation stays proportional." The
dashboard should be built around entries-vs-quota and the human/bot split, per HLD §4.2.

## 6. Client SDK contract

One shared layer (`clients/sdk`); nothing in React, the bot-runner, or bot worker code talks
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
  "clearingPrice": 30000, "entriesReceived": 814, "allocated": 100,
  "quotaRemainingAfterRollover": 0, "drawSeed": "9f2c…" }
```

The SDK surface gains `startCountdown(eventId)` (admin) alongside `createEvent` — inventory is
sized there, not at creation (§2).

## 7. Module test suite layout

```
module/
├── src/
│   ├── schema/
│   ├── reducers/
│   │   ├── create_event.ts
│   │   ├── start_countdown.ts       // inventory sizing from turnout (§2)
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
    ├── turn.test.ts         // one-entry-per-identity-per-slot, seeded draw, quota rollover
    ├── inventory.test.ts    // totalTickets = round(fraction × headcount); sum(quota) == total
    ├── wallet.test.ts       // never negative; debit only on win; reject entries over balance
    ├── onewin.test.ts       // C5: hasWon blocks later slots, in both modes
    ├── invariance.test.ts   // C1: shuffled arrival order → identical allocation
    ├── verifiability.test.ts// recompute the draw from drawSeed outside the module → exact match
    └── lifecycle.test.ts    // state machine guards from §3
```

## 8. Admin dashboard data contract

```
GET (subscription) per event:
  totalTickets, ticketsRemaining, participantsAtOpen
  allocatedTo: { human: number, bot: number }        // aggregate Allocation JOIN Participant.origin
  slots (turn mode): [{ index, floor, quota, entriesReceived, filled }]
```

This is a pure read-model over `Allocation` + `Participant` + `SlotResult` — no new write path.

There is no `cutoffPrice`. Under pay-the-floor the slot's floor is its clearing price, so the
per-slot money column is just `floor`. The column worth projecting instead is
`entriesReceived / quota` — the oversubscription ratio — which is what visibly changes as the
ladder climbs and the eligible field shrinks.

## 9. Onboarding + event-list UI data contract

```
POST /onboard { displayName } → { identity, walletBalance }   // via bot-runner service, §5
GET  (subscription) events → [{ id, name, mode, state, ticketPrice? , slots? }]
```

## 10. Experiment runner (pre-demo validation, not audience-facing)

Not part of the live demo UI, but the thing that proves the mechanism before it is on stage —
and, in v3, the thing that produced the design. HLD §5a's tables are its output. A working
prototype exists at `scratchpad/sim3.py` and should be ported into `integration/experiment` as
the seed for this component rather than rewritten from scratch.

`npm run experiment` sweeps a configured population and prints, per round:

```
=== ROUND 1 — QUEUE (FCFS) ===
Human allocations:   4  (2.0%)
Bot allocations:   196

=== ROUND 2 — TURN (FAIR DROP, random among qualifying) ===
Human allocations:  40  (19.9%)
Bot allocations:   160
Winners from richest cohort:  45.1%
Floors binding: 5/5
```

Required capabilities, all exercised by TC-EXP:

1. **Turnout sweep.** Run the same config at 50 / 100 / 150 / 250 humans (4:1 bots) and assert
   the derived-inventory rule holds every observable flat — this is the check that protects
   against the failure mode described in HLD §3.3.
2. **Rule comparison arm.** Run both `random-among-qualifying` and the retired
   `price-descending pay-as-bid` over identical populations, reporting human share,
   richest-cohort overlap, average price paid, and floors-binding count. This arm is why the
   pay-as-bid comparator still exists in the codebase at all (§1b), and it regenerates HLD §5a
   on demand if the parameters are ever revisited.
3. **Delay sweep.** Sweep bot reaction delay δ against a fixed human delay distribution: the
   queue-mode outcome must move substantially and the turn-mode outcome must not move at all.
   This is the evidentiary core of the whole thesis.
4. **Seeded determinism.** Every run takes an explicit RNG seed. Same seed → identical output,
   so rehearsal numbers match show numbers and a change in the human/bot split is attributable
   to a code change rather than to the dice.

## 11. Test plan mapped to invariants

| Invariant | Test | Mechanism |
|---|---|---|
| C1 | `invariance.test.ts` | Same entry set, shuffled insertion order (`ABCDE` vs `ECADB`) → assert identical `Allocation` rows |
| C1 (draw independence) | `invariance.test.ts` | Assert by construction that `drawSeed` derives only from `(eventId, slotIndex, sorted(entry ids))` — never `seq`, insertion order, or participant identity. Plus a statistical arm: over 500 synthetic slots, the earliest-joined participant's win rate is indistinguishable from uniform |
| C1 (system-level) | Merge Gate 5 | Bots at near-zero reaction delay, humans at realistic delay → turn-mode outcome unchanged |
| C2 | `turn.test.ts` | Same identity enters twice in one slot → second rejected, exactly one `Bid` row persists |
| C3 | Merge Gate 6 | Every client records `{slot_result_id, state_version, received_at}`; assert all clients derive their next action from the same committed slot state |
| C4 | Merge Gate 6 | Same as above — verify no client acts on a `SlotResult` before it is the module's committed state |
| C5 | `onewin.test.ts` | Winner in slot 1 is rejected in slots 2–5, in both modes; exactly one `Allocation` row and one debit per participant per event |
| Verifiability | `verifiability.test.ts` | Recompute the draw outside the module from published `drawSeed` + committed entries → winner set matches exactly |
| Inventory sizing | `inventory.test.ts` | `totalTickets == round(fraction × headcount)` and `sum(slot.quota) == totalTickets` at 250 / 500 / 750 / 1250 participants |
| Wallet | `wallet.test.ts` | Losing entry → balance unchanged; winning entry → balance -= slot.floor, exactly once; entry above balance → rejected pre-write |
| Quota rollover | `turn.test.ts` | Slot with 5 qualifying entries against quota 20 → 15 unfilled roll into next slot's quota |
| Queue baseline | `queue.test.ts` | inventory=5, entries A/B/C arrive in order → allocation order == arrival order; inventory never negative |
| Bot ratio | integration test | N humans onboarded → exactly 4N bot `Participant` rows with `origin == "bot"` |
| **Load / fan-out** | integration test | **1,250 participants subscribed concurrently through the bounded pool; one slot's entries all land, `close_slot` completes inside the window, no subscriber misses the result.** Highest-risk item — run at Gate 3, not at the end |
| Master acceptance | `test:core` (below) | Flip `mode: "queue"` → `"turn"`, same participants/inventory/UI/network → different winners |

`npm run test:core` end-to-end sequence: start local SpacetimeDB → publish module → onboard the
configured human count (spawning 4x bots into the pool) → `start_countdown` sizes inventory →
open queue-mode event → run bots + scripted human entries → settle → save result → create a
*new* event (never reset the old one, §1b) with a fresh population → run turn mode → settle →
compare outcomes → verify invariants. This command is the project's definition of done.

## 12. Repository structure

```
fair-drop/
├── module/                   # Engineer A — schema, reducers, allocation, tests
├── services/
│   └── bot-runner/            # Engineer B — onboarding proxy + bounded bot worker pool
├── clients/
│   ├── sdk/                   # shared contract (FairDropClient)
│   ├── bots/                  # Engineer B — bot bid-loop logic (queue + turn strategies)
│   └── web/                   # Engineer B — event list, phone view, admin dashboard
├── integration/                # shared — queue/turn/invariance/wallet/load/experiment specs
└── docs/
    ├── CONTRACT.md
    ├── CORE_LOOP.md
    └── ACCEPTANCE.md
```

Branching: short-lived feature branches (`feat/schema`, `feat/turn-clearing`,
`feat/wallet`, `feat/bot-runner`, `feat/admin-dashboard`, ...) merged continuously into `main`;
avoid long-lived per-engineer branches. Every merge must leave `main` runnable.

## 13. Merge gates (build sequence)

Do not build in isolation and combine at the end — merge progressively:

1. **Gate 0 — Contract.** Tables, reducers, states, events, IDs, error semantics — including
   the wallet debit contract, C5, and the derived-inventory rule — agreed and frozen (spend the
   first 60–90 minutes on this together, before any independent coding).
2. **Gate 1 — Hello-world integration.** Engineer B calls `create_event()` + `join()`;
   Engineer A's module returns authoritative event + participant state (with wallet balance)
   via subscription. No UI, no bidding round.
3. **Gate 2 — One participant, queue mode.** `create event → join → start_countdown →
   submit_bid → allocation appears → wallet debited`. If this doesn't work, stop adding
   features until it does.
4. **Gate 3 — Scale, early.** Two things, both before any turn-mode work:
   (a) queue mode with 10 humans / 40 bots → fast bots should disproportionately win; Round 1
   is *supposed* to look unfair.
   (b) **the 1,250-participant load test** (§11) against the bounded worker pool. This is the
   likeliest stage failure and it is cheapest to find now — do not defer it to Gate 8.
5. **Gate 4 — Turn mode.** Same population, only `mode = "turn"`, 5 slots with the fixed floor
   ladder → arrival ordering no longer determines allocation, every winner in a slot pays
   exactly that slot's floor, and unfilled quota rolls forward.
6. **Gate 5 — C1 invariance + verifiability.** Bots at near-zero delay vs. humans at realistic
   delay → outcome unchanged. Independently recompute a slot's draw from its published
   `drawSeed` and match the module's winners exactly.
7. **Gate 6 — Subscription correctness (C3/C4) + wallet atomicity.** Record `slot_result_id`,
   `state_version`, `received_at` on every client; verify all clients act from the same
   committed state, and that no participant is ever debited without a corresponding
   `Allocation` row (or vice versa).
8. **Gate 7 — Bot-runner + onboarding.** Human onboarding via QR flow → 4 bots appear in the
   pool within the service's SLA, all subject to the same reducer guards as the human.
9. **Gate 8 — UI.** Only now wire event list + phone view + admin dashboard together against
   the already-working loop. UI is the last consumer, not a parallel track.

## 14. Execution schedule (reference, ~30–35h/engineer)

| Phase | Engineer A | Engineer B |
|---|---|---|
| 0–2h | Contract + state model (incl. wallet, slots) | Contract + state model |
| 2–6h | Schema + reducer skeleton | SDK + mock server |
| 6–10h | Queue allocator + wallet debit | Bot-spawner service skeleton |
| 10–14h | Turn allocator (seeded draw, pay-the-floor) | Bot entry loop + worker pool (queue + turn) |
| 14–18h | Slot lifecycle + countdown scheduling + inventory sizing | Onboarding flow (QR → join → pool register) |
| 18–22h | Unit/invariant/wallet/C5 tests | Admin dashboard read-model |
| 22–26h | Integration fixes | Event list + phone view |
| 26–30h | Load/state tests (1,250) | Experiment runner (§10) |
| 30–34h | Shared E2E | Shared E2E |

UI intentionally does not start in earnest until ~70% of the core mechanism (including wallet
and slot lifecycle) exists — building it earlier risks building UI around a mechanism that
hasn't proven itself yet.
