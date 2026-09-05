# Fair Drop — Low-Level Design


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
  id: EventId                  // PK — u64 autoInc (bigint in JS, see §1c)
  name: string
  mode: "queue" | "turn"
  state: "created" | "countdown" | "open" | "settled"

  ticketFraction: number       // default 0.40 — see §1a. Inventory is DERIVED from this.
  totalTickets: u32            // 0 until start_countdown computes it from the participant count
  ticketsRemaining: u32
  participantsAtOpen: u32      // headcount snapshot the inventory was derived from (audit)
  slotCount: u32               // = config.floors.length at create_event; 0 for queue mode.
                                // Read by start_countdown (quota split) and close_slot
                                // (last-slot detection) — §2 referenced it before it existed.

  startTime: Timestamp
  endTime: Timestamp | null

  // queue mode only
  ticketPrice: number | null

  // turn mode only
  currentSlotIndex: u32
  currentSlotEndsAt: Timestamp | null
}

Slot {
  id: SlotId                   // PK — u64 autoInc. There is NO composite UNIQUE
                                // (eventId, slotIndex): SpacetimeDB supports single-column
                                // unique/primaryKey only. Uniqueness of (eventId, slotIndex)
                                // is a construction invariant of create_event, not a
                                // constraint. Lookups go through the by_event_slot btree.
  eventId: EventId
  slotIndex: u32
  floor: number                // the posted price for this slot — under pay-the-floor this is
                                // also the clearing price every winner pays. Strictly increasing
                                // across slots (enforced in create_event).
  baseQuota: u32               // seeded once at start_countdown (totalTickets / slotCount,
                                // remainder to the EARLIEST slots — see §2c; the "last slot"
                                // rule is pathological below ~13 participants and is frozen
                                // against reintroduction, CONTRACT §11). NEVER mutated after.
                                // sum(baseQuota) == totalTickets holds at all times — this is
                                // the column TC-EVT-09 asserts against.
  effectiveQuota: u32          // baseQuota + rollover carried in from the prior slot (§3).
                                // This is what close_slot allocates against. sum(effectiveQuota)
                                // deliberately EXCEEDS totalTickets once any rollover has
                                // occurred; that is correct, not a violation.
  filled: u32
  entriesReceived: u32         // qualifying entries this slot — the oversubscription readout
}
// A slot is CLOSED iff a SlotResult row exists for (eventId, slotIndex). There is no
// `closed` flag: slot_result is written exactly once per close inside the same transaction,
// so it cannot drift out of sync with reality the way a separate boolean could. `filled == 0`
// is NOT a closed-marker — a slot can legitimately close having allocated nothing.

Participant {
  id: ParticipantId            // PK — u64 autoInc. NOT the identity: bots are multiplexed over
                                // a bounded pool of connections (§5a), so one `identity` backs
                                // many participant rows. Reducers therefore take an explicit
                                // participantId rather than deriving the actor from ctx.sender.
  eventId: EventId             // FK, indexed. Registration is PER EVENT — `count(Participant)`
                                // in start_countdown filters on this, and C5's "one ticket per
                                // participant per event" is true by construction. A person in
                                // two events has two rows and two independent wallet draws,
                                // which is what §1b's session-scoped wallet already implies.
  identity: Identity           // indexed, NOT unique — the connection that created this row
  handle: string               // UNIQUE. Generated at join as displayName + "-" + random
                                // suffix, for both origins ("Asha-k3f9", "Bot-k3f9-2a7c").
                                // This makes TC-POOL-07 (no bot-name collisions across 1,000
                                // registrations) a schema guarantee rather than a probabilistic
                                // assertion: on the astronomically-unlikely collision the
                                // insert fails loudly and the pool retries, instead of the
                                // demo silently running with 999 bots.
  displayName: string          // as typed, NOT unique — live audiences collide on names
                                // ("Asha" twice) and a unique constraint here would reject the
                                // second human. Display uses this; identity uses `handle`/`id`.
  origin: "human" | "bot"      // drives the dashboard's human-vs-bot split — first-class
  initialBalance: number       // the wallet draw as issued at join. NEVER mutated. Exists so
                                // spend is reconstructible: there is no ledger table, so
                                // without this there is no quantity to reconcile an Allocation
                                // against and TC-WAL-04 cannot be written at all. See §2b.
  walletBalance: number        // session-scoped; ctx.random.integerInRange(20_000, 150_000)
                                // at join, INTEGER RUPEES, for BOTH origins. This is the
                                // participant's paying capacity — there is no separate
                                // `ceiling` field (deleted in v3, see §1b).
  hasWon: bool                 // C5 — set true on allocation; blocks entry in every later slot
}

Bid {                          // "entry" in turn mode — the name is kept for continuity
  id: BidId                    // PK — u64 autoInc
  eventId: EventId             // FK, indexed
  slotIndex: u32               // indexed — TURN MODE ONLY. Queue mode writes NO Bid rows:
                                // submit_bid's queue branch allocates directly (§2), and the
                                // Allocation row is the record.
  participantId: ParticipantId // FK, indexed
  price: number                // turn mode: must equal slot.floor (there is no bid amount to
                                // choose — an entry is an opt-in at the posted price)
  qty: u32                     // fixed at 1 for this build — see §1b
  seq: u64                     // server-assigned arrival sequence, retained for audit only —
                                // MUST NOT be read by the turn allocator (that's the point, C1).
                                // DO NOT DELETE AS REDUNDANT WITH `id`: TC-INV-03 proves C1 by
                                // randomising every seq before close_slot and asserting the
                                // outcome is unchanged. That proof cannot run against `id`,
                                // which is the primary key and a draw-hash input. seq is a
                                // deliberate decoy that makes C1 mechanically falsifiable
                                // rather than merely asserted. TC-SCH-05 also pins it.
  state: "pending" | "won" | "lost" | "rejected"
}
// (eventId, slotIndex, participantId) has no schema-level UNIQUE — SpacetimeDB only supports
// single-column unique/primaryKey constraints. C2 is enforced by check-then-insert
// inside submit_bid (§2), which is safe only because reducers execute serially — no other
// call can interleave between the existence check and the insert.

Allocation {
  id: AllocationId             // PK — u64 autoInc
  eventId: EventId             // indexed
  slotIndex: u32
  participantId: ParticipantId // indexed
  pricePaid: number            // = slot.floor (turn) or ticketPrice (queue). Uniform per slot.
}

