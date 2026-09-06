/**
 * Fair Drop — module root. Schema + lifecycle (Gate 1b).
 *
 * The authority for every shape here is `docs/CONTRACT.md`; `LLD.md` §1–§2 carries the
 * reasoning. Where this file and the LLD disagree, the CONTRACT wins (it says so itself).
 *
 * Conventions, all four load-bearing and all four wrong in the pre-Gate-0 draft:
 *   - table names snake_case, columns camelCase
 *   - `t.option(x)`, never `.optional()`
 *   - `scheduled:` lives on the TABLE, not on the reducer
 *   - `t.u64()` is `bigint`
 *
 * `.primaryKey().autoInc()` does NOT make the column optional at insert — pass `id: 0n` and
 * read the assigned id off the returned row (CONTRACT §2, correction 5).
 *
 * The allocation draw and the inventory arithmetic live in `src/pure/` as plain TS with no
 * `ctx`. That split is a contract requirement, not a style choice: `spacetimedb/server` pulls
 * `spacetime:sys@2.0`, which vitest cannot resolve, so anything in this file is untestable
 * in-process and everything in `pure/` is testable in milliseconds.
 */

import { schema, table, t, SenderError, ScheduleAt } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
// Explicit `.ts` extensions, consistently, in every intra-`src/` import. Not a style choice:
// `scripts/smoke.sh` and `tests/verifier-parity.unit.test.ts` load these modules directly with
// `node --experimental-strip-types`, which does NOT resolve extensionless relative specifiers.
// `draw.ts` already needed the extension for that reason; having only one file carry it was
// the inconsistency. `allowImportingTsExtensions` in tsconfig.json is what permits this.
import { sizeInventory, effectiveQuota, InventoryError } from './pure/inventory.ts';
import { isEmail } from './pure/email.ts';
import { deriveDrawSeed, rankEntries, type Entry } from './pure/draw.ts';

/** Countdown, still 60s (LLD §1a) — and unlike the slot window it binds nothing: the admin
 *  calls `open_event` by hand, so this only feeds the display timer and this log line. */
const COUNTDOWN_SECONDS = 60;

/**
 * Per-slot window. 60s is LLD §1a's number and remains the DEFAULT, but it is no longer a
 * constant: it is stored per event (`event.slotWindowSeconds`) and chosen at `create_event`.
 *
 * The reason is rehearsal cost, not stage flexibility. Five slots at 60s is five minutes per
 * turn-mode run, which is the whole rehearsal budget — so a full turn round gets exercised far
 * less often than the queue round it is supposed to be compared against. At 10s the same run
 * takes 50 seconds and can be repeated between changes. On stage it stays 60.
 *
 * Bounded on both ends. Below `MIN` the window is shorter than a person's reaction time, so the
 * draw would be measuring who had the page already open — the exact failure turn mode exists to
 * remove. Above `MAX` a single slot outlives any plausible demo slot and, more practically, an
 * abandoned event would keep a scheduled row live for hours.
 */
const DEFAULT_SLOT_WINDOW_SECONDS = 60;
const MIN_SLOT_WINDOW_SECONDS = 5;
const MAX_SLOT_WINDOW_SECONDS = 600;

// ---------------------------------------------------------------------------------------
// Tables — seven. `countdown_schedule` and `settle_schedule` are cut in the 4h re-plan;
// the admin calls `open_event` and `settle` directly. `slot_schedule` survives because turn
// mode genuinely needs slots to auto-advance. Adding the other two back is additive.
// ---------------------------------------------------------------------------------------

const event = table(
  { name: 'event', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    /** `queue` | `turn` — `t.string()`, not `t.enum()` (CONTRACT §2). */
    mode: t.string(),
    /** `created` | `countdown` | `open` | `settled`. */
    state: t.string(),
    /** Whoever creates the event is its admin. Self-establishing, no bootstrap table. */
    adminIdentity: t.identity().index('btree'),

    ticketFraction: t.f64(),
    /** 0 until `start_countdown` derives it from the per-event headcount. */
    totalTickets: t.u32(),
    ticketsRemaining: t.u32(),
    /** Headcount snapshot the inventory was derived from. Late joins do not resize it. */
    participantsAtOpen: t.u32(),
    /** `= floors.length` at create; 0 for queue. Read by `start_countdown` and `close_slot`. */
    slotCount: t.u32(),

    startTime: t.timestamp(),
    /** Written only by `settle`. */
    endTime: t.option(t.timestamp()),

    /** Queue mode only. */
    ticketPrice: t.option(t.f64()),

    /**
     * Turn mode only — seconds each slot stays open, chosen at `create_event` and never
     * mutated. Stored per event rather than read from a module constant so a rehearsal can run
     * 10s slots and the stage can run 60s ones from the same published module. 0 in queue mode.
     */
    slotWindowSeconds: t.u32(),

    /** Turn mode only. */
    currentSlotIndex: t.u32(),
    currentSlotEndsAt: t.option(t.timestamp()),
  }
);

