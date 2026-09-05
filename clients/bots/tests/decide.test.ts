import { describe, it, expect } from "vitest";
import { DELTA_MS, queueDelayMs, turnDecision } from "../src/decide.ts";

// TC-BOT-01 — queue-mode delay is drawn uniformly on [0, DELTA_MS], never a fixed sleep.
describe("TC-BOT-01 — queue delay draw", () => {
  it("is a named constant, bound 500ms", () => {
    expect(DELTA_MS).toBe(500);
  });

  it("draws ≥100 independent values, all within [0, DELTA_MS], spread rather than clustered", () => {
    const n = 500;
    const samples = Array.from({ length: n }, () => queueDelayMs());

    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(DELTA_MS);
    }

    const mean = samples.reduce((a, b) => a + b, 0) / n;
    expect(mean).toBeGreaterThan(200);
    expect(mean).toBeLessThan(300);

    // spread, not clustered at either end: a meaningful fraction should land
    // away from both 0 and DELTA_MS.
    const middleThird = samples.filter((s) => s > DELTA_MS / 3 && s < (2 * DELTA_MS) / 3);
    expect(middleThird.length).toBeGreaterThan(n * 0.2);

    // not every bot fixed at the same value (0 or DELTA_MS or otherwise).
    const distinct = new Set(samples.map((s) => Math.round(s)));
    expect(distinct.size).toBeGreaterThan(n * 0.5);
  });
});

// TC-BOT-02 — turn mode: eligible bot bids exactly the floor, nothing else.
describe("TC-BOT-02 — turn mode entry at the floor", () => {
  it("submits exactly one entry at price == slot.floor when eligible", () => {
    const d = turnDecision({ hasWon: false, walletBalance: 40_000, floor: 25_000 });
    expect(d).toEqual({ action: "bid", price: 25_000 });
  });
});

// TC-BOT-03 — turn mode: wallet below floor abstains permanently.
describe("TC-BOT-03 — turn mode wallet dropout", () => {
  it("abstains when walletBalance < slot.floor", () => {
    const d = turnDecision({ hasWon: false, walletBalance: 10_000, floor: 25_000 });
    expect(d).toEqual({ action: "abstain" });
  });
});

// TC-BOT-04 — turn mode: hasWon means do nothing in every later slot (C5).
describe("TC-BOT-04 — turn mode C5 respected client-side", () => {
  it("does nothing once hasWon is true, even with plenty of balance", () => {
    const d = turnDecision({ hasWon: true, walletBalance: 999_999, floor: 25_000 });
    expect(d).toEqual({ action: "none" });
  });
});

// TC-BOT-05 — a bot never submits above its walletBalance.
describe("TC-BOT-05 — never bids above wallet balance", () => {
  it("abstains rather than bidding more than walletBalance allows", () => {
    const d = turnDecision({ hasWon: false, walletBalance: 24_999, floor: 25_000 });
    expect(d.action).not.toBe("bid");
  });
});

// TC-BOT-06 — at most one entry per slot (client side); no strategy beyond the trivial rule.
describe("TC-BOT-06 — deliberately trivial, no strategy", () => {
  it("never returns a price other than the floor when bidding", () => {
    const d = turnDecision({ hasWon: false, walletBalance: 1_000_000, floor: 55_000 });
    expect(d.action).toBe("bid");
    if (d.action === "bid") {
      expect(d.price).toBe(55_000);
    }
  });
});
