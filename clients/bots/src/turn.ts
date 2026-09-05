#!/usr/bin/env node
// Round 2 (turn mode) bot entry point — DEMO-RECIPE.md Stage 2. The queue-mode counterpart is
// `index.ts`; this exists because Stage 2 runs five slots and 4H bots, which is not typeable.
//
// Usage: node --experimental-strip-types src/turn.ts <humanCount|auto> <eventId> [dbName]
//
// Two phases, and the seam between them is the point (CONTRACT §6: inventory is derived from
// the headcount at `start_countdown` and only that instant):
//
//   1. every bot connects and joins
//   2. the OPERATOR locks inventory + opens
//   3. bots notice `state == "open"` on their own subscription and run every slot
//
// Do not collapse the phases. A driver that started the countdown itself would race its own
// joins and size the event off a partial field, silently.
//
//   <humanCount>  a number: join `humanCount x BOT_RATIO` bots, print READY, and wait for the
//                 operator. Original behaviour; `scripts/rehearse-*.sh` still pass this.
//   auto          hold bots at BOT_RATIO x the LIVE human count until the admin locks, then run.
//                 No READY handshake is needed in this mode: the phase boundary IS the lock, so
//                 the operator can simply lock when the room has finished joining.
//
// Connections come from a bounded pool (`pool.ts`, LLD §5a) rather than one per bot.

import { BOT_RATIO, computeBotCount } from "./config.ts";
import { createPool, pooledTurnBotClients, POOL_SIZE } from "./pool.ts";
import { joinTurnBots, runTurnBots, type JoinedTurnBot } from "./turnRunner.ts";

const SERVER_URI = process.env.FAIRDROP_URI ?? "http://127.0.0.1:3000";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const humanArg = process.argv[2] ?? "10";
  const auto = humanArg.toLowerCase() === "auto";
  const eventId = BigInt(process.argv[3] ?? "1");
  const dbName = process.argv[4] ?? "fairdrop-scratch";

  const pool = await createPool(SERVER_URI, dbName, POOL_SIZE);
  console.log(`turn mode — pool=${pool.size} connections, sized to cores (LLD §5a)`);
  console.log(`pid=${process.pid} — one process regardless of bot count`);

  const control = pool.next();
  const factory = pooledTurnBotClients(pool, eventId);
  const bots: JoinedTurnBot[] = [];

  if (auto) {
    const deadline = Date.now() + 10_000;
    while (control.listEvents().find((e) => e.id === eventId) == null) {
      if (Date.now() > deadline) throw new Error(`event ${eventId} not found on ${dbName}`);
      await sleep(50);
    }
    const orphans = control.listParticipants(eventId).filter((p) => p.origin === "bot").length;
    if (orphans > 0) {
      console.warn(
        `WARNING: ${orphans} bot row(s) already exist on event ${eventId} from an earlier run. ` +
          `Nothing drives them and they will not enter any slot. Use a fresh event.`
      );
    }
    console.log(`auto mode — holding bots at ${BOT_RATIO}x the live human count until lock`);

    for (;;) {
      const ev = control.listEvents().find((e) => e.id === eventId);
      if (ev == null || ev.state !== "created") {
        console.log(`event is ${ev?.state ?? "gone"} — joining stops here, ${bots.length} bots in`);
        break;
      }
      const humans = control.listParticipants(eventId).filter((p) => p.origin === "human").length;
      const want = computeBotCount(humans);
      if (want > bots.length) {
        const deficit = want - bots.length;
        console.log(`humans=${humans} -> want=${want} bots, joining ${deficit}`);
        bots.push(...(await joinTurnBots(factory, { eventId, count: deficit })));
      }
      await sleep(250);
    }
  } else {
    const humanCount = Number(humanArg);
    const botCount = computeBotCount(humanCount);
    console.log(`humans=${humanCount} -> bots=${botCount} (ratio derived, not hardcoded)`);
    bots.push(...(await joinTurnBots(factory, { eventId, count: botCount })));
    console.log(`READY joined=${bots.length} — call start_countdown, then open_event`);
  }

  await runTurnBots(bots, { eventId });

  // The last submitBid calls are fire-and-forget from this client's point of view.
  await sleep(500);
  console.log(
    `turn run complete — ${bots.length} bots over ${pool.size} connections, ` +
      `one process, pid=${process.pid}`
  );
  pool.closeAll();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