SlotResult {
  id: SlotResultId             // PK — u64 autoInc
  eventId: EventId             // indexed
  slotIndex: u32
  clearingPrice: number        // = slot.floor. Every winner in the slot paid exactly this.
  entriesReceived: u32
  allocated: u32
  quotaRemainingAfterRollover: u32  // rolls into the next slot's effectiveQuota
  drawSeed: string             // the seed the draw was derived from — published so anyone can
                                // recompute the winner set from committed state (HLD §5)
}
```

Index every column used in a filter or join (`eventId`, `slotIndex`, `participantId`,
`identity`). Per the SpacetimeDB docs, prefer a **multi-column btree** over filtering one
column and looping — declare `by_event_slot` on `(eventId, slotIndex)` for `slot`, `bid`,
`allocation` and `slot_result`, which is what `close_slot`'s entry load and the
already-closed check both hit. `slotIndex` is a data column, not a schema variant —
re-running the demo produces new rows, never a migration.

**Money is integer rupees.** Every currency field (`floor`, `ticketPrice`, `walletBalance`,
`price`, `pricePaid`, `clearingPrice`) is a whole number of rupees — no paise. The wallet
draw is rounded at `join`. `t.f64()` represents these exactly (all values sit far below
2^53), so equality assertions like TC-WAL-02's "byte-identical balance" are safe.

**There is no `settle` scoreboard table.** §8's dashboard is a pure read-model over
`Allocation` + `Participant` + `SlotResult`; `settle` writes only `event.state`.

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
| Slots | 5, quota split evenly (`totalTickets / 5`) | With inventory scaled to turnout there is no reason to shrink quotas across slots; the eligible field shrinks on its own as floors rise past wallets, which is the visible drama. Remainder from the division spreads over the **earliest** slots — see §2c for why not the last one. |
| `slots[].floor` | ₹15,000 / 22,000 / 30,000 / 40,000 / 55,000 | Strictly increasing (enforced). Under pay-the-floor every floor binds by construction — the clearing price of slot *k* *is* `floor[k]`. Tuned so the top floor sits well inside the wallet distribution: at ₹55,000, ~73% of the wallet range still qualifies, keeping the last slot genuinely contested rather than empty. |
| `ticketPrice` (queue mode) | ₹15,000 | Equal to Slot 1's floor, so Round 1 and Round 2 start from the same face value — the only variable that changes between rounds is the clearing rule. |
| `walletBalance` (both origins) | `randomUniform(₹20,000, ₹1,50,000)` at join | Replaces v2's flat ₹5,00,000. A flat balance means nobody ever drops out and willingness-to-pay carries no information. The random draw produces a genuine dropout curve as floors rise. Minimum (₹20,000) sits above Slot 1's floor so everyone can contest the first slot; maximum (₹1,50,000) sits well above the top floor so the last slot has a real field. Bots draw from the identical distribution — a bot's win is wallet-backed, not free. |
| Turn-mode entry | Opt-in at `slot.floor`; no amount to choose | Under a draw at a posted price there is no bid amount, for humans or bots. See §5. |
| Bot reaction delay δ (queue) | **`U(0, 500ms)`** — δ is the *bound*, not the delay | Every bot draws its **own** delay uniformly on `[0, 500ms]`, independently, each run. Some land near-instant, some near the full 500ms; the mean is **250ms** and the max is 500ms. It is never a fixed 500ms for all bots — that would make them a synchronised block rather than a realistic field. So the *average* bot reacts in 250ms — comparable to a **best-case human** reaction time, and slower than many. This is a deliberate handicap and it is what makes Round 1's result honest: a skeptic cannot say "you set the bots to zero." They still take essentially all inventory, because there are 40 of them, they are consistent, and a real human tapping a phone lands 1–2s out. The finding is that you do not need superhuman speed to win FCFS — you only need to be *reliably slightly faster*, at scale. δ is a named config constant (TC-POOL-09), not a literal. |
| Countdown / slot window | 60s each | Long enough to read on a projector, short enough for a 5-slot event inside a demo slot. |

**Expected shape** (reproduce with the experiment runner, §10, before it is ever on stage):
Round 1 skews heavily bot — sub-second, *consistent* reaction time against scarce inventory
(δ = 500ms, so bots are not superhuman; they are merely reliable). Round 2 lands
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

**Pinned version: `spacetimedb@2.8.3` exactly** (not `2.8.*`). There is no LTS line — 2.8.x is
simply the release line we froze on; `latest` has since moved to 2.10.x. The pin, not a support
channel, is the stability mechanism, so a floating range would silently defeat it. Everything
below was verified against 2.8's own TS reference (vendored at `fair-drop-db/CLAUDE.md`), not
assumed from 2.0.

SpacetimeDB v2.x TS modules use a **schema-builder API**, not decorators — tables are values
built with `table()` + the `t.*` type builder, collected into one `schema({...})`, and reducers
are exported members of that schema object (`spacetimedb.reducer(...)`). Import surface is
`spacetimedb/server` for `schema`/`table`/`t`/`Range`, and `spacetimedb` (note: no `/server`)
for `ScheduleAt`/`Timestamp`/`ConnectionId`. Confirmed for 2.8.

**Four corrections to the v2.0-era draft of this section**, each of which would have failed at
build on first contact:

1. **Optional columns are `t.option(t.f64())`, not `t.f64().optional()`.** There is no
   `.optional()` modifier; the documented set is `.primaryKey() .autoInc() .unique()
   .index('btree') .default()`.
2. **The `scheduled` option lives on the TABLE, not on the reducer.** The draft's
   `spacetimedb.reducer({ onSchedule: slotSchedule }, ...)` does not exist. The table carries
   `scheduled: (): any => reducerRef` (the arrow breaks the circular reference), and the
   reducer receives the schedule row as its single argument. The runtime deletes that row
   after the reducer runs.
3. **`t.u64()` is `bigint` in JS, not `number`.** All ids are therefore bigints crossing into
   the SDK, the tests and React — and `bigint` does not survive `JSON.stringify`. The SDK owns
   bigint↔string conversion at its boundary (§6).
4. **Table names are snake_case; columns are camelCase.** `ctx.db` accessors are the
   `schema({...})` keys verbatim — client codegen converts case, the server does not.

**`mode` and `state` stay `t.string()`, not `t.enum()`.** 2.8 documents `t.enum()` only as a
tagged union carrying payloads (`{ tag: 'circle', value: 10 }`); a payload-free variant would
need `t.unit()`, which the docs show only as a procedure return type and never inside an enum.
That is an undocumented pattern sitting on the seam between two engineers, and it complicates
SQL subscription filters. The literal sets are frozen here instead:
`mode ∈ {"queue","turn"}`, `state ∈ {"created","countdown","open","settled"}`,
`origin ∈ {"human","bot"}`, `bid.state ∈ {"pending","won","lost","rejected"}`.

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
    slotCount: t.u32(),
    startTime: t.timestamp(),
    endTime: t.option(t.timestamp()),
    ticketPrice: t.option(t.f64()),
    currentSlotIndex: t.u32(),
    currentSlotEndsAt: t.option(t.timestamp()),
  }
);

const slot = table(
  { name: "slot", public: true,
    indexes: [{ accessor: "by_event_slot", algorithm: "btree",
                columns: ["eventId", "slotIndex"] }] },
  {
    id: t.u64().primaryKey().autoInc(),
    eventId: t.u64(),
    slotIndex: t.u32(),
    floor: t.f64(),
    baseQuota: t.u32(),        // never mutated after start_countdown — TC-EVT-09 asserts on this
    effectiveQuota: t.u32(),   // baseQuota + rollover; what close_slot allocates against
    filled: t.u32(),
    entriesReceived: t.u32(),
  }
);

const participant = table(
  { name: "participant", public: true },
  {
    id: t.u64().primaryKey().autoInc(),    // NOT identity — see §1 and §5a (pooled connections)
    eventId: t.u64().index("btree"),
    identity: t.identity().index("btree"), // the connection that created the row; NOT unique
    handle: t.string().unique(),           // displayName + "-" + random suffix; see §1
    displayName: t.string(),               // as typed; NOT unique
    origin: t.string(),                    // "human" | "bot"
    initialBalance: t.f64(),               // immutable — the reconciliation anchor (§2b)
    walletBalance: t.f64(),                // integer rupees
    hasWon: t.bool(),
  }
);

// Turn/slot boundaries AND the queue-mode countdown both use SpacetimeDB's *scheduled table*
// pattern: a table carrying a `t.scheduleAt()` column and a `scheduled:` option pointing at an
// exported reducer, which the runtime invokes automatically. This — not a hand-rolled
// setTimeout/cron — is what gives close_slot (and open_event, once the countdown elapses) their
// "only the scheduler may invoke this" guarantee for free.
//
// Scheduled reducers are PRIVATE BY DEFAULT in 2.x: ordinary clients cannot call them, and the
// docs state explicitly that comparing ctx.sender against the module identity is unnecessary.
// The §2 draft's `ctx.sender == module identity` guard is therefore DELETED, not merely
// downgraded — ConnectionId is None for scheduler-invoked reducers, so that guard is more
// likely to be written wrong than to catch anything. The guard that does real work is
// "this slot has not already been closed" (i.e. no SlotResult row exists for it).
const slotSchedule = table(
  { name: "slot_schedule", scheduled: (): any => closeSlot },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    eventId: t.u64(),
    slotIndex: t.u32(),   // WHICH slot this timer closes. Do not drop it and read
                          // event.currentSlotIndex instead: a stale timer would then close
                          // whatever slot happens to be current when it fires, and the
                          // double-close guard cannot detect that. See close_slot in §2.
  }
);

// ⚠ CUT FROM THE 4h BUILD (see banner). Retained as design; openEvent is admin-called instead.
const countdownSchedule = table(
  { name: "countdown_schedule", scheduled: (): any => openEvent },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    eventId: t.u64(),
  }
);

// ⚠ CUT FROM THE 4h BUILD. Queue mode's settle fallback would need its own schedule table — a
// scheduled table binds to exactly one reducer, so it cannot share slotSchedule or
// countdownSchedule. Nine tables as designed; SEVEN in the 4h build (settle is admin-called).
const settleSchedule = table(
  { name: "settle_schedule", scheduled: (): any => settle },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    eventId: t.u64(),
  }
);

const spacetimedb = schema({
  event, slot, participant, slotSchedule,   // 4h build stops here (+ bid, allocation, slotResult)
  countdownSchedule, settleSchedule,        // ⚠ cut from the 4h build
  /*, bid, allocation, slotResult */
});
export default spacetimedb;

// The schedule row arrives as the reducer's single argument and is auto-deleted afterwards.
export const closeSlot = spacetimedb.reducer(
  { timer: slotSchedule.rowType },
  (ctx, { timer }) => {
    // invoked automatically by the scheduler; timer.eventId identifies which event's slot closed
  }
);

export const openEvent = spacetimedb.reducer(
  { timer: countdownSchedule.rowType },
  (ctx, { timer }) => { /* ... */ }
);

// One-time schedule: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + delayMicros)

export const join = spacetimedb.reducer(
  { eventId: t.u64(), displayName: t.string(), origin: t.string() },
  (ctx, { eventId, displayName, origin }) => {
    // creates Participant scoped to eventId, identity = ctx.sender,
    // handle = displayName + "-" + randomSuffix (unique),
    // walletBalance = round(randomUniform(20_000, 150_000)), hasWon = false
  }
);
```

