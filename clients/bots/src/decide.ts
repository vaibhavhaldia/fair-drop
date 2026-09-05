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
};

export type TurnAction =
  | { action: "none" } // already won (C5) — nothing to do
  | { action: "abstain" } // wallet below floor — permanent dropout, floors only rise
  | { action: "bid"; price: number }; // eligible — enter at the posted floor, nothing to choose

/**
 * Turn-mode bot logic. Deliberately trivial — under a draw at a posted price there is no
 * amount to choose, for anyone. Do not add strategy.
 */
export function turnDecision(input: TurnInput): TurnAction {
  if (input.hasWon) {
    return { action: "none" };
  }
  if (input.walletBalance < input.floor) {
    return { action: "abstain" };
  }
  return { action: "bid", price: input.floor };
}
