// Live display entry point (Gate 2). No React, no framework — a subscription callback
// re-derives `DisplayModel` with the existing pure `deriveDisplayModel` -> `renderDisplay`
// pipeline and swaps `innerHTML` on a mount node, exactly per the task file's Gate 2 DoD
// ("Display updates live from subscriptions, no refresh") and its instruction not to change
// `deriveDisplayModel`/`renderDisplay`'s shape. `preview.ts` (the Gate 1 fixture path) keeps
// working unchanged.
//
// `LiveSource` is the minimal read surface this file needs, expressed in `deriveDisplayModel`'s
// own plain row types (never `./generated`, per TC-SDK-02's intent) — a real `FairDropClient`
// (`clients/sdk`) satisfies it structurally with no adapter code, and a test can hand in a
// fake one to drive two successive callbacks without a live connection.

import type {
  DisplaySourceData,
  EventRow,
  ParticipantRow,
  AllocationRow,
  SlotRow,
} from "./deriveDisplayModel.ts";
import { deriveDisplayModel } from "./deriveDisplayModel.ts";
import { renderDisplay } from "./renderDisplay.ts";

export type Unsubscribe = () => void;

export interface LiveSource {
  listEvents(): EventRow[];
  listParticipants(eventId: bigint): ParticipantRow[];
  listAllocations(eventId: bigint): AllocationRow[];
  listSlots(eventId: bigint): SlotRow[];
  subscribeEvent(eventId: bigint, cb: (e: EventRow) => void): Unsubscribe;
  subscribeAllocations(eventId: bigint, cb: (a: AllocationRow) => void): Unsubscribe;
  subscribeSlotResults(eventId: bigint, cb: (r: unknown) => void): Unsubscribe;
  /**
   * Turn mode's live window. `Slot.entriesReceived` is bumped on every `submit_bid` while the
   * 60s slot is open, but an `Allocation` row is not written until `close_slot` — so without
   * this subscription the "Entries" and "Oversubscription" columns sit at 0 for the whole
   * window and jump at close, hiding the one thing the projector should be showing as it
   * happens. Queue mode has no `Slot` rows, so this simply never fires there.
   */
  subscribeSlots(eventId: bigint, cb: (s: SlotRow) => void): Unsubscribe;
}

/** The one DOM dependency this file has — anything with a settable `innerHTML`. */
export interface MountNode {
  innerHTML: string;
}

function snapshot(source: LiveSource, eventId: bigint): DisplaySourceData | undefined {
  const event = source.listEvents().find((e) => e.id === eventId);
  if (event == null) return undefined;
  return {
    event,
    participants: source.listParticipants(eventId),
    allocations: source.listAllocations(eventId),
    slots: source.listSlots(eventId),
  };
}

/**
 * Subscribes `mount` to `eventId`'s live state. Every event/allocation/slot/slot-result update
 * re-derives the full `DisplayModel` from a fresh snapshot and re-renders — the same
 * `deriveDisplayModel` -> `renderDisplay` pipeline `preview.ts` uses on a static fixture, run
 * again on every subscribed change instead of once. Returns an `Unsubscribe` that tears down
 * all four underlying subscriptions.
 */
export function mountLive(mount: MountNode, source: LiveSource, eventId: bigint): Unsubscribe {
  const render = () => {
    const data = snapshot(source, eventId);
    if (data == null) return; // event row not replicated yet — nothing to render
    mount.innerHTML = renderDisplay(deriveDisplayModel(data));
  };

  render(); // initial paint from whatever is already in the local cache

  const unsubEvent = source.subscribeEvent(eventId, render);
  const unsubAllocations = source.subscribeAllocations(eventId, render);
  const unsubSlotResults = source.subscribeSlotResults(eventId, render);
  const unsubSlots = source.subscribeSlots(eventId, render);

  return () => {
    unsubEvent();
    unsubAllocations();
    unsubSlotResults();
    unsubSlots();
  };
}
