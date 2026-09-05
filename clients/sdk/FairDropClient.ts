// FairDropClient — the one thin wrapper over SpacetimeDB's generated TS client.
//
// docs/CONTRACT.md §3 ("SDK surface") and §8 ("Ownership: clients/sdk/** — Saksham") are the
// authority for this file. LLD §6 carries the reasoning: nothing in React, the bot driver, or
// any other client talks to `./generated` directly, or the two sides drift silently. The 4h
// re-plan (`sdd-engine/tasks/saksham.md`) cuts "clients/sdk as an ENFORCED layer + an
// import-graph lint (TC-SDK-02)" — this file is the "one thin wrapper file" that survives that
// cut. It is not a test target itself (reducers/procedures are only reachable through a live
// connection, and CONTRACT §1 rules out an in-process harness); it exists so every consumer
// gets the bigint<->string and callback-shape translation in exactly one place.
//
// Generated bindings: `spacetime generate --module-path fair-drop-db/spacetimedb --lang
// typescript --out-dir clients/sdk/generated` against the published module. Never hand-edit
// `./generated` — regenerate it after any schema/reducer/procedure change (CONTRACT §1's "the
// two sides will drift silently" is exactly this file's reason to exist).

import { DbConnection, type EventContext } from "./generated/index.ts";
import type {
  Event as EventRow,
  Allocation as AllocationRow,
  SlotResult as SlotResultRow,
  Participant as ParticipantRow,
  Slot as SlotRow,
  Bid as BidRow,
} from "./generated/types.ts";

export type EventId = bigint;
export type ParticipantId = bigint;
export type Unsubscribe = () => void;

export interface CreateEventConfig {
  name: string;
  mode: "queue" | "turn";
  ticketFraction: number;
  /** Queue mode only; ignored (but still required by the procedure signature) for turn. */
  ticketPrice: number;
  /** Turn mode only; `[]` for queue. */
  floors: number[];
}

/**
 * Thin wrapper around one `DbConnection`. Translates CONTRACT §3's plain callback surface onto
 * `connection.reducers` / `connection.procedures` (call side) and `connection.db.<table>`
 * (read/subscribe side) — see LLD §6: "reducer calls become `connection.reducers.<name>(...)`,
 * and subscriptions become SQL-shaped queries whose row callbacks `FairDropClient` translates
 * into the plain callback surface below."
 *
 * Callers never touch `connection` or `./generated` directly (TC-SDK-02's intent, even though
 * the import-graph lint itself is cut at 4h — see the module header).
 */
export class FairDropClient {
  private readonly connection: DbConnection;

  // No TypeScript parameter properties: `clients/bots/src/index.ts` and this file are both run
  // directly with `node --experimental-strip-types`, a strip-only mode that erases types but
  // cannot desugar syntax needing extra emitted code (CONTRACT-adjacent gotcha, same family as
  // `allowImportingTsExtensions` — verified live 2026-09-06).
  private constructor(connection: DbConnection) {
    this.connection = connection;
  }

