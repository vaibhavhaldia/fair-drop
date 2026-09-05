#!/usr/bin/env node
// Bot driver entry point — Gate 1: runs against the fixture client. Gate 2 swaps
// `createFixtureClient()` for the real `FairDropClient` from `clients/sdk`; nothing else in
// this file changes, since both conform to the same `BotClient` shape.
//
// Usage: node --experimental-strip-types src/index.ts <humanCount> [eventId] [ticketPrice]

import { computeBotCount } from "./config.ts";
import { runQueueBots } from "./runner.ts";
import { createFixtureClient } from "./fixtureClient.ts";

async function main() {
  const humanCount = Number(process.argv[2] ?? "10");
  const eventId = BigInt(process.argv[3] ?? "1");
  const ticketPrice = Number(process.argv[4] ?? "15000");

  const botCount = computeBotCount(humanCount);
  console.log(`humans=${humanCount} -> bots=${botCount} (ratio derived, not hardcoded)`);

  const client = createFixtureClient();
  const start = Date.now();
  await runQueueBots(client, { eventId, ticketPrice, count: botCount });
  console.log(`${botCount} bots joined and bid in ${Date.now() - start}ms, one process, pid=${process.pid}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
