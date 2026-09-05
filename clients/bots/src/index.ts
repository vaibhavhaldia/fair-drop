#!/usr/bin/env node
// Bot driver entry point — queue mode.
//
// Usage: node --experimental-strip-types src/index.ts <humanCount|auto> [eventId] [dbName]
//
//   <humanCount>  a number: join exactly `humanCount x BOT_RATIO` bots, once, and stop. This is
//                 the original behaviour and what `scripts/rehearse-*.sh` and
//                 `manual-walkthrough.md` still pass.
//   auto          derive the bot count from the LIVE human count and keep topping up as people
//                 join, until the admin locks inventory. See "Auto mode" below.
//   [eventId]     defaults to 1 (fairdrop-scratch's smoke-test event).
//   [dbName]      defaults to fairdrop-scratch — never point this at fairdrop-demo casually.
//
// Connections come from a bounded pool (`pool.ts`, LLD §5a), not one per bot. At 40 bots the
// difference was cosmetic; at 25-100 real humans it is 100-400 bots, and one socket each stops
// being viable.
//
// ## Auto mode
//
// The number a human operator has to type is the one thing that cannot be right: people trickle
// in over minutes, so any count typed up front is stale before it is entered. Auto mode reads it
// off the `participant` table instead and reconciles toward `BOT_RATIO x humans`.
//
// It is a RECONCILING loop, not an event-driven one — it computes a deficit from the current
// count rather than reacting to each join. A missed callback, a bot whose join failed, or a
// restart all self-correct on the next tick; a fire-and-forget "spawn 4 on join" hook has no
// repair path and would drift silently to the wrong ratio.
//
// Topping up STOPS when the event leaves `created`. Inventory is derived from the headcount at
// `start_countdown` and never again (CONTRACT §6), so a bot joining after the lock inflates the
// field without inflating supply — quietly shifting everyone's odds. A human who wanders in
// late still plays; they just do not get four bots behind them.

import { BOT_RATIO, computeBotCount } from "./config.ts";
import { runQueueBots } from "./runner.ts";
import { createPool, pooledBotClients, POOL_SIZE } from "./pool.ts";
import type { BotClient } from "./runner.ts";

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
  console.log(`pool=${pool.size} connections — sized to cores, never to bot count (LLD §5a)`);
  console.log(`pid=${process.pid} — one process regardless of bot count`);

  // The ticket price is read from the live event row, never assumed — a bot that guessed the
  // price could satisfy CONTRACT §5's check by coincidence and mask a real mismatch elsewhere.
  const control = pool.next();
  const deadline = Date.now() + 10_000;
  let eventRow;
  while ((eventRow = control.listEvents().find((e) => e.id === eventId)) == null) {
    if (Date.now() > deadline) {
      throw new Error(`event ${eventId} not found on ${dbName} after 10s — create it first`);
    }
    await sleep(50);
  }
  const ticketPrice = eventRow.ticketPrice;
  if (ticketPrice == null) {
    throw new Error(`event ${eventId} has no ticketPrice — is it turn mode? use turn.ts`);
  }

  // Per-bot timing instrumentation. The delay a bot ACTUALLY achieves is DELTA_MS plus however
  // long this process took to notice `state == "open"` on its own socket. That second term is
  // invisible from outside and, if it dominates, Round 1 stops measuring FCFS and starts
  // measuring the demo rig (DEMO-RECIPE failure playbook).
  const openedAt: number[] = [];
  const bidAt: number[] = [];
  const base = pooledBotClients(pool);
  const instrumented = async (): Promise<BotClient> => {
    const botClient = await base();
    const waitForOpen = botClient.waitForOpen!.bind(botClient);
    return {
      ...botClient,
      async waitForOpen(id: bigint) {
        await waitForOpen(id);
        openedAt.push(Date.now());
      },
      submitBid(...args: Parameters<typeof botClient.submitBid>) {
        bidAt.push(Date.now());
        return botClient.submitBid(...args);
      },
    };
  };

  const start = Date.now();
  const inFlight: Array<Promise<void>> = [];
  let spawned = 0;

  const spawn = (count: number) => {
    if (count <= 0) return;
    spawned += count;
    inFlight.push(runQueueBots(instrumented, { eventId, ticketPrice, count }));
  };

  if (auto) {
    const orphans = control.listParticipants(eventId).filter((p) => p.origin === "bot").length;
    if (orphans > 0) {
      console.warn(
        `WARNING: ${orphans} bot row(s) already exist on event ${eventId} from an earlier run. ` +
          `They are orphans — nothing is driving them and they will not bid. They are NOT counted ` +
          `toward the ratio, so the visible bot count will read high. Use a fresh event.`
      );
    }
    console.log(`auto mode — holding bots at ${BOT_RATIO}x the live human count until lock`);

    for (;;) {
      const ev = control.listEvents().find((e) => e.id === eventId);
      if (ev == null) break;
      if (ev.state !== "created") {
        console.log(`event is ${ev.state} — topping up stops here, ${spawned} bots live`);
        break;
      }
      const humans = control.listParticipants(eventId).filter((p) => p.origin === "human").length;
      const want = computeBotCount(humans);
      if (want > spawned) {
        console.log(`humans=${humans} -> want=${want} bots, spawning ${want - spawned}`);
        spawn(want - spawned);
      }
      await sleep(250);
    }
  } else {
    const humanCount = Number(humanArg);
    const botCount = computeBotCount(humanCount);
    console.log(`humans=${humanCount} -> bots=${botCount} (ratio derived, not hardcoded)`);
    spawn(botCount);
  }

  await Promise.all(inFlight);

  const pct = (xs: number[], from: number, q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length === 0 ? NaN : Math.round(s[Math.floor((s.length - 1) * q)] - from);
  };
  const firstOpen = Math.min(...openedAt);
  console.log(
    `open detected across bots (ms after the first): ` +
      `p50=${pct(openedAt, firstOpen, 0.5)} p90=${pct(openedAt, firstOpen, 0.9)} max=${pct(openedAt, firstOpen, 1)}`
  );
  console.log(
    `bid submitted (ms after the first open detection): ` +
      `p50=${pct(bidAt, firstOpen, 0.5)} p90=${pct(bidAt, firstOpen, 0.9)} max=${pct(bidAt, firstOpen, 1)}`
  );
  // submitBid is fire-and-forget from this client's point of view — let the last calls land.
  await sleep(500);
  console.log(
    `${spawned} bots joined and bid in ${Date.now() - start}ms over ${pool.size} connections, ` +
      `one process, pid=${process.pid}`
  );
  pool.closeAll();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
