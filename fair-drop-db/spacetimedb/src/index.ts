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
import { sizeInventory, InventoryError } from './pure/inventory';

/** Countdown and per-slot window, both 60s (LLD §1a). */
const COUNTDOWN_SECONDS = 60;
const SLOT_WINDOW_SECONDS = 60;

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
    /** The posted price. Under pay-the-floor this is also the clearing price every winner pays. */
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
    /** `= slot.floor`. Every winner in the slot paid exactly this. */
    clearingPrice: t.f64(),
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
  if (row === undefined) throw new SenderError('E_UNKNOWN_EVENT');
  return row;
}

function requireAdmin(ctx: Ctx, ev: { adminIdentity: any }) {
  if (!ctx.sender.isEqual(ev.adminIdentity)) throw new SenderError('E_NOT_ADMIN');
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
  },
  t.u64(),
  (ctx, { name, mode, ticketFraction, ticketPrice, floors }) => {
    if (mode !== 'queue' && mode !== 'turn') throw new SenderError('E_MODE_INVALID');
    if (!(ticketFraction > 0 && ticketFraction <= 1)) throw new SenderError('E_FRACTION_INVALID');

    if (mode === 'turn') {
      if (floors.length === 0) throw new SenderError('E_FLOORS_EMPTY');
      // Reject, do not warn. Under pay-the-floor a non-increasing ladder means a later slot is
      // cheaper than an earlier one, and every remaining participant would rationally skip
      // ahead to it — which quietly dismantles the mechanism the demo is about.
      for (let i = 1; i < floors.length; i++) {
        if (floors[i] <= floors[i - 1]) throw new SenderError('E_FLOORS_NOT_INCREASING');
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
  { eventId: t.u64(), displayName: t.string(), origin: t.string() },
  t.u64(),
  (ctx, { eventId, displayName, origin }) => {
    if (origin !== 'human' && origin !== 'bot') throw new SenderError('E_ORIGIN_INVALID');

    return ctx.withTx((tx: any) => {
      const ev = tx.db.event.id.find(eventId);
      if (ev === undefined) throw new SenderError('E_UNKNOWN_EVENT');
      if (ev.state === 'settled') throw new SenderError('E_EVENT_SETTLED');

      // Module RNG, never Math.random — the wallet draw must be replayable. Contrast the
      // allocation draw, which must never touch ctx.random at all (CONTRACT §4).
      const draw = ctx.random.integerInRange(20_000, 150_000);
      const suffix = ctx.random.integerInRange(0, 0xffff).toString(16);

      // A duplicate `handle` throws and rolls the row back (verified, CONTRACT §10), so
      // E_HANDLE_COLLISION is a real catchable path. Bots retry with a fresh suffix.
      const row = tx.db.participant.insert({
        id: 0n,
        eventId,
        identity: ctx.sender,
        handle: `${displayName}-${suffix}`,
        displayName,
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
    const endsAt = secondsFrom(ctx.timestamp, SLOT_WINDOW_SECONDS);
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
  if (ev === undefined) return;
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
 * `close_slot` — GATE 3. Stub for now; `slot_schedule` needs the reference to compile.
 *
 * When implemented it must: guard `timer.slotIndex == event.currentSlotIndex` (E_STALE_TIMER),
 * refuse a second close (a `slot_result` row existing IS the closed flag), call the pure
 * `drawSlot`, and NEVER touch `ctx.random`.
 */
export const closeSlot = spacetimedb.reducer(
  { timer: slotSchedule.rowType },
  (_ctx, { timer }) => {
    console.info(
      `close_slot STUB — event ${timer.eventId} slot ${timer.slotIndex}. Implemented at Gate 3.`
    );
  }
);
