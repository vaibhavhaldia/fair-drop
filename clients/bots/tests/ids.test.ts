import { describe, it, expect } from "vitest";
import { parseFixtureId, fixtureIdsToJson } from "../src/ids.ts";

// TC-SDK-09 (adapted: the rule — bigint ids cross a JSON boundary as decimal strings, and no
// consumer does the conversion ad hoc/inconsistently — applies wherever the bot driver loads
// JSON fixture data shaped like CONTRACT.md §3, e.g. `{ "eventId": "1" }`).
describe("TC-SDK-09 — bigint ids convert at the JSON boundary, nowhere else", () => {
  it("parses a decimal-string fixture id into a bigint", () => {
    expect(parseFixtureId("1")).toBe(1n);
    expect(parseFixtureId("9007199254740993")).toBe(9007199254740993n);
  });

  it("serialises a bigint id back to a decimal string for JSON output", () => {
    expect(fixtureIdsToJson({ eventId: 1n, participantId: 40n })).toEqual({
      eventId: "1",
      participantId: "40",
    });
  });

  it("round-trips without precision loss beyond Number.MAX_SAFE_INTEGER", () => {
    const big = 18446744073709551615n; // u64 max
    expect(parseFixtureId(big.toString())).toBe(big);
  });
});
