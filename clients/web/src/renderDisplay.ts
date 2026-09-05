// One-page display, rendered from a DisplayModel (itself derived from subscribed rows —
// deriveDisplayModel.ts). Only the human/bot split gets visual treatment; everything else is
// a table. Task file "Display": "The human/bot allocation split is the only element that needs
// to look good — it is what the audience reads. Everything else is a table."
//
// Plain string templating, not a framework — Gate 1 has no Playwright/E2E, so this stays
// simple and is unit-tested by asserting on the emitted markup. Wiring this to live
// subscriptions (instead of a fixture) is Gate 2; nothing here changes shape when that happens.

import type { DisplayModel } from "./deriveDisplayModel.ts";

function ratio(entriesReceived: number, quota: number): string {
  if (quota === 0) return "—";
  return `${(entriesReceived / quota).toFixed(1)}x`;
}

export function renderDisplay(model: DisplayModel): string {
  const slotTable =
    model.slots.length > 0
      ? `
    <table>
      <thead>
        <tr><th>Slot</th><th>Floor</th><th>Effective quota</th><th>Entries</th><th>Filled</th><th>Oversubscription</th></tr>
      </thead>
      <tbody>
        ${model.slots
          .map(
            (s) => `<tr>
          <td>${s.index}</td><td>${s.floor}</td><td>${s.effectiveQuota}</td>
          <td>${s.entriesReceived}</td><td>${s.filled}</td>
          <td>${ratio(s.entriesReceived, s.effectiveQuota)}</td>
        </tr>`
          )
          .join("\n")}
      </tbody>
    </table>`
      : `<p class="ticket-price">Ticket price: ${model.ticketPrice ?? "—"}</p>`;

  return `
<section class="split">
  <div class="split-human"><span class="split-label">Human</span><span class="split-count">${model.allocatedTo.human}</span></div>
  <div class="split-bot"><span class="split-label">Bot</span><span class="split-count">${model.allocatedTo.bot}</span></div>
</section>
<table>
  <tbody>
    <tr><th>Total tickets</th><td>${model.totalTickets}</td></tr>
    <tr><th>Tickets remaining</th><td>${model.ticketsRemaining}</td></tr>
    <tr><th>Participants at open</th><td>${model.participantsAtOpen}</td></tr>
  </tbody>
</table>
${slotTable}
`.trim();
}
