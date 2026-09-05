// Participant page — one page, phone-first, identical on a laptop.
//
// Queue mode (Step 2): join -> wait for t-0 -> Buy -> got it, or did not.
// Turn mode  (Step 3): join -> per slot: enter -> wait for the draw -> won, or did not.
//
// Two rules from the task file are load-bearing here and are worth stating where they are
// easy to break:
//
//   1. NEVER compute a balance in the browser. Every number below is a subscribed row read
//      back from the module. A phone doing `balance - price` optimistically will eventually
//      disagree with the module, and it will do so in front of the audience.
//   2. The event's own `state` decides what this page offers — never a local timer. Every
//      participant learns `open` from the same subscription broadcast, which is what makes
//      Round 1's equal-start premise true.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { dbName, errorCode, errorText, eventIdParam, moduleUri } from "./connect.ts";
import { useConnection, useEventData, useEventList } from "./useFairDrop.ts";
import { useSession } from "./session.ts";
import type { FairDropClient } from "../../sdk/FairDropClient.ts";

// ---------------------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------------------

function JoinForm({
  client,
  eventId,
  onJoined,
}: {
  client: FairDropClient;
  eventId: bigint;
  onJoined: (id: bigint) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const join = async () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Enter a name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let id: bigint;
      try {
        id = await client.join(eventId, trimmed, "human");
      } catch (err) {
        // The handle is `<eventId>-<name>-<random 32-bit suffix>`, minted server-side, so a
        // collision means this exact name drew a suffix already taken in this event. Retrying
        // draws a fresh one — it is not a name-is-taken error and must not be shown as one.
        if (errorCode(err) !== "E_HANDLE_COLLISION") throw err;
        id = await client.join(eventId, trimmed, "human");
      }
      onJoined(id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Join</h2>
      <label htmlFor="name">Your name</label>
      <input
        id="name" value={name} autoComplete="off" enterKeyHint="go"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void join(); }}
      />
      <button onClick={() => void join()} disabled={busy}>{busy ? "Joining…" : "Join"}</button>
      {error !== "" && <p className="err">{error}</p>}
      <p className="muted" style={{ marginBottom: 0 }}>
        You get a wallet with a random balance when you join. Joining late is allowed, but only
        people who joined before the admin locks inventory are counted in the ticket supply.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Queue mode
// ---------------------------------------------------------------------------------------

function QueueFlow({
  client,
  eventId,
  data,
  participantId,
}: {
  client: FairDropClient;
  eventId: bigint;
  data: ReturnType<typeof useEventData>;
  participantId: bigint;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ev = data.event!;
  const won = data.allocations.find((a) => a.participantId === participantId);
  const price = ev.ticketPrice ?? 0;

  const buy = () => {
    setBusy(true);
    setError("");
    // submitBidChecked, not submitBid: the plain wrapper swallows every rejection, which for a
    // person means tapping Buy and watching nothing happen — indistinguishable from a dead
    // connection. Allocation and debit both land inside this one call; there is no confirm step.
    client
      .submitBidChecked(eventId, participantId, 0, price)
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  if (won != null) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>You got a ticket</h2>
        <p className="ok" style={{ fontSize: "1.3rem", margin: 0 }}>Paid {won.pricePaid}</p>
      </div>
    );
  }

  if (ev.state === "settled") {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Sold out</h2>
        <p className="muted" style={{ margin: 0 }}>
          Every ticket went to someone faster. That is what queue mode rewards.
        </p>
      </div>
    );
  }

  if (ev.state !== "open") {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Waiting for the drop</h2>
        <p className="muted" style={{ margin: 0 }}>
          {ev.state === "countdown"
            ? "Inventory is locked. The admin opens it any moment — be ready."
            : "Not open yet."}
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Open — {ev.ticketsRemaining} left</h2>
      <button onClick={buy} disabled={busy}>
        {busy ? "Buying…" : `Buy — ${price}`}
      </button>
      {error !== "" && <p className="err">{error}</p>}
    </div>
  );
}


// ---------------------------------------------------------------------------------------
// Turn mode
// ---------------------------------------------------------------------------------------

/** Seconds left in the open slot window, or null. Recomputed against a ticking clock. */
function secondsLeft(endsAt: unknown, _tick: number): number | null {
  const raw = endsAt as { microsSinceUnixEpoch?: bigint } | null | undefined;
  if (raw?.microsSinceUnixEpoch == null) return null;
  return Math.max(0, Math.ceil((Number(raw.microsSinceUnixEpoch / 1000n) - Date.now()) / 1000));
}

