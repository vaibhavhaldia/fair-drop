// The monitor — human/bot split, inventory, and the turn-mode slot table.
//
// The MARKUP moved to JSX, but the derivation did not: `deriveDisplayModel` is still the only
// thing that decides what the numbers are, so TC-DASH-01/02/04/06/07/10 keep covering the
// shipped path. In particular the human/bot split stays a join over `Allocation` x
// `Participant.origin` computed there — never inferred here from a display name, and never
// recomputed in the view.

import { deriveDisplayModel, type DisplaySourceData } from "./deriveDisplayModel.ts";

function ratio(entriesReceived: number, quota: number): string {
  if (quota === 0) return "—";
  return `${(entriesReceived / quota).toFixed(1)}x`;
}

export function Monitor({ data }: { data: DisplaySourceData }) {
  const model = deriveDisplayModel(data);

  return (
    <>
      <section className="split">
        <div className="split-human">
          <span className="split-label">Human</span>
          <span className="split-count">{model.allocatedTo.human}</span>
        </div>
        <div className="split-bot">
          <span className="split-label">Bot</span>
          <span className="split-count">{model.allocatedTo.bot}</span>
        </div>
      </section>

      <div className="scroll">
        <table>
          <tbody>
            <tr><th>Total tickets</th><td>{model.totalTickets}</td></tr>
            <tr><th>Tickets remaining</th><td>{model.ticketsRemaining}</td></tr>
            <tr><th>Participants at open</th><td>{model.participantsAtOpen}</td></tr>
          </tbody>
        </table>
      </div>

      {model.slots.length > 0 ? (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Slot</th><th>Floor</th><th>Quota</th>
                <th>Entries</th><th>Filled</th><th>Oversub.</th>
              </tr>
            </thead>
            <tbody>
              {model.slots.map((s) => (
                <tr key={s.index}>
                  <td>{s.index}</td>
                  <td>{s.floor}</td>
                  <td>{s.effectiveQuota}</td>
                  <td>{s.entriesReceived}</td>
                  <td>{s.filled}</td>
                  <td>{ratio(s.entriesReceived, s.effectiveQuota)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ticket-price">Ticket price: {model.ticketPrice ?? "—"}</p>
      )}
    </>
  );
}
