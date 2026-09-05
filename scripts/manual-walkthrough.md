# Manual walkthrough — driving the module by hand

For exercising the module from the CLI without the bot driver or the display: create an event,
watch queue mode sell out, watch turn mode defer allocation to the draw. Every command here was
run against a live 2.10 instance on 2026-09-06; the SQL column names are copied from actual
output, not from the schema source.

This is a **learning and debugging** document. The rehearsal script is `docs/DEMO-RECIPE.md`,
and the rig check is `scripts/smoke.sh` — do not substitute this for either.

```bash
export PATH="$HOME/.local/bin:$PATH"   # the CLI is installed but NOT on PATH
cd "$(git rev-parse --show-toplevel)"
DB=fairdrop-scratch
```

## Read this before you start

**Use `fairdrop-scratch`, never `fairdrop-demo`.** The demo database holds the rehearsal and its
evidence.

**Do not run `scripts/smoke.sh` while a walkthrough is live.** It publishes with
`--delete-data=always` and will silently destroy everything below.

**Run every admin call from the same shell that created the event.** `create_event` records
`ctx.sender` as the event's admin, and `start_countdown`, `open_event` and `settle` all check it.
`spacetime call` runs as the database owner, so one shell is consistent with itself — but a
different identity gets `E_NOT_ADMIN`.

**Everyone must join before `start_countdown`.** Inventory is derived from the headcount at that
instant, and only that instant. Joining afterwards succeeds, but those participants are not
counted in the ticket supply — the join door stays open until `settled` deliberately, so a
straggler mid-demo is not turned away.

**Procedures log a spurious `nonexistent reducer` ERROR on success** (CONTRACT §10). The returned
value and the committed row are what count. Do not read that line as a failure.

**Event ids increment across the database**, they do not restart per run. Substitute the id
`create_event` actually returns for `$EV` below.

---

## Queue mode — allocation on arrival

```bash
spacetime call --server local $DB create_event '"manual-queue"' '"queue"' '0.40' '15000' '[]'
```

Arguments are `name, mode, ticketFraction, ticketPrice, floors`. There is no `totalTickets`
argument — inventory is derived later, at the only moment the participant count is both final
and known.

```bash
# join returns a ParticipantId. Wallet is a module-RNG draw on [20000, 150000].
spacetime call --server local $DB join "$EV" '"Alice"' '"human"'
spacetime call --server local $DB join "$EV" '"Bob"'   '"human"'
spacetime call --server local $DB join "$EV" '"Cara"'  '"human"'

spacetime sql --server local $DB \
  "SELECT id, handle, wallet_balance, has_won, origin FROM participant WHERE event_id = $EV"
```

```bash
spacetime call --server local $DB start_countdown "$EV"   # sizes inventory from headcount
spacetime call --server local $DB open_event "$EV"

spacetime sql --server local $DB \
  "SELECT id, state, total_tickets, tickets_remaining, participants_at_open FROM event WHERE id = $EV"
```

```bash
# slotIndex is always 0 in queue mode; price must equal ticketPrice exactly.
spacetime call --server local $DB submit_bid "$EV" "$PID" '0' '15000'

spacetime sql --server local $DB "SELECT * FROM allocation WHERE event_id = $EV"
```

Allocation and debit happen in that one call — never two calls, never a follow-up reducer, and
there is no reservation or hold state anywhere. Serialized reducers are what make a hold
redundant (CONTRACT §5).

At 3 participants and `ticketFraction = 0.40` the inventory is **1 ticket**, so the event settles
the instant that one sale lands. That sell-out path is worth watching: it is the reason
`settleImpl` is split from the public `settle` reducer. The final purchaser is not the admin, so
a single guarded `settle` would throw, and because a throw rolls back the whole transaction the
last ticket purchase would fail.

**Join 10 participants (4 tickets) if you want to exercise the error paths.** At 3 participants
the event settles after the first sale, and every subsequent call returns `E_EVENT_NOT_OPEN`
before reaching any of the more specific guards.

