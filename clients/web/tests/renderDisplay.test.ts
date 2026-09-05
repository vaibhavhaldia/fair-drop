import { describe, it, expect } from "vitest";
import { renderDisplay } from "../src/renderDisplay.ts";
import type { DisplayModel } from "../src/deriveDisplayModel.ts";

function turnModel(): DisplayModel {
  return {
    totalTickets: 20,
    ticketsRemaining: 16,
    participantsAtOpen: 50,
    ticketPrice: null,
    allocatedTo: { human: 1, bot: 3 },
    slots: [
      { index: 0, floor: 25_000, effectiveQuota: 4, entriesReceived: 12, filled: 4 },
    ],
  };
}

// TC-DASH-09 (adapted: no Playwright/E2E in Gate 1, so the "visually dominant" requirement is
// checked structurally — the split renders in its own headline element, not buried in a table).
describe("TC-DASH-09 — human/bot split is the visually dominant element", () => {
  it("renders the split in a dedicated headline element, separate from the data table", () => {
    const html = renderDisplay(turnModel());
    expect(html).toMatch(/class="split"[^]*?1[^]*?3/);
    expect(html).toMatch(/<table/);
  });
});

// TC-DASH-04 / TC-DASH-05 — turn mode renders a per-slot table with the oversubscription ratio.
describe("TC-DASH-04/05 — turn mode slot table with oversubscription ratio", () => {
  it("renders one row per slot with the entriesReceived/quota ratio", () => {
    const html = renderDisplay(turnModel());
    expect(html).toContain("25000"); // floor
    expect(html).toContain("12"); // entriesReceived
    expect(html).toMatch(/3(\.0+)?x|3\b/); // 12 / 4 = 3x oversubscription
  });
});

// TC-DASH-07 — queue mode: no slot table, fixed ticket price shown instead.
describe("TC-DASH-07 — queue mode shows the fixed price, no slot table", () => {
  it("omits the slot table and shows ticketPrice when slots is empty", () => {
    const model: DisplayModel = { ...turnModel(), slots: [], ticketPrice: 15_000 };
    const html = renderDisplay(model);
    expect(html).not.toContain("Effective quota"); // no per-slot table
    expect(html).toContain("15000");
  });
});

// TC-DASH-10 — zero allocations renders 0/0, never NaN, never erroring.
describe("TC-DASH-10 — zero allocations renders 0/0, not NaN", () => {
  it("never emits the literal string NaN", () => {
    const model: DisplayModel = { ...turnModel(), allocatedTo: { human: 0, bot: 0 }, slots: [] };
    const html = renderDisplay(model);
    expect(html).not.toContain("NaN");
  });
});
