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
