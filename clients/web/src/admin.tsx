// Admin page — create an event, drive its lifecycle, watch it live.
//
// The lifecycle is three ordered steps and this UI keeps them separate rather than collapsing
// them into one "publish" button:
//
//   create_event -> people join -> start_countdown -> open_event -> (settle)
//                   ^^^^^^^^^^^^                      ^^^^^^^^^^
//                   nothing to click                  this is t-0
//
// The gap is the point. Inventory is derived from the per-event headcount at `start_countdown`
// and at no other moment (CONTRACT §6), so locking before the room has joined sizes the event
// off a partial field. Late joiners are still admitted — the join door stays open until
// `settled` — they are simply not counted in supply.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { dbName, errorText, eventIdParam, moduleUri } from "./connect.ts";
import { useConnection, useEventData, useEventList, toDisplaySource } from "./useFairDrop.ts";
import { Monitor } from "./Monitor.tsx";
import type { FairDropClient } from "../../sdk/FairDropClient.ts";
// The module's OWN sizing function, not a reimplementation. It is pure (no spacetimedb import)
// so the browser can call it, and the projected-inventory preview therefore cannot drift from
// what `start_countdown` will actually compute — including `round(0.40 x 1) == 0`, which the
// preview surfaces as a blocked button instead of as a dead event on the projector.
import {
  sizeInventory,
  InventoryError,
} from "../../../fair-drop-db/spacetimedb/src/pure/inventory.ts";
// The ratio itself, from the bot driver's own config — not a 4 retyped here. TC-POOL-09 makes
// it a named constant precisely so the delay sweep and the on-stage "what if there were more
// bots?" question change it in exactly one place.
import { BOT_RATIO, computeBotCount } from "../../bots/src/config.ts";

function parseFloors(raw: string): number[] {
  const floors = raw.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (floors.length === 0) throw new Error("Turn mode needs at least one floor.");
  if (floors.some((f) => !Number.isFinite(f))) throw new Error("Floors must all be numbers.");
  // Checked here as well as in the module: E_FLOORS_NOT_INCREASING is correct but arrives as a
  // rejection after a round trip, and a typo in a five-number list is far easier to fix while
  // it is still on screen.
  for (let i = 1; i < floors.length; i++) {
    if (floors[i] <= floors[i - 1]) {
      throw new Error(`Floors must strictly increase — ${floors[i]} follows ${floors[i - 1]}.`);
    }
  }
  return floors;
}

/**
 * Seconds per slot. Bounds mirror the module's (`E_SLOT_WINDOW_INVALID`, 5..600) and are
 * checked here too for the same reason `parseFloors` is: the module's rejection is correct but
 * arrives after a round trip, and this is a field an operator edits under time pressure.
 *
 * The point of the field is rehearsal cost. Five slots at 60s is five minutes, so a turn round
 * gets rehearsed far less often than the queue round it is meant to be compared with; at 10s
 * the same round takes 50 seconds. Anything below ~10s stops being a fair test of turn mode
 * against humans, though — the window has to outlast a person noticing it and tapping.
 */
function parseSlotWindow(raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n)) throw new Error("Slot window must be a whole number of seconds.");
  if (n < 5 || n > 600) throw new Error("Slot window must be between 5 and 600 seconds.");
  return n;
}

