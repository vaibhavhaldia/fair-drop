// Pure display derivation — CONTRACT.md §3 shape in, render model out. No arithmetic on
// walletBalance anywhere in this file: it never reads or touches that column at all. The
// human/bot split is always a live join over subscribed rows (Allocation × Participant.origin),
// never inferred from a display name — CONTRACT.md §2, task file "Display".

export type Origin = "human" | "bot";

export interface EventRow {
  id: bigint;
  mode: "queue" | "turn";
  state: "created" | "countdown" | "open" | "settled";
  totalTickets: number;
  ticketsRemaining: number;
  participantsAtOpen: number;
  ticketPrice: number | null; // queue mode only
}

export interface ParticipantRow {
  id: bigint;
  eventId: bigint;
  origin: Origin;
}

export interface AllocationRow {
  eventId: bigint;
  participantId: bigint;
  slotIndex: number;
  pricePaid: number;
}

export interface SlotRow {
  eventId: bigint;
  slotIndex: number;
  floor: number;
  effectiveQuota: number;
  entriesReceived: number;
  filled: number;
}

export interface DisplaySourceData {
  event: EventRow;
  participants: ParticipantRow[];
  allocations: AllocationRow[];
  slots: SlotRow[];
}

export interface DisplayModel {
  totalTickets: number;
  ticketsRemaining: number;
  participantsAtOpen: number;
  ticketPrice: number | null;
  allocatedTo: { human: number; bot: number };
  slots: Array<{
    index: number;
    floor: number;
    effectiveQuota: number;
    entriesReceived: number;
    filled: number;
  }>;
}

export function deriveDisplayModel(data: DisplaySourceData): DisplayModel {
  const originById = new Map<bigint, Origin>();
  for (const p of data.participants) {
    originById.set(p.id, p.origin);
  }

  const allocatedTo = { human: 0, bot: 0 };
  for (const a of data.allocations) {
    const origin = originById.get(a.participantId);
    if (origin === "human") allocatedTo.human += 1;
    else if (origin === "bot") allocatedTo.bot += 1;
    // an allocation with no known participant origin is not counted — never guessed.
  }

  return {
    totalTickets: data.event.totalTickets,
    ticketsRemaining: data.event.ticketsRemaining,
    participantsAtOpen: data.event.participantsAtOpen,
    ticketPrice: data.event.ticketPrice,
    allocatedTo,
    slots: data.slots
      .slice()
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map((s) => ({
        index: s.slotIndex,
        floor: s.floor,
        effectiveQuota: s.effectiveQuota,
        entriesReceived: s.entriesReceived,
        filled: s.filled,
      })),
  };
}
