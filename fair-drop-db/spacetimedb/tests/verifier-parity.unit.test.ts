/**
 * TC-CLR-09 — the verifier is INDEPENDENT of the module. (P0, `acceptance/test-cases.md`.)
 *
 * WHY THIS FILE EXISTS, separately from `draw.unit.test.ts`:
 *
 * `draw.unit.test.ts`'s TC-CLR-09 block imports `recomputeWinners` and `deriveDrawSeed` from
 * `../src/pure/draw` and checks they reproduce a draw made by that same module. That proves
 * the module agrees with ITSELF, which is exactly the failure `integration/verify/recompute.mjs`
 * calls out in its own header: "if this file had to import the module's own code, it would
 * prove only that the module agrees with itself."
 *
 * The verifiability claim is that a THIRD PARTY, holding only published state and their own
 * from-scratch reimplementation, recomputes the same winners. The only artefact that can
 * support that claim is `recompute.mjs`, which imports nothing. Until this file existed,
 * nothing in `npm test` loaded it — the two hash implementations could drift apart and every
 * test would stay green while TC-CLR-09 was void. `scripts/smoke.sh` checked it, but only
 * when `node --experimental-strip-types` happened to be available, and skipped silently
 * otherwise.
 *
 * This is the same defect class as the avalanche bug: a claim with no test behind it.
 * See CONTRACT §7's rule — every invariant names the test that enforces it, or says plainly
 * that nothing does.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveDrawSeed, rankEntries, type Entry } from '../src/pure/draw.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFIER = resolve(REPO, 'integration/verify/recompute.mjs');

/** Drive the standalone verifier as a third party would: argv in, stdout out. */
function verifier(args: string[]): string {
  return execFileSync('node', [VERIFIER, ...args], { encoding: 'utf8', cwd: REPO });
}

/** Non-contiguous ids, as `autoInc` leaves them once other events have interleaved. */
const IDS = [1000n, 1007n, 1014n, 1021n, 1099n, 1234n, 5n];
const EVENT_ID = 42n;
const SLOT_INDEX = 2;

describe('TC-CLR-09 — recompute.mjs is a real independent check on the module', () => {
  it('re-derives the module drawSeed from the entry set alone', () => {
    const expected = deriveDrawSeed(EVENT_ID, SLOT_INDEX, IDS);

    const out = verifier([
      '--event', String(EVENT_ID),
      '--slot', String(SLOT_INDEX),
      '--ids', IDS.join(','),
    ]);

    expect(out).toContain(`derived drawSeed: ${expected}`);
  });

  it('reproduces the module winner set in the module ranking order', () => {
    const seed = deriveDrawSeed(EVENT_ID, SLOT_INDEX, IDS);
    const entries: Entry[] = IDS.map(id => ({ id, participantId: id, price: 0 }));
    const quota = 4;
    const expected = rankEntries(seed, entries).slice(0, quota).map(e => e.id);

    const out = verifier([
      '--seed', seed,
      '--quota', String(quota),
      '--ids', IDS.join(','),
    ]);

    // The verifier prints "  1. bid 1099" in draw order; read the ids back out in that order.
    const got = [...out.matchAll(/^\s*\d+\.\s+bid\s+(\d+)$/gm)].map(m => BigInt(m[1]));
    expect(got).toEqual(expected);
  });

  it('agrees with the module on the PRICED ranking, not just the hash', () => {
    // The parity that matters after v4. Bare ids exercise only the tie-break path — if the
    // verifier never learned about price it would still pass every other case in this file
    // while disagreeing with the module about every real slot.
    const priced: Entry[] = IDS.map((id, i) => ({
      id,
      participantId: id,
      // Two entries share 55_000 on purpose, so the tie-break is exercised inside a priced set.
      price: [91_000, 55_000, 74_500, 30_000, 55_000, 41_200, 62_000][i],
    }));
    const seed = deriveDrawSeed(EVENT_ID, SLOT_INDEX, IDS);
    const quota = 5;
    const expected = rankEntries(seed, priced).slice(0, quota).map(e => e.id);

    const out = verifier([
      '--seed', seed,
      '--quota', String(quota),
      '--ids', priced.map(e => `${e.id}:${e.price}`).join(','),
    ]);

    const got = [...out.matchAll(/^\s*\d+\.\s+bid\s+(\d+)$/gm)].map(m => BigInt(m[1]));
    expect(got).toEqual(expected);
    // And it must report the cutoff a third party would quote back at us.
    expect(out).toContain(`cutoff (lowest winning bid): ${
      priced.find(e => e.id === expected[expected.length - 1])!.price}`);
  });

  it('agrees with the module across many independent slots, not one lucky vector', () => {
    // A single vector can pass while the two hashes differ on almost every other input —
    // the avalanche bug itself agreed with a correct implementation on plenty of inputs.
    // Every slot here is a separate seed AND a separate entry set.
    for (let s = 0; s < 12; s++) {
      const ids = IDS.map(id => id + BigInt(s * 37));
      const expected = deriveDrawSeed(BigInt(s), s % 5, ids);
      const out = verifier(['--event', String(s), '--slot', String(s % 5), '--ids', ids.join(',')]);
      expect(out, `slot ${s}`).toContain(`derived drawSeed: ${expected}`);
    }
  });

  it('reports a MISMATCH when the published seed does not belong to the entry set', () => {
    // The verifier is only worth running if it can also say "no". A seed from a different
    // slot must be rejected against these entries, or ✅ MATCH means nothing.
    const wrongSeed = deriveDrawSeed(EVENT_ID, SLOT_INDEX + 1, IDS);
    let stdout = '';
    let failed = false;
    try {
      stdout = verifier([
        '--event', String(EVENT_ID),
        '--slot', String(SLOT_INDEX),
        '--seed', wrongSeed,
        '--ids', IDS.join(','),
      ]);
    } catch (e: any) {
      failed = true;
      stdout = e.stdout ?? '';
    }
    expect(stdout).toContain('MISMATCH');
    expect(failed, 'a mismatch must be a non-zero exit, not just a message').toBe(true);
  });
});