function CreateEvent({
  client,
  onCreated,
}: {
  client: FairDropClient;
  onCreated: (id: bigint) => void;
}) {
  const [mode, setMode] = useState<"queue" | "turn">("queue");
  const [name, setName] = useState(`demo-${new Date().toTimeString().slice(0, 5).replace(":", "")}`);
  const [fraction, setFraction] = useState("0.20");
  const [price, setPrice] = useState("15000");
  const [floors, setFloors] = useState("25000,30000,40000,55000,75000");
  const [slotWindow, setSlotWindow] = useState("60");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      const id = await client.createEvent({
        name: name.trim() || "demo",
        mode,
        ticketFraction: Number(fraction),
        // Required by the procedure signature in both modes; ignored by the module for turn.
        ticketPrice: mode === "queue" ? Number(price) : 0,
        floors: mode === "turn" ? parseFloors(floors) : [],
        slotWindowSeconds: mode === "turn" ? parseSlotWindow(slotWindow) : 0,
      });
      onCreated(id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>New event</h2>

      <label htmlFor="name">Name</label>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} />

      <label htmlFor="mode">Mode</label>
      <select id="mode" value={mode} onChange={(e) => setMode(e.target.value as "queue" | "turn")}>
        <option value="queue">queue — first come, first served</option>
        <option value="turn">turn — draw at each slot close</option>
      </select>

      <label htmlFor="fraction">Ticket fraction (supply ÷ headcount)</label>
      <input
        id="fraction" type="number" step="0.05" min="0.05" max="1"
        value={fraction} onChange={(e) => setFraction(e.target.value)}
      />

      {mode === "queue" ? (
        <>
          <label htmlFor="price">Ticket price</label>
          <input id="price" type="number" step="100" value={price}
                 onChange={(e) => setPrice(e.target.value)} />
        </>
      ) : (
        <>
          <label htmlFor="floors">Floors, comma separated — must strictly increase</label>
          <input id="floors" value={floors} onChange={(e) => setFloors(e.target.value)} />

          <label htmlFor="slotWindow">Slot window (seconds) — 60 on stage, 10 to rehearse</label>
          <input
            id="slotWindow" type="number" step="5" min="5" max="600"
            value={slotWindow} onChange={(e) => setSlotWindow(e.target.value)}
          />
          <p className="muted" style={{ marginTop: 4 }}>
            {parseFloorsCount(floors)} slots x {slotWindow}s ={" "}
            {formatDuration(parseFloorsCount(floors) * Number(slotWindow || 0))} of open bidding.
          </p>
        </>
      )}

      <button onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create event"}</button>
      {error !== "" && <p className="err">{error}</p>}
    </div>
  );
}

/** Slot count without throwing — the duration hint must survive a half-typed floors field. */
function parseFloorsCount(raw: string): number {
  return raw.split(",").map((f) => f.trim()).filter(Boolean).length;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function EventPicker({
  client,
  onPick,
}: {
  client: FairDropClient;
  onPick: (id: bigint) => void;
}) {
  const events = useEventList(client).slice(0, 8);
  const [selected, setSelected] = useState("");
  if (events.length === 0) return null;
  const value = selected !== "" ? selected : String(events[0].id);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Or monitor an existing event</h2>
      <select value={value} onChange={(e) => setSelected(e.target.value)}>
        {events.map((e) => (
          <option key={String(e.id)} value={String(e.id)}>
            #{String(e.id)} · {e.name} · {e.mode} · {e.state}
          </option>
        ))}
      </select>
      <button className="secondary" onClick={() => onPick(BigInt(value))}>Monitor it</button>
      <p className="muted">
        Lifecycle buttons need the identity that created the event — a different browser, or the
        CLI, gets E_NOT_ADMIN.
      </p>
    </div>
  );
}


/**
 * Bots — the ratio, whether it is actually met, and the command to fix it.
 *
 * The browser cannot launch them. The driver runs 4H bots as async tasks in ONE Node process
 * (LLD §5a: child-process-per-bot is the thing that "would not survive a demo rig"), and a page
 * has no way to spawn that. So this panel does the two things a page CAN do: report the live
 * ratio against the 4:1 target, and hand over a command already filled in with this event's id,
 * database, and the human count currently joined.
 */
