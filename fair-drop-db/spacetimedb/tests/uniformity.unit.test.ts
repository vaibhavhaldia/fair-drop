/**
 * TC-CLR-11 — Uniformity of the draw (P0, `acceptance/test-cases.md:316`).
 *
 * "Over 500 synthetic slots with the same participant set, each participant's win rate is
 *  statistically indistinguishable from `quota / entries` (χ² or binomial CI). In particular
 *  the earliest-joined participant has no edge — the 'join-order-in-disguise' failure."
 *
 * WHY THIS FILE EXISTS, given `saksham.md` says to write exactly two tests: it was cut in the
 * 4h re-plan on the reasoning that TC-INV-01 carried C1 by itself. It does not. TC-INV-01
 * permutes the input *array*, which never changes the ids inside it — so it is structurally
 * blind to an allocator whose ordering correlates with `bid.id`. Since `bid.id` is a
 * sequential `autoInc` PK (CONTRACT.md:79), that correlation IS arrival order, and raw FNV-1a
 * produced it: 6 of 24 entries could never place first. Restored 2026-09-05 with the fix.
 *
 * C1 has two failure modes. TC-INV-01 covers "reads arrival order directly"; this covers
 * "reads something that correlates with arrival order". Neither substitutes for the other.
 */

import { describe, expect, it } from 'vitest';
import { deriveDrawSeed, rankEntries, type Entry } from '../src/pure/draw';
import { fnv1a64, digest64 } from '../src/pure/hash';

/** Sequential ids, exactly as `autoInc` assigns them in arrival order. */
const N = 24;
const QUOTA = 6;
const SLOTS = 500;
const ENTRIES: readonly Entry[] = Array.from({ length: N }, (_, i) => ({
  id: BigInt(i + 1),
  participantId: BigInt(i + 1),
}));

/** Run `slots` synthetic draws over the same entry set, varying only the seed inputs. */
function winCounts(slots: number): number[] {
  const counts = new Array<number>(N).fill(0);
  for (let s = 0; s < slots; s++) {
    const seed = deriveDrawSeed(BigInt(s), s % 5, ENTRIES.map(e => e.id));
    for (const w of rankEntries(seed, ENTRIES).slice(0, QUOTA)) {
      counts[Number(w.id) - 1]++;
    }
  }
  return counts;
}

describe('TC-CLR-11 — the draw is uniform over entries', () => {
  it('gives every entry a win rate indistinguishable from quota/entries', () => {
    const counts = winCounts(SLOTS);
    const expected = (SLOTS * QUOTA) / N;

    // χ² with N-1 = 23 dof. Critical value at p=0.001 is 49.7; we assert well inside that,
    // so a genuinely uniform hash passes with room and a biased one fails by orders of
    // magnitude (raw FNV-1a scored ~19,600 here, not ~50).
    const chiSquare = counts.reduce((acc, o) => acc + (o - expected) ** 2 / expected, 0);
    expect(chiSquare, `win counts: ${counts.join(',')}`).toBeLessThan(49.7);

    // No entry is ever shut out, and none runs away with it. Kept alongside χ² because it is
    // the form the failure actually took, and it reads as an obvious defect in a diff.
    for (const [i, c] of counts.entries()) {
      expect(c, `entry id ${i + 1} won ${c} of ${SLOTS} slots (expected ~${expected})`)
        .toBeGreaterThan(expected * 0.5);
      expect(c, `entry id ${i + 1} won ${c} of ${SLOTS} slots (expected ~${expected})`)
        .toBeLessThan(expected * 1.5);
    }
  });

  it('gives the earliest-joined entry no edge over the latest', () => {
    // The named "join-order-in-disguise" case: lowest id vs highest id, head to head.
    const counts = winCounts(SLOTS);
    const expected = (SLOTS * QUOTA) / N;
    expect(Math.abs(counts[0] - expected)).toBeLessThan(expected * 0.4);
    expect(Math.abs(counts[N - 1] - expected)).toBeLessThan(expected * 0.4);
  });

  it('does not rank consecutive ids into adjacent positions', () => {
    // Direct probe of avalanche. For a uniform permutation of N, the mean absolute rank gap
    // between two distinct entries is (N+1)/3 = 8.33. Raw FNV-1a scored 2.59 — consecutive
    // ids landing next to each other, which is id order leaking into the ranking.
    let total = 0;
    let pairs = 0;
    for (let s = 0; s < SLOTS; s++) {
      const seed = deriveDrawSeed(BigInt(s), s % 5, ENTRIES.map(e => e.id));
      const ranked = rankEntries(seed, ENTRIES);
      const pos = new Array<number>(N);
      ranked.forEach((e, r) => (pos[Number(e.id) - 1] = r));
      for (let i = 0; i + 1 < N; i++) {
        total += Math.abs(pos[i] - pos[i + 1]);
        pairs++;
      }
    }
    expect(total / pairs).toBeGreaterThan(7.5); // uniform expects 8.33
  });
});

describe('TC-CLR-11 — the finalizer is what provides the property', () => {
  it('raw FNV-1a is demonstrably biased, so mix64 cannot be dropped as redundant', () => {
    // Pins the reason `hash.ts` is not ten lines shorter. If someone "simplifies" digest64
    // back to raw FNV-1a, the tests above fail — this one explains why in one place.
    const gap = (hash: (s: string) => bigint) => {
      let total = 0;
      let pairs = 0;
      for (let s = 0; s < 200; s++) {
        const seed = `${s}`;
        const ranked = [...ENTRIES]
          .map(e => ({ e, key: hash(`${seed}:${e.id}`) }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          .map(x => x.e);
        const pos = new Array<number>(N);
        ranked.forEach((e, r) => (pos[Number(e.id) - 1] = r));
        for (let i = 0; i + 1 < N; i++) {
          total += Math.abs(pos[i] - pos[i + 1]);
          pairs++;
        }
      }
      return total / pairs;
    };
    expect(gap(fnv1a64)).toBeLessThan(4); // the bug
    expect(gap(digest64)).toBeGreaterThan(7.5); // the fix
  });
});
