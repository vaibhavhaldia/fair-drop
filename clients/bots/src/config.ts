// Named config constants — task file: "Bot count is derived from the human count, not
// hardcoded to 40," and TC-POOL-09: the ratio must be a config constant, not a literal
// scattered through the code.

/** Bots per human. HLD §6 / task file: 4:1, target H = 10 -> 40 bots. */
export const BOT_RATIO = 4;

/** Number of bots to run for a given human turnout, at a given ratio (defaults to BOT_RATIO). */
export function computeBotCount(humanCount: number, ratio: number = BOT_RATIO): number {
  return humanCount * ratio;
}
