// Bounded connection pool — LLD §5a.
//
// §5a calls this "a hard constraint, not a tuning preference": at the top of the turnout range
// the 4:1 ratio means ~1,000 bots, and "1,000 bots must not mean 1,000 WebSocket connections."
// The 4h re-plan deferred it because 40 bots x 1 connection is genuinely fine. It stops being
// fine the moment real turnout is 25-100 people, which is 100-400 bots.
//
// The expensive half of §5a was never deferred — it is already in the schema, and that is why
// this file is small:
//
//   - `participant.id` is an autoInc PK, NOT `identity`
//   - `identity` is a plain indexed, NON-unique column (verified live: three rows, one identity)
//   - every reducer takes an explicit `participantId` rather than deriving the actor from
//     `ctx.sender`
//
// So one connection can already act for many participants with no module change and no
// migration. All that was missing is the multiplexing, below.
//
// The seam it plugs into already existed too: `runQueueBots` accepts
// `BotClient | (() => Promise<BotClient>)` and calls the factory once per bot. A pool is just a
// factory that hands back a shared connection instead of opening a new one.

import { cpus } from "node:os";
import { FairDropClient } from "../../sdk/FairDropClient.ts";
import { toBotClient, toTurnBotClient } from "./realClient.ts";
import type { BotClient } from "./runner.ts";
import type { TurnBotClient } from "./turnRunner.ts";

/**
 * Connections in the pool. **Sized to cores, never to bot count** (§5a) — the pool exists
 * precisely so that connection count stops tracking bot count. Clamped: below 2 a single slow
 * socket serialises everything, above 8 buys nothing at demo scale because each connection
 * already carries the full `subscribeToAllTables` replica.
 */
export const POOL_SIZE = Math.max(2, Math.min(8, cpus().length));

export interface ConnectionPool {
  readonly size: number;
  /** Round-robin. Every caller gets a live connection; none of them owns it. */
  next(): FairDropClient;
  closeAll(): void;
}

export async function createPool(
  uri: string,
  dbName: string,
  size: number = POOL_SIZE
): Promise<ConnectionPool> {
  // Opened in parallel: serially, 8 handshakes against a remote instance is dead time before
  // the first bot can join, and joins are what the topup loop is racing against the operator.
  const connections = await Promise.all(
    Array.from({ length: size }, () => FairDropClient.connect(uri, dbName))
  );

  let cursor = 0;
  return {
    size,
    next() {
      const c = connections[cursor];
      cursor = (cursor + 1) % connections.length;
      return c;
    },
    closeAll() {
      for (const c of connections) c.disconnect();
    },
  };
}

/**
 * A `BotClient` factory over the pool — the shape `runQueueBots` already takes.
 *
 * `toBotClient` closes over nothing bot-specific: `join` and `submitBid` both take explicit
 * ids, so one wrapper per call is safe and the returned clients are interchangeable.
 */
export function pooledBotClients(pool: ConnectionPool): () => Promise<BotClient> {
  return async () => toBotClient(pool.next());
}

/** Same, for turn mode. `toTurnBotClient` needs the event id for its participant lookups. */
export function pooledTurnBotClients(
  pool: ConnectionPool,
  eventId: bigint
): () => Promise<TurnBotClient> {
  return async () => toTurnBotClient(pool.next(), eventId);
}
