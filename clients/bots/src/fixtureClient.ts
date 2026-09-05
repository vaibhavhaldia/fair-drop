// A fixture-backed BotClient — stands in for `clients/sdk`'s FairDropClient until Gate 2 wires
// the real module. Lets the driver and its tests run against CONTRACT.md §3 shapes without a
// live SpacetimeDB instance. Never imported by anything outside this package.

import type { BotClient } from "./runner.ts";

let nextParticipantId = 1n;
const takenHandles = new Set<string>();

/**
 * In-memory stand-in for the module: rejects a handle collision exactly like `join` would
 * (CONTRACT.md §4), otherwise hands back a fresh incrementing ParticipantId, mirroring the
 * real `join` procedure's return shape.
 */
export function createFixtureClient(): BotClient {
  return {
    async join(_eventId, displayName, _origin) {
      if (takenHandles.has(displayName)) {
        // Same carrier the live module uses: `throw new SenderError('E_HANDLE_COLLISION')`
        // puts the code in `.message` and nowhere else. Never an invented `.code` property —
        // the fixture would then be agreeing with the driver instead of standing in for the
        // module (see `runner.ts`'s `hasCode`).
        throw new Error("E_HANDLE_COLLISION");
      }
      takenHandles.add(displayName);
      const id = nextParticipantId;
      nextParticipantId += 1n;
      return id;
    },
    submitBid(_eventId, _participantId, _slotIndex, _price) {
      // Fixture accepts every bid — queue-mode allocation/sell-out logic lives in the module,
      // not here. Gate 1 only needs the call shape to match CONTRACT.md §3.
    },
  };
}
