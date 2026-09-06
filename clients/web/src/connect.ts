// Browser-side connection setup, shared by the admin page and the participant page.

import { FairDropClient } from "../../sdk/FairDropClient.ts";
import type { LiveSource } from "./live.ts";

/**
 * Where the module lives, derived from the page's own host rather than hardcoded.
 *
 * This is the difference between a demo that works on the presenter's laptop and one that works
 * on the audience's phones. `spacetime start` binds `*:3000`, so a phone loading this page from
 * `http://192.168.0.122:5173` must be told `http://192.168.0.122:3000` — a literal
 * `127.0.0.1:3000` would resolve to the phone itself and fail with a connection error that
 * looks exactly like the module being down.
 *
 * `?host=` overrides for the case where the module is not on the same box as the dev server.
 *
 * A DEPLOYED build sets `VITE_STDB_URI` (e.g. `https://maincloud.spacetimedb.com`) and that wins
 * over the LAN guess, which is meaningless once the page is served from Vercel — there is no
 * SpacetimeDB on port 3000 of `fair-drop.vercel.app`. It must be `https://`, not `http://`:
 * the SDK derives its WebSocket scheme from this, and an HTTPS page cannot open a plaintext
 * `ws://` — the browser blocks it as mixed content and the failure looks exactly like the
 * module being down (DEPLOYMENT.md).
 */
const ENV = import.meta.env as { VITE_STDB_URI?: string; VITE_STDB_DB?: string };

export function moduleUri(): string {
  const override = new URLSearchParams(location.search).get("host");
  if (override) return override;
  if (ENV.VITE_STDB_URI) return ENV.VITE_STDB_URI;
  return `${location.protocol}//${location.hostname}:3000`;
}

/** Database name. `?db=` overrides, then the deployed build's `VITE_STDB_DB`; locally
 *  `fairdrop-scratch`, so a stray page load can never touch `fairdrop-demo`, which holds the
 *  rehearsal evidence. */
export function dbName(): string {
  return (
    new URLSearchParams(location.search).get("db") ?? ENV.VITE_STDB_DB ?? "fairdrop-scratch"
  );
}

/** `?event=<id>` if present. */
export function eventIdParam(): bigint | null {
  const raw = new URLSearchParams(location.search).get("event");
  if (raw == null || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

/**
 * The `E_*` code carried by a rejected reducer/procedure call, or `""`.
 *
 * Same reasoning as `clients/bots/src/runner.ts`'s `hasCode`, and deliberately the same
 * substring approach: a failed procedure rejects with a raw **string**
 * (`ProcedureStatus::InternalError`), a failed reducer with a `SenderError` whose only carrier
 * is `.message`, and neither has a `.code` property — so reading `err.code` yields `undefined`
 * every time and the UI would show "something went wrong" for every one of CONTRACT §9's
 * distinct, actionable codes. The host may also frame the code
 * (`"Error: E_SOLD_OUT\n at ..."`), hence a match rather than an equality test.
 */
export function errorCode(err: unknown): string {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null
          ? String((err as { message?: unknown }).message ?? "")
          : "";
  return /\bE_[A-Z_]+\b/.exec(text)?.[0] ?? "";
}

/** Human-readable text for the codes a person can actually hit. Unknown codes fall through
 *  to the raw code, which is more useful on stage than "an error occurred". */
const MESSAGES: Record<string, string> = {
  E_EVENT_NOT_OPEN: "Not open yet — or the event just sold out.",
  E_SOLD_OUT: "Sold out.",
  E_ALREADY_WON: "You already have a ticket.",
  E_PRICE_MISMATCH: "Price changed — reload.",
  E_STALE_SLOT: "That slot has already closed.",
  E_DUPLICATE_ENTRY: "You are already entered in this slot.",
  E_INSUFFICIENT_BALANCE: "Not enough balance for this floor.",
  E_UNKNOWN_PARTICIPANT: "Session lost — join again.",
  E_WRONG_EVENT: "Session belongs to a different event — join again.",
  E_NOT_ADMIN: "This browser is not the admin for that event.",
  E_NO_PARTICIPANTS: "Too few participants to fund even one ticket at this fraction.",
  E_FLOORS_NOT_INCREASING: "Floors must strictly increase.",
  E_HANDLE_COLLISION: "Name taken — try another.",
  E_EMAIL_INVALID: "That email does not look reachable — check it.",
};

export function errorText(err: unknown): string {
  const code = errorCode(err);
  if (code === "") return String(err ?? "Unknown error");
  return MESSAGES[code] ?? code;
}

/**
 * Connects, and hands back the client typed as a `LiveSource`.
 *
 * The cast is deliberate and is the only one in the page code. `FairDropClient` satisfies
 * `LiveSource` structurally at runtime — same method names, same arities, same row shapes — but
 * not nominally to `tsc`: `live.ts` declares its rows as plain local interfaces (`mode:
 * "queue" | "turn"`) on purpose, so the display never imports `./generated`, while the client
 * returns the generated types (`mode: string`). Widening `live.ts` to the generated types would
 * undo that separation for a compile-time detail.
 */
export async function connect(): Promise<{ client: FairDropClient; source: LiveSource }> {
  const client = await FairDropClient.connect(moduleUri(), dbName());
  return { client, source: client as unknown as LiveSource };
}
