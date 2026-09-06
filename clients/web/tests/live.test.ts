import { describe, it, expect } from "vitest";
import { mountLive, type LiveSource, type MountNode } from "../src/live.ts";
import type {
  EventRow,
  ParticipantRow,
  AllocationRow,
  SlotRow,
} from "../src/deriveDisplayModel.ts";

/**
 * A fake `LiveSource` that captures the `subscribeEvent`/`subscribeAllocations` callbacks so
 * a test can drive them directly, standing in for a real `FairDropClient` subscription without
 * a live connection.
 */
function fakeSource(initial: {
  event: EventRow;
  participants: ParticipantRow[];
  allocations: AllocationRow[];
  slots?: SlotRow[];
}) {
  let event = initial.event;
  const allocations = [...initial.allocations];
  let slots = [...(initial.slots ?? [])];
  const eventCbs: Array<(e: EventRow) => void> = [];
  const allocationCbs: Array<(a: AllocationRow) => void> = [];
  const slotCbs: Array<(s: SlotRow) => void> = [];

  const source: LiveSource = {
    listEvents: () => [event],
    listParticipants: () => initial.participants,
    listAllocations: () => allocations,
    listSlots: () => slots,
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
    subscribeSlots: (_eventId, cb) => {
      slotCbs.push(cb);
      return () => {
        const i = slotCbs.indexOf(cb);
        if (i >= 0) slotCbs.splice(i, 1);
      };
    },
  };

  /** Simulate a new `Allocation` row landing and firing every registered callback. */
  const pushAllocation = (a: AllocationRow) => {
    allocations.push(a);
    event = { ...event, ticketsRemaining: event.ticketsRemaining - 1 };
    for (const cb of allocationCbs) cb(a);
  };

  /** Simulate `submit_bid` bumping a live `Slot` row's `entriesReceived` mid-window. */
  const bumpSlotEntries = (slotIndex: number) => {
    slots = slots.map((s) =>
      s.slotIndex === slotIndex ? { ...s, entriesReceived: s.entriesReceived + 1 } : s
    );
    const row = slots.find((s) => s.slotIndex === slotIndex);
    if (row != null) for (const cb of slotCbs) cb(row);
  };

  return { source, pushAllocation, bumpSlotEntries };
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

// Turn mode: `Slot.entriesReceived` is bumped on every `submit_bid` during the 60s window,
// while `Allocation` rows are written only at `close_slot`. Subscribing to event/allocation/
// slot_result alone therefore leaves the "Entries" and "Oversubscription" columns frozen at 0
// for the whole window and jumping at close — the field piling into the slot is exactly what
// the projector should show while it happens. Same additive rationale `listSlots` already
// carries (CONTRACT.md §11).
describe("mountLive — the slot window updates live, not only at close", () => {
  it("re-renders when a Slot row's entriesReceived changes with no allocation yet", () => {
    const { source, bumpSlotEntries } = fakeSource({
      event: {
        id: 1n,
        mode: "turn",
        state: "open",
        totalTickets: 16,
        ticketsRemaining: 16,
        participantsAtOpen: 40,
        ticketPrice: 15000,
      },
      participants: [{ id: 1n, eventId: 1n, origin: "human" }],
      allocations: [],
      slots: [
        { eventId: 1n, slotIndex: 0, floor: 10000, effectiveQuota: 4, entriesReceived: 0, filled: 0 },
      ],
    });

    const mount: MountNode = { innerHTML: "" };
    const unsubscribe = mountLive(mount, source, 1n);

    const initialHtml = mount.innerHTML;
    expect(initialHtml).toContain("<td>0</td>"); // entries start at 0

    bumpSlotEntries(0);
    const afterFirst = mount.innerHTML;
    expect(afterFirst).not.toBe(initialHtml);
    expect(afterFirst).toContain("0.3x"); // 1 / quota 4, live, before any allocation lands

    bumpSlotEntries(0);
    expect(mount.innerHTML).not.toBe(afterFirst); // not a one-shot re-render

    unsubscribe();
  });

  it("stops updating on slot changes once unsubscribed", () => {
    const { source, bumpSlotEntries } = fakeSource({
      event: {
        id: 1n,
        mode: "turn",
        state: "open",
        totalTickets: 16,
        ticketsRemaining: 16,
        participantsAtOpen: 40,
        ticketPrice: 15000,
      },
      participants: [{ id: 1n, eventId: 1n, origin: "human" }],
      allocations: [],
      slots: [
        { eventId: 1n, slotIndex: 0, floor: 10000, effectiveQuota: 4, entriesReceived: 0, filled: 0 },
      ],
    });

    const mount: MountNode = { innerHTML: "" };
    const unsubscribe = mountLive(mount, source, 1n);
    unsubscribe();

    const htmlAfterUnsubscribe = mount.innerHTML;
    bumpSlotEntries(0);
    expect(mount.innerHTML).toBe(htmlAfterUnsubscribe);
  });
});
