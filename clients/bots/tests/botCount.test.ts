import { describe, it, expect } from "vitest";
import { BOT_RATIO, computeBotCount } from "../src/config.ts";

// TC-POOL-09 (adapted from the cut HTTP service to the in-process script: the ratio is
// asserted as a named constant that changing propagates through one function, not scattered
// literals). N humans -> ratio*N bots.
describe("TC-POOL-09 — 4:1 ratio is a named constant, not a literal", () => {
  it("BOT_RATIO is 4", () => {
    expect(BOT_RATIO).toBe(4);
  });

  it("computeBotCount derives bot count from BOT_RATIO, not a hardcoded 40", () => {
    expect(computeBotCount(10)).toBe(40);
  });
});

// TC-POOL-02 (adapted: no HTTP /onboard in the 4h script, but the underlying guarantee —
// N humans -> exactly ratio*N bots, no more no fewer — still holds and is cheap to test pure).
describe("TC-POOL-02 — bot count derived from human count", () => {
  it("scales with arbitrary human counts, not hardcoded to 40", () => {
    expect(computeBotCount(1)).toBe(4);
    expect(computeBotCount(8)).toBe(32);
    expect(computeBotCount(25)).toBe(100);
  });

  it("changing the ratio changes the derived count (config, not a scattered literal)", () => {
    expect(computeBotCount(10, 2)).toBe(20);
  });
});
