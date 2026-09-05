import { describe, it, expect } from "vitest";
import { deriveDisplayModel, type DisplaySourceData } from "../src/deriveDisplayModel.ts";

function base(): DisplaySourceData {
  return {
    event: {
      id: 1n,
      mode: "turn",
      state: "open",
      totalTickets: 20,
      ticketsRemaining: 20,
      participantsAtOpen: 50,
      ticketPrice: null,
    },
    participants: [
      { id: 1n, eventId: 1n, origin: "human" },
      { id: 2n, eventId: 1n, origin: "bot" },
      { id: 3n, eventId: 1n, origin: "bot" },
    ],
    allocations: [],
    slots: [],
  };
}

// TC-DASH-01 (adapted: pure derivation, no live subscriptions in Gate 1) — conservation.
describe("TC-DASH-01 — inventory conservation", () => {
  it("allocated + ticketsRemaining == totalTickets", () => {
    const data = base();
    data.allocations = [{ eventId: 1n, participantId: 1n, slotIndex: 0, pricePaid: 25_000 }];
    data.event.ticketsRemaining = 19;
    const model = deriveDisplayModel(data);
    expect(model.allocatedTo.human + model.allocatedTo.bot + model.ticketsRemaining).toBe(
      model.totalTickets
    );
  });
});

// TC-DASH-02 — human/bot split is Allocation JOIN Participant.origin, derived on read.
describe("TC-DASH-02 — human/bot split derived from Allocation JOIN Participant.origin", () => {
  it("counts each allocation's origin from the participant row, not the display name", () => {
    const data = base();
    data.allocations = [
      { eventId: 1n, participantId: 1n, slotIndex: 0, pricePaid: 25_000 }, // human
      { eventId: 1n, participantId: 2n, slotIndex: 0, pricePaid: 25_000 }, // bot
      { eventId: 1n, participantId: 3n, slotIndex: 1, pricePaid: 30_000 }, // bot
    ];
    const model = deriveDisplayModel(data);
    expect(model.allocatedTo).toEqual({ human: 1, bot: 2 });
  });

  it("the two numbers sum to total allocations", () => {
    const data = base();
    data.allocations = [
      { eventId: 1n, participantId: 1n, slotIndex: 0, pricePaid: 25_000 },
      { eventId: 1n, participantId: 2n, slotIndex: 0, pricePaid: 25_000 },
    ];
    const model = deriveDisplayModel(data);
    expect(model.allocatedTo.human + model.allocatedTo.bot).toBe(data.allocations.length);
  });
});

// TC-DASH-04 — turn mode per-slot rows: index, floor, effectiveQuota, entriesReceived, filled.
describe("TC-DASH-04 — turn-mode slot rows match the module's slot/slot_result rows", () => {
  it("shapes each slot row exactly, no cutoff-price column", () => {
    const data = base();
    data.slots = [
      { eventId: 1n, slotIndex: 0, floor: 25_000, effectiveQuota: 4, entriesReceived: 12, filled: 4 },
    ];
    const model = deriveDisplayModel(data);
    expect(model.slots).toEqual([
      { index: 0, floor: 25_000, effectiveQuota: 4, entriesReceived: 12, filled: 4 },
    ]);
  });
});

// TC-DASH-07 — queue mode: no slot table, fixed ticket price shown instead.
describe("TC-DASH-07 — queue mode shows no slot table", () => {
  it("slots is empty and ticketPrice is surfaced", () => {
    const data = base();
    data.event.mode = "queue";
    data.event.ticketPrice = 15_000;
    data.slots = [];
    const model = deriveDisplayModel(data);
    expect(model.slots).toEqual([]);
    expect(model.ticketPrice).toBe(15_000);
  });
});

// TC-DASH-10 — zero allocations renders 0/0, never NaN.
describe("TC-DASH-10 — zero allocations renders 0/0, not NaN", () => {
  it("renders zeros with no allocations at all", () => {
    const model = deriveDisplayModel(base());
    expect(model.allocatedTo).toEqual({ human: 0, bot: 0 });
    expect(Number.isNaN(model.allocatedTo.human)).toBe(false);
    expect(Number.isNaN(model.allocatedTo.bot)).toBe(false);
  });
});

// TC-DASH-06 — participantsAtOpen and totalTickets both shown, from the snapshot.
describe("TC-DASH-06 — participantsAtOpen and totalTickets surfaced from the snapshot", () => {
  it("passes through the event's snapshot fields verbatim, never re-derived", () => {
    const model = deriveDisplayModel(base());
    expect(model.participantsAtOpen).toBe(50);
    expect(model.totalTickets).toBe(20);
  });
});