/** The floor ladder, with the current slot marked. Shows the field thinning as floors rise. */
function SlotLadder({
  slots,
  currentSlotIndex,
  walletBalance,
}: {
  slots: ReturnType<typeof useEventData>["slots"];
  currentSlotIndex: number;
  walletBalance: number;
}) {
  if (slots.length === 0) return null;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr><th>Slot</th><th>Floor</th><th>Entries</th><th>Filled</th><th /></tr>
        </thead>
        <tbody>
          {slots.slice().sort((a, b) => a.slotIndex - b.slotIndex).map((s) => {
            const current = s.slotIndex === currentSlotIndex;
            return (
              <tr key={s.slotIndex} style={current ? { color: "var(--ink)" } : { opacity: 0.55 }}>
                <td>{s.slotIndex}</td>
                <td>{s.floor}</td>
                <td>{s.entriesReceived}</td>
                <td>{s.filled}</td>
                <td className="muted">
                  {current ? "now" : walletBalance < s.floor ? "out of reach" : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TurnFlow({
  client,
  eventId,
  data,
  participantId,
}: {
  client: FairDropClient;
  eventId: bigint;
  data: ReturnType<typeof useEventData>;
  participantId: bigint;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [bid, setBid] = useState("");

  // The window is wall-clock: nothing is written to the event row while it ticks down, so
  // without this the countdown would sit still until the draw fires.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const ev = data.event!;
  const me = data.participants.find((p) => p.id === participantId);
  const slot = data.slots.find((s) => s.slotIndex === ev.currentSlotIndex);

  // Reset the field to the new floor on every slot change, and never carry the previous slot's
  // number forward: floors rise, so a stale value is either rejected or an accidental underbid
  // — and the one thing this page must not do is submit an amount the person did not mean.
  useEffect(() => {
    setBid(slot == null ? "" : String(slot.floor));
    setError("");
  }, [ev.currentSlotIndex, slot?.floor]);
  const myAllocation = data.allocations.find((a) => a.participantId === participantId);
  const myBids = data.bids.filter((b) => b.participantId === participantId);
  const bidThisSlot = myBids.find((b) => b.slotIndex === ev.currentSlotIndex);
  const lost = myBids.filter((b) => b.state === "lost");
  const left = secondsLeft(ev.currentSlotEndsAt, tick);

  const enter = () => {
    if (slot == null) return;
    const amount = Number(bid);
    // Checked here as well as in the module: E_PRICE_MISMATCH and E_INSUFFICIENT_BALANCE are
    // correct but arrive after a round trip, and this field is edited against a running clock.
    if (!Number.isFinite(amount) || amount < slot.floor) {
      setError(`Bid at least the floor — ${slot.floor}.`);
      return;
    }
    if (me != null && amount > me.walletBalance) {
      setError(`That is more than your wallet holds (${me.walletBalance}).`);
      return;
    }
    setBusy(true);
    setError("");
    // Blind: nobody sees this number until the slot closes, and it is what you pay if you win.
    client
      .submitBidChecked(eventId, participantId, ev.currentSlotIndex, amount)
      .catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  const ladder = (
    <SlotLadder
      slots={data.slots}
      currentSlotIndex={ev.currentSlotIndex}
      walletBalance={me?.walletBalance ?? 0}
    />
  );

  // C5 — one ticket per participant per event. Won already: nothing left to do, ever.
  if (myAllocation != null) {
    return (
      <>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>You won a ticket</h2>
          <p className="ok" style={{ fontSize: "1.3rem", margin: 0 }}>
            Slot {myAllocation.slotIndex} · paid {myAllocation.pricePaid}
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            You pay what you bid — not what the last winner bid, and not what anyone else paid.
          </p>
        </div>
        {ladder}
      </>
    );
  }

  if (ev.state === "settled") {
    return (
      <>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Event over</h2>
          <p className="muted" style={{ margin: 0 }}>
            No ticket this time — you bid in {myBids.length} slot
            {myBids.length === 1 ? "" : "s"} and were outbid in each.
          </p>
        </div>
        {ladder}
      </>
    );
  }

  if (ev.state !== "open") {
    return (
      <>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Waiting for the drop</h2>
          <p className="muted" style={{ margin: 0 }}>
            {ev.state === "countdown"
              ? "Inventory is locked. Slot 0 opens when the admin does — no need to be fast."
              : "Not open yet."}
          </p>
        </div>
        {ladder}
      </>
    );
  }

  const affordable = me != null && slot != null && me.walletBalance >= slot.floor;

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          Slot {ev.currentSlotIndex} of {ev.slotCount} · floor {slot?.floor ?? "—"}
        </h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Draw in <strong style={{ color: "var(--ink)" }}>{left ?? "—"}s</strong>
          {slot != null && ` · ${slot.entriesReceived} entered for ${slot.effectiveQuota}`}
        </p>

        {bidThisSlot != null ? (
          <p className="ok" style={{ margin: 0 }}>
            Your bid of {bidThisSlot.price} is in. Nobody can see it, and bidding earlier would
            not have helped — the slot resolves all at once when the clock runs out.
          </p>
        ) : !affordable ? (
          <>
            <p style={{ color: "var(--warn)", margin: 0 }}>
              Your wallet is below this floor.
            </p>
            <p className="muted" style={{ marginBottom: 0 }}>
              Floors only rise, so this is the end of the road for you — that thinning field is
              the mechanism working, not a bug.
            </p>
          </>
        ) : (
          <>
            <label htmlFor="bid">Your bid — at least {slot?.floor}, at most {me?.walletBalance}</label>
            <input
              id="bid" type="number" inputMode="numeric"
              step={1000} min={slot?.floor} max={me?.walletBalance}
              value={bid} onChange={(e) => setBid(e.target.value)}
            />
            <p className="muted" style={{ marginTop: 4 }}>
              Sealed. Highest bids take the {slot?.effectiveQuota} tickets when the clock hits
              zero, and winners pay their own bid. Ties are broken by the published draw, never
              by who bid first.
            </p>
            <button onClick={enter} disabled={busy}>
              {busy ? "Bidding…" : `Bid ${bid || slot?.floor}`}
            </button>
          </>
        )}

        {error !== "" && <p className="err">{error}</p>}

        {lost.length > 0 && bidThisSlot == null && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Outbid in slot{lost.length === 1 ? "" : "s"}{" "}
            {lost.map((b) => b.slotIndex).join(", ")}. Nothing carries over — your wallet is
            untouched, and this slot is a fresh sealed round.
          </p>
        )}
      </div>
      {ladder}
    </>
  );
}

// ---------------------------------------------------------------------------------------

function MyStatus({
  data,
  participantId,
  onForget,
}: {
  data: ReturnType<typeof useEventData>;
  participantId: bigint;
  onForget: () => void;
}) {
  const me = data.participants.find((p) => p.id === participantId);
  const ev = data.event!;
  if (me == null) {
    return (
      <div className="card">
        <p className="err" style={{ marginTop: 0 }}>
          This event has no record of you — the database may have been republished.
        </p>
        <button className="secondary" onClick={onForget}>Join again</button>
      </div>
    );
  }
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
        <strong>{me.displayName}</strong>
        <span className={`pill ${ev.state}`}>{ev.state}</span>
      </div>
      {/* Rendered straight from the subscribed row — never `balance - price` locally. */}
      <p className="muted" style={{ margin: ".5rem 0 0" }}>
        Wallet <strong style={{ color: "var(--ink)" }}>{me.walletBalance}</strong>
        {me.hasWon && " · you hold a ticket"}
      </p>
    </div>
  );
}

function EventChooser({ client }: { client: FairDropClient }) {
  const events = useEventList(client).filter((e) => e.state !== "settled").slice(0, 8);
  if (events.length === 0) {
    return <p className="muted">No open event yet. Ask the admin to create one, then reload.</p>;
  }
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Pick the event</h2>
      {events.map((e) => (
        <button
          key={String(e.id)}
          className="secondary"
          onClick={() => { location.search = `?event=${e.id}&db=${dbName()}`; }}
        >
          #{String(e.id)} · {e.name} · {e.mode}
        </button>
      ))}
    </div>
  );
}

function ParticipantPage() {
  const { client, error } = useConnection();
  const [eventId] = useState<bigint | null>(eventIdParam());
  const data = useEventData(client, eventId);
  const { participantId, remember, forget } = useSession(eventId);

  useEffect(() => {
    document.title = eventId == null ? "Fair Drop" : `Fair Drop — event ${eventId}`;
  }, [eventId]);

  if (error != null) {
    return (
      <p className="err">
        Cannot reach the module at {moduleUri()}. Check you are on the same wifi as the host.{" "}
        {String(error)}
      </p>
    );
  }
  if (client == null) return <p className="muted">connecting…</p>;
  if (eventId == null) return <EventChooser client={client} />;
  if (data.event == null) {
    return <p className="muted">Waiting for event #{String(eventId)} to appear…</p>;
  }

  if (participantId == null) {
    return <JoinForm client={client} eventId={eventId} onJoined={remember} />;
  }

  return (
    <>
      <MyStatus data={data} participantId={participantId} onForget={forget} />
      {data.event.mode === "queue" ? (
        <QueueFlow client={client} eventId={eventId} data={data} participantId={participantId} />
      ) : (
        <TurnFlow client={client} eventId={eventId} data={data} participantId={participantId} />
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<ParticipantPage />);