function BotPanel({
  eventId,
  mode,
  state,
  humans,
  bots,
}: {
  eventId: bigint;
  mode: string;
  state: string;
  humans: number;
  bots: number;
}) {
  const [copied, setCopied] = useState(false);
  const target = computeBotCount(humans);
  const script = mode === "turn" ? "turn.ts" : "index.ts";
  // FAIRDROP_URI is part of the command, always — not only when it looks non-local.
  //
  // The driver defaults to http://127.0.0.1:3000. Copy this command off a DEPLOYED admin page
  // without it and the bots dial localhost while the event lives on Maincloud: every join
  // fails, and because a failed join is not fatal the driver prints `READY joined=0` and exits
  // cleanly. The operator sees a command they copied from the page itself, a driver that
  // claims success, and no bots — with nothing in any log to say why.
  const command =
    `FAIRDROP_URI=${moduleUri()} node --experimental-strip-types clients/bots/src/${script} ` +
    `${humans} ${eventId} ${dbName()}`;

  const copy = () => {
    void navigator.clipboard?.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Bots — {BOT_RATIO}:1</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {humans} human · {bots} bot · target <strong>{target}</strong>
        {humans > 0 && bots === target && <span className="ok"> — ratio met</span>}
        {bots !== target && (
          <span style={{ color: "var(--warn)" }}>
            {" "}— {bots > target ? "above" : "below"} target
          </span>
        )}
      </p>

      {humans < 8 && (
        <p className="muted" style={{ marginTop: 0 }}>
          Below H = 8 the Round 2 claim is a coin flip rather than a measurement — top up the
          human count from the floor before locking.
        </p>
      )}

      <pre className="scroll" style={{ background: "#0c0e12", border: "1px solid var(--line)",
                                       borderRadius: 10, padding: ".7rem", fontSize: ".8rem",
                                       margin: ".5rem 0" }}>{command}</pre>
      <button className="secondary" onClick={copy}>{copied ? "Copied" : "Copy command"}</button>

      <p className="muted" style={{ marginBottom: 0 }}>
        Run it from the repo root {state === "created"
          ? <><strong>before</strong> locking inventory — supply is sized from the headcount at
            that moment, and bots joining after are not counted.</>
          : <>— but inventory is already locked, so these bots will not be counted in supply.</>}
        {mode === "turn" && <> Turn mode pauses at <code>READY joined=N</code>; lock only then.</>}
      </p>
    </div>
  );
}

/** Seconds left on the current turn-mode slot, or null when no window is open. */
function slotSecondsLeft(endsAt: unknown, _tick: number): number | null {
  const raw = endsAt as { microsSinceUnixEpoch?: bigint } | null | undefined;
  if (raw?.microsSinceUnixEpoch == null) return null;
  return Math.max(0, Math.ceil((Number(raw.microsSinceUnixEpoch / 1000n) - Date.now()) / 1000));
}

/**
 * Who won, and how to reach them.
 *
 * The projector shows counts; this shows the list an operator actually has to act on after the
 * room empties. Admin-only by placement, not by permission — the `participant` table is public,
 * so this is a convenience view over rows any client could read, not a confidentiality boundary
 * (worth knowing before real addresses are collected on a real event).
 */
function Winners({ data }: { data: ReturnType<typeof useEventData> }) {
  const [copied, setCopied] = useState(false);
  const rows = data.allocations
    .slice()
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((a) => ({ alloc: a, p: data.participants.find((p) => p.id === a.participantId) }))
    .filter((r) => r.p?.origin === "human");

  if (rows.length === 0) return null;

  // Only the humans have addresses, and only they need mailing — bots hold tickets too, which
  // is the point of the demo, but there is nobody to send those to.
  const addresses = rows.map((r) => r.p!.email).filter((e) => e !== "").join(", ");

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Human winners — {rows.length}</h2>
      <div className="scroll">
        <table>
          <thead><tr><th>Slot</th><th>Name</th><th>Email</th><th>Paid</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.alloc.participantId)}>
                <td>{r.alloc.slotIndex}</td>
                <td>{r.p!.displayName}</td>
                <td>{r.p!.email === "" ? <span className="muted">—</span> : r.p!.email}</td>
                <td>{r.alloc.pricePaid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        className="secondary"
        disabled={addresses === ""}
        onClick={() => {
          // `writeText` needs a secure context; over plain http on the LAN it rejects, and the
          // operator would be left with a button that silently does nothing.
          navigator.clipboard?.writeText(addresses).then(
            () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
            () => setCopied(false)
          );
        }}
      >
        {copied ? "Copied" : "Copy addresses"}
      </button>
    </div>
  );
}

