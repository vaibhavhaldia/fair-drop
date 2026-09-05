/**
 * FNV-1a 64-bit over UTF-8 bytes. Pure, dependency-free, no `ctx`, no crypto import.
 *
 * Chosen over SHA-256 deliberately (CONTRACT §7 leaves the choice open and says to note it):
 * the verifiability claim is that a *third party* can recompute the draw from published state,
 * and a 12-line hash they can reimplement in any language serves that better than a primitive
 * that drags in `node:crypto` — which is not available inside the SpacetimeDB host anyway.
 *
 * This is not a security primitive and does not need to be. Nothing here resists an adversary;
 * the draw's unpredictability comes from `drawSeed` depending on entries that do not exist
 * until the slot closes (C4), not from the hash being hard to invert.
 */

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** Stable 64-bit digest of a string, as an unsigned bigint. */
export function fnv1a64(input: string): bigint {
  let h = OFFSET;
  const bytes = new TextEncoder().encode(input);
  for (const b of bytes) {
    h = (h ^ BigInt(b)) & MASK;
    h = (h * PRIME) & MASK;
  }
  return h;
}

/** Zero-padded lowercase hex — the form published in `slot_result.drawSeed`. */
export function toHex64(value: bigint): string {
  return (value & MASK).toString(16).padStart(16, '0');
}
