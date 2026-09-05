/**
 * The allocation draw — CONTRACT §7 (C1, C4) and LLD §2 `close_slot`.
 *
 * PURE. No `spacetimedb/server` import, no `ctx`, no `ctx.random`, no `Date.now`. This file must
 * stay loadable in plain Node, because it is the only part of the module that can be unit-tested
 * at all (`spacetimedb/server` pulls `spacetime:sys@2.0`, which vitest cannot resolve).
 *
 * `close_slot` is a thin caller over this. If you find yourself needing `ctx` in here, the
 * design has drifted — escalate rather than importing it.
 */

import { digest64, toHex64 } from './hash';

/** One committed entry in a slot. `id` is the `bid` row's PK. */
export interface Entry {
  readonly id: bigint;
  readonly participantId: bigint;
}

export interface DrawResult {
  /** Winners, in the order the draw ranked them. Length <= effectiveQuota. */
  readonly winners: readonly Entry[];
  /** Quota that found no taker. Rolls into the next slot's effectiveQuota. */
  readonly unfilled: number;
  /** Published on `slot_result` so a third party can recompute all of this. */
  readonly drawSeed: string;
}

/**
 * `drawSeed := hash(eventId, slotIndex, sorted(entry ids))`.
 *
 * The ids are sorted before hashing, so the seed is a function of the entry **set** — not of
 * the order rows were inserted. This is half of C1; the other half is the ranking below.
 */
export function deriveDrawSeed(
  eventId: bigint,
  slotIndex: number,
  entryIds: readonly bigint[]
): string {
  const sorted = [...entryIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return toHex64(digest64(`${eventId}:${slotIndex}:${sorted.join(',')}`));
}

/**
 * Rank entries by `hash(drawSeed, entry.id)` ascending.
 *
 * Ties break on `entry.id` ascending. That tie-break is load-bearing, not defensive: without
 * it two entries colliding in the hash would keep whatever relative order the input array
 * happened to have, and TC-INV-01 would fail intermittently on ~1-in-2^32 sets — the worst
 * possible failure shape, since it passes every rehearsal and breaks on stage.
 *
 * `entry.id` is read here only as a hash input and as a tie-break, never as an ordering.
 * That distinction is the hinge C1 turns on (CONTRACT §7) — but it holds ONLY because
 * `digest64` avalanches. `bid.id` is a sequential autoInc PK, so it encodes arrival order; a
 * hash that preserves input locality turns "hash input" back into "ordering", and C1 then
 * fails silently while the demo still looks correct on stage. Raw FNV-1a did exactly that
 * (see `hash.ts` `mix64`). TC-CLR-11 is what makes this paragraph a fact rather than a hope.
 */
export function rankEntries(drawSeed: string, entries: readonly Entry[]): Entry[] {
  return [...entries]
    .map(entry => ({ entry, key: digest64(`${drawSeed}:${entry.id}`) }))
    .sort((a, b) => {
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
    })
    .map(({ entry }) => entry);
}

/**
 * Resolve one slot: derive the seed, rank, take the top `effectiveQuota`.
 *
 * Every winner pays the same price — the slot floor — so there is no per-winner price to
 * compute here (CONTRACT §5.2). The caller does the allocation write and the wallet debit
 * together, in the same reducer call.
 *
 * Eligibility (`hasWon == false`, wallet covers the floor) is enforced at `submit_bid`, so an
 * entry existing here means it already qualified. Do not re-filter on wallet state in this
 * function: it would make the draw depend on data that is not published on `slot_result`, and
 * TC-CLR-09's out-of-module recomputation would stop matching.
 */
export function drawSlot(
  eventId: bigint,
  slotIndex: number,
  entries: readonly Entry[],
  effectiveQuota: number
): DrawResult {
  if (effectiveQuota < 0) {
    throw new Error(`effectiveQuota must not be negative, got ${effectiveQuota}`);
  }
  const drawSeed = deriveDrawSeed(eventId, slotIndex, entries.map(e => e.id));
  const winners = rankEntries(drawSeed, entries).slice(0, effectiveQuota);
  return { winners, unfilled: effectiveQuota - winners.length, drawSeed };
}

/**
 * The same draw, recomputed from published state alone — the TC-CLR-09 / TC-INV-11 entrypoint.
 *
 * It takes the `drawSeed` off `slot_result` rather than deriving it, so a verifier can check
 * the ranking without trusting our derivation, then separately check the derivation itself
 * with `deriveDrawSeed`. Anything this function cannot see is, by construction, not an input
 * to the allocation.
 */
export function recomputeWinners(
  drawSeed: string,
  entries: readonly Entry[],
  effectiveQuota: number
): readonly Entry[] {
  return rankEntries(drawSeed, entries).slice(0, effectiveQuota);
}