### Errors worth provoking

Verified live on 2026-09-06 against a 10-participant / 4-ticket event.

| Command change | Code | What it proves |
|---|---|---|
| price `14999` | `E_PRICE_MISMATCH` | Queue mode is a posted price, not an offer |
| slotIndex `1` | `E_STALE_SLOT` | Queue mode has exactly one slot |
| same participant twice, while tickets remain | `E_ALREADY_WON` | C5 — one ticket per participant per event |
| bid before `open_event`, or after sell-out | `E_EVENT_NOT_OPEN` | The equal-start premise, and the settled door |

**`E_SOLD_OUT` never fires on the sell-out path**, which is the one place you would go looking
for it. The last sale calls `settleImpl` in the same transaction, so the state is already
`settled` when the next bid arrives and `E_EVENT_NOT_OPEN` answers first. Verified: on a
4-ticket event, participants 48 and 49 both got `E_EVENT_NOT_OPEN`.

It is now reachable only through a deliberately malformed call, because the zero-inventory
route was closed on 2026-09-06 (TC-EVT-12). Before that fix, `size_inventory` guarded
`participants == 0` but not `totalTickets == 0`, and `round(0.40 x 1) == 0`, so this sequence
opened a dead event:

```bash
EV=$(spacetime call --server local $DB create_event '"zero-inv"' '"queue"' '0.40' '15000' '[]')
PID=$(spacetime call --server local $DB join "$EV" '"Solo"' '"human"')
spacetime call --server local $DB start_countdown "$EV"   # totalTickets = 0, no error
spacetime call --server local $DB open_event "$EV"
spacetime call --server local $DB submit_bid "$EV" "$PID" '0' '15000'   # -> E_SOLD_OUT
```

`start_countdown` now returns `E_NO_PARTICIPANTS` at the third line and the event stays in
`created`, so the recovery is to add participants and call it again — which is exactly what
`DEMO-RECIPE`'s failure playbook already told the operator to expect.

---

## Turn mode — allocation deferred to the draw

```bash
spacetime call --server local $DB create_event '"manual-turn"' '"turn"' '0.40' '0' '[25000,30000,40000]'
```

Floors must **strictly increase** or you get `E_FLOORS_NOT_INCREASING`. This is a rejection rather
than a warning on purpose: under pay-the-floor, a later slot that is cheaper than an earlier one
means every remaining participant would rationally skip ahead to it, which dismantles the
mechanism the demo exists to show. `ticketPrice` is unused in turn mode — pass `0`.

Join **10 or more** participants. Below that the quota tends to meet or exceed the entries and no
draw actually happens, so you would be watching the uninteresting case.

```bash
spacetime call --server local $DB start_countdown "$EV"
spacetime call --server local $DB open_event "$EV"

# "floor" collides with the SQL FLOOR function — quote it, or SELECT *.
spacetime sql --server local $DB \
  "SELECT slot_index, \"floor\", base_quota, effective_quota FROM slot WHERE event_id = $EV"
```

```bash
# An entry, not a purchase. price must equal that slot's floor exactly.
spacetime call --server local $DB submit_bid "$EV" "$PID" '0' '25000'

spacetime sql --server local $DB "SELECT * FROM bid WHERE event_id = $EV"
spacetime sql --server local $DB "SELECT * FROM allocation WHERE event_id = $EV"   # still empty
```

**This is the difference the whole demo rests on.** `submit_bid` inserts a `bid` row and nothing
else — no allocation, no debit. The slot window is 60 seconds; when it expires the scheduled
`close_slot` runs the draw and allocates *then*. That deferral is the mechanism: once entry is
decoupled from allocation, nothing about arrival time can influence the outcome.

Wait out the window, then:

```bash
spacetime sql --server local $DB "SELECT * FROM slot_result WHERE event_id = $EV"
spacetime sql --server local $DB "SELECT * FROM allocation  WHERE event_id = $EV"
```

