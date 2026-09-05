/**
 * FNV-1a 64-bit over UTF-8 bytes, followed by a SplitMix64 avalanche finalizer.
 *
 * Chosen over SHA-256 deliberately (CONTRACT §7 leaves the choice open and says to note it):
 * the verifiability claim is that a *third party* can recompute the draw from published state,
 * and a ~20-line hash they can reimplement in any language serves that better than a primitive
 * that drags in `node:crypto` — which is not available inside the SpacetimeDB host anyway.
 *
 * This is not a security primitive and does not need to be. Nothing here resists an adversary;
 * the draw's unpredictability comes from `drawSeed` depending on entries that do not exist
 * until the slot closes (C4), not from the hash being hard to invert.
 *
 * ⚠ THE FINALIZER IS LOAD-BEARING — do not remove it to "simplify". See `mix64` below.
 */

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/**
 * Raw FNV-1a. **Not suitable for the draw on its own** — see `digest64`.
 *
 * Exported only so the finalizer's contribution stays visible and testable in isolation.
 */
export function fnv1a64(input: string): bigint {
  let h = OFFSET;
  const bytes = new TextEncoder().encode(input);
  for (const b of bytes) {
    h = (h ^ BigInt(b)) & MASK;
    h = (h * PRIME) & MASK;
  }
  return h;
}

/**
 * SplitMix64 finalizer — the reason this file is not ten lines shorter.
 *
 * FNV-1a's last operation is `h = (h ^ lastByte) * PRIME`, so inputs differing only in their
 * trailing bytes produce outputs differing in a small, structured way: it has almost no
 * avalanche on the tail of its input. The draw ranks by `hash(drawSeed + ":" + entry.id)`,
 * and entry ids are sequential `autoInc` primary keys differing only at the end — so raw
 * FNV-1a ranks entries in very nearly *id* order, and `bid.id` is assigned in insertion order,
 * which is arrival order. That is C1 violated through the back door (CONTRACT §7).
 *
 * Measured on 24 sequential ids over 24,000 draws, before and after:
 *
 *   | | raw FNV-1a | with mix64 | uniform |
 *   | mean rank-gap between consecutive ids | 2.59   | 8.34        | 8.33 |
 *   | rank-1 share, min..max                | 0..12.7% | 4.00..4.37% | 4.17% |
 *   | ids that NEVER place first            | 6 of 24 | 0          | 0    |
 *   | chi-square, 23 dof (p=0.05 at 35.2)   | 19569  | 15.5        | ~23  |
 *
 * TC-CLR-11 guards this. It is a P0 case that was cut in the 4h re-plan and restored after the
 * bias was found on 2026-09-05; the cut is why the bug shipped. TC-INV-01 cannot catch it —
 * permuting the input array never changes the ids inside it.
 */
export function mix64(h: bigint): bigint {
  h = (h ^ (h >> 33n)) & MASK;
  h = (h * 0xff51afd7ed558ccdn) & MASK;
  h = (h ^ (h >> 33n)) & MASK;
  h = (h * 0xc4ceb9fe1a85ec53n) & MASK;
  return (h ^ (h >> 33n)) & MASK;
}

/**
 * The draw's hash: FNV-1a then avalanche. **Use this, not `fnv1a64`.**
 *
 * `integration/verify/recompute.mjs` reimplements this from scratch; the two must agree
 * byte-for-byte or TC-CLR-09's verifiability claim is void. Change one, change both.
 */
export function digest64(input: string): bigint {
  return mix64(fnv1a64(input));
}

/** Zero-padded lowercase hex — the form published in `slot_result.drawSeed`. */
export function toHex64(value: bigint): string {
  return (value & MASK).toString(16).padStart(16, '0');
}
