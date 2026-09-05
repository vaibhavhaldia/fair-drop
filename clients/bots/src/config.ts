// Named config constants — task file: "Bot count is derived from the human count, not
// hardcoded to 40," and TC-POOL-09: the ratio must be a config constant, not a literal
// scattered through the code.

/** Bots per human. HLD §6 / task file: 4:1, target H = 10 -> 40 bots. */
export const BOT_RATIO = 4;

/** Number of bots to run for a given human turnout, at a given ratio (defaults to BOT_RATIO). */
export function computeBotCount(humanCount: number, ratio: number = BOT_RATIO): number {
  return humanCount * ratio;
}

/**
 * What a reseller bot believes the ticket fetches on the secondary market, and the gross margin
 * it needs to bother. Together they set the most a bot will ever bid:
 *
 *     ceiling = RESALE_PRICE x (1 - RESALE_MARGIN)
 *
 * This is the whole reason bots and fans behave differently under blind bidding, and it is the
 * demo's actual claim. A fan bids what the night is worth to THEM. A reseller cannot: every
 * rupee above the resale price is a loss, so their ceiling is a business fact, not a preference.
 * Fans who value the event above a scalper's resale margin outbid them — no speed, no luck.
 *
 * Numbers are demo parameters, not physics. At a 15,000 face value, 37,500 (2.5x) is a
 * deliberately generous resale assumption — a scalper who believed less would drop out sooner
 * and make the point look rigged. The resulting 30,000 ceiling clears the first three floors
 * and cannot reach the 40,000 and 55,000 slots at all, which is exactly the intended shape:
 * the expensive slots are where fans face no bot competition whatsoever.
 */
export const RESALE_PRICE = 37_500;
export const RESALE_MARGIN = 0.2;

/** The most a reseller bot will bid, before its own wallet is taken into account. */
export function botBidCeiling(
  resale: number = RESALE_PRICE,
  margin: number = RESALE_MARGIN
): number {
  return Math.floor(resale * (1 - margin));
}