`slot_result.draw_seed` is the verifiable part — this is TC-CLR-09's whole claim, that an
outsider can recompute the draw from committed state alone.

**`--ids` takes BID ids, not participant ids.** The seed is derived from `entries.map(e => e.id)`
where the entries are `bid` rows (`index.ts`, `close_slot`). Passing participant ids produces a
plausible-looking seed that silently disagrees with the module.

```bash
# pull the bid ids for the slot
bids=$(spacetime sql --server local $DB \
  "SELECT id FROM bid WHERE event_id = $EV AND slot_index = 0" 2>/dev/null \
  | grep -oE '^ [0-9]+' | tr -d ' ' | paste -sd, -)

node integration/verify/recompute.mjs --event "$EV" --slot 0 --ids "$bids" --quota 2
```

Worked example, run live on 2026-09-06 — event 4, slot 0, 7 entries, quota 2:

```
bid ids: 5,7,3,1,4,6,2
derived drawSeed: a91837a60f7de0ae
winners, in the order the draw ranked them:
    1. bid 5
    2. bid 7
```

`slot_result.draw_seed` read back `a91837a60f7de0ae`, and `bid.state` showed `won` on exactly 5
and 7. The verifier and the module agree on real data, not only on the synthetic inputs
`scripts/smoke.sh` §7 uses. If they ever disagree, TC-CLR-09 is void — change one, change both.

Note that the ids need no sorting on your part: both sides sort internally before hashing, which
is why the unsorted `5,7,3,1,4,6,2` above still reproduces the seed.

### Closing a slot early

You own the database, and the owner is the one caller the host does not block:

```bash
spacetime call --server local $DB close_slot \
  "{\"scheduled_id\":1,\"scheduled_at\":{\"Time\":[1]},\"event_id\":$EV,\"slot_index\":0}"
```

This is not an integrity hole — the admin can end the round anyway. A **non-owner** calling
`close_slot` gets `404 No such procedure`, because scheduled reducers are private. That is
verified rather than assumed, and pinned by `scripts/smoke.sh` §8, because the module carries no
sender guard here and has no second line of defence if a version bump ever revokes it.

### Errors worth provoking

| Command change | Code | What it proves |
|---|---|---|
| same participant, same slot, twice | `E_DUPLICATE_ENTRY` | C2 — check-then-insert, safe only because reducers serialize |
| slotIndex `1` while slot 0 is current | `E_STALE_SLOT` | Entries land in the open slot or nowhere |
| price `26000` on a 25000 floor | `E_PRICE_MISMATCH` | There is no amount to choose, for anyone |
| a participant whose wallet < floor | `E_INSUFFICIENT_BALANCE` | The field thins as floors rise — this is the finding, not a bug |

All four verified live on 2026-09-06. `E_INSUFFICIENT_BALANCE` needs no setup: wallets are drawn
on `[20000, 150000]`, so at a 25000 floor roughly one entrant in eight is already priced out at
the first slot.

---

## Adding bots to a hand-built event

Once the event is `open`, in a second terminal:

```bash
node --experimental-strip-types clients/bots/src/index.ts 10 "$EV" 15000
```

The first argument is the **human** count; the bot count is derived from it at 4:1 (`BOT_RATIO`
in `clients/bots/src/config.ts`), so `10` gives 40 bots. All 40 run as async tasks in one
process — check the pid it prints.

Each bot waits a value drawn independently and uniformly on `[0, DELTA_MS = 500ms]`, so a
successful queue run shows scattered rather than sequential winners:

```bash
spacetime sql --server local $DB "SELECT id, participant_id FROM allocation WHERE event_id = $EV"
```

If those `participant_id`s come out near-sequential, something has replaced the per-bot draw with
a fixed sleep — which would synchronize the field into one arriving block and make the
arrival-order result meaningless.

---

## Resetting

```bash
DB=fairdrop-scratch ./scripts/smoke.sh    # republishes with --delete-data=always
```

Only ever against `fairdrop-scratch`, and never while anything you care about is live.
