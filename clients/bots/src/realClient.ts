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
import { FairDropClient } from "../../sdk/FairDropClient.ts";

const DEFAULT_URI = "http://127.0.0.1:3000";

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
    async waitForOpen(eventId, pollMs = 25, timeoutMs = 60_000) {
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