There is no schema-level composite `UNIQUE` (single-column `.unique()`/`.primaryKey()` only —
see the `Bid` table comment in §1 and C2 in §2's `submit_bid`); multi-column lookups use a
multi-column btree index instead, declared via the table's `indexes` option.

The module's **entry file must export the schema as default**. If tables (`schema.ts`) are
split from reducers (`index.ts`), re-export it: `export { default } from './schema';`.

**The draw is a pure function, and this is a contract requirement, not a style preference.**
SpacetimeDB ships no test harness — the official approach is CLI-driven against a live
`spacetime start` instance, and the request for an isolated in-module harness
(clockworklabs/SpacetimeDB#2833) is still open, unassigned. So `drawSeed` computation and
`rank(seed, entries) → ordered ids` MUST live in a plain importable TS file taking no `ctx`,
with `close_slot` as a thin caller. Same for the inventory arithmetic. Two reasons: TC-INV-01's
≥100 shuffled permutations are milliseconds as a pure call and minutes through a live DB; and
TC-CLR-09 ("recompute the draw *outside* the module") is only meaningful if the test imports
the very function the module ran, rather than reimplementing it and proving nothing.

Tests split accordingly: `*.unit.test.ts` (vitest, pure, no server) and `*.int.test.ts`
(vitest, requires a live local instance, fresh event per test per §1b). Vitest is our choice of
driver, not a SpacetimeDB convention — there isn't one.

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
  event.adminIdentity := ctx.sender           // see "On the admin identity" below
  event.state := "created"
  event.ticketFraction := config.ticketFraction
  event.totalTickets := 0                     // not known yet
  event.ticketsRemaining := 0
  event.slotCount := (mode == "turn") ? len(config.floors) : 0
  if mode == "queue": event.ticketPrice := config.ticketPrice
  if mode == "turn":
    for i, floor in config.floors:
      insert Slot { eventId, slotIndex: i, floor,
                    baseQuota: 0, effectiveQuota: 0, filled: 0, entriesReceived: 0 }
    event.currentSlotIndex := 0
  return event.id                             // procedure, not reducer — see below
```

**On the admin identity.** The v2 draft guarded two reducers on "the admin identity" without
ever defining where that value comes from, and there was no bootstrap path to establish one.
Resolved without a new table or a chicken-and-egg problem: **whoever creates an event is that
event's admin**, recorded in `Event.adminIdentity`, and `start_countdown` checks against it.
Admin authority is therefore per-event and self-establishing.

**`create_event` and `join` are PROCEDURES, not reducers.** SpacetimeDB reducers declare
arguments only and return nothing to the caller — the client observes effects via subscription.
`spacetimedb.procedure(...)` declares both argument and return types, so it is the only shape
that can hand back a freshly-generated id. §6's `createEvent(): EventId` and
`join(): ParticipantId` are otherwise unimplementable as written.

`submit_bid` and `close_slot` **must remain reducers.** Procedures open short `ctx.withTx`
transactions rather than wrapping the whole call, and both C2's check-then-insert and the
atomic allocation+debit depend on full reducer serialization. Do not convert them for
signature convenience.

*Verify at Gate 1* that 2.8's generated TS client surfaces procedure return values as
expected. If it does not, the fallback is to keep both as reducers and have the SDK await the
committed row via its unique `handle` (§1) — but do not adopt the fallback pre-emptively.

### `start_countdown(event_id)`

Registration closes here, and this is where inventory is sized — it is the only moment at
which the participant count is both final and known.

```
guard: ctx.sender == event.adminIdentity
guard: event.state == "created"
guard: count(Participant where eventId == event.id) > 0     // E_NO_PARTICIPANTS, see §2c
effect:
  n := count(Participant where eventId == event.id)   // PER-EVENT headcount, not global
  event.participantsAtOpen := n
  event.totalTickets := round(event.ticketFraction * n)     // half away from zero, see §2c
  event.ticketsRemaining := event.totalTickets
  if mode == "turn":
    base      := floor_div(event.totalTickets, event.slotCount)
    remainder := event.totalTickets - base * event.slotCount
    for i in 0..event.slotCount-1:
      // remainder spread over the EARLIEST slots, not dumped on the last one — see §2c
      slot[i].baseQuota      := base + (i < remainder ? 1 : 0)
      slot[i].effectiveQuota := slot[i].baseQuota      // no rollover has occurred yet
  event.state := "countdown"
  schedule open_event(event.id) at now() + countdownSeconds   // 60s
```

The headcount filter is load-bearing. `count(Participant)` unqualified counts every
participant of every event, so the second event in `test:core` would size its inventory off
both populations — silently, and undetectably in any single-event test.

**Acceptance:** `sum(slot.baseQuota) == event.totalTickets` exactly, at every turnout, **and at
every point in the event's life** — `baseQuota` is never mutated after this reducer.
`sum(effectiveQuota)` deliberately exceeds `totalTickets` once any rollover has occurred; that
is the rollover working, not an overbooking bug. There is no overbooking path: quotas are
derived from inventory, and allocation is bounded by `ticketsRemaining` independently.

### `open_event(event_id)`

**4h build: admin-called.** As designed it was scheduled off `countdownSchedule`; that table is
cut, so the admin invokes it directly when the display countdown reaches zero.

```
guard: ctx.sender == event.adminIdentity   // E_NOT_ADMIN — REQUIRED now that this is
                                            // client-callable. Previously it relied on
                                            // scheduled-reducers-are-private; that protection
                                            // is gone with countdownSchedule, and without this
                                            // guard any participant could open the event early
                                            // and destroy Round 1's equal-start premise.
guard: event.state == "countdown"           // E_WRONG_STATE
effect:
  event.state := "open"
  if mode == "turn":
    event.currentSlotEndsAt := now() + W   // W = 60s
    schedule close_slot(event.id) at event.currentSlotEndsAt   // the one surviving schedule
```

Every bot still starts from the same instant: they learn `state == "open"` from one
subscription broadcast, exactly as they would have from a scheduled transition.

**On settling a queue event.** The v2 draft scheduled nothing for queue mode and nothing else
ever called `settle`, so a Round 1 event stayed `open` forever — the dashboard would never
show a final scoreboard and `test:core`'s "settle → save result → create a new event" sequence
could never advance. Queue mode now settles on **either** trigger, whichever comes first:
`ticketsRemaining` reaching 0 inside `submit_bid` (the sell-out case, which is the expected one
at 40% inventory against a bot-heavy field), or the scheduled fallback above (the case where
inventory outlasts demand). `settle` is idempotent-guarded on `event.state == "open"`, so the
fallback firing after a sell-out is a no-op.

### `join(event_id, displayName, origin) -> ParticipantId`

```
guard: event.state != "settled"
effect:
  draw := ctx.random.integerInRange(20_000, 150_000)   // module RNG, never Math.random (§2a)
  insert Participant { eventId: event_id, identity: ctx.sender, displayName,
                        handle: displayName + "-" + randomSuffix(),   // UNIQUE, see §1
                        origin,
                        initialBalance: draw,          // immutable anchor (§2b)
                        walletBalance: draw,
                        hasWon: false }
  return participant.id
```

Registration is **per event**: a participant row belongs to exactly one event, so C5's "one
ticket per participant per event" is true by construction rather than by convention, and a
person taking part in both demo rounds gets two rows with two independent wallet draws — which
is what §1b's session-scoped wallet already implies.

Joining after `start_countdown` is allowed but pointless-by-design: `totalTickets` is already
fixed, so a late joiner competes for inventory that was sized without them. This is deliberate
(the door does not slam on a straggler mid-demo) and is why the guard is on `settled` rather
than on `created`.

`ctx.sender` is recorded as `identity` for audit only — it does **not** identify the
participant, because pooled bot connections share one identity across many rows (§1, §5a).
Every subsequent call carries an explicit `participantId`.

The wallet draw is the participant's paying capacity, and it is the *only* such field — v2's
separate `ceiling` is gone (§1b). It applies identically to humans and bots: a human's entry
is gated by their real wallet in exactly the way a bot's is, and neither can enter a slot whose
floor exceeds their balance.

Called directly by a human's React client for the human row, and by each bot worker for its own
row (see §5) — same reducer, no special-cased "bot join" path in the module.

### `submit_bid(event_id, participant_id, slot_index, price)`

Single entrypoint. This branch is the entire difference between the two rounds — nothing else
about the two modes is allowed to diverge, or the comparison is no longer valid. Note that both
branches now validate `price` against a server-known value, so the two paths are structurally
identical up to the clearing rule.

**`slot_index` is a required argument, not an inferred one.** The v2 draft guarded on
`request.slotIndex` while declaring the signature `submit_bid(event_id, price)` — the value was
never passed. Without it the server can only assume `currentSlotIndex`, which means a slow
bot's stale submission silently lands in whichever slot happens to be current when it arrives,
instead of being rejected. That is precisely the failure the guard exists to prevent, so the
argument is now explicit. Queue mode passes `0`.

```
guard: event.state == "open"
guard: participant := Participant(participant_id) exists
guard: participant.eventId == event_id         // no cross-event entries
guard: participant.hasWon == false             // C5 — one ticket per participant per event

if event.mode == "queue":
    guard: slot_index == 0
    guard: price == event.ticketPrice
    guard: participant.walletBalance >= price
    guard: event.ticketsRemaining > 0           // else reject, wallet untouched
    // allocation + debit happen together, atomically, in this same reducer call
    insert Allocation { eventId, slotIndex: 0, participantId: participant_id, pricePaid: price }
    participant.walletBalance -= price
    participant.hasWon := true
    event.ticketsRemaining -= 1
    if event.ticketsRemaining == 0: call settle(event.id)   // sell-out settles immediately
    // NOTE: no Bid row is written in queue mode — the Allocation IS the record (§1)

if event.mode == "turn":
    slot := slot[event.currentSlotIndex]
    guard: slot_index == event.currentSlotIndex          // reject stale/future slot
    guard: price == slot.floor                  // an entry is an opt-in at the posted price;
                                                 // there is no bid amount to choose
    guard: participant.walletBalance >= slot.floor
    guard: no existing Bid(eventId, event.currentSlotIndex, participant_id)  // C2 —
                                                 // check-then-insert; safe ONLY because
                                                 // reducers run serially. This is why
                                                 // submit_bid must never become a procedure.
    insert Bid { eventId, slotIndex: event.currentSlotIndex, participantId: participant_id,
                 price: slot.floor, qty: 1, seq: next_seq(), state: "pending" }
    slot.entriesReceived += 1
    // no allocation or debit happens here — return only "accepted"
```

**Acceptance:**
- `ticketsRemaining` cannot go negative
- `queue` mode: allocation order == arrival order (this is the expected, undesirable baseline)
- `turn` mode: participantId + slot → max 1 entry persisted; a second attempt is rejected, not
  queued
- a participant with `hasWon == true` is rejected in both modes (C5)
- no entry is ever accepted from a participant whose wallet cannot cover the floor
- a `participantId` belonging to another event is rejected

### `close_slot(event_id)`

Engineer A's most important reducer — this is where C1 is either satisfied or violated, and
where the wallet debit must be atomic with the allocation write.

```
guard: event.state == "open" and event.mode == "turn"   // no sender guard — scheduled
                                                        // reducers are private by default (§1c)
guard: timer.slotIndex == event.currentSlotIndex        // E_STALE_TIMER — the timer names the
                                                        // slot it was scheduled for, so a
                                                        // stale row cannot close a slot it was
                                                        // never meant to. Reading
                                                        // currentSlotIndex alone would let it.
guard: no SlotResult exists for (event.id, event.currentSlotIndex)   // reject double-close;
                                                        // slot_result's existence IS the
                                                        // closed-marker (§1). `filled == 0` is
                                                        // not — a slot can close empty.

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
    if filled >= slot.effectiveQuota: entry.state = "lost"; continue
    p := participant(entry.participantId)
    if p.hasWon: entry.state = "rejected"; continue      // defensive; submit_bid already blocks
    if p.walletBalance < slot.floor: entry.state = "rejected"; continue   // see note below
    insert Allocation { eventId, slotIndex: event.currentSlotIndex,
                         participantId: entry.participantId, pricePaid: slot.floor }
    p.walletBalance -= slot.floor                  // same transaction as the write above
    p.hasWon := true                                // C5
    entry.state = "won"
    filled += 1
    event.ticketsRemaining -= 1

unfilled := slot.effectiveQuota - filled
slot.filled := filled

write SlotResult { slotIndex: event.currentSlotIndex, clearingPrice: slot.floor,
                    entriesReceived: slot.entriesReceived, allocated: filled,
                    quotaRemainingAfterRollover: unfilled,
                    drawSeed }                     // single serialized write

nextIndex := event.currentSlotIndex + 1
if nextIndex >= event.slotCount or event.ticketsRemaining == 0:
    call settle(event.id)                          // unfilled on the LAST slot is discarded,
                                                    // not rolled — there is nowhere to roll it
else:
    slot[nextIndex].effectiveQuota += unfilled     // rollover — CONFIRMED, see header.
                                                    // baseQuota is NEVER touched here; that is
                                                    // what keeps sum(baseQuota) == totalTickets
                                                    // true for the life of the event (§2)
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

**Split into two things, and the split is load-bearing.** "Called internally" is not a
condition the module can test: an internal call is a plain function call, so `ctx.sender` is
still whoever entered the outermost reducer. A single `settle` carrying an `E_NOT_ADMIN` guard
would therefore throw on the queue-mode sell-out path — participant #N calls `submit_bid`,
which calls `settle`, whose sender is the participant, not the admin — and because a throw
rolls back the whole transaction (§2a), **the final ticket purchase would fail**. The admin
check must live on the exported entry point only.

```
// PRIVATE helper. Not exported, not a reducer. No sender guard — it has no caller to check.
settleImpl(ctx, event_id):
  guard: event.state == "open"       // the idempotency guard: a second call is a NO-OP,
                                     // not an error — which is what makes the dual trigger
                                     // safe. This guard MUST NOT THROW (§2a).
  effect: event.state := "settled"
          event.endTime := now()

// PUBLIC reducer. The only thing that carries the admin check.
settle(event_id):
  guard: ctx.sender == event.adminIdentity   // E_NOT_ADMIN — REQUIRED in the 4h build:
                                             // settle is client-callable now that
                                             // settle_schedule is cut, so without this any
                                             // participant could end the round mid-flight.
  effect: settleImpl(ctx, event_id)
```

`close_slot` and `submit_bid` call **`settleImpl`**, never the reducer. Only the admin's direct
call goes through `settle`. This keeps both properties that §2a freezes: the state check is a
silent no-op on the redundant call, and a non-admin cannot end the round.

**`settle` writes no scoreboard.** The v2 draft said "write final scoreboard summary (aggregate
Allocation by participant.origin)", implying a table that appears nowhere in §1. It isn't
needed: §8's dashboard is a pure read-model over `Allocation` + `Participant` + `SlotResult`,
so the human/bot split is derived on read. A materialised copy would be a second source of
truth for a number the subscription already carries, free to drift.

Reached from three places: `close_slot` when the ladder is exhausted or inventory runs out,
and `submit_bid` in queue mode on sell-out — **both via `settleImpl`** — plus an **admin call**
through the `settle` reducer (which replaces the scheduled fallback cut from the 4h build).
`event.endTime` is written here and nowhere else — it was declared in §1 and never set by the
v2 draft.

## 2a. Error semantics

Frozen at Gate 0. Both engineers code against this table; the UI maps codes to copy and the
tests assert on codes, never on message text.

### How failure is signalled

A reducer or procedure fails by **throwing**. `SenderError` (imported from
`spacetimedb/server`) is the documented shape for caller-fault errors:
`throw new SenderError('E_ALREADY_WON')`. Throwing **rolls back the entire transaction** — this
is what makes "ticket XOR refund, never partial" structural rather than something we hand-roll,
and it is why no reducer needs compensating writes.

Consequence worth stating because two tests lean on it: TC-Q-04 and the TC-WAL-* family assert
that a rejected purchase leaves the wallet untouched "pre-write." Rollback delivers that
whether the guard runs before or after the write. We still put guards first for legibility, but
the *guarantee* comes from the transaction, not from statement order — so no test should be
written in a way that only passes if the ordering is manual.

### Two classes of failure

- **Expected rejection** — the caller did something the rules forbid. Thrown as `SenderError`
  with a stable code from the table below. These are normal traffic: a bot entering a slot it
  can't afford is the mechanism working. The UI renders them; bots swallow them and move on.
- **Invariant violation** — the module reached a state it believes impossible. Thrown as a
  plain `Error`. These must never surface to a user, and a test that *expects* one is testing
  the wrong thing. TC-CLR-12/13 are the canonical examples: assert they never fire, rather than
  exercising them.

`settleImpl`'s state check is neither. Its `event.state == "open"` check is a **no-op
condition, not an error**: queue mode settles on sell-out *and* on an admin call (§2), so a
second call is the expected path. It returns silently. This is the one guard in the module that
must not throw. The `E_NOT_ADMIN` check on the exported `settle` reducer *does* throw — that is
why the two live in different functions.

### Frozen error codes

| Reducer | Code | Guard |
|---|---|---|
| `create_event` | `E_FLOORS_EMPTY` | turn mode with no floors |
| | `E_FLOORS_NOT_INCREASING` | floors not strictly increasing — **reject, never warn** |
| | `E_TICKET_PRICE_INVALID` | queue mode, `ticketPrice <= 0` |
| | `E_FRACTION_INVALID` | `ticketFraction` outside `(0, 1]` |
| `start_countdown` | `E_NOT_ADMIN` | `ctx.sender != event.adminIdentity` |
| | `E_WRONG_STATE` | `event.state != "created"` |
| | `E_NO_PARTICIPANTS` | zero registered participants — resolves TC-EVT-12 (§2c) |
| `join` | `E_EVENT_SETTLED` | event already settled |
| | `E_HANDLE_COLLISION` | `handle` unique violation — **retryable**; the pool regenerates the suffix and calls again (§1) |
| `submit_bid` | `E_EVENT_NOT_OPEN` | `event.state != "open"` — covers both pre-open countdown and post-settle |
| | `E_UNKNOWN_PARTICIPANT` | no participant row for `participant_id` |
| | `E_WRONG_EVENT` | `participant.eventId != event_id` |
| | `E_ALREADY_WON` | C5 |
| | `E_STALE_SLOT` | `slot_index != event.currentSlotIndex` |
| | `E_PRICE_MISMATCH` | `price != ticketPrice` (queue) / `!= slot.floor` (turn) |
| | `E_INSUFFICIENT_BALANCE` | wallet below the price |
| | `E_SOLD_OUT` | queue mode, `ticketsRemaining == 0` |
| | `E_DUPLICATE_ENTRY` | C2 — an entry already exists for this participant in this slot |
| `open_event` | `E_NOT_ADMIN` | 4h build only — it is client-callable, so it must be guarded |
| | `E_WRONG_STATE` | `event.state != "countdown"` |
| `settle` | `E_NOT_ADMIN` | 4h build only. On the **exported reducer only** — `close_slot`/`submit_bid` call the private `settleImpl`, which has no sender guard. Putting this check inside `settleImpl` breaks the queue sell-out path (§2) |
| `close_slot` | `E_WRONG_STATE` | not `open`, or not turn mode |
| | `E_STALE_TIMER` | `timer.slotIndex != event.currentSlotIndex` — a schedule row outliving the slot it named |
| | `E_SLOT_ALREADY_CLOSED` | a `SlotResult` already exists for this slot |

**`open_event` and `settle` now need codes.** In the 4h build both are admin-called rather
than scheduler-invoked, so both carry `E_NOT_ADMIN` and `E_WRONG_STATE`. This is the one place
where cutting the scheduled tables *added* a guard rather than removing one: scheduled reducers
are private by default, and admin-called ones are not.

### Guard order is part of the contract

When a call violates several guards at once, the code returned depends entirely on which guard
runs first — so the order is frozen, not incidental. A participant who has already won, is
broke, *and* is aiming at a sold-out event must get `E_ALREADY_WON`, every time, or the UI
copy and the tests disagree about what happened.

Canonical order for `submit_bid`, most-fundamental first:

```
E_EVENT_NOT_OPEN → E_UNKNOWN_PARTICIPANT → E_WRONG_EVENT → E_ALREADY_WON
  → E_STALE_SLOT → E_PRICE_MISMATCH → E_INSUFFICIENT_BALANCE → E_SOLD_OUT / E_DUPLICATE_ENTRY
```

The reasoning: identity questions ("who are you, and are you even eligible?") resolve before
offer questions ("is what you're offering valid?"), which resolve before contention questions
("is there anything left?"). C5 sits high deliberately — a winner is out of the event entirely,
so their balance and the remaining inventory are both irrelevant to them. This is the same
"conjunction, not two independent checks" reasoning TC-BID-08 already applies to the turn
branch; it is stated here once for every reducer instead.

### Determinism: `ctx.random` vs. the draw

Two different random sources, and confusing them silently breaks verifiability.

- **The wallet draw uses `ctx.random`** — `ctx.random.integerInRange(20_000, 150_000)`, the
  module's own deterministic RNG. Never `Math.random()`, which is non-replayable and would make
  module execution non-deterministic.
- **The allocation draw MUST NOT use `ctx.random`.** It is a pure function of `drawSeed`, which
  is a pure function of committed state (§1c). If `close_slot` reaches for `ctx.random`, then
  TC-CLR-09 and TC-INV-11 — "recompute the draw outside the module and match exactly" — become
  impossible, because a third party has no access to the module's RNG stream. The entire
  verifiability claim rests on this distinction.

`now()` throughout §2 means `ctx.timestamp`, which is fixed for the duration of a reducer call
and identical on replay. Never `Date.now()`.

## 2b. Wallet-debit contract

Frozen at Gate 0. This is the money path; it is the one part of the module where "probably
fine" is not an acceptable standard.

### The rule, in one line

**A debit happens if and only if an allocation happens, in the same reducer call, for exactly
the slot's uniform price.** There is no other way money moves.

Unpacked into the five things that follow from it:

1. **Debit is co-transactional with allocation.** `submit_bid` (queue) and `close_slot` (turn)
   each write the `Allocation` row and decrement `walletBalance` inside one reducer call.
   Never two calls, never a follow-up reducer, never a saga. A throw anywhere in between rolls
   both back (§2a), which is what makes "ticket XOR nothing" structural.
2. **The amount is the slot's uniform price** — `ticketPrice` in queue mode, `slot.floor` in
   turn mode — and it equals the `pricePaid` written on the `Allocation`. Under pay-the-floor
   there is no per-winner price, so a debit that differs from the row next to it is a bug by
   definition.
3. **A losing entry costs nothing.** No partial debit, no fee, no rounding residue. The balance
   is byte-identical before and after (TC-WAL-02) — which holds trivially, because a loser's
   path touches no wallet field at all.
4. **There is no reservation, hold, escrow, pending-debit or rollback state** anywhere in the
   schema (TC-WAL-05). Grep-able: no column named `reserved`, `held`, `pending`, `locked`.
   Serialized reducers make holds unnecessary — nothing can interleave between the balance
   check and the debit, which is the only reason a hold would exist.
5. **The balance can never go negative.** Guarded on entry (`E_INSUFFICIENT_BALANCE`) and
   again defensively at clearing (§2's mid-close note). Under C5 the second is unreachable, and
   a test asserting it never fires is worth more than one exercising it.

### Reconciliation, and why `initialBalance` exists

The v2 draft asked for TC-WAL-04 — *"no allocation without a matching debit or vice versa"* —
without giving anything to reconcile against. There is no ledger table, `walletBalance` is
mutated in place, and the starting value was a random draw that nothing recorded. The test was
unwritable: no quantity in the schema could confirm a debit had occurred, let alone that it
matched an allocation.

`Participant.initialBalance` (§1) closes that with one immutable column. The invariant becomes
a single expression, sweepable across every participant after every test:

```
initialBalance - walletBalance == sum(pricePaid) over Allocation for that participant
```

and, because C5 caps a participant at one ticket per event, the right-hand side is always
either `0` or a single slot price. So the whole money model reduces to a per-row assertion with
two possible outcomes — which is the point of C5 doing double duty here.

This also hands §8's dashboard "amount spent" for free, with no second write path.

### Client-side rules

`walletBalance` is server-authoritative and read only through a subscription. **No client ever
performs arithmetic on it** — not the phone view, not the dashboard, not a bot. A client that
computes `balance - price` to predict a post-purchase figure will eventually disagree with the
module, and TC-WAL-10 exists precisely to catch that. Render the subscribed row; if it looks
stale, that is a subscription bug to fix, never a number to compute locally.

### Out of scope, deliberately

No top-up, no refund path, no persistence across a demo reset (§1b). Money only ever moves in
one direction, once, per participant per event. A "reset demo" creates new participants with
new draws rather than re-crediting existing rows — which is also why `initialBalance` can be
immutable without needing a migration story.

## 2c. Derived-inventory rule

Frozen at Gate 0. Inventory is a *function of turnout*, computed once, at `start_countdown`.
Nothing supplies it, nothing recomputes it, and no other parameter may depend on turnout
(§1a).

```
totalTickets   := round(ticketFraction × participants_in_this_event)
base           := floor(totalTickets / slotCount)
remainder      := totalTickets − base × slotCount
baseQuota[i]   := base + (i < remainder ? 1 : 0)
```

### The four things that were underspecified

**1. `round` is half-away-from-zero** (JS `Math.round`; `0.5 → 1`). Not banker's rounding.
Worth pinning because **no existing test exercises it**: TC-EVT-10's populations
(250/500/750/1250 × 0.40) all divide exactly, so a wrong rounding mode would ship green. Any
odd headcount hits it — 253 participants → `101.2 → 101`.

**2. The remainder spreads over the earliest slots, not the last one.** §1a's original
"remainder is added to the final slot" is safe at demo scale and pathological below it. At 10
participants: `totalTickets = 4`, `base = 0`, and the old rule gives slots 0–3 a quota of zero
while slot 4 receives all four — the entire event sells at the top floor (₹55,000), where most
of the wallet distribution doesn't qualify. Slots 1–4 clear empty and the demo looks broken.

This triggers at any turnout under ~13 participants, which is precisely the range unit tests,
local runs and rehearsals live in. The two rules are identical whenever `slotCount` divides
`totalTickets` — including every demo-scale number — so this costs nothing and removes a
small-N cliff. It also front-loads inventory into the cheap slots where the whole field still
qualifies, which is the shape the narrative wants anyway.

**3. Zero participants is rejected** (`E_NO_PARTICIPANTS`), which settles the escalation
`saksham.md` Gate 2 flags as "LLD doesn't say whether to reject or allow." Allowing it yields
a technically-correct event with `totalTickets == 0` that opens, sells nothing, and settles —
a dead event on a projector with no explanation. Rejecting gives the admin immediate feedback
that they started the countdown before anyone joined, which is the only realistic way this
happens. Resolved here rather than left for Gate 2.

**4. `participantsAtOpen` is snapshotted, not recounted.** The name is slightly wrong — it is
the headcount at *countdown*, not at open — but it is load-bearing in §8's dashboard contract,
so the name stays and the semantics are documented instead. Late joins are permitted after
sizing (§2 `join`) and deliberately do **not** resize inventory: a straggler competes for
inventory sized without them. Any test asserting TC-EVT-10 must read the snapshot, never
re-count participants at assertion time, or it will fail whenever a bot registers late.

### Why `ticketsRemaining` cannot go negative

Not a guard — a conservation property, and worth stating so nobody adds a defensive check that
hides a real bug. Total allocable capacity across all slots is exactly `totalTickets`:
`sum(baseQuota) == totalTickets` by construction above, and rollover moves *only* the unfilled
portion of a slot's `effectiveQuota` forward, neither creating nor destroying any. So
`sum(filled)` over the whole event is bounded by `totalTickets` regardless of how entries
distribute across slots. Queue mode has no rollover and guards `ticketsRemaining > 0` directly.

The corollary that matters for testing: `sum(baseQuota) == totalTickets` holds for the entire
life of the event, while `sum(effectiveQuota)` exceeds it as soon as anything rolls forward.
Assert against `baseQuota` (TC-EVT-09). Asserting against `effectiveQuota` will pass before the
first close and fail after it.

## 3. Turn state machine

```
CREATED → COUNTDOWN → OPEN → (queue: single race) or (turn: slot 0 → slot 1 → ... → slot N-1) → SETTLED
             ▲
      inventory sized here (start_countdown): totalTickets = round(fraction × participants)
```

Reject explicitly, don't silently ignore. Codes are frozen in §2a:

| Invalid transition | Guard that catches it | Code |
|---|---|---|
| bid before `open` (including during `countdown`) | `event.state == "open"` check in `submit_bid` | `E_EVENT_NOT_OPEN` |
| bid after `settle` | same guard — `state` is no longer `"open"` | `E_EVENT_NOT_OPEN` |
| entry from a participant who already won | `participant.hasWon == false` guard (C5) | `E_ALREADY_WON` |
| entry using another event's participant | `participant.eventId == event_id` guard | `E_WRONG_EVENT` |
| `close_slot` called twice on same slot | no `SlotResult` exists for the slot | `E_SLOT_ALREADY_CLOSED` |
| `settle` called twice | `settleImpl`'s `event.state == "open"` — **silent no-op, not an error** (§2a) | — |
| `open_event` / `settle` by a non-admin | `ctx.sender == event.adminIdentity` (4h build) | `E_NOT_ADMIN` |
| bid for a stale or future slot | `slot_index` match check in `submit_bid` | `E_STALE_SLOT` |
| turn-mode price != current slot floor | `price == slot.floor` guard in `submit_bid` | `E_PRICE_MISMATCH` |
| wallet cannot cover the floor | balance guard in `submit_bid` | `E_INSUFFICIENT_BALANCE` |
| `start_countdown` on an already-sized event | `event.state == "created"` guard | `E_WRONG_STATE` |
| `start_countdown` by a non-admin | `ctx.sender == event.adminIdentity` guard | `E_NOT_ADMIN` |

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
                                             t_open + random(0, δ), δ = 500ms; turn: per §5b)
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

**Identity is per-connection; participants are not.** Pooling connections means one
SpacetimeDB `Identity` backs many bots, so `Participant` CANNOT be keyed on `identity` — it is
keyed on an autoInc `id`, with `identity` demoted to a plain indexed column recording which
connection created the row (§1). Reducers therefore take an explicit `participantId` rather
than deriving the actor from `ctx.sender`.

The tradeoff, recorded deliberately: any connection can then act on behalf of any participant.
For a demo with no adversary this is acceptable, and it actively *preserves* the property above
— a bot's `submit_bid` and a human's are now identical in shape, so the module genuinely cannot
distinguish them. The alternative (one connection per bot, giving each a real identity) is
exactly what this section rules out as unsurvivable at 1,000 bots.

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
  join(eventId: EventId, displayName: string,
       origin: "human" | "bot"): Promise<ParticipantId>   // procedure — returns the new row's id
  listEvents(): Event[]
  createEvent(config): Promise<EventId>                    // procedure; admin only
  startCountdown(eventId: EventId): void                   // admin only
  submitBid(eventId: EventId, participantId: ParticipantId,
            slotIndex: number, price: number): void
  subscribeEvent(eventId: EventId, cb: (e: Event) => void): Unsubscribe
  subscribeAllocations(eventId: EventId, cb: (a: Allocation) => void): Unsubscribe
  subscribeSlotResults(eventId: EventId, cb: (r: SlotResult) => void): Unsubscribe
  getWalletBalance(participantId: ParticipantId): number
}
```

Four signature changes from the v2 draft, each forced by §1–§2 rather than by taste:
`join` takes an `eventId` (registration is per-event) and returns a `ParticipantId` rather than
an `Identity` (one pooled identity backs many participants); `submitBid` carries an explicit
`participantId` and `slotIndex` (the server can no longer derive the actor from `ctx.sender`,
and the stale-slot guard needs a value to compare against); `getWalletBalance` needs to know
*whose* balance, since one connection may hold hundreds. `join`/`createEvent` are `Promise`-
returning because they are procedures — reducers cannot return values at all.

React usage is a thin context provider around one `FairDropClient` + `DbConnection` instance,
with components reading table state via a hook (e.g. `useTable(Event)` /
`useTable(SlotResult)`) that subscribes on mount and re-renders on row events — not manual
`useEffect` wiring duplicated across the event list, phone view, and admin dashboard.

This is the seam: Engineer B must never need to know how Engineer A implements allocation or
wallet debit — only `command in → authoritative state change → subscription event out`.

**Ids are `u64` → `bigint`, and `bigint` does not survive `JSON.stringify`.** The SDK owns the
bigint↔string conversion at its boundary: `EventId`/`ParticipantId`/`BidId` are `bigint` in
every signature above, and any JSON that crosses a wire (the `/onboard` response §9, mock
fixtures, test snapshots) carries them as decimal strings. No consumer does this conversion
itself — that is the drift this seam exists to prevent.

Mock fixture for parallel development before the real module exists (note `eventId` is the
string form of a `bigint`, not an opaque slug — the earlier `"evt-1"` was wrong):
```json
{ "type": "slot_result", "eventId": "1", "slotIndex": 2,
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
3. **Delay sweep.** Sweep bot reaction delay δ (default 500ms) against a fixed human delay
   distribution: the
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
