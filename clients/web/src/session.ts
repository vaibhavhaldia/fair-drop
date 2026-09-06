// Participant identity, persisted per (database, event).
//
// A phone that reloads — or locks its screen and comes back — must not become a second
// participant. The module has no login: `join` mints a row and returns its id, and that id is
// the only thing that identifies the person afterwards. So it is kept in localStorage, keyed by
// database AND event: the same phone legitimately joins Round 1 and Round 2 as two different
// participants (DEMO-RECIPE Stage 2.1 requires a fresh population for Round 2), and a key that
// ignored the event would silently carry a stale `hasWon` into the new round.

import { useCallback, useEffect, useState } from "react";
import { dbName } from "./connect.ts";

function key(eventId: bigint): string {
  return `fairdrop:${dbName()}:${eventId}`;
}

export function useSession(eventId: bigint | null): {
  participantId: bigint | null;
  remember: (id: bigint) => void;
  forget: () => void;
} {
  const [participantId, setParticipantId] = useState<bigint | null>(null);

  useEffect(() => {
    if (eventId == null) {
      setParticipantId(null);
      return;
    }
    const raw = localStorage.getItem(key(eventId));
    setParticipantId(raw != null && /^\d+$/.test(raw) ? BigInt(raw) : null);
  }, [eventId]);

  const remember = useCallback(
    (id: bigint) => {
      if (eventId == null) return;
      localStorage.setItem(key(eventId), String(id));
      setParticipantId(id);
    },
    [eventId]
  );

  const forget = useCallback(() => {
    if (eventId != null) localStorage.removeItem(key(eventId));
    setParticipantId(null);
  }, [eventId]);

  return { participantId, remember, forget };
}
