// Spike: re-verifies every API claim in docs/CONTRACT.md §10 against a live instance.
//
// WHY THIS FILE EXISTS
// The original spike source was reverted and dist/ is gitignored, so §10's nine
// "build-proven" claims became unreproducible from the repo. This reconstructs them from
// the shapes §10 recorded as working. It is NOT the original bytes — if it fails to build,
// that is a finding about §10, not a bug in the spike. Report it before proceeding.
//
// HOW TO RUN (never publishes over the real module — separate database name)
//   export PATH="$HOME/.local/bin:$PATH"
//   spacetime --version                     # must read 2.9.0; else: spacetime version use 2.9.0
//   cp fair-drop-db/spacetimedb/src/index.ts /tmp/index.ts.bak
//   cp fair-drop-db/spacetimedb/spike/verify-2.8-api.ts fair-drop-db/spacetimedb/src/index.ts
//   spacetime publish -p fair-drop-db/spacetimedb fairdrop-spike --server local -y --delete-data=always
//   # run from OUTSIDE fair-drop-db/, or spacetime.local.json overrides the database name
//   spacetime call --server local fairdrop-spike join_proc '"Asha"'   # x3
//   spacetime sql  --server local fairdrop-spike "SELECT * FROM participant"
//   cp /tmp/index.ts.bak fair-drop-db/spacetimedb/src/index.ts
//
// PASS CRITERIA (all four, matching §10)
//   1. It compiles at all           → t.option(...), scheduled: on the table, multi-column btree
//   2. join_proc RETURNS [id, wallet] to the caller  → procedures return values
//   3. Three rows land from ONE identity             → identity is non-unique
//   4. The three walletBalance values are distinct integers in [20000, 150000]
//      → ctx.random.integerInRange works and is not Math.random

import { schema, table, t } from 'spacetimedb/server';

// Claim: t.option(...) is the optional modifier; `.optional()` does not exist.
// Claim: multi-column btree via indexes: [{ accessor, algorithm, columns }].
const spikeEvent = table(
  {
    name: 'spike_event',
    public: true,
    indexes: [{ accessor: 'by_event_slot', algorithm: 'btree', columns: ['eventId', 'slotIndex'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    eventId: t.u64(),
    slotIndex: t.u32(),
    ticketPrice: t.option(t.f64()),
    endTime: t.option(t.timestamp()),
  }
);

// Claim: participant.id is the PK; identity is indexed but NOT unique (one connection,
// many rows); handle IS unique, so a duplicate insert throws catchably.
const participant = table(
  { name: 'participant', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity().index('btree'),
    handle: t.string().unique(),
    displayName: t.string(),
    walletBalance: t.f64(),
  }
);

// Claim: the `scheduled:` option lives on the TABLE, not as onSchedule on the reducer.
// The arrow defers the circular reference to closeSlot.
const slotSchedule = table(
  { name: 'slot_schedule', scheduled: (): any => closeSlot },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    eventId: t.u64(),
    slotIndex: t.u32(),
  }
);

const spacetimedb = schema({ spikeEvent, participant, slotSchedule });
export default spacetimedb;

// Claim: the schedule row arrives as the reducer's single argument.
export const closeSlot = spacetimedb.reducer(
  { timer: slotSchedule.rowType },
  (_ctx, { timer }) => {
    console.info(`closeSlot fired for event ${timer.eventId} slot ${timer.slotIndex}`);
  }
);

// THE LOAD-BEARING CLAIM: procedures return values to the caller, so create_event and join
// can hand back a generated id. If this returns nothing, CONTRACT §3's fallback applies
// (keep them as reducers, await the row by unique handle) — escalate before adopting it.
//
// Expected CLI output, three calls: [1, <int>] [2, <int>] [3, <int>] — distinct wallets,
// three rows, one identity.
export const joinProc = spacetimedb.procedure(
  { displayName: t.string() },
  t.array(t.f64()),
  (ctx, { displayName }) => {
    return ctx.withTx(tx => {
      // Claim: ctx.random.integerInRange, never Math.random — module RNG is replayable.
      const draw = ctx.random.integerInRange(20_000, 150_000);
      const suffix = ctx.random.integerInRange(0, 0xffff).toString(16);
      const row = tx.db.participant.insert({
        identity: ctx.sender,
        handle: `${displayName}-${suffix}`,
        displayName,
        walletBalance: draw,
      });
      return [Number(row.id), draw];
    });
  }
);

// Claim: a duplicate `handle` insert THROWS, making E_HANDLE_COLLISION a real catchable
// path rather than a probabilistic hope. Call twice with the same arg; the second must fail.
export const forceHandleCollision = spacetimedb.reducer(
  { handle: t.string() },
  (ctx, { handle }) => {
    ctx.db.participant.insert({
      identity: ctx.sender,
      handle,
      displayName: handle,
      walletBalance: 20_000,
    });
  }
);
