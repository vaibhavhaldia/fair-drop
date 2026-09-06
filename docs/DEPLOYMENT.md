# Deployment — where each piece runs, and why

Written 2026-09-06, when the React admin/participant pages landed and the question became
"what does this look like off the laptop?"

## The topology

Three processes, and **all three are outbound clients**. Nothing accepts an inbound connection.

```
phones / laptops ──wss──►                            ◄──wss── bot driver
                            SpacetimeDB                        (laptop or hosted)
static React pages ──wss──►  (Maincloud, or local)
   (Netlify, or vite)
```

The React pages are static files. There is no application server, no API, no session store —
the browser talks to SpacetimeDB directly, and a "login" is a `join` procedure call that
returns a `ParticipantId` the page keeps in localStorage.

## Why you do not need ngrok

ngrok exposes a *local server to inbound traffic*. Nothing here takes inbound traffic.

The bot driver dials **out** to SpacetimeDB and holds WebSockets open; SpacetimeDB never
initiates a connection to it, and neither does the browser. So there is nothing to tunnel.

This is a consequence of a design choice, not luck. The original plan (`services/bot-runner/`,
`POST /onboard`) *would* have needed a public URL, because the browser was going to call it on
every join. That service was cut, and the replacement watches the `participant` table instead
of listening for HTTP. A watcher needs no address.

## When local is fine

Running the bot driver on your laptop is correct whenever:

- you are developing, or testing with 2–3 people;
- the demo is on a network you control and trust;
- you can see the terminal — the driver prints the per-bot bid spread
  (`p50=290 p90=455 max=510`), which is the single most useful diagnostic during Round 1, and
  the thing `DEMO-RECIPE`'s failure playbook tells you to read first.

There is no functional difference. A laptop and a hosted box are the same outbound client.

## When to host it (Railway, Fly, a VM — the provider does not matter)

Host it when a dropped connection would cost you the demo:

1. **Conference wifi.** If the laptop's network hiccups mid-round, every bot dies at once and
   the round is unrecoverable — you cannot re-run the driver without joining a *second* set of
   bots. An always-on box with wired/stable networking removes the single largest live risk.
2. **You need the laptop for something else** — presenting, screen-sharing, sleeping the lid.
3. **Long-running events**, where "leave this terminal open" stops being realistic.

Two things to get right if you do host it:

- **Region.** A bot's reaction time is `U(0, DELTA_MS)` **plus** network RTT to the module.
  Put the driver near the SpacetimeDB deployment. A driver on another continent silently makes
  bots slower than the finding assumes, and Round 1 then measures geography rather than FCFS.
- **Logs.** You still need to read the bid-spread line. If you cannot see the driver's stdout,
  you have removed your only view into whether the bots behaved.

## The deployed setup (2026-09-06)

| Piece | Where | Address |
|---|---|---|
| Module | SpacetimeDB Maincloud | `https://maincloud.spacetimedb.com`, database `fairdrop-demo` |
| Pages | Netlify (static) | build base is the **repo root**, config in `netlify.toml` |
| Bot driver | Wherever you run it | `FAIRDROP_URI=https://maincloud.spacetimedb.com` |

```bash
# module
spacetime login                      # once
spacetime publish --server maincloud --module-path fair-drop-db/spacetimedb fairdrop-demo

# pages
netlify login                        # once (or export NETLIFY_AUTH_TOKEN)
netlify deploy --prod                # from the repo root, reads netlify.toml

# bots, against the deployed module — same process model as local, only the URI changes
cd clients/bots
FAIRDROP_URI=https://maincloud.spacetimedb.com \
  node --experimental-strip-types src/turn.ts auto <eventId> fairdrop-demo
```

**No region control.** Maincloud publishes to one global endpoint; the CLI has no `--region`
flag and `mumbai.maincloud.spacetimedb.com` does not resolve. So the "put the driver near the
module" advice above cannot be satisfied by moving the *module* — only by choosing where the
driver runs, and by accepting that every phone in a Mumbai room is paying transatlantic RTT to
reach the module. That is fine for turn mode, which resolves on a 45s wall clock, and it is
**not** fine for a Round 1 that claims to measure reaction time: RTT then sits inside the thing
being measured. Run Round 1 against a local instance on the room's own wifi if the number has
to mean anything.

## Endpoints, and how they are configured

Nothing is hardcoded any more. Each side reads its own env:

| Side | Variable | Default when unset |
|---|---|---|
| Pages (build-time, Vite) | `VITE_STDB_URI`, `VITE_STDB_DB` | `${location.hostname}:3000`, `fairdrop-scratch` |
| Bot driver (run-time) | `FAIRDROP_URI`, plus the db name as argv[4] | `http://127.0.0.1:3000`, `fairdrop-scratch` |

`?host=` and `?db=` on the page URL still override the build's values — which is what lets one
deployed build be pointed at a laptop's local module during a rehearsal.

Two hard requirements once the pages are served over HTTPS, both satisfied by the values above:

- **`wss://`, not `ws://`.** A page served over HTTPS cannot open a plaintext WebSocket; the
  browser blocks it as mixed content, and the failure looks exactly like the module being down.
  The SDK derives its socket scheme from `VITE_STDB_URI`, so that value must be `https://`.
- **`dbName()` must not default to `fairdrop-scratch`** in a deployed build — hence
  `VITE_STDB_DB` in `netlify.toml`.

## The one that will bite you: admin identity

`create_event` records `ctx.sender` as the event's admin, and `start_countdown`, `open_event`
and `settle` all check it. The browser's SpacetimeDB identity lives in local storage.

So: clear site data, use a different browser, or open the admin page in a private window on
demo day, and you lose admin **on your own event** — `E_NOT_ADMIN`, with no recovery for that
event. Create a fresh one and start over.

Mitigations, in order of effort: create the event from the same browser profile you will
present from; or surface the identity in the admin UI with an export/import; or create events
from the CLI (which runs as the database owner) and use the page as a monitor only.

This bites harder on Maincloud than it did on the laptop, because the CLI and the browser are
now obviously different identities: an event created with `spacetime call ... create_event` can
only be locked, opened and settled from the CLI. **Create the demo event from the admin page**,
in the browser you will present from.
