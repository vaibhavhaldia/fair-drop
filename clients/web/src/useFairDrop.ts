// React bindings over FairDropClient. Two hooks, no context provider: the pages each hold one
// connection, and LLD §1199's "thin context provider around one FairDropClient" buys nothing
// until something needs the client three levels down.
//
// The re-render strategy is deliberately the same one `mountLive` uses and its tests pin: any
// subscribed change bumps a revision counter, and the view re-derives a FULL snapshot from the
// client's local cache rather than trying to patch row-by-row into React state. At demo scale
// (CONTRACT §9 caps this at ~50 participant rows) a full re-derive costs nothing, and it means
// there is exactly one way for the UI to be wrong — a stale revision — instead of one per table.

import { useEffect, useMemo, useState } from "react";
import type { FairDropClient } from "../../sdk/FairDropClient.ts";
import { connect } from "./connect.ts";
import type { DisplaySourceData } from "./deriveDisplayModel.ts";

export interface Connection {
  client: FairDropClient | null;
  error: unknown;
}

export function useConnection(): Connection {
  const [client, setClient] = useState<FairDropClient | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: FairDropClient | null = null;
    connect()
      .then(({ client: c }) => {
        if (cancelled) {
          c.disconnect();
          return;
        }
        opened = c;
        setClient(c);
      })
      .catch(setError);
    return () => {
      cancelled = true;
      opened?.disconnect();
    };
  }, []);

  return { client, error };
}

/**
 * Everything one event's views need, re-derived on every subscribed change.
 *
 * All five subscriptions matter and each covers a case the others miss:
 *   - event        — state transitions (`created` -> `countdown` -> `open` -> `settled`)
 *   - participants — the wallet debit and the `hasWon` flip, both row UPDATEs
 *   - allocations  — a ticket being issued
 *   - slots        — `entriesReceived` climbing DURING the 60s window; without it the
 *                    oversubscription column sits at 0 and jumps at close
 *   - slotResults  — the draw landing
 *   - bids         — turn mode only: `pending` -> `won`|`lost` is written at `close_slot`, and
 *                    it is the exact moment a phone must change what it says. Also the only way
 *                    to know "have I already entered this slot?" before a double-tap earns an
 *                    E_DUPLICATE_ENTRY.
 */
export function useEventData(client: FairDropClient | null, eventId: bigint | null) {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (client == null || eventId == null) return;
    const bump = () => setRevision((r) => r + 1);
    const unsubs = [
      client.subscribeEvent(eventId, bump),
      client.subscribeParticipants(eventId, bump),
      client.subscribeAllocations(eventId, bump),
      client.subscribeSlots(eventId, bump),
      client.subscribeSlotResults(eventId, bump),
      client.subscribeBids(eventId, bump),
    ];
    bump(); // paint from whatever the cache already holds
    return () => {
      for (const u of unsubs) u();
    };
  }, [client, eventId]);

  return useMemo(() => {
    if (client == null || eventId == null) {
      return { event: null, participants: [], allocations: [], slots: [], bids: [], revision };
    }
    const event = client.listEvents().find((e) => e.id === eventId) ?? null;
    return {
      event,
      participants: client.listParticipants(eventId),
      allocations: client.listAllocations(eventId),
      slots: client.listSlots(eventId),
      bids: client.listBids(eventId),
      revision,
    };
    // `revision` is the whole point of the dependency list — the underlying rows live in the
    // SDK's mutable cache, so nothing else here changes identity when data arrives.
  }, [client, eventId, revision]);
}

/** The list of events, for the admin's picker. Refreshed on any event-table change. */
export function useEventList(client: FairDropClient | null) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (client == null) return;
    // No event id to filter on yet, so watch the table broadly by re-listing on any event row.
    const id = setInterval(() => setRevision((r) => r + 1), 1000);
    return () => clearInterval(id);
  }, [client]);
  return useMemo(
    () => (client == null ? [] : client.listEvents().slice().sort((a, b) => Number(b.id - a.id))),
    [client, revision]
  );
}

/** `DisplaySourceData` for `deriveDisplayModel` — the pure, tested derivation is unchanged. */
export function toDisplaySource(data: ReturnType<typeof useEventData>): DisplaySourceData | null {
  if (data.event == null) return null;
  return {
    event: data.event as unknown as DisplaySourceData["event"],
    participants: data.participants as unknown as DisplaySourceData["participants"],
    allocations: data.allocations as unknown as DisplaySourceData["allocations"],
    slots: data.slots as unknown as DisplaySourceData["slots"],
  };
}
