import { describe, it, expect, vi } from "vitest";
import { runOneTurnBot, type TurnBotClient } from "../src/turnRunner.ts";

// A scriptable stand-in for a subscribed connection: the test drives the event row forward
// exactly as `close_slot` would, so the bot's slot sequencing is exercised without a live
// instance (CONTRACT §1: reducers are not loadable in vitest, so this is the only tier that
// can cover the loop at all).
function fakeTurn(opts: {
  slotCount: number;
  floors: number[];
  walletBalance: number;
  hasWon?: boolean;
}) {
  const state = {
    event: { state: "open", currentSlotIndex: 0, slotCount: opts.slotCount },
    hasWon: opts.hasWon ?? false,
    walletBalance: opts.walletBalance,
  };
  const submitBid = vi.fn();
  const client: TurnBotClient = {
    join: vi.fn(async () => 1n),
    submitBid,
    getEvent: () => ({ ...state.event }),
    getSlot: (_e, i) => (opts.floors[i] == null ? undefined : { floor: opts.floors[i] }),
    getParticipant: () => ({ walletBalance: state.walletBalance, hasWon: state.hasWon }),
  };
  return { client, state, submitBid };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// TC-BOT-06 — a bot submits at most one entry per slot (client-side; the module's
// E_DUPLICATE_ENTRY is the backstop, TC-BID-02).
describe("TC-BOT-06 — one entry per slot, however long the reaction delay runs", () => {
  it("submits exactly once in a slot that stays open across many poll ticks", async () => {
    const { client, state, submitBid } = fakeTurn({
      slotCount: 1,
      floors: [15_000],
      walletBalance: 100_000,
    });

    const run = runOneTurnBot(client, 1n, 7n, { pollMs: 1, timeoutMs: 3_000 });
    // The slot stays open for ~700ms against a 1ms poll interval: hundreds of loop passes over
    // one slot, all of which must produce exactly one entry. (This does NOT cover a concurrent
    // re-entry during the delay draw — the loop awaits that delay inline, so no such
    // interleaving exists to test.)
    await tick(700);
    state.event.state = "settled";
    await run;

    expect(submitBid).toHaveBeenCalledTimes(1);
    expect(submitBid).toHaveBeenCalledWith(1n, 7n, 0, 15_000);
  });
});

// TC-BOT-04 — a bot with hasWon == true submits nothing in every later slot (C5 client-side).
describe("TC-BOT-04 — a winner goes quiet for the rest of the event", () => {
  it("enters slot 0, wins, and submits nothing in slots 1-2", async () => {
    const { client, state, submitBid } = fakeTurn({
      slotCount: 3,
      floors: [15_000, 22_000, 30_000],
      walletBalance: 100_000,
    });

    const run = runOneTurnBot(client, 1n, 7n, { pollMs: 1, timeoutMs: 5_000 });
    await tick(600); // slot 0 entry lands
    state.hasWon = true; // the draw picked this bot
    state.event.currentSlotIndex = 1;
    await tick(600);
    state.event.currentSlotIndex = 2;
    await tick(600);
    state.event.state = "settled";
    await run;

    expect(submitBid).toHaveBeenCalledTimes(1);
    expect(submitBid.mock.calls[0][2]).toBe(0);
  });
});

// TC-BOT-03 — wallet below the floor means abstain, permanently: floors strictly increase, so
// a bot priced out of slot 1 is priced out of every slot after it. This is the dropout curve
// TC-BOT-08 watches on stage, seen from one bot's side.
describe("TC-BOT-03 — a bot priced out of a floor abstains from then on", () => {
  it("enters slot 0 at 15000 but nothing at 22000 or 30000 on a 20000 wallet", async () => {
    const { client, state, submitBid } = fakeTurn({
      slotCount: 3,
      floors: [15_000, 22_000, 30_000],
      walletBalance: 20_000,
    });

    const run = runOneTurnBot(client, 1n, 7n, { pollMs: 1, timeoutMs: 5_000 });
    await tick(600);
    state.event.currentSlotIndex = 1;
    await tick(600);
    state.event.currentSlotIndex = 2;
    await tick(600);
    state.event.state = "settled";
    await run;

    expect(submitBid).toHaveBeenCalledTimes(1);
    expect(submitBid.mock.calls[0][3]).toBe(15_000);
  });
});
