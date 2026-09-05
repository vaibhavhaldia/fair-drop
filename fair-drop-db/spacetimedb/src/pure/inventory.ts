/**
 * Derived-inventory arithmetic — CONTRACT §6, LLD §2 `start_countdown`.
 *
 * PURE, like `draw.ts`: no `ctx`, no server import. `start_countdown` is a thin caller.
 */

/** Thrown for caller-fault cases. The reducer maps `.code` onto a `SenderError`. */
export class InventoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'InventoryError';
  }
}

export interface Inventory {
  readonly totalTickets: number;
  /** Empty in queue mode. Set once, then never mutated (CONTRACT §2). */
  readonly baseQuota: readonly number[];
}

/**
 * `totalTickets := round(ticketFraction × participants_in_this_event)`, then split across slots.
 *
 * `Math.round` is half-UP, not half-away-from-zero — the two differ only for negatives, which
 * cannot occur here. Pinned because no test exercises it: TC-EVT-10's populations all divide
 * exactly, so a wrong rounding mode ships green (TC-EVT-17).
 *
 * The remainder goes to the **earliest** slots. Remainder-to-last is pathological below ~13
 * participants: at 10 participants `totalTickets` is 4 and `base` is 0, so slots 0-3 clear
 * empty and the whole event sells at the top floor, where most of the wallet distribution does
 * not qualify (TC-EVT-16). Identical whenever the division is exact, which is every demo-scale
 * number, and strictly better otherwise.
 */
export function sizeInventory(
  participants: number,
  ticketFraction: number,
  slotCount: number
): Inventory {
  if (!Number.isInteger(participants) || participants < 0) {
    throw new Error(`participants must be a non-negative integer, got ${participants}`);
  }
  // Zero participants yields a dead event on a projector with no explanation (CONTRACT §6).
  if (participants === 0) throw new InventoryError('E_NO_PARTICIPANTS');
  if (!(ticketFraction > 0 && ticketFraction <= 1)) {
    throw new InventoryError('E_FRACTION_INVALID');
  }

  const totalTickets = Math.round(ticketFraction * participants);

  // Queue mode has no slots, and `floor(totalTickets / 0)` is `Infinity` rather than a throw —
  // it would propagate silently into every quota. The whole per-slot split is skipped instead.
  if (slotCount === 0) return { totalTickets, baseQuota: [] };
  if (slotCount < 0) throw new Error(`slotCount must not be negative, got ${slotCount}`);

  const base = Math.floor(totalTickets / slotCount);
  const remainder = totalTickets - base * slotCount;
  const baseQuota = Array.from({ length: slotCount }, (_, i) => base + (i < remainder ? 1 : 0));
  return { totalTickets, baseQuota };
}

/**
 * `effectiveQuota` for a slot: its immutable `baseQuota` plus whatever the previous slot left
 * unfilled. `baseQuota` is never touched, which is what keeps `sum(baseQuota) == totalTickets`
 * true for the life of the event (TC-EVT-09).
 *
 * At the locked demo parameters `carriedForward` is always 0 — the eligible field never falls
 * below quota. That is expected, not a bug; see CONTRACT §6 for the measurement. The path is
 * kept because the parameters are not frozen forever, and it is tested here rather than by
 * running the demo, which cannot produce it.
 */
export function effectiveQuota(baseQuota: number, carriedForward: number): number {
  return baseQuota + carriedForward;
}
