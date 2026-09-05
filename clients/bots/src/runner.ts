// Bot driver — N bots per human as async tasks in ONE process, sharing the event loop.
// Process count stays independent of bot count. CONTRACT.md §3, task file "Bot driver". Wired
// to the real FairDropClient in Gate 2; here `BotClient` is the minimal subset of the SDK
// surface a bot needs, so this module builds and tests against fixtures/mocks before the
// module exists.

import { queueDelayMs, turnDecision, type TurnInput } from "./decide.ts";

export interface BotClient {
  join(eventId: bigint, displayName: string, origin: "bot"): Promise<bigint>;
  submitBid(eventId: bigint, participantId: bigint, slotIndex: number, price: number): void;
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/** `Bot-<random>` display name, per join's handle scheme (CONTRACT.md §2). */
export function randomBotHandle(): string {
  return `Bot-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Join as a bot, regenerating the handle suffix and retrying on E_HANDLE_COLLISION — the only
 * error a bot handles specially. Every other join error is swallowed: the bot gives up and
 * resolves to `undefined` rather than taking down the whole run.
 */
export async function joinBotWithRetry(
  client: BotClient,
  eventId: bigint,
  maxAttempts = 20
): Promise<bigint | undefined> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await client.join(eventId, randomBotHandle(), "bot");
    } catch (err) {
      if (hasCode(err, "E_HANDLE_COLLISION")) {
        continue; // regenerate suffix on next iteration and retry
      }
      return undefined; // E_EVENT_SETTLED or anything else: swallow, move on
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOneQueueBot(
  client: BotClient,
  eventId: bigint,
  ticketPrice: number
): Promise<void> {
  const participantId = await joinBotWithRetry(client, eventId);
  if (participantId === undefined) return;

  await sleep(queueDelayMs()); // independent per-bot draw on [0, DELTA_MS] — never fixed

  try {
    client.submitBid(eventId, participantId, 0, ticketPrice);
  } catch {
    // E_INSUFFICIENT_BALANCE is normal traffic; every other code is swallowed too —
    // E_HANDLE_COLLISION is the only error a bot handles specially, and that's at join.
  }
}

/**
 * Run `count` queue-mode bots as concurrent async tasks in this process. Process count is
 * independent of `count` — there is no per-bot process or worker here, only Promise.all over
 * async functions sharing the event loop.
 */
export async function runQueueBots(
  client: BotClient,
  opts: { eventId: bigint; ticketPrice: number; count: number }
): Promise<void> {
  await Promise.all(
    Array.from({ length: opts.count }, () => runOneQueueBot(client, opts.eventId, opts.ticketPrice))
  );
}

/**
 * Turn-mode bot for a single slot decision. Deliberately trivial (see decide.ts) — this just
 * wires the decision to the call, it adds no logic of its own.
 */
export async function runOneTurnBotSlot(
  client: BotClient,
  eventId: bigint,
  participantId: bigint,
  slotIndex: number,
  input: TurnInput
): Promise<void> {
  const decision = turnDecision(input);
  if (decision.action !== "bid") return;
  try {
    client.submitBid(eventId, participantId, slotIndex, decision.price);
  } catch {
    // swallow — E_INSUFFICIENT_BALANCE etc. are normal traffic, and the wallet/hasWon guard
    // is re-checked server-side (C5) regardless of what this client believes.
  }
}
