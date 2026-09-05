import { describe, it, expect } from "vitest";
import { parseFixture } from "../src/loadFixture.ts";

// TC-SDK-09 (adapted: same bigint/JSON boundary rule, applied where the display loads a
// fixture in place of a live subscription in Gate 1).
describe("TC-SDK-09 — fixture ids convert from decimal string to bigint at load", () => {
  it("parses event, participant, allocation, and slot ids as bigint", () => {
    const data = parseFixture(
      JSON.stringify({
        event: {
          id: "1",
          mode: "turn",
          state: "open",
          totalTickets: 20,
          ticketsRemaining: 20,
          participantsAtOpen: 50,
          ticketPrice: null,
        },
        participants: [{ id: "1", eventId: "1", origin: "human" }],
        allocations: [{ eventId: "1", participantId: "1", slotIndex: 0, pricePaid: 25000 }],
        slots: [{ eventId: "1", slotIndex: 0, floor: 25000, effectiveQuota: 4, entriesReceived: 10, filled: 4 }],
      })
    );

    expect(data.event.id).toBe(1n);
    expect(typeof data.event.id).toBe("bigint");
    expect(data.participants[0].id).toBe(1n);
    expect(data.allocations[0].participantId).toBe(1n);
    expect(data.slots[0].eventId).toBe(1n);
  });
});
