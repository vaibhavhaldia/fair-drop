// Pure bot decision logic — no network, no SDK, so it is testable without a live module.
// CONTRACT.md §3, task file "Bot driver" pseudocode.

/**
 * DELTA_MS is the *upper bound* on a queue-mode bot's reaction delay, not the delay itself.
 * Each bot draws its own value independently, uniform on [0, DELTA_MS]. It is a named
 * constant — TC-EXP-07's delay sweep, and the on-stage "what if bots were faster?" question,
 * both need to change it in exactly one place.
 */
export const DELTA_MS = 500;

/** Uniform draw on [0, DELTA_MS], independent per call. Never a fixed sleep. */
export function queueDelayMs(): number {
  return Math.random() * DELTA_MS;
}

export type TurnInput = {
  hasWon: boolean;
  walletBalance: number;
  floor: number;
  /**
   * The most this bot will pay, from `botBidCeiling()`. Optional so the queue-mode callers and
   * older tests keep working; omitted means "no resale ceiling", i.e. bid the floor as v3 did.
   */
  ceiling?: number;
};

export type TurnAction =
  | { action: "none" } // already won (C5) — nothing to do
  | { action: "abstain" } // wallet below floor — permanent dropout, floors only rise
  | { action: "bid"; price: number }; // eligible — bids `price`, blind

/**
 * Turn-mode bot logic under blind bidding.
 *
 * A reseller bids its ceiling — the resale price less its required margin — capped by its
 * wallet, and never below the floor. It does NOT shade below that: the margin already is the
 * shade, and a scalper that bid less would be modelling a scalper who leaves money on the
 * table, which flatters the demo.
 *
 * When the ceiling is below the floor the bot abstains, and because floors only rise, it is out
 * for the rest of the event — a real budget dropout, not a scripted weakening. That is the
 * mechanism working: at 40,000 and 55,000 a reseller's economics simply do not close.
 *
 * With no `ceiling` supplied this degrades to v3's behaviour (bid the floor exactly), so a
 * caller that has no resale model still produces a legal entry.
 */
export function turnDecision(input: TurnInput): TurnAction {
  if (input.hasWon) {
    return { action: "none" };
  }
  const ceiling = Math.min(input.ceiling ?? input.floor, input.walletBalance);
  if (ceiling < input.floor) {
    return { action: "abstain" };
  }
  return { action: "bid", price: ceiling };
}