const slot = table(
  {
    name: 'slot',
    public: true,
    indexes: [{ accessor: 'by_event_slot', algorithm: 'btree', columns: ['eventId', 'slotIndex'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    eventId: t.u64(),
    slotIndex: t.u32(),
    /** The MINIMUM bid for this slot. Not a price anyone necessarily pays — under v4's blind
     *  bidding a winner pays their own bid, which is `>= floor`. */
    floor: t.f64(),
    /** Set once at `start_countdown`, NEVER mutated. `sum(baseQuota) == totalTickets` always. */
    baseQuota: t.u32(),
    /** `baseQuota` + rollover. Deliberately exceeds `totalTickets` once anything rolls forward. */
    effectiveQuota: t.u32(),
    filled: t.u32(),
    entriesReceived: t.u32(),
  }
);

const participant = table(
  {
    name: 'participant',
    public: true,
    indexes: [{ accessor: 'by_event', algorithm: 'btree', columns: ['eventId'] }],
  },
  {
    /** PK — NOT `identity`. One pooled connection backs many participant rows. */
    id: t.u64().primaryKey().autoInc(),
    /** Registration is PER EVENT, which is what makes C5 true by construction. */
    eventId: t.u64(),
    /** Indexed, NOT unique — verified with three rows from one identity (CONTRACT §10). */
    identity: t.identity().index('btree'),
    /** UNIQUE. Makes no-collisions a schema guarantee rather than a probabilistic hope. */
    handle: t.string().unique(),
    /** As typed, NOT unique — live audiences collide on names. */
    displayName: t.string(),
    /** Normalised (trimmed, lowercased) contact address. `''` for bots, which have none.
     *  NOT unique: one person may join two events, and a household may share an address. */
    email: t.string(),
    /** `human` | `bot` — first-class, because it drives the dashboard split. */
    origin: t.string(),
    /** The wallet draw as issued. NEVER mutated; the reconciliation anchor (CONTRACT §5). */
    initialBalance: t.f64(),
    walletBalance: t.f64(),
    /** C5 — set true on allocation, blocks entry in every later slot. */
    hasWon: t.bool(),
  }
);

const bid = table(
  {
    name: 'bid',
    public: true,
    indexes: [{ accessor: 'by_event_slot', algorithm: 'btree', columns: ['eventId', 'slotIndex'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    eventId: t.u64(),
    /** TURN MODE ONLY. Queue mode writes no `bid` rows at all. */
    slotIndex: t.u32(),
    participantId: t.u64(),
    price: t.f64(),
    /** Fixed at 1 for this build. */
    qty: t.u32(),
    /**
     * Server-assigned arrival sequence, audit only. **MUST NOT be read by the turn allocator.**
     * DO NOT DELETE as redundant with `id`: TC-INV-03 proves C1 by randomising every `seq`
     * before `close_slot` and asserting the outcome is unchanged. That proof cannot run against
     * `id`, which is the PK and a draw-hash input. `seq` is a deliberate decoy that makes C1
     * mechanically falsifiable rather than merely asserted.
     */
    seq: t.u64(),
    /** `pending` | `won` | `lost` | `rejected`. */
    state: t.string(),
  }
);

const allocation = table(
  {
    name: 'allocation',
    public: true,
    indexes: [{ accessor: 'by_event_slot', algorithm: 'btree', columns: ['eventId', 'slotIndex'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    eventId: t.u64(),
    slotIndex: t.u32(),
    participantId: t.u64(),
    /** `= slot.floor` (turn) or `ticketPrice` (queue). Uniform per slot, by construction. */
    pricePaid: t.f64(),
  }
);

const slotResult = table(
  {
    name: 'slot_result',
    public: true,
    indexes: [{ accessor: 'by_event_slot', algorithm: 'btree', columns: ['eventId', 'slotIndex'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    eventId: t.u64(),
    slotIndex: t.u32(),
    /**
     * The LOWEST winning bid in this slot — what it took to get in. Under blind bidding each
     * winner pays their own bid, so there is no single price everyone paid; this is a fact
     * about the slot, not a charge. `0` when the slot drew no entries.
     *
     * Replaces v3's `clearingPrice`, which could be one column only because pay-the-floor made
     * the floor and the price paid the same number.
     */
    cutoffPrice: t.f64(),
    entriesReceived: t.u32(),
    allocated: t.u32(),
    quotaRemainingAfterRollover: t.u32(),
    /** Published so a third party can recompute the winner set from committed state. */
    drawSeed: t.string(),
  }
);

/**
 * The one surviving scheduled table.
 *
 * `slotIndex` is carried on the row on purpose. Do NOT drop it and read
 * `event.currentSlotIndex` instead: a stale row would then close whatever slot happens to be
 * current, and the double-close guard cannot see that (`E_STALE_TIMER`).
 */
const slotSchedule = table(
  { name: 'slot_schedule', scheduled: (): any => closeSlot },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    eventId: t.u64(),
    slotIndex: t.u32(),
  }
);

const spacetimedb = schema({
  event,
  slot,
  participant,
  bid,
  allocation,
  slotResult,
  slotSchedule,
});
export default spacetimedb;

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

type Ctx = { db: any; sender: any; timestamp: any; random: any };

function loadEvent(ctx: Ctx, eventId: bigint) {
  const row = ctx.db.event.id.find(eventId);
  // `find` returns null, not undefined — `=== undefined` would never fire and the
  // next property read would panic instead of returning a clean sender error.
  if (row == null) throw new SenderError('E_UNKNOWN_EVENT');
  return row;
}

function requireAdmin(ctx: Ctx, ev: { adminIdentity: any }) {
  if (!ctx.sender.isEqual(ev.adminIdentity)) throw new SenderError('E_NOT_ADMIN');
}

/** Row for `(eventId, slotIndex)` via the named btree — there is no composite unique. */
function findSlot(ctx: Ctx, eventId: bigint, slotIndex: number) {
  for (const s of ctx.db.slot.by_event_slot.filter([eventId, slotIndex])) return s;
  return null;
}

/**
 * Next arrival sequence for this event. Audit only — the turn allocator MUST NOT read `seq`.
 *
 * Per-event and monotonic (TC-SCH-05). It exists so C1 is mechanically falsifiable: TC-INV-03
 * randomises every `seq` before `close_slot` and asserts the outcome is unchanged, a proof that
 * cannot run against `id`, because `id` is the PK and a draw-hash input.
 */
function nextSeq(ctx: Ctx, eventId: bigint): bigint {
  let n = 0n;
  for (const _b of ctx.db.bid.by_event_slot.filter(eventId)) n++;
  return n + 1n;
}


/**
 * Seconds → a Timestamp, derived from `ctx.timestamp` and never `Date.now()` (CONTRACT §4).
 *
 * `Timestamp` has no arithmetic helper — there is no `addMicros`. Build a new one from
 * `microsSinceUnixEpoch`; the class is exported from the package root, while `ScheduleAt`
 * comes from `/server`.
 */
function secondsFrom(ts: Timestamp, seconds: number): Timestamp {
  return new Timestamp(ts.microsSinceUnixEpoch + BigInt(seconds) * 1_000_000n);
}

// ---------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------

export const init = spacetimedb.init(_ctx => {
  // Nothing to seed: an event establishes its own admin at create_event.
});

export const onConnect = spacetimedb.clientConnected(_ctx => {});
export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

/**
 * `create_event` — PROCEDURE, because it must hand back the generated id.
 *
 * Verified at Gate 0 that procedures return values to the caller (CONTRACT §10), so the
 * reducer-plus-await-by-handle fallback is not needed.
 *
 * There is no `totalTickets` argument: inventory is DERIVED at `start_countdown`, the only
 * moment when the participant count is both final and known.
 */
export const createEvent = spacetimedb.procedure(
  {
    name: t.string(),
    mode: t.string(),
    ticketFraction: t.f64(),
    ticketPrice: t.f64(),
    floors: t.array(t.f64()),
    /** Turn mode only; pass 0 in queue mode, or to take the 60s default. */
    slotWindowSeconds: t.u32(),
  },
  t.u64(),
  (ctx, { name, mode, ticketFraction, ticketPrice, floors, slotWindowSeconds }) => {
    if (mode !== 'queue' && mode !== 'turn') throw new SenderError('E_MODE_INVALID');
    if (!(ticketFraction > 0 && ticketFraction <= 1)) throw new SenderError('E_FRACTION_INVALID');

    if (mode === 'turn') {
      if (floors.length === 0) throw new SenderError('E_FLOORS_EMPTY');
      // Reject, do not warn. A non-increasing ladder means a later slot is
      // cheaper than an earlier one, and every remaining participant would rationally skip
      // ahead to it — which quietly dismantles the mechanism the demo is about.
      for (let i = 1; i < floors.length; i++) {
        if (floors[i] <= floors[i - 1]) throw new SenderError('E_FLOORS_NOT_INCREASING');
      }
      // 0 means "unspecified" and takes the default, so an existing caller that has no opinion
      // about the window keeps the 60s it already had. Any other out-of-range value is a typo
      // worth rejecting rather than silently clamping — a run at the wrong slot length looks
      // like a working run and its timings are quietly meaningless.
      if (
        slotWindowSeconds !== 0 &&
        (slotWindowSeconds < MIN_SLOT_WINDOW_SECONDS || slotWindowSeconds > MAX_SLOT_WINDOW_SECONDS)
      ) {
        throw new SenderError('E_SLOT_WINDOW_INVALID');
      }
    } else if (!(ticketPrice > 0)) {
      throw new SenderError('E_TICKET_PRICE_INVALID');
    }

    return ctx.withTx((tx: any) => {
      const row = tx.db.event.insert({
        id: 0n,
        name,
        mode,
        state: 'created',
        adminIdentity: ctx.sender,
        ticketFraction,
        totalTickets: 0,
        ticketsRemaining: 0,
        participantsAtOpen: 0,
        slotCount: mode === 'turn' ? floors.length : 0,
        slotWindowSeconds:
          mode === 'turn' ? slotWindowSeconds || DEFAULT_SLOT_WINDOW_SECONDS : 0,
        startTime: ctx.timestamp,
        endTime: undefined,
        ticketPrice: mode === 'queue' ? ticketPrice : undefined,
        currentSlotIndex: 0,
        currentSlotEndsAt: undefined,
      });

      if (mode === 'turn') {
        for (let i = 0; i < floors.length; i++) {
          tx.db.slot.insert({
            id: 0n,
            eventId: row.id,
            slotIndex: i,
            floor: floors[i],
            baseQuota: 0,
            effectiveQuota: 0,
            filled: 0,
            entriesReceived: 0,
          });
        }
      }
      return row.id;
    });
  }
);

/**
 * `join` — PROCEDURE, returns the ParticipantId.
 *
 * `ctx.sender` is recorded for audit only; it does NOT identify the participant, because one
 * connection backs many rows. Every later call carries an explicit `participantId`.
 *
 * Joining after `start_countdown` is allowed but pointless by design — inventory is already
 * fixed. The guard is on `settled` rather than `created` so the door does not slam on a
 * straggler mid-demo.
 */
export const join = spacetimedb.procedure(
  { eventId: t.u64(), displayName: t.string(), email: t.string(), origin: t.string() },
  t.u64(),
  (ctx, { eventId, displayName, email, origin }) => {
    if (origin !== 'human' && origin !== 'bot') throw new SenderError('E_ORIGIN_INVALID');

    // Normalised HERE, not on the client: the bot driver, the CLI and the browser all call this
    // procedure, and a row's address has to mean the same thing whichever one wrote it.
    const contact = email.trim().toLowerCase();
    // Bots have no address and must not be forced to invent one; a human without a valid one is
    // rejected, because the address is the only way to reach a winner after the room empties.
    if (origin === 'human' && !isEmail(contact)) throw new SenderError('E_EMAIL_INVALID');

    return ctx.withTx((tx: any) => {
      const ev = tx.db.event.id.find(eventId);
      if (ev == null) throw new SenderError('E_UNKNOWN_EVENT');
      if (ev.state === 'settled') throw new SenderError('E_EVENT_SETTLED');

      // Module RNG, never Math.random — the wallet draw must be replayable. Contrast the
      // allocation draw, which must never touch ctx.random at all (CONTRACT §4).
      const draw = ctx.random.integerInRange(20_000, 150_000);
      // 32 bits, not 16. `handle` is UNIQUE GLOBALLY while participants are per-event, so the
      // birthday space is every row the instance has ever held, not this event's headcount.
      // At 16 bits and 40 bots sharing a displayName that is a ~1% collision per rehearsal,
      // rising across rehearsals that do not wipe. Scoping the handle by `eventId` as well
      // confines a collision to one event and one name.
      const suffix = ctx.random.integerInRange(0, 0xffffffff).toString(16).padStart(8, '0');
      const handle = `${eventId}-${displayName}-${suffix}`;

      // CHECK-THEN-INSERT, not try/catch. A duplicate insert does throw and roll back
      // (CONTRACT §10), but the error it raises is the host's constraint violation, NOT
      // `E_HANDLE_COLLISION` — so a bot pool matching on the documented code would never
      // match, and the DEMO-RECIPE line telling the operator to grep for it in `spacetime
      // logs` would never fire. Safe for the same reason C2's check-then-insert is safe:
      // reducers serialize. This is what makes the code in CONTRACT §9 real.
      if (tx.db.participant.handle.find(handle) != null) {
        throw new SenderError('E_HANDLE_COLLISION');
      }

      const row = tx.db.participant.insert({
        id: 0n,
        eventId,
        identity: ctx.sender,
        handle,
        displayName,
        email: contact,
        origin,
        initialBalance: draw,
        walletBalance: draw,
        hasWon: false,
      });
      return row.id;
    });
  }
);

/**
 * `start_countdown` — registration closes, and inventory is sized.
 *
 * A thin caller over `sizeInventory` in `src/pure/inventory.ts`. The arithmetic lives there
 * because that is the only place it can be tested.
 */
export const startCountdown = spacetimedb.reducer(
  { eventId: t.u64() },
  (ctx, { eventId }) => {
    const ev = loadEvent(ctx as any, eventId);
    requireAdmin(ctx as any, ev);
    if (ev.state !== 'created') throw new SenderError('E_WRONG_STATE');

    // PER-EVENT headcount. An unqualified count would size the second demo event off both
    // populations — silently, and undetectably in any single-event test.
    let n = 0;
    for (const _p of ctx.db.participant.by_event.filter(eventId)) n++;

    let inventory;
    try {
      inventory = sizeInventory(n, ev.ticketFraction, ev.slotCount);
    } catch (e) {
      // The pure module speaks in codes; map them onto the sender-facing error.
      if (e instanceof InventoryError) throw new SenderError(e.code);
      throw e;
    }

    ctx.db.event.id.update({
      ...ev,
      participantsAtOpen: n,
      totalTickets: inventory.totalTickets,
      ticketsRemaining: inventory.totalTickets,
      state: 'countdown',
    });

    if (ev.mode === 'turn') {
      for (const s of ctx.db.slot.by_event_slot.filter(eventId)) {
        const quota = inventory.baseQuota[s.slotIndex];
        // effectiveQuota == baseQuota here: no rollover has occurred yet.
        ctx.db.slot.id.update({ ...s, baseQuota: quota, effectiveQuota: quota });
      }
    }

    // No countdown_schedule in the 4h scope — the 60s is a display timer and the admin calls
    // open_event. Every bot still starts from the same instant, because they all learn
    // `state == "open"` from the same subscription broadcast.
    console.info(
      `start_countdown: event ${eventId}, ${n} participants, ${inventory.totalTickets} tickets, ` +
        `quotas [${inventory.baseQuota.join(',')}], open in ${COUNTDOWN_SECONDS}s`
    );
  }
);

/**
 * `open_event` — admin-called in the 4h scope (designed as scheduled; `countdown_schedule` cut).
 *
 * The `E_NOT_ADMIN` guard is REQUIRED precisely because of that cut: this became
 * client-callable and lost the scheduled-reducers-are-private protection it relied on. Without
 * it any participant could open the event early and destroy Round 1's equal-start premise.
 */
export const openEvent = spacetimedb.reducer({ eventId: t.u64() }, (ctx, { eventId }) => {
  const ev = loadEvent(ctx as any, eventId);
  requireAdmin(ctx as any, ev);
  if (ev.state !== 'countdown') throw new SenderError('E_WRONG_STATE');

  if (ev.mode === 'turn') {
    const endsAt = secondsFrom(ctx.timestamp, ev.slotWindowSeconds);
    ctx.db.event.id.update({ ...ev, state: 'open', currentSlotEndsAt: endsAt });
    ctx.db.slotSchedule.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(endsAt.microsSinceUnixEpoch),
      eventId,
      slotIndex: ev.currentSlotIndex,
    });
  } else {
    ctx.db.event.id.update({ ...ev, state: 'open' });
  }
});

/**
 * PRIVATE. Not exported, not a reducer, and deliberately carries NO sender guard.
 *
 * The `state == "open"` check is a silent NO-OP, not an error. Queue mode settles on sell-out
 * *and* on an admin call, so a redundant second call is the normal case — this is the one
 * guard in the module that must not throw.
 *
 * DO NOT merge this with `settle` below. "Called internally" is not a condition the module can
 * test: an internal call is a plain function call, so `ctx.sender` is still the outermost
 * caller. A single guarded `settle` would throw on the queue sell-out path — participant #N
 * calls `submit_bid`, which calls settle, whose sender is the participant, not the admin — and
 * because a throw rolls back the whole transaction, the final ticket purchase would fail.
 * That is the one case this split exists to protect, and it fails nowhere else.
 */
function settleImpl(ctx: Ctx, eventId: bigint): void {
  const ev = ctx.db.event.id.find(eventId);
  if (ev == null) return;
  if (ev.state !== 'open') return; // no-op, NOT an error
  ctx.db.event.id.update({ ...ev, state: 'settled', endTime: ctx.timestamp });
}

/**
 * PUBLIC `settle` — the only thing carrying the admin check.
 *
 * Required in the 4h build: `settle_schedule` is cut, so this is client-callable and without
 * the guard any participant could end the round mid-flight.
 */
export const settle = spacetimedb.reducer({ eventId: t.u64() }, (ctx, { eventId }) => {
  const ev = loadEvent(ctx as any, eventId);
  requireAdmin(ctx as any, ev);
  settleImpl(ctx as any, eventId);
});

/**
 * `submit_bid` — the single entrypoint, and the ONE place the two rounds diverge.
 *
 * Nothing else about the two modes is allowed to differ, or the comparison the whole demo
 * rests on stops being valid. Both branches validate `price` against a server-known value, so
 * the paths are structurally identical right up to the clearing rule.
 *
 * **Must stay a reducer, never a procedure.** Procedures open short `ctx.withTx` transactions
 * rather than wrapping the whole call; C2's check-then-insert and the atomic allocation+debit
 * both depend on full reducer serialization.
 *
 * **`slotIndex` is an explicit argument, not inferred.** Inferring `currentSlotIndex` would let
 * a slow bot's stale submission silently land in whichever slot happens to be current when it
 * arrives — precisely the failure `E_STALE_SLOT` exists to prevent. Queue mode passes 0.
 *
 * Guard order is frozen (CONTRACT §4) and MUST NOT be reordered for convenience — the code a
 * caller receives depends entirely on which guard runs first:
 *
 *   E_EVENT_NOT_OPEN -> E_UNKNOWN_PARTICIPANT -> E_WRONG_EVENT -> E_ALREADY_WON
 *     -> E_STALE_SLOT -> E_PRICE_MISMATCH -> E_INSUFFICIENT_BALANCE
 *     -> E_SOLD_OUT / E_DUPLICATE_ENTRY
 *
 * Identity questions before offer questions before contention questions. C5 sits high because a
 * winner is out of the event entirely, so their balance and the remaining inventory are moot.
 */
export const submitBid = spacetimedb.reducer(
  { eventId: t.u64(), participantId: t.u64(), slotIndex: t.u32(), price: t.f64() },
  (ctx, { eventId, participantId, slotIndex, price }) => {
    const ev = loadEvent(ctx as any, eventId);
    if (ev.state !== 'open') throw new SenderError('E_EVENT_NOT_OPEN');

    const p = ctx.db.participant.id.find(participantId);
    if (p == null) throw new SenderError('E_UNKNOWN_PARTICIPANT');
    if (p.eventId !== eventId) throw new SenderError('E_WRONG_EVENT');
    // C5 — one ticket per participant per event.
    if (p.hasWon) throw new SenderError('E_ALREADY_WON');

    if (ev.mode === 'queue') {
      if (slotIndex !== 0) throw new SenderError('E_STALE_SLOT');
      if (ev.ticketPrice == null || price !== ev.ticketPrice) {
        throw new SenderError('E_PRICE_MISMATCH');
      }
      if (p.walletBalance < price) throw new SenderError('E_INSUFFICIENT_BALANCE');
      if (ev.ticketsRemaining <= 0) throw new SenderError('E_SOLD_OUT');

      // Allocation and debit together, in this same call. Never two calls, never a follow-up
      // reducer, never a saga — and no reservation/hold state anywhere, because serialized
      // reducers are exactly what makes a hold redundant (CONTRACT §5).
      ctx.db.allocation.insert({
        id: 0n,
        eventId,
        slotIndex: 0,
        participantId,
        pricePaid: price,
      });
      ctx.db.participant.id.update({
        ...p,
        walletBalance: p.walletBalance - price,
        hasWon: true,
      });
      const remaining = ev.ticketsRemaining - 1;
      ctx.db.event.id.update({ ...ev, ticketsRemaining: remaining });

      // No `bid` row in queue mode — the allocation IS the record (CONTRACT §2).

      // Sell-out settles immediately. settleImpl, NOT the exported settle: `ctx.sender` here is
      // the buyer, so the guarded reducer would throw E_NOT_ADMIN, and because a throw rolls
      // back the whole transaction THIS VERY PURCHASE would fail. That is the single case the
      // settle split exists to protect, and it fails nowhere else.
      if (remaining === 0) settleImpl(ctx as any, eventId);
      return;
    }

    // ---- turn mode ----
    if (slotIndex !== ev.currentSlotIndex) throw new SenderError('E_STALE_SLOT');

    const slotRow = findSlot(ctx as any, eventId, slotIndex);
    if (slotRow == null) throw new SenderError('E_STALE_SLOT');
    // Blind bidding: the floor is a MINIMUM, not the price. A bidder commits to any amount at
    // or above it that their wallet covers, sees nobody else's number, and the slot resolves in
    // decreasing order at close. Bidding the floor exactly is still allowed and still normal —
    // it is the cheapest way in when a slot is undersubscribed.
    if (!(price >= slotRow.floor)) throw new SenderError('E_PRICE_MISMATCH');
    // The wallet is checked against the BID, not the floor: committing more than you hold is
    // the one way a blind bid could win a ticket it cannot pay for.
    if (p.walletBalance < price) throw new SenderError('E_INSUFFICIENT_BALANCE');

    // C2 — check-then-insert, safe ONLY because reducers run serially. There is no composite
    // unique constraint to lean on; SpacetimeDB supports single-column unique only.
    for (const existing of ctx.db.bid.by_event_slot.filter([eventId, slotIndex])) {
      if (existing.participantId === participantId) throw new SenderError('E_DUPLICATE_ENTRY');
    }

    ctx.db.bid.insert({
      id: 0n,
      eventId,
      slotIndex,
      participantId,
      price,
      qty: 1,
      seq: nextSeq(ctx as any, eventId),
      state: 'pending',
    });
    ctx.db.slot.id.update({ ...slotRow, entriesReceived: slotRow.entriesReceived + 1 });
    // No allocation and no debit here — the draw at close_slot decides. That deferral IS the
    // mechanism: nothing about arrival time can influence the outcome once entry is decoupled
    // from allocation.
  }
);

/**
 * `close_slot` — the turn-mode clearing rule. This is where C1 is satisfied or violated.
 *
 * A thin caller over `src/pure/draw.ts`. The ranking lives there because it is the only part
 * of this that can be unit-tested, and it happens to be the part that matters.
 *
 * **No sender guard, and this is now verified rather than assumed** (2026-09-06, live 2.10
 * instance). A scheduled reducer is genuinely private to non-owners: an anonymous identity
 * calling `close_slot` over HTTP gets `404 No such procedure`, while the same identity calling
 * `open_event` reaches the reducer and is turned away by its own `E_NOT_ADMIN`. So the 404 is
 * real privacy enforcement, not a routing artifact, and a bot CANNOT close a slot early.
 * What the platform does NOT stop is the database OWNER invoking it by hand — verified by
 * closing slot 0 at t=0s, far inside the 60s window. That is the admin, who can end the round
 * anyway, so it is not an integrity hole; it is a host behaviour this module depends on.
 * `scripts/smoke.sh` pins it, so a version bump cannot revoke it silently.
 *
 * A hand-rolled `ctx.sender == ctx.databaseIdentity` guard is still declined: it is more likely
 * to be written wrong than to catch anything the host does not already catch. The real
 * in-module guard is "no `slot_result` exists".
 *
 * **MUST NOT call `ctx.random`** (TC-CLR-14). The draw is a pure function of `drawSeed`, itself
 * a pure function of committed state. An RNG-seeded draw still looks uniform and still passes
 * every behavioural check, but a third party has no access to that stream — so verifiability
 * would die *silently*. Contrast `join`, where the wallet draw MUST use `ctx.random`.
 */
export const closeSlot = spacetimedb.reducer(
  { timer: slotSchedule.rowType },
  (ctx, { timer }) => {
    const ev = ctx.db.event.id.find(timer.eventId);
    if (ev == null) return;
    // Silent returns, not throws: a scheduled reducer has no caller to receive an error.
    // But silent must not mean INVISIBLE — CONTRACT §9 lists codes for these paths, and an
    // operator debugging a stuck slot greps the log for them. Each return names its code, so
    // the documented code is something `spacetime logs` can actually show.
    if (ev.state !== 'open' || ev.mode !== 'turn') {
      console.info(
        `close_slot: E_WRONG_STATE event=${timer.eventId} state=${ev.state} mode=${ev.mode}`
      );
      return;
    }

    // E_STALE_TIMER. The timer names the slot it was scheduled for, so a stale row cannot close
    // a slot it was never meant to. Reading `currentSlotIndex` alone would let it, and the
    // double-close guard below cannot detect that case.
    if (timer.slotIndex !== ev.currentSlotIndex) {
      console.info(
        `close_slot: E_STALE_TIMER event=${timer.eventId} timerSlot=${timer.slotIndex} ` +
          `currentSlot=${ev.currentSlotIndex}`
      );
      return;
    }

    // A `slot_result` row existing IS the closed-marker. There is no `closed` flag, and
    // `filled == 0` is not one either — a slot can legitimately close having allocated nothing.
    //
    // UNREACHABLE in practice, and kept anyway. Probed live 2026-09-06 against every
    // double-close shape: closing a non-last slot twice advances `currentSlotIndex` first, so
    // the second call is caught above by E_STALE_TIMER; closing the last slot twice settles the
    // event first, so the second call is caught by E_WRONG_STATE. There is no state where a
    // `slot_result` exists for the CURRENT slot of an OPEN event. Retained as defence-in-depth
    // because it is the only guard that stays correct if either of those two is ever reordered
    // — but CONTRACT §9 no longer advertises the code, because it cannot be observed.
    for (const _r of ctx.db.slotResult.by_event_slot.filter([timer.eventId, timer.slotIndex])) {
      console.info(
        `close_slot: E_SLOT_ALREADY_CLOSED event=${timer.eventId} slot=${timer.slotIndex}`
      );
      return;
    }

    const slotRow = findSlot(ctx as any, timer.eventId, timer.slotIndex);
    if (slotRow == null) return;

    const entries: Entry[] = [];
    const bidRows: any[] = [];
    for (const b of ctx.db.bid.by_event_slot.filter([timer.eventId, timer.slotIndex])) {
      entries.push({ id: b.id, participantId: b.participantId, price: b.price });
      bidRows.push(b);
    }

    // The seed depends on the sorted SET of entry ids in this slot — data that does not exist
    // until the slot closes, which is what makes it unpredictable in advance (C4). It
    // deliberately does not use `seq`, arrival order, or participant identity: ids are assigned
    // sequentially at join, so "lowest identity wins" would be join-order-in-disguise, exactly
    // the C1 violation this mechanism exists to remove.
    const drawSeed = deriveDrawSeed(timer.eventId, timer.slotIndex, entries.map(e => e.id));
    const ranked = rankEntries(drawSeed, entries);

    const bidById = new Map<bigint, any>(bidRows.map(b => [b.id, b]));
    let filled = 0;
    // 0, not null: `slot_result.cutoffPrice` is `f64` rather than `option<f64>` because a slot
    // that took no entries has no cutoff to report and 0 says so unambiguously — `allocated`
    // is 0 alongside it, and every reader already has to handle the empty slot.
    let cutoffPrice = 0;
    let ticketsRemaining = ev.ticketsRemaining;

    for (const entry of ranked) {
      const bidRow = bidById.get(entry.id);
      if (filled >= slotRow.effectiveQuota) {
        ctx.db.bid.id.update({ ...bidRow, state: 'lost' });
        continue;
      }
      const p = ctx.db.participant.id.find(entry.participantId);
      if (p == null) {
        ctx.db.bid.id.update({ ...bidRow, state: 'rejected' });
        continue;
      }
      // Both skips are defence-in-depth and should be unreachable: `submit_bid` already blocks
      // a winner (C5), and under C5 a balance cannot move between submit and close within one
      // event. The policy is stated rather than exercised — pass the ticket to the next in draw
      // order, never produce a negative balance. TC-CLR-12/13 assert these never fire.
      if (p.hasWon || p.walletBalance < entry.price) {
        ctx.db.bid.id.update({ ...bidRow, state: 'rejected' });
        continue;
      }

      // Allocation and debit in the same transaction, at THIS winner's own bid. Two winners in
      // one slot routinely pay different amounts — that is what pay-your-bid means, and it is
      // why `pricePaid` is per-allocation rather than derivable from the slot.
      ctx.db.allocation.insert({
        id: 0n,
        eventId: timer.eventId,
        slotIndex: timer.slotIndex,
        participantId: entry.participantId,
        pricePaid: entry.price,
      });
      ctx.db.participant.id.update({
        ...p,
        walletBalance: p.walletBalance - entry.price,
        hasWon: true,
      });
      ctx.db.bid.id.update({ ...bidRow, state: 'won' });
      cutoffPrice = entry.price; // ranked descending, so the last one taken IS the cutoff
      filled++;
      ticketsRemaining--;
    }

    const unfilled = slotRow.effectiveQuota - filled;
    ctx.db.slot.id.update({ ...slotRow, filled });

    // Single serialized write, exactly once per close. `drawSeed` is published here so anyone
    // can recompute the winner set from committed state — see integration/verify/recompute.mjs.
    ctx.db.slotResult.insert({
      id: 0n,
      eventId: timer.eventId,
      slotIndex: timer.slotIndex,
      cutoffPrice,
      entriesReceived: slotRow.entriesReceived,
      allocated: filled,
      quotaRemainingAfterRollover: unfilled,
      drawSeed,
    });

    const nextIndex = timer.slotIndex + 1;
    if (nextIndex >= ev.slotCount || ticketsRemaining === 0) {
      // Unfilled on the LAST slot is discarded, not rolled — there is nowhere to roll it.
      ctx.db.event.id.update({ ...ev, ticketsRemaining });
      // settleImpl, NOT settle: this is scheduler-invoked and would fail E_NOT_ADMIN.
      settleImpl(ctx as any, timer.eventId);
      return;
    }

    // Rollover. `baseQuota` is NEVER touched here — that is what keeps
    // sum(baseQuota) == totalTickets true for the life of the event.
    // At the locked parameters `unfilled` is always 0, so this branch is correct but never
    // observed on stage; it is tested against the pure inventory module instead.
    const nextSlot = findSlot(ctx as any, timer.eventId, nextIndex);
    if (nextSlot != null) {
      ctx.db.slot.id.update({
        ...nextSlot,
        effectiveQuota: effectiveQuota(nextSlot.baseQuota, unfilled),
      });
    }

    // Every slot in an event uses the same window — read from the event row, so a slot cannot
    // silently run to a different length than the one the round was rehearsed at.
    const endsAt = secondsFrom(ctx.timestamp, ev.slotWindowSeconds);
    ctx.db.event.id.update({
      ...ev,
      ticketsRemaining,
      currentSlotIndex: nextIndex,
      currentSlotEndsAt: endsAt,
    });
    ctx.db.slotSchedule.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(endsAt.microsSinceUnixEpoch),
      eventId: timer.eventId,
      slotIndex: nextIndex,
    });
  }
);
