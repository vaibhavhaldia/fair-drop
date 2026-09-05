#!/usr/bin/env node
// Bot driver entry point — Gate 2: runs against the real `FairDropClient` (`clients/sdk`) over
// `createRealBotClient` (`realClient.ts`), one connection per bot per CONTRACT.md §9. Gate 1's
// fixture path (`createFixtureClient()`) is still exported by `fixtureClient.ts` for the unit
// tests, which mock/stub `BotClient` directly and never touch a live connection.
//
// Usage: node --experimental-strip-types src/index.ts <humanCount> [eventId] [dbName]
//   <humanCount>  drives bot count via computeBotCount (BOT_RATIO = 4) — never hardcode 40.
//   [eventId]     defaults to 1 (fairdrop-scratch's smoke-test event).
//   [dbName]      defaults to fairdrop-scratch — never point this at fairdrop-demo casually.

import { computeBotCount } from "./config.ts";
import { runQueueBots } from "./runner.ts";
import { createRealBotClient } from "./realClient.ts";

const SERVER_URI = "http://127.0.0.1:3000";

async function main() {
  const humanCount = Number(process.argv[2] ?? "10");
  const eventId = BigInt(process.argv[3] ?? "1");
  const dbName = process.argv[4] ?? "fairdrop-scratch";

  const botCount = computeBotCount(humanCount);
  console.log(`humans=${humanCount} -> bots=${botCount} (ratio derived, not hardcoded)`);
  console.log(`pid=${process.pid} — one process regardless of bot count`);

  // The ticket price is read from the live event row, never assumed by the driver — a bot
  // that guessed the price could pass CONTRACT.md §5's price check by coincidence and mask a
  // real mismatch elsewhere. `connect()`'s `subscribeToAllTables` call doesn't hand back a
  // ready signal, so poll the cache briefly for the row to arrive.
  const probe = await createRealBotClient(SERVER_URI, dbName);
  let eventRow;
  const probeDeadline = Date.now() + 10_000;
  while ((eventRow = probe.client.listEvents().find((e) => e.id === eventId)) == null) {
    if (Date.now() > probeDeadline) {
      throw new Error(`event ${eventId} not found on ${dbName} after 10s — create it first`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const ticketPrice = eventRow.ticketPrice;
  if (ticketPrice == null) {
    throw new Error(`event ${eventId} has no ticketPrice — is it turn mode? this driver is queue-only`);
  }
  probe.client.disconnect();

  // Track every per-bot connection so this script can close them all and actually exit —
  // an open WebSocket keeps Node's event loop alive indefinitely otherwise (CONTRACT.md §9:
  // "40 bots get one connection each," so there are up to 40 sockets to close here).
  const connections: import("../../sdk/FairDropClient.ts").FairDropClient[] = [];
  const start = Date.now();
  await runQueueBots(
    async () => {
      const { client, botClient } = await createRealBotClient(SERVER_URI, dbName);
      connections.push(client);
      return botClient;
    },
    { eventId, ticketPrice, count: botCount }
  );
  // Give the last submitBid calls a moment to reach the module before disconnecting —
  // submitBid is fire-and-forget from this client's point of view.
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(`${botCount} bots joined and bid in ${Date.now() - start}ms, one process, pid=${process.pid}`);
  for (const c of connections) c.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
