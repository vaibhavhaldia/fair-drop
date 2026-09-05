// Turn-mode bot driver — the Round 2 counterpart to `runQueueBots`, added at Gate 3 because
// Gate 2 wired queue mode only and `DEMO-RECIPE.md` Stage 2 cannot be driven by hand
// (H humans is typeable; 4H bots across five slots is not).
//
// The per-slot DECISION is not here — it is `turnDecision` in `decide.ts`, called through
// `runOneTurnBotSlot` in `runner.ts`, both already covered by TC-BOT-02/03/04. What this file
// adds is only the SEQUENCING: notice which slot is current, act once in it, wait for the next.
// Keeping those apart is deliberate; the decision is the part the demo's claim rests on and it
// stays trivial (task file: "Do not add strategy; its absence is the finding, not a gap").

import { queueDelayMs } from "./decide.ts";
import { joinBotWithRetry, runOneTurnBotSlot, type BotClient } from "./runner.ts";

/**
 * The read surface a turn-mode bot needs on top of `BotClient`. Turn mode is stateful in a way
 * queue mode is not: a bot must know which slot is open, that slot's floor, and its own
 * wallet/hasWon — and every one of those is a subscribed row, never a client-side computation
 * (task file "Display": "Never compute a balance client-side").
 */
export interface TurnView {
  getEvent(eventId: bigint): { state: string; currentSlotIndex: number; slotCount: number } | undefined;
  getSlot(eventId: bigint, slotIndex: number): { floor: number } | undefined;
  getParticipant(participantId: bigint): { walletBalance: number; hasWon: boolean } | undefined;
}

export type TurnBotClient = BotClient & TurnView;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type TurnBotOpts = {
  /** How often to re-read the subscribed event row to notice a slot change. */
  pollMs?: number;
  /** Hard stop, so a hung event cannot keep the process alive forever. */
  timeoutMs?: number;
};

/**
 * Run one bot through every slot of a turn event: act once per slot index, then wait for the
 * module to advance. Returns when the event settles (or the deadline passes).
 *
 * The `queueDelayMs()` draw before each entry is NOT decoration — TC-BOT-07 requires bot effort
 * to be identical across modes ("same reaction speed and same call cadence in queue and turn
 * mode"). The demo's claim is that turn mode neutralises the speed advantage *without the bot
 * behaving differently*; a bot that politely slowed down in Round 2 would be assuming the
 * conclusion, and the Round 2 result would prove nothing.
 */
export async function runOneTurnBot(
  client: TurnBotClient,
  eventId: bigint,
  participantId: bigint,
  opts: TurnBotOpts = {}
): Promise<void> {
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  const acted = new Set<number>();

  while (Date.now() < deadline) {
    const event = client.getEvent(eventId);
    if (event?.state === "settled") return;

    if (event?.state === "open") {
      const slotIndex = event.currentSlotIndex;
      const slot = client.getSlot(eventId, slotIndex);
      const self = client.getParticipant(participantId);

      if (slot != null && self != null && !acted.has(slotIndex)) {
        acted.add(slotIndex);
        // Claimed before the delay rather than after. This loop is sequential — it awaits the
        // delay inline, so no second poll tick can reach this slot meanwhile, and either order
        // behaves identically today (verified: inverting it fails no test). It is written this
        // way so that it stays correct if the delay is ever moved off the loop's critical path.
        await sleep(queueDelayMs());

        // Re-read after the delay: hasWon/walletBalance may have moved while we waited, and
        // acting on the pre-delay snapshot is exactly the stale-read bug C5 exists to catch.
        const fresh = client.getParticipant(participantId) ?? self;
        const stillOpen = client.getEvent(eventId);
        if (stillOpen?.state === "open" && stillOpen.currentSlotIndex === slotIndex) {
          await runOneTurnBotSlot(client, eventId, participantId, slotIndex, {
            hasWon: fresh.hasWon,
            walletBalance: fresh.walletBalance,
            floor: slot.floor,
          });
        }
      }
    }

    await sleep(pollMs);
  }
}

export type JoinedTurnBot = { client: TurnBotClient; participantId: bigint };

/**
 * Phase 1 — connect `count` bots and register every one of them, as concurrent async tasks in
 * ONE process (the constraint `runQueueBots` also honours; LLD §5a calls a per-bot process "not
 * survivable on a demo rig"). `clientFactory` is invoked once per bot because CONTRACT.md §9
 * gives each bot its own connection.
 *
 * Joining is a separate call from bidding, and that seam is load-bearing: inventory is derived
 * from the headcount at `start_countdown` and *only* that instant (CONTRACT §6), so the admin
 * must not start the countdown until this resolves. A driver that joined and bid in one call
 * would race the operator and silently size the event off a partial field.
 */
export async function joinTurnBots(
  clientFactory: () => Promise<TurnBotClient>,
  opts: { eventId: bigint; count: number }
): Promise<JoinedTurnBot[]> {
  const clients = await Promise.all(
    Array.from({ length: opts.count }, () => clientFactory())
  );
  const ids = await Promise.all(clients.map((c) => joinBotWithRetry(c, opts.eventId)));

  return clients
    .map((client, i) => ({ client, participantId: ids[i] }))
    .filter((b): b is JoinedTurnBot => b.participantId !== undefined);
}

/** Phase 2 — run every joined bot through all five slots, concurrently, until the event settles. */
export async function runTurnBots(
  bots: JoinedTurnBot[],
  opts: { eventId: bigint } & TurnBotOpts
): Promise<void> {
  await Promise.all(
    bots.map((b) => runOneTurnBot(b.client, opts.eventId, b.participantId, opts))
  );
}
