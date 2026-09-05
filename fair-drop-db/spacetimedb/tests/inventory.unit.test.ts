/**
 * `src/pure/inventory.ts` had no test file at all, which is how TC-EVT-12 came to be promised
 * in two documents and implemented in neither. The arithmetic here is four lines long and
 * decides how many tickets exist, so it is worth pinning properly rather than relying on the
 * demo to exercise it — the demo runs one population, and every claim below is about the ones
 * it does not run.
 */

import { describe, expect, it } from 'vitest';
import { InventoryError, effectiveQuota, sizeInventory } from '../src/pure/inventory.ts';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof InventoryError ? e.code : `non-InventoryError: ${String(e)}`;
  }
  return 'DID NOT THROW';
};

describe('TC-EVT-12 — an event can never open with zero tickets', () => {
  it('rejects zero participants', () => {
    expect(codeOf(() => sizeInventory(0, 0.4, 0))).toBe('E_NO_PARTICIPANTS');
  });

  // The gap this file was written for. `round(0.40 x 1) == 0`, so a one-participant queue event
  // passed every guard, reached `open` looking entirely normal, and returned E_SOLD_OUT to
  // every bid. Verified live on 2026-09-06 (fairdrop-scratch event 5) BEFORE this guard existed.
  // DEMO-RECIPE's failure playbook already told the operator "E_NO_PARTICIPANTS should have
  // blocked it", and it did not.
  it('rejects a participant count that rounds down to zero tickets', () => {
    expect(codeOf(() => sizeInventory(1, 0.4, 0))).toBe('E_NO_PARTICIPANTS');
  });

  it('rejects zero-rounding in turn mode too, not just queue', () => {
    expect(codeOf(() => sizeInventory(1, 0.4, 3))).toBe('E_NO_PARTICIPANTS');
  });

  // The guard must key on the ticket count, not on a hardcoded participant floor: at a small
  // enough fraction a large population still rounds to zero.
  it('rejects a large population under a fraction small enough to round to zero', () => {
    expect(codeOf(() => sizeInventory(100, 0.004, 0))).toBe('E_NO_PARTICIPANTS');
  });

  it('admits the smallest population that does yield a ticket', () => {
    expect(sizeInventory(2, 0.4, 0)).toEqual({ totalTickets: 1, baseQuota: [] });
  });

  // Guard order matters: an invalid fraction is the caller's more specific mistake, and
  // reporting it as "no participants" would send them looking in the wrong place.
  it('reports a bad fraction as E_FRACTION_INVALID, not as zero inventory', () => {
    expect(codeOf(() => sizeInventory(10, 0, 0))).toBe('E_FRACTION_INVALID');
    expect(codeOf(() => sizeInventory(10, 1.5, 0))).toBe('E_FRACTION_INVALID');
  });

  it('still treats a malformed participant count as a programmer error, not a sender fault', () => {
    expect(codeOf(() => sizeInventory(-1, 0.4, 0))).toMatch(/^non-InventoryError/);
    expect(codeOf(() => sizeInventory(1.5, 0.4, 0))).toMatch(/^non-InventoryError/);
  });
});

describe('TC-EVT-17 — rounding is half-up, and no demo population exercises it', () => {
  // The demo's populations all divide exactly, so a wrong rounding mode ships green. These are
  // the ones that do not.
  it('rounds a .5 remainder up', () => {
    expect(sizeInventory(5, 0.5, 0).totalTickets).toBe(3); // 2.5 -> 3
  });

  it('rounds below .5 down', () => {
    expect(sizeInventory(11, 0.4, 0).totalTickets).toBe(4); // 4.4 -> 4
  });

  it('sizes the demo population as the recipe expects', () => {
    expect(sizeInventory(50, 0.4, 0).totalTickets).toBe(20);
  });
});

describe('TC-EVT-16 — the remainder goes to the earliest slots', () => {
  it('spreads a remainder forward, never onto the top floor', () => {
    // 10 participants -> 4 tickets over 5 slots. Remainder-to-last would clear slots 0-3 empty
    // and sell the whole event at the top floor, where most wallets do not qualify.
    expect(sizeInventory(10, 0.4, 5).baseQuota).toEqual([1, 1, 1, 1, 0]);
  });

  it('divides exactly when it can', () => {
    expect(sizeInventory(50, 0.4, 5).baseQuota).toEqual([4, 4, 4, 4, 4]);
  });

  // TC-EVT-09's invariant, stated as arithmetic rather than as a single example.
  it('always splits exactly totalTickets across the slots', () => {
    for (let n = 2; n <= 200; n++) {
      for (const slots of [1, 3, 5, 7]) {
        const inv = sizeInventory(n, 0.4, slots);
        const summed = inv.baseQuota.reduce((a, b) => a + b, 0);
        expect(summed).toBe(inv.totalTickets);
        expect(inv.baseQuota).toHaveLength(slots);
      }
    }
  });

  it('returns no quotas at all in queue mode', () => {
    expect(sizeInventory(50, 0.4, 0).baseQuota).toEqual([]);
  });
});

describe('effectiveQuota — rollover adds to base without mutating it', () => {
  it('adds the carried-forward remainder', () => {
    expect(effectiveQuota(4, 2)).toBe(6);
  });

  it('is the identity when nothing was carried — the locked demo parameters', () => {
    expect(effectiveQuota(4, 0)).toBe(4);
  });
});
