#!/usr/bin/env node
/**
 * Fair Drop — standalone draw verifier (DEMO-RECIPE Stage 3).
 *
 * This is the script you run on stage after reading a `drawSeed` out of `slot_result`.
 *
 * It deliberately **imports nothing** — not the module, not its pure draw, not a hash library.
 * The 10 lines of FNV-1a below are a from-scratch reimplementation. That is the entire point:
 * if this file had to import the module's own code, it would prove only that the module agrees
 * with itself. A verifier an auditor could have written in any language is the claim.
 *
 * Usage — recompute a slot's winners from published state:
 *   node integration/verify/recompute.mjs \
 *     --seed <drawSeed> --quota <effectiveQuota> --ids 1000,1007,1014,...
 *
 * Usage — independently re-derive the seed the module published:
 *   node integration/verify/recompute.mjs \
 *     --event <eventId> --slot <slotIndex> --ids 1000,1007,1014,...
 *
 * Get the inputs with:
 *   spacetime sql --server local fairdrop \
 *     "SELECT slotIndex, drawSeed, allocated FROM slot_result"
 *   spacetime sql --server local fairdrop \
 *     "SELECT id, participantId FROM bid WHERE eventId = 1 AND slotIndex = 0"
 */

const MASK = 0xffffffffffffffffn;

function fnv1a64(input) {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(input)) {
    h = (h ^ BigInt(b)) & MASK;
    h = (h * 0x100000001b3n) & MASK;
  }
  return h;
}

// SplitMix64 finalizer. NOT optional: raw FNV-1a barely avalanches on the tail of its input,
// and bid ids are sequential autoInc PKs differing only at the end — so without this the
// ranking follows id order, which is arrival order, and C1 is violated through the back door.
// The module's src/pure/hash.ts carries the same five lines and the measurements. TC-CLR-11.
function mix64(h) {
  h = (h ^ (h >> 33n)) & MASK;
  h = (h * 0xff51afd7ed558ccdn) & MASK;
  h = (h ^ (h >> 33n)) & MASK;
  h = (h * 0xc4ceb9fe1a85ec53n) & MASK;
  return (h ^ (h >> 33n)) & MASK;
}

const digest64 = s => mix64(fnv1a64(s));

const hex64 = v => (v & MASK).toString(16).padStart(16, '0');

const deriveSeed = (eventId, slotIndex, ids) =>
  hex64(digest64(`${eventId}:${slotIndex}:${[...ids].sort(cmp).join(',')}`));

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Rank by hash(seed, id) ascending, ties on id ascending. */
function rank(seed, ids) {
  return ids
    .map(id => ({ id, key: digest64(`${seed}:${id}`) }))
    .sort((a, b) => (a.key !== b.key ? cmp(a.key, b.key) : cmp(a.id, b.id)))
    .map(e => e.id);
}

// --- args -------------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

if (!args.ids) {
  console.error('error: --ids is required (comma-separated bid ids)\n');
  console.error(process.argv[1].endsWith('.mjs') ? 'see the header of this file for usage' : '');
  process.exit(2);
}

const ids = args.ids.split(',').map(s => BigInt(s.trim()));

if (args.event !== undefined && args.slot !== undefined) {
  const seed = deriveSeed(BigInt(args.event), Number(args.slot), ids);
  console.log(`derived drawSeed: ${seed}`);
  if (args.seed) {
    const ok = seed === args.seed;
    console.log(`published drawSeed: ${args.seed}`);
    console.log(ok ? '\n✅ MATCH — the module published the seed for exactly these entries'
                   : '\n❌ MISMATCH — the entry set does not produce the published seed');
    if (!ok) process.exit(1);
  }
  if (args.quota === undefined) process.exit(0);
}

const seed = args.seed ?? deriveSeed(BigInt(args.event ?? 0), Number(args.slot ?? 0), ids);
const quota = Number(args.quota ?? ids.length);
const winners = rank(seed, ids).slice(0, quota);

console.log(`\nseed   ${seed}`);
console.log(`quota  ${quota} of ${ids.length} entries\n`);
console.log('winners, in the order the draw ranked them:');
for (const [i, id] of winners.entries()) console.log(`  ${String(i + 1).padStart(3)}. bid ${id}`);
if (winners.length < quota) console.log(`\nunfilled: ${quota - winners.length} (rolls forward)`);
