import { describe, expect, it } from 'vitest';
import { deriveDrawSeed, drawSlot, recomputeWinners, type Entry } from '../src/pure/draw';

const EVENT_ID = 42n;
const SLOT_INDEX = 2;
const QUOTA = 7;

/** 24 entries — above TC-INV-01's floor of 20. Ids are deliberately non-contiguous. */
const ENTRIES: readonly Entry[] = Array.from({ length: 24 }, (_, i) => ({
  id: BigInt(1000 + i * 7),
  participantId: BigInt(500 + i),
}));

/** Deterministic shuffle, so a failure is reproducible from the seed printed in the message. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    // xorshift32 — the test's own RNG, unrelated to the module's determinism story.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('TC-INV-01 — C1: allocation is independent of arrival order', () => {
  it('produces byte-identical allocations across 100 permutations of a 24-entry set', () => {
    const baseline = drawSlot(EVENT_ID, SLOT_INDEX, ENTRIES, QUOTA);
    expect(baseline.winners).toHaveLength(QUOTA);

    for (let seed = 1; seed <= 100; seed++) {
      const permuted = shuffle(ENTRIES, seed);
      const result = drawSlot(EVENT_ID, SLOT_INDEX, permuted, QUOTA);

      // The seed must not move: it is a function of the entry SET, not the insertion order.
      expect(result.drawSeed, `drawSeed moved under shuffle seed ${seed}`).toBe(baseline.drawSeed);

      // Same winners, in the same ranked order, and the same rollover.
      expect(
        result.winners.map(w => [w.id, w.participantId]),
        `winners moved under shuffle seed ${seed}`
      ).toEqual(baseline.winners.map(w => [w.id, w.participantId]));
      expect(result.unfilled).toBe(baseline.unfilled);
    }
  });

  it('is not trivially order-independent — the draw actually reorders the input', () => {
    // Guards against the false green where the "draw" is a no-op that returns entries as given:
    // that would pass the permutation test above for the wrong reason.
    const { winners } = drawSlot(EVENT_ID, SLOT_INDEX, ENTRIES, QUOTA);
    const firstByInsertion = ENTRIES.slice(0, QUOTA).map(e => e.id);
    expect(winners.map(w => w.id)).not.toEqual(firstByInsertion);
  });

  it('selects a different winner set per slot from the same entries', () => {
    // slotIndex is a seed input, so two slots with an identical entry set must not agree.
    const a = drawSlot(EVENT_ID, 0, ENTRIES, QUOTA);
    const b = drawSlot(EVENT_ID, 1, ENTRIES, QUOTA);
    expect(a.drawSeed).not.toBe(b.drawSeed);
  });
});

describe('TC-CLR-09 — verifiability: the draw recomputes from published state alone', () => {
  it('reproduces the winner set from drawSeed + committed entries', () => {
    const committed = drawSlot(EVENT_ID, SLOT_INDEX, ENTRIES, QUOTA);

    // A third party has exactly this: the published seed, the committed entries, the quota.
    // No wallet balances, no timestamps, no arrival order, no module RNG stream.
    const recomputed = recomputeWinners(committed.drawSeed, shuffle(ENTRIES, 99), QUOTA);

    expect(recomputed.map(w => [w.id, w.participantId])).toEqual(
      committed.winners.map(w => [w.id, w.participantId])
    );
  });

  it('lets a verifier re-derive the published seed independently', () => {
    const committed = drawSlot(EVENT_ID, SLOT_INDEX, ENTRIES, QUOTA);
    const rederived = deriveDrawSeed(
      EVENT_ID,
      SLOT_INDEX,
      shuffle(ENTRIES, 7).map(e => e.id)
    );
    expect(rederived).toBe(committed.drawSeed);
  });

  it('detects a tampered entry set', () => {
    // If the module dropped an entry after publishing the seed, recomputation must diverge —
    // otherwise the seed proves nothing about which entries were actually in the draw.
    const committed = drawSlot(EVENT_ID, SLOT_INDEX, ENTRIES, QUOTA);
    const tampered = deriveDrawSeed(EVENT_ID, SLOT_INDEX, ENTRIES.slice(1).map(e => e.id));
    expect(tampered).not.toBe(committed.drawSeed);
  });
});

// -----------------------------------------------------------------------------------------
// v4 — blind bidding. An entry now carries the amount its bidder committed, and the slot
// resolves in DECREASING price order. The hash draw does not disappear: it decides the order
// WITHIN a price tier, which is where C1 now lives. Two people who bid the same amount are
// still separated by something neither of them can influence by bidding earlier.
// -----------------------------------------------------------------------------------------
describe('TC-CLR-13 — blind bidding resolves in decreasing price order', () => {
  const priced = (specs: readonly [bigint, number][]): Entry[] =>
    specs.map(([id, price]) => ({ id, participantId: id + 1000n, price }));

  const SPREAD: readonly [bigint, number][] = [
    [10n, 41_200], [11n, 91_000], [12n, 52_000], [13n, 74_500], [14n, 38_000],
  ];

  // 12 distinct prices, deliberately: with 5 entries a hash-only ranking lands on descending
  // price by coincidence about once in 120 runs, and a test that can pass before the feature
  // exists is not a test. At 12 the odds are 1 in 479,001,600.
  const LADDER: readonly [bigint, number][] = Array.from({ length: 12 }, (_, i): [bigint, number] =>
    [BigInt(700 + i * 13), 30_000 + i * 4_500]);

  it('ranks strictly by price, highest first, regardless of entry order', () => {
    const descending = [...LADDER].map(([, price]) => price).sort((a, b) => b - a).slice(0, 8);
    for (const seed of [0, 3, 17]) {
      const shuffled = seed === 0 ? priced(LADDER) : shuffle(priced(LADDER), seed);
      const result = drawSlot(EVENT_ID, SLOT_INDEX, shuffled, 8);
      expect(result.winners.map(w => w.price)).toEqual(descending);
    }
    // The entries that lose are the four cheapest — not a random four.
    const losers = drawSlot(EVENT_ID, SLOT_INDEX, priced(LADDER), 8).winners.map(w => w.price);
    expect(Math.min(...losers)).toBe(30_000 + 4 * 4_500);
  });

  it('reports the cutoff — the LOWEST winning bid, which is what slot_result publishes', () => {
    expect(drawSlot(EVENT_ID, SLOT_INDEX, priced(SPREAD), 4).cutoffPrice).toBe(41_200);
  });

  it('reports the lowest bid taken when the slot does not fill', () => {
    const result = drawSlot(EVENT_ID, SLOT_INDEX, priced([[10n, 30_000], [11n, 44_000]]), 5);
    expect(result.winners).toHaveLength(2);
    expect(result.unfilled).toBe(3);
    expect(result.cutoffPrice).toBe(30_000);
  });

  it('leaves cutoffPrice null when nobody entered', () => {
    expect(drawSlot(EVENT_ID, SLOT_INDEX, [], 5).cutoffPrice).toBeNull();
  });

  it('is still arrival-order independent within a price tier (C1 survives)', () => {
    // Every entry at the same price: the slot is decided entirely by the hash draw, exactly as
    // v3 decided every slot. This is the case that would silently regress to "first come" if
    // the sort were not stable under permutation.
    const tied = priced(Array.from({ length: 24 }, (_, i): [bigint, number] =>
      [BigInt(1000 + i * 7), 30_000]));
    const baseline = drawSlot(EVENT_ID, SLOT_INDEX, tied, QUOTA).winners.map(w => w.id);
    for (let seed = 1; seed <= 100; seed++) {
      expect(drawSlot(EVENT_ID, SLOT_INDEX, shuffle(tied, seed), QUOTA).winners.map(w => w.id))
        .toEqual(baseline);
    }
  });

  it('does not let arrival order break a tie at the cutoff', () => {
    // Three entries at 50_000 compete for the one remaining seat under quota 3. Whichever the
    // hash picks, it must be the same one under every permutation.
    const entries = priced([[20n, 90_000], [21n, 60_000], [22n, 50_000], [23n, 50_000], [24n, 50_000]]);
    const baseline = drawSlot(EVENT_ID, SLOT_INDEX, entries, 3).winners.map(w => w.id);
    for (let seed = 1; seed <= 50; seed++) {
      expect(drawSlot(EVENT_ID, SLOT_INDEX, shuffle(entries, seed), 3).winners.map(w => w.id))
        .toEqual(baseline);
    }
  });

  it('recomputes the same winners from published state alone', () => {
    const result = drawSlot(EVENT_ID, SLOT_INDEX, priced(SPREAD), 4);
    expect(recomputeWinners(result.drawSeed, shuffle(priced(SPREAD), 9), 4).map(w => w.id))
      .toEqual(result.winners.map(w => w.id));
  });
});
