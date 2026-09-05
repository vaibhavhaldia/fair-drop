#!/usr/bin/env node
// Round 2 (turn mode) bot entry point — DEMO-RECIPE.md Stage 2. The queue-mode counterpart is
// `index.ts`; this exists because Stage 2 runs five slots and 4H bots, which is not typeable.
//
// Usage: node --experimental-strip-types src/turn.ts <humanCount> <eventId> [dbName]
//
// Two phases, and the pause between them is the point (CONTRACT §6: inventory is derived from
// the headcount at `start_countdown` and only that instant):
//
//   1. every bot connects and joins, then this prints  READY joined=<n>
//   2. the OPERATOR calls start_countdown + open_event
//   3. bots notice `state == "open"` from their own subscription and run every slot
//
// Do not collapse the phases. A driver that started the countdown itself would race its own
// joins and size the event off a partial field, silently.

import { computeBotCount } from "./config.ts";
import { createRealTurnBotClient } from "./realClient.ts";
import { joinTurnBots, runTurnBots, type JoinedTurnBot } from "./turnRunner.ts";
import type { FairDropClient } from "../../sdk/FairDropClient.ts";

const SERVER_URI = "http://127.0.0.1:3000";

async function main() {
  const humanCount = Number(process.argv[2] ?? "10");
  const eventId = BigInt(process.argv[3] ?? "1");
  const dbName = process.argv[4] ?? "fairdrop-scratch";

  const botCount = computeBotCount(humanCount);
  console.log(`turn mode — humans=${humanCount} -> bots=${botCount} (ratio derived, not hardcoded)`);
  console.log(`pid=${process.pid} — one process regardless of bot count`);

  const connections: FairDropClient[] = [];
  const bots: JoinedTurnBot[] = await joinTurnBots(async () => {
    const { client, botClient } = await createRealTurnBotClient(eventId, SERVER_URI, dbName);
    connections.push(client);
    return botClient;
  }, { eventId, count: botCount });

  console.log(`READY joined=${bots.length} — call start_countdown, then open_event`);

  await runTurnBots(bots, { eventId });

  // The last submitBid calls are fire-and-forget from this client's point of view; give them a
  // moment to land before the sockets close (same reason as index.ts).
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(`turn run complete — ${bots.length} bots, one process, pid=${process.pid}`);
  for (const c of connections) c.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
