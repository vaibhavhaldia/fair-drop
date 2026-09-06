// Bot driver — N bots per human as async tasks in ONE process, sharing the event loop.
// Process count stays independent of bot count. CONTRACT.md §3, task file "Bot driver". Wired
// to the real FairDropClient in Gate 2; here `BotClient` is the minimal subset of the SDK
// surface a bot needs, so this module builds and tests against fixtures/mocks before the
// module exists.

import { queueDelayMs, turnDecision, type TurnInput } from "./decide.ts";

export interface BotClient {
  join(eventId: bigint, displayName: string, origin: "bot"): Promise<bigint>;
  submitBid(eventId: bigint, participantId: bigint, slotIndex: number, price: number): void;
  /**
   * Optional: resolves once the event has reached `state == "open"`. Real usage (Gate 2)
   * joins during `created`, then the admin calls `start_countdown` and `open_event` — task
   * file's "Bots poll for state == 'open'" — so a bot must wait before its delay+bid draw.
   * The fixture client and existing mocks omit this: they don't model event lifecycle, so a
   * bot bids immediately, matching Gate 1 behaviour exactly.
   */
  waitForOpen?(eventId: bigint): Promise<void>;
}

/**
 * Does `err` carry `code`? Matches on the error's *text*, because that is the only carrier the
 * real transport has. `join` is a procedure, and the SpacetimeDB SDK rejects a failed procedure
 * call with the raw `ProcedureStatus::InternalError` payload — a plain **string** — while
 * reducers reject with a `SenderError`, an `Error` whose only carrier is `.message`. Neither
 * has a `.code` property: an `err.code === "E_HANDLE_COLLISION"` check can never fire in
 * production, so the retry below would be dead code (module `index.ts`'s join comment —
 * "a bot pool matching on the documented code would never match" — is the reason the module
 * throws the documented code itself; matching it here is the other half of that).
 *
 * Substring, not equality: the host may frame the thrown code (`"Error: E_HANDLE_COLLISION\n
 * at ..."`). The codes in CONTRACT.md §9 are distinct `E_`-prefixed tokens, so a substring hit
 * is unambiguous.
 */
function hasCode(err: unknown, code: string): boolean {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null
          ? String((err as { message?: unknown }).message ?? "")
          : "";
  return text.includes(code);
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

  if (client.waitForOpen) {
    try {
      await client.waitForOpen(eventId);
    } catch {
      // A bot that gave up waiting drops out quietly. It must NOT propagate: every bot runs
      // inside one `Promise.all`, so a single rejection would abort every other bot mid-flight
      // — turning one slow start into a dead round. Dropping out costs one bot.
      return;
    }
  }

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
 *
 * `client` may be a single shared `BotClient` (Gate 1 fixture usage, and every existing test)
 * or a factory invoked once per bot (Gate 2 real usage: CONTRACT.md §9 — "40 bots get one
 * connection each" — each bot gets its own `FairDropClient` connection, still all as async
 * tasks in this one process).
 */
export async function runQueueBots(
  client: BotClient | (() => Promise<BotClient>),
  opts: { eventId: bigint; ticketPrice: number; count: number }
): Promise<void> {
  const getClient: () => Promise<BotClient> =
    typeof client === "function" ? client : () => Promise.resolve(client);
  await Promise.all(
    Array.from({ length: opts.count }, async () => {
      const c = await getClient();
      return runOneQueueBot(c, opts.eventId, opts.ticketPrice);
    })
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
