// Adapts `clients/sdk`'s `FairDropClient` onto the `BotClient` shape `runner.ts` expects.
// Lives here, not in `clients/sdk`, because CONTRACT.md §3 keeps the SDK a thin wrapper with
// "no logic of its own" — `waitForOpen`'s poll-for-"open" loop is bot-driver logic (task file:
// "Bots poll for state == 'open'"), so it belongs on this side of the seam, built only from the
// SDK's existing §3 surface (`listEvents`, `join`, `submitBid`).
//
// docs/CONTRACT.md §9: "40 bots get one connection each" — each bot opens its own
// `FairDropClient.connect(...)`, still all as async tasks in this one process (never a
// per-bot OS process).

import type { BotClient } from "./runner.ts";
import type { TurnBotClient } from "./turnRunner.ts";
import { FairDropClient } from "../../sdk/FairDropClient.ts";

const DEFAULT_URI = "http://127.0.0.1:3000";

/**
 * How long a bot waits for `state == "open"` before giving up.
 *
 * Was 60s, which was correct while the driver was launched immediately before the operator
 * opened the event. Auto mode inverts that: the driver now runs for the WHOLE join window, and
 * the first bots start waiting the moment the first human joins. With 25-100 people arriving
 * over several minutes, a 60s ceiling means the earliest bots time out and throw before anyone
 * presses Open — verified live: `waitForOpen: event 13 did not open within 60000ms`.
 *
 * 30 minutes is not a real limit, it is a leak guard: it exists so an abandoned driver
 * eventually exits instead of holding pooled sockets open forever.
 */
const OPEN_TIMEOUT_MS = Number(process.env.FAIRDROP_OPEN_TIMEOUT_MS ?? 30 * 60_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps one freshly-connected `FairDropClient` as a `BotClient`. `waitForOpen` polls the
 * client's own subscribed cache (`listEvents`) rather than issuing any new SQL — `connect()`
 * already subscribes to every table, so the row is already local; this just waits for it.
 */
export function toBotClient(client: FairDropClient): BotClient {
  return {
    join(eventId, displayName, origin) {
      return client.join(eventId, displayName, origin);
    },
    submitBid(eventId, participantId, slotIndex, price) {
      client.submitBid(eventId, participantId, slotIndex, price);
    },
    async waitForOpen(eventId, pollMs = 25, timeoutMs = OPEN_TIMEOUT_MS) {
      const start = Date.now();
      for (;;) {
        const event = client.listEvents().find((e) => e.id === eventId);
        if (event?.state === "open") return;
        if (event?.state === "settled") return; // sold out under us — nothing to wait for
        if (Date.now() - start > timeoutMs) {
          throw new Error(`waitForOpen: event ${eventId} did not open within ${timeoutMs}ms`);
        }
        await sleep(pollMs);
      }
    },
  };
}

/** Connects a fresh `FairDropClient` and returns it wrapped as a `BotClient`. */
export async function createRealBotClient(
  uri: string = DEFAULT_URI,
  dbName: string = "fairdrop-scratch"
): Promise<{ client: FairDropClient; botClient: BotClient }> {
  const client = await FairDropClient.connect(uri, dbName);
  return { client, botClient: toBotClient(client) };
}

// ---------------------------------------------------------------------------------------------
// Turn mode (Gate 3). Same seam as `toBotClient` above: the SDK stays a thin §3 wrapper, and the
// bot-side reads that `TurnView` needs are assembled here from the SDK's existing cache
// accessors (`listEvents`, `listSlots`, `listParticipants`) rather than by reaching into
// `./generated`. No arithmetic happens on this side — `walletBalance` is the subscribed row as
// the module wrote it (task file "Display": "Never compute a balance client-side").
// ---------------------------------------------------------------------------------------------

/** Wraps a connected `FairDropClient` as a `TurnBotClient` for one event. */
export function toTurnBotClient(client: FairDropClient, eventId: bigint): TurnBotClient {
  const base = toBotClient(client);
  return {
    ...base,
    getEvent(id) {
      const row = client.listEvents().find((e) => e.id === id);
      if (row == null) return undefined;
      return {
        state: row.state,
        currentSlotIndex: row.currentSlotIndex,
        slotCount: row.slotCount,
      };
    },
    getSlot(id, slotIndex) {
      const row = client.listSlots(id).find((s) => s.slotIndex === slotIndex);
      return row == null ? undefined : { floor: row.floor };
    },
    getParticipant(participantId) {
      const row = client.listParticipants(eventId).find((p) => p.id === participantId);
      return row == null
        ? undefined
        : { walletBalance: row.walletBalance, hasWon: row.hasWon };
    },
  };
}

/** Connects a fresh `FairDropClient` and returns it wrapped as a `TurnBotClient`. */
export async function createRealTurnBotClient(
  eventId: bigint,
  uri: string = DEFAULT_URI,
  dbName: string = "fairdrop-scratch"
): Promise<{ client: FairDropClient; botClient: TurnBotClient }> {
  const client = await FairDropClient.connect(uri, dbName);
  return { client, botClient: toTurnBotClient(client, eventId) };
}
