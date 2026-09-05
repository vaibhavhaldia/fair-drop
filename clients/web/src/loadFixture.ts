// Loads a JSON fixture shaped like CONTRACT.md §3 and converts ids at the boundary — bigint
// does not survive JSON.stringify, so fixtures carry ids as decimal strings and this is the
// one place that parses them back. Real subscriptions (Gate 2) hand bigint already, via
// clients/sdk; this loader exists only because Gate 1 has no live module.

import type { DisplaySourceData } from "./deriveDisplayModel.ts";

interface RawFixture {
  event: {
    id: string;
    mode: "queue" | "turn";
    state: "created" | "countdown" | "open" | "settled";
    totalTickets: number;
    ticketsRemaining: number;
    participantsAtOpen: number;
    ticketPrice: number | null;
  };
  participants: Array<{ id: string; eventId: string; origin: "human" | "bot" }>;
  allocations: Array<{ eventId: string; participantId: string; slotIndex: number; pricePaid: number }>;
  slots: Array<{
    eventId: string;
    slotIndex: number;
    floor: number;
    effectiveQuota: number;
    entriesReceived: number;
    filled: number;
  }>;
}

export function parseFixture(json: string): DisplaySourceData {
  const raw = JSON.parse(json) as RawFixture;
  return {
    event: { ...raw.event, id: BigInt(raw.event.id) },
    participants: raw.participants.map((p) => ({
      id: BigInt(p.id),
      eventId: BigInt(p.eventId),
      origin: p.origin,
    })),
    allocations: raw.allocations.map((a) => ({
      eventId: BigInt(a.eventId),
      participantId: BigInt(a.participantId),
      slotIndex: a.slotIndex,
      pricePaid: a.pricePaid,
    })),
    slots: raw.slots.map((s) => ({
      eventId: BigInt(s.eventId),
      slotIndex: s.slotIndex,
      floor: s.floor,
      effectiveQuota: s.effectiveQuota,
      entriesReceived: s.entriesReceived,
      filled: s.filled,
    })),
  };
}
