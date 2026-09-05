import { describe, it, expect } from "vitest";
import { mountLive, type LiveSource, type MountNode } from "../src/live.ts";
import type { EventRow, ParticipantRow, AllocationRow } from "../src/deriveDisplayModel.ts";

/**
 * A fake `LiveSource` that captures the `subscribeEvent`/`subscribeAllocations` callbacks so
 * a test can drive them directly, standing in for a real `FairDropClient` subscription without
 * a live connection.
 */
function fakeSource(initial: {
  event: EventRow;
  participants: ParticipantRow[];
  allocations: AllocationRow[];
}) {
  let event = initial.event;
  const allocations = [...initial.allocations];
  const eventCbs: Array<(e: EventRow) => void> = [];
  const allocationCbs: Array<(a: AllocationRow) => void> = [];

  const source: LiveSource = {
    listEvents: () => [event],
    listParticipants: () => initial.participants,
    listAllocations: () => allocations,
    listSlots: () => [],
    subscribeEvent: (_eventId, cb) => {
      eventCbs.push(cb);
      return () => {
        const i = eventCbs.indexOf(cb);
        if (i >= 0) eventCbs.splice(i, 1);
      };
    },
    subscribeAllocations: (_eventId, cb) => {
      allocationCbs.push(cb);
      return () => {
        const i = allocationCbs.indexOf(cb);
        if (i >= 0) allocationCbs.splice(i, 1);
      };
    },
    subscribeSlotResults: () => () => {},
  };

  /** Simulate a new `Allocation` row landing and firing every registered callback. */
  const pushAllocation = (a: AllocationRow) => {
    allocations.push(a);
    event = { ...event, ticketsRemaining: event.ticketsRemaining - 1 };
    for (const cb of allocationCbs) cb(a);
  };

  return { source, pushAllocation };
}

// TC-SDK-04 (adapted: subscribeEvent/subscribeAllocations invoking their callback and driving
// a re-render is exercised at the display's `mountLive` wiring, via a fake subscription source,
// rather than against `FairDropClient` itself — a live connection is IT/E2E scope per the task
// file's Gate 2 note: "a test with a fake subscription source driving two successive callbacks
// and asserting the mount node's HTML changed is acceptable and preferable to a manual claim.")
describe("mountLive — display updates from subscriptions without a refresh", () => {
  it("re-renders the mount node's HTML when a new allocation lands, with no re-run of mountLive", () => {
    const { source, pushAllocation } = fakeSource({
      event: {
        id: 1n,
        mode: "queue",
        state: "open",
        totalTickets: 16,
        ticketsRemaining: 16,
        participantsAtOpen: 40,
        ticketPrice: 15000,
      },
      participants: [
        { id: 1n, eventId: 1n, origin: "bot" },
        { id: 2n, eventId: 1n, origin: "human" },
      ],
      allocations: [],
    });

    const mount: MountNode = { innerHTML: "" };
    const unsubscribe = mountLive(mount, source, 1n);

    const initialHtml = mount.innerHTML;
    expect(initialHtml).toContain(">0<"); // human/bot split both start at 0

    // First successive callback: a bot wins.
    pushAllocation({ eventId: 1n, participantId: 1n, slotIndex: 0, pricePaid: 15000 });
    const afterFirst = mount.innerHTML;
    expect(afterFirst).not.toBe(initialHtml);

    // Second successive callback: a human wins — proves this isn't a one-shot re-render.
    pushAllocation({ eventId: 1n, participantId: 2n, slotIndex: 0, pricePaid: 15000 });
    const afterSecond = mount.innerHTML;
    expect(afterSecond).not.toBe(afterFirst);

    unsubscribe();
  });

  it("stops updating the mount node once unsubscribed", () => {
    const { source, pushAllocation } = fakeSource({
      event: {
        id: 1n,
        mode: "queue",
        state: "open",
        totalTickets: 16,
        ticketsRemaining: 16,
        participantsAtOpen: 40,
        ticketPrice: 15000,
      },
      participants: [{ id: 1n, eventId: 1n, origin: "bot" }],
      allocations: [],
    });

    const mount: MountNode = { innerHTML: "" };
    const unsubscribe = mountLive(mount, source, 1n);
    unsubscribe();

    const htmlAfterUnsubscribe = mount.innerHTML;
    pushAllocation({ eventId: 1n, participantId: 1n, slotIndex: 0, pricePaid: 15000 });
    expect(mount.innerHTML).toBe(htmlAfterUnsubscribe);
  });
});