function Controls({ client, eventId }: { client: FairDropClient; eventId: bigint }) {
  const data = useEventData(client, eventId);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  // The slot countdown is wall-clock, not event-driven: nothing is written to the event row
  // while a window ticks down, so without this the number would freeze until close.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const ev = data.event;
  if (ev == null) return <p className="muted">Waiting for event #{String(eventId)}…</p>;

  const joined = data.participants.length;
  const humans = data.participants.filter((p) => p.origin === "human").length;
  const bots = joined - humans;

  let preview = "";
  let lockBlocked = false;
  try {
    const inv = sizeInventory(joined, ev.ticketFraction, ev.mode === "turn" ? ev.slotCount : 0);
    preview = `→ ${inv.totalTickets} ticket${inv.totalTickets === 1 ? "" : "s"}`;
  } catch (e) {
    lockBlocked = true;
    preview =
      e instanceof InventoryError && e.code === "E_NO_PARTICIPANTS"
        ? "→ 0 tickets — locking is blocked"
        : `→ ${errorText(e)}`;
  }

  const left = slotSecondsLeft(ev.currentSlotEndsAt, tick);
  const run = (p: Promise<void>) => {
    setError("");
    p.catch((err) => setError(errorText(err)));
  };

  const joinUrl = `${location.origin}/?event=${ev.id}${
    dbName() === "fairdrop-scratch" ? "" : `&db=${dbName()}`
  }`;

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", flexWrap: "wrap", gap: ".5rem",
                      alignItems: "center", justifyContent: "space-between" }}>
          <div><strong>#{String(ev.id)}</strong> {ev.name} · {ev.mode}</div>
          <span className={`pill ${ev.state}`}>{ev.state}</span>
        </div>

        <p className="muted" style={{ margin: ".6rem 0 0" }}>
          {joined} joined ({humans} human · {bots} bot) {ev.state === "created" ? preview : ""}
        </p>

        {ev.mode === "turn" && ev.state === "open" && (
          <p className="muted">
            Slot {ev.currentSlotIndex} of {ev.slotCount} · closes in <strong>{left ?? "—"}s</strong>
            {" "}— the draw runs then, on a timer. A browser cannot close it early;{" "}
            <code>close_slot</code> is owner-only.
          </p>
        )}

        <div className="row">
          <button
            disabled={ev.state !== "created" || lockBlocked}
            onClick={() => run(client.startCountdownChecked(ev.id))}
          >
            Lock inventory
          </button>
          <button
            disabled={ev.state !== "countdown"}
            onClick={() => run(client.openEventChecked(ev.id))}
          >
            Open — t-0
          </button>
        </div>
        <button
          className="secondary"
          disabled={ev.state === "settled" || ev.state === "created"}
          onClick={() => run(client.settleChecked(ev.id))}
        >
          Settle
        </button>

        {error !== "" && <p className="err">{error}</p>}
        <p className="muted" style={{ marginBottom: 0 }}>Participants join at <code>{joinUrl}</code></p>
      </div>

      <BotPanel
        eventId={ev.id} mode={ev.mode} state={ev.state} humans={humans} bots={bots}
      />

      <Winners data={data} />

      {(() => {
        const source = toDisplaySource(data);
        return source == null ? null : <Monitor data={source} />;
      })()}
    </>
  );
}

function AdminPage() {
  const { client, error } = useConnection();
  const [eventId, setEventId] = useState<bigint | null>(eventIdParam());

  const pick = (id: bigint) => {
    setEventId(id);
    // Keep the id in the URL so a reload — or a second laptop — lands on the same event.
    const url = new URL(location.href);
    url.searchParams.set("event", String(id));
    history.replaceState(null, "", url);
  };

  if (error != null) {
    return (
      <p className="err">
        Cannot reach the module at {moduleUri()} — is <code>spacetime start</code> running?{" "}
        {String(error)}
      </p>
    );
  }
  if (client == null) return <p className="muted">connecting…</p>;

  return (
    <>
      <p className="muted">
        <span className="pill">{dbName()}</span> {moduleUri()}
      </p>
      {eventId == null ? (
        <>
          <CreateEvent client={client} onCreated={pick} />
          <EventPicker client={client} onPick={pick} />
        </>
      ) : (
        <Controls client={client} eventId={eventId} />
      )}
    </>
  );
}

// No StrictMode. Its dev-only double-invoked effects would open a second SpacetimeDB
// connection and immediately tear one down on every mount — churn against a live module that
// obscures exactly the connection errors this page exists to surface.
createRoot(document.getElementById("root")!).render(<AdminPage />);
