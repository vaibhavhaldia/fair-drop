// Ids are `bigint` (u64) and do not survive `JSON.stringify` — convert at the boundary.
// The boundary here is JSON fixture data (CONTRACT.md §3 shape, e.g. `{ "eventId": "1" }`)
// crossing into/out of the bot driver. No other code in this package should do this ad hoc.

/** Parse a decimal-string id (as it appears in a JSON fixture) into a bigint. */
export function parseFixtureId(id: string): bigint {
  return BigInt(id);
}

/** Convert every bigint-valued field of an object to its decimal-string form for JSON output. */
export function fixtureIdsToJson<T extends Record<string, unknown>>(
  obj: T
): { [K in keyof T]: T[K] extends bigint ? string : T[K] } {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return out as { [K in keyof T]: T[K] extends bigint ? string : T[K] };
}