  /**
   * Connect and wait for the initial handshake. `uri`/`dbName` match `DEMO-RECIPE.md` Stage 0:
   * `--server local` == `http://127.0.0.1:3000`, database `fairdrop-demo`.
   *
   * Subscribes to every public table once, up front (`subscribeToAllTables`), rather than a
   * bespoke SQL query per read/callback. This is deliberate at demo scale: `docs/CONTRACT.md`
   * §9 caps this build at 40 bots / ~50 participant rows total, `subscribeToAllTables` must not
   * be mixed with `subscribe(...)` on the same connection (SpacetimeDB SDK constraint), and a
   * single broad subscription is simpler than per-event query strings while every reader
   * (`listEvents`, `getWalletBalance`, `subscribeEvent`/`subscribeAllocations`/
   * `subscribeSlotResults`) needs is already in the local cache the instant it resolves.
   */
  static connect(uri: string, dbName: string): Promise<FairDropClient> {
    return new Promise((resolve, reject) => {
      const builder = DbConnection.builder()
        .withUri(uri)
        .withDatabaseName(dbName)
        .onConnect((connection) => {
          connection.subscriptionBuilder().subscribeToAllTables();
          resolve(new FairDropClient(connection));
        })
        .onConnectError((_ctx, error) => reject(error));
      builder.build();
    });
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  // -----------------------------------------------------------------------------------------
  // Procedures — return values to the caller (CONTRACT §3: "reducers cannot return values").
  // -----------------------------------------------------------------------------------------

  /** `join` — PROCEDURE. Registration is per-event; returns the new row's `ParticipantId`. */
  async join(
    eventId: EventId,
    displayName: string,
    origin: "human" | "bot"
  ): Promise<ParticipantId> {
    return this.connection.procedures.join({ eventId, displayName, origin });
  }

  /** `create_event` — PROCEDURE, admin-only by construction (creator becomes `adminIdentity`). */
  async createEvent(config: CreateEventConfig): Promise<EventId> {
    return this.connection.procedures.createEvent({
      name: config.name,
      mode: config.mode,
      ticketFraction: config.ticketFraction,
      ticketPrice: config.ticketPrice,
      floors: config.floors,
    });
  }

  // -----------------------------------------------------------------------------------------
  // Reducers — fire-and-forget from the caller's point of view (CONTRACT §3: every signature
  // here is `void`, never `Promise`). The underlying `connection.reducers.*` call IS a Promise
  // over the wire, and it rejects on a `SenderError` (verified live: `E_SOLD_OUT` surfaced this
  // way during Gate 4 rehearsal). A `void`-returning wrapper cannot re-throw that synchronously
  // — by the time the rejection exists, the caller's stack frame is long gone — so an unhandled
  // rejection would otherwise crash the process. `clients/bots/src/runner.ts` already wraps
  // every `submitBid` call in a synchronous `try/catch` that swallows everything except the
  // (join-time-only) `E_HANDLE_COLLISION`, on the fixture contract where errors were assumed
  // synchronous; `attachErrorLog` below reproduces that swallow-and-continue behaviour for the
  // real, asynchronous transport instead of leaving it to crash. Admin-only calls additionally
  // log to `console.error`, since those are steps a correctly-run demo never expects to fail.
  // -----------------------------------------------------------------------------------------

  private attachErrorLog(promise: Promise<void>, label: string): void {
    promise.catch((err: unknown) => {
      console.error(`FairDropClient: ${label} rejected —`, err);
    });
  }

  /** `start_countdown` — admin only; sizes inventory from the per-event headcount. */
  startCountdown(eventId: EventId): void {
    this.attachErrorLog(this.connection.reducers.startCountdown({ eventId }), "startCountdown");
  }

  /** `open_event` — admin-called in the 4h scope (CONTRACT §3). */
  openEvent(eventId: EventId): void {
    this.attachErrorLog(this.connection.reducers.openEvent({ eventId }), "openEvent");
  }

  /** `settle` — admin only, `E_NOT_ADMIN` guarded. */
  settle(eventId: EventId): void {
    this.attachErrorLog(this.connection.reducers.settle({ eventId }), "settle");
  }

  /**
   * `submit_bid` — the single entrypoint for both modes. Queue mode passes `slotIndex = 0`.
   * Errors (`E_INSUFFICIENT_BALANCE`, `E_SOLD_OUT`, ...) are normal traffic per CONTRACT §4 —
   * swallowed here with no log, matching every bot caller's own catch block, which already
   * discards them. This wrapper never retries.
   */
  submitBid(
    eventId: EventId,
    participantId: ParticipantId,
    slotIndex: number,
    price: number
  ): void {
    this.connection.reducers
      .submitBid({ eventId, participantId, slotIndex, price })
      .catch(() => {
        // normal traffic (CONTRACT §4) — deliberately silent, see class-level note above.
      });
  }

  // -----------------------------------------------------------------------------------------
  // Reads — subscribed table state. `listEvents` reads the current client cache; the
  // `subscribe*` methods additionally register a live callback and return an `Unsubscribe`.
  // -----------------------------------------------------------------------------------------

  listEvents(): EventRow[] {
    return [...this.connection.db.event.iter()];
  }

  // NOTE beyond the literal CONTRACT.md §3 list: the Display's own documented shape
  // (task file "Display": "allocatedTo: { human, bot } <- Allocation JOIN Participant.origin,
  // derived on read") cannot be built from the nine listed methods alone — none of them
  // surface `Participant` or `Slot` rows, and both are already replicated locally by
  // `connect()`'s `subscribeToAllTables`. These two accessors mirror `listEvents()`'s existing
  // pattern exactly (read-only cache iteration, no reducer/procedure call, no arithmetic) so
  // `clients/web` can build a `DisplaySourceData` snapshot without importing `./generated`
  // itself (TC-SDK-02's intent). Recorded here per CONTRACT.md §11's amended change-control
  // rule ("record the reason, not forbid the change") rather than silently added.

  /** Every `Participant` row for `eventId` — needed for the human/bot origin join. */
  listParticipants(eventId: EventId): ParticipantRow[] {
    return [...this.connection.db.participant.iter()].filter((p) => p.eventId === eventId);
  }

  /** Every `Slot` row for `eventId` — turn mode only; `[]` for queue mode (`slotCount == 0`). */
  listSlots(eventId: EventId): SlotRow[] {
    return [...this.connection.db.slot.iter()].filter((s) => s.eventId === eventId);
  }

  /**
   * Every `Allocation` row for `eventId` so far. Same rationale as `listParticipants` /
   * `listSlots` above: `subscribeAllocations` only hands the display *new* rows as they land,
   * but `deriveDisplayModel` needs the full accumulated set on every re-render.
   */
  listAllocations(eventId: EventId): AllocationRow[] {
    return [...this.connection.db.allocation.iter()].filter((a) => a.eventId === eventId);
  }

  /** Wallet balance for one participant. One connection may hold hundreds (CONTRACT §9). */
  getWalletBalance(participantId: ParticipantId): number {
    const row = this.connection.db.participant.id.find(participantId);
    if (row == null) throw new Error(`unknown participantId ${participantId}`);
    return row.walletBalance;
  }

  /**
   * Invokes `cb` on every insert/update of `eventId`'s row. The underlying table is already in
   * the local cache (`connect`'s `subscribeToAllTables`) — this registers a filtered listener,
   * it does not issue a new SQL subscription. Returns an `Unsubscribe` that removes it.
   */
  subscribeEvent(eventId: EventId, cb: (e: EventRow) => void): Unsubscribe {
    const onInsert = (_ctx: EventContext, row: EventRow) => {
      if (row.id === eventId) cb(row);
    };
    const onUpdate = (_ctx: EventContext, _old: EventRow, row: EventRow) => {
      if (row.id === eventId) cb(row);
    };
    this.connection.db.event.onInsert(onInsert);
    this.connection.db.event.onUpdate(onUpdate);
    return () => {
      this.connection.db.event.removeOnInsert(onInsert);
      this.connection.db.event.removeOnUpdate(onUpdate);
    };
  }

  /** Invokes `cb` for every `Allocation` row inserted for `eventId`. */
  subscribeAllocations(eventId: EventId, cb: (a: AllocationRow) => void): Unsubscribe {
    const onInsert = (_ctx: EventContext, row: AllocationRow) => {
      if (row.eventId === eventId) cb(row);
    };
    this.connection.db.allocation.onInsert(onInsert);
    return () => {
      this.connection.db.allocation.removeOnInsert(onInsert);
    };
  }

  /**
   * Invokes `cb` on every insert/update of one of `eventId`'s `Slot` rows. Turn mode bumps
   * `Slot.entriesReceived` on every `submit_bid` inside the 60s window, whereas `Allocation`
   * rows (and the `SlotResult` row) are only written at `close_slot` — so the display's live
   * "Entries"/"Oversubscription" columns need this to move during the window instead of
   * jumping at the end. Same additive rationale as `listSlots` above, recorded per
   * CONTRACT.md §11 rather than silently added.
   */
  subscribeSlots(eventId: EventId, cb: (s: SlotRow) => void): Unsubscribe {
    const onInsert = (_ctx: EventContext, row: SlotRow) => {
      if (row.eventId === eventId) cb(row);
    };
    const onUpdate = (_ctx: EventContext, _old: SlotRow, row: SlotRow) => {
      if (row.eventId === eventId) cb(row);
    };
    this.connection.db.slot.onInsert(onInsert);
    this.connection.db.slot.onUpdate(onUpdate);
    return () => {
      this.connection.db.slot.removeOnInsert(onInsert);
      this.connection.db.slot.removeOnUpdate(onUpdate);
    };
  }

  /** Invokes `cb` for every `SlotResult` row inserted for `eventId` — one per `close_slot`. */
  subscribeSlotResults(eventId: EventId, cb: (r: SlotResultRow) => void): Unsubscribe {
    const onInsert = (_ctx: EventContext, row: SlotResultRow) => {
      if (row.eventId === eventId) cb(row);
    };
    this.connection.db.slotResult.onInsert(onInsert);
    return () => {
      this.connection.db.slotResult.removeOnInsert(onInsert);
    };
  }

  // -----------------------------------------------------------------------------------------
  // Human-facing surface (`clients/web`'s participant page). Recorded per CONTRACT.md §11
  // ("record the reason, not forbid the change"), same as the `listParticipants`/`listSlots`
  // note above. The nine methods CONTRACT §3 lists were specified for the DISPLAY, which is a
  // read-only projector view of aggregates. A participant acting on their own behalf needs
  // three things the display never did, and none of them can be built from the existing
  // methods:
  //
  //   1. their OWN row changing — `walletBalance` is debited and `hasWon` flips on allocation,
  //      both `participant` UPDATEs. `subscribeAllocations` fires on the allocation insert but
  //      carries no wallet, and `subscribeEvent` never mentions participants at all.
  //   2. their own bid's fate — turn mode's `bid.state` goes `pending` -> `won`|`lost` at
  //      `close_slot`, which is the exact moment the phone must change what it says. Also the
  //      only way to answer "have I already entered this slot?" before the user double-taps
  //      into `E_DUPLICATE_ENTRY`.
  //   3. errors, at all — see `submitBidChecked`.
  // -----------------------------------------------------------------------------------------

  /** One `Participant` row by id, or `null` if it is not in the local cache yet. */
  getParticipant(participantId: ParticipantId): ParticipantRow | null {
    return this.connection.db.participant.id.find(participantId) ?? null;
  }

  /** Every `Bid` row for `eventId`. Turn mode only — queue mode writes no `bid` rows. */
  listBids(eventId: EventId): BidRow[] {
    return [...this.connection.db.bid.iter()].filter((b) => b.eventId === eventId);
  }

  /**
   * Invokes `cb` on every insert/update of one of `eventId`'s `Participant` rows. `onUpdate` is
   * the load-bearing half: the wallet debit and the `hasWon` flip are both updates to an
   * already-inserted row.
   */
  subscribeParticipants(eventId: EventId, cb: (p: ParticipantRow) => void): Unsubscribe {
    const onInsert = (_ctx: EventContext, row: ParticipantRow) => {
      if (row.eventId === eventId) cb(row);
    };
    const onUpdate = (_ctx: EventContext, _old: ParticipantRow, row: ParticipantRow) => {
      if (row.eventId === eventId) cb(row);
    };
    this.connection.db.participant.onInsert(onInsert);
    this.connection.db.participant.onUpdate(onUpdate);
    return () => {
      this.connection.db.participant.removeOnInsert(onInsert);
      this.connection.db.participant.removeOnUpdate(onUpdate);
    };
  }

  /**
   * Invokes `cb` on every insert/update of one of `eventId`'s `Bid` rows. The update half
   * carries the `pending` -> `won`|`lost` transition written by `close_slot`.
   */
  subscribeBids(eventId: EventId, cb: (b: BidRow) => void): Unsubscribe {
    const onInsert = (_ctx: EventContext, row: BidRow) => {
      if (row.eventId === eventId) cb(row);
    };
    const onUpdate = (_ctx: EventContext, _old: BidRow, row: BidRow) => {
      if (row.eventId === eventId) cb(row);
    };
    this.connection.db.bid.onInsert(onInsert);
    this.connection.db.bid.onUpdate(onUpdate);
    return () => {
      this.connection.db.bid.removeOnInsert(onInsert);
      this.connection.db.bid.removeOnUpdate(onUpdate);
    };
  }

  /**
   * `submit_bid`, but the caller learns whether it worked.
   *
   * `submitBid` above swallows every rejection deliberately — CONTRACT §4 calls
   * `E_INSUFFICIENT_BALANCE` and friends "normal traffic", and every bot caller discards them.
   * That is exactly wrong for a person holding a phone: a human who taps Buy and sees nothing
   * happen cannot tell a sold-out event from a dropped connection, and "nothing happened" is
   * the single most likely thing to go wrong in front of an audience.
   *
   * Rejects with the module's `SenderError` (whose message carries the `E_*` code) instead.
   * The bot path is untouched — this is an additional method, not a change to `submitBid`.
   */
  /**
   * Admin lifecycle calls that report failure to the caller, for the same reason as
   * `submitBidChecked`: `startCountdown`/`openEvent`/`settle` above route rejections to
   * `console.error`, which is invisible to an operator driving the demo from a phone or from a
   * laptop whose devtools are not open — and these are exactly the calls whose failures are
   * actionable. `E_NO_PARTICIPANTS` on lock is the documented zero-inventory trap
   * (`inventory.ts`: `round(0.40 x 1) == 0`), and `E_NOT_ADMIN` fires whenever the event was
   * created by a different identity than the one now clicking. Both need to reach a person.
   */
  startCountdownChecked(eventId: EventId): Promise<void> {
    return this.connection.reducers.startCountdown({ eventId });
  }

  openEventChecked(eventId: EventId): Promise<void> {
    return this.connection.reducers.openEvent({ eventId });
  }

  settleChecked(eventId: EventId): Promise<void> {
    return this.connection.reducers.settle({ eventId });
  }

  submitBidChecked(
    eventId: EventId,
    participantId: ParticipantId,
    slotIndex: number,
    price: number
  ): Promise<void> {
    return this.connection.reducers.submitBid({ eventId, participantId, slotIndex, price });
  }
}
