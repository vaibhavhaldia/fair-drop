# Fair Drop — Frozen Contract (Gate 0)

**Status:** FROZEN 2026-09-05 · Saksham + Vaibhav
**Supersedes:** the v2-era shapes in `sdd-engine/techspec/LLD.md` §1–§2 wherever the two disagree.
**Companion:** `LLD.md` carries the reasoning and pseudocode; this file carries the decisions.

This is the seam. Everything below is agreed by both engineers and may not be changed by one
of them alone — see [Change control](#11-change-control). If a screen, a bot, or a test appears
to need something this document doesn't provide, that is an **escalation**, not a workaround.

---

## 1. Preconditions

| Item | Frozen value |
|---|---|
| SpacetimeDB | **`spacetimedb@2.10.0` exactly** — not `2.10.*` |
| Module path | `fair-drop-db/spacetimedb/` — **not** `module/`, which does not exist |
| Module tests | `fair-drop-db/spacetimedb/tests/` |
| Test runner | **vitest**. 4h build writes only the pure tier (TC-INV-01, TC-CLR-09); the `*.int.test.ts` tier below is designed, not built |
| Demo target | **local `spacetime start`**; Maincloud optional |
| CLI | **v2.10.0 — matched to the lib, no skew.** Installed at `~/.local/bin/spacetime`, NOT on PATH — `export PATH="$HOME/.local/bin:$PATH"`. 2.10.0 is `current`, so no `spacetime version use` step is needed; check with `spacetime --version` before Stage 0 and run `spacetime version use 2.10.0` only if it reads something else. The full §10 table was **re-verified end-to-end on this pair** on 2026-09-05 |

**There is no LTS.** 2.10.x is a release line, not a support channel. The exact pin *is* the
stability mechanism, which is why a floating range would defeat it. **CLI and lib are pinned to
the same version deliberately** — the earlier 2.9.0-CLI/2.8.3-lib pairing worked, but a skew
you have to remember to re-establish on every rig is a demo-morning failure waiting to happen.
Matched versions remove the check entirely.

**Supply-chain rules** — all five, everywhere in the repo, not just the module:

1. Exact versions, no `*`/`^`/`~` ranges.
2. `npm ci` only; never `npm install` in CI or on the demo rig.
3. `--ignore-scripts` on install (kills the `postinstall` vector).
4. `npm audit signatures` in CI.
5. Lockfiles committed.

### Test strategy

SpacetimeDB ships **no test harness and no recommended framework**. Official testing is
CLI-driven against a live instance; the request for an isolated in-module harness
([#2833](https://github.com/clockworklabs/SpacetimeDB/issues/2833)) is open and unassigned.
Vitest is our choice of driver, not a convention we inherit.

**Reducers cannot be unit-tested at all — verified, not assumed.** `spacetimedb/server`
imports `spacetime:sys@2.0`, a host-provided module scheme that plain Node cannot resolve. Any
file importing `spacetimedb/server` is unloadable in vitest. This settles the Gate 1 escalation
about the module test harness: there isn't one, and there cannot be one in-process.

The consequence is that the pure-function split below is **the only thing that makes any of
this testable**, and that every case marked `UT` in `test-cases.md` which assumes it can invoke
a reducer is really an `IT` needing a live instance.

Two tiers, and the split is a **contract requirement, not a style preference**:

- `*.unit.test.ts` — pure functions, no server. The draw (`drawSeed` derivation and
  `rank(seed, entries)`) and the inventory arithmetic **must** live in plain importable modules
  taking no `ctx`, with the reducers as thin callers.
- `*.int.test.ts` — live local instance, fresh event per test (never a DB reset, per §1b).

Two reasons this is mandatory: TC-INV-01's ≥100 shuffled permutations are milliseconds as a
pure call and minutes through a live DB; and TC-CLR-09 ("recompute the draw *outside* the
module") is only meaningful if the test imports the very function the module ran, rather than
reimplementing it and proving nothing.

---

## 2. Table shapes

**Nine tables as designed:** `event`, `slot`, `participant`, `bid`, `allocation`,
`slot_result`, `slot_schedule`, `countdown_schedule`, `settle_schedule`.

> **4h build scope: seven.** `countdown_schedule` and `settle_schedule` are cut — the admin
> calls `open_event` and `settle` directly, which removes two scheduled-table wirings and the
> two ways an event can hang forever. `slot_schedule` stays: turn mode needs slots to
> auto-advance. Everything else in this document is unchanged; adding the two tables back is
> additive.

Conventions: **snake_case table names, camelCase columns.** Every table has a `u64` autoInc
primary key. There are **no composite unique constraints** — SpacetimeDB supports single-column
`.unique()`/`.primaryKey()` only; multi-column access goes through a named btree
(`by_event_slot` on `(eventId, slotIndex)` for `slot`, `bid`, `allocation`, `slot_result`).

### Column notes that carry decisions

| Table | Column | Decision |
|---|---|---|
| `event` | `slotCount` | `= floors.length` at create; 0 for queue. §2 read it before it existed |
| | `adminIdentity` | whoever creates the event is its admin — self-establishing, no bootstrap |
| | `endTime` | written only by `settle` |
| `slot` | `baseQuota` | set once at `start_countdown`, **never mutated**. `sum(baseQuota) == totalTickets` for the life of the event — assert against this |
| | `effectiveQuota` | `baseQuota` + rollover. **Deliberately exceeds** `totalTickets` once anything rolls forward. `close_slot` allocates against this. **At the locked parameters it always equals `baseQuota`** — see §6 |
| `participant` | `id` | PK — **not** `identity` |
| | `eventId` | registration is **per event**; C5 is per-event by construction |
| | `identity` | indexed, **not unique** — one pooled connection backs many rows |
| | `handle` | **UNIQUE**, `displayName + "-" + randomSuffix`. Makes TC-POOL-07 a schema guarantee |
| | `displayName` | as typed, **not unique** — live audiences collide on names |
| | `initialBalance` | immutable; the reconciliation anchor (§5) |
| `bid` | `slotIndex` | **turn mode only** — queue mode writes no `bid` rows at all |
| | `seq` | **DO NOT DELETE.** TC-INV-03 randomises it to prove C1; that proof cannot run against `id`, which is the PK and a draw-hash input |
| `slot_schedule` | `slotIndex` | the timer names the slot it closes. Do **not** drop it and read `event.currentSlotIndex` — a stale row would then close whatever slot is current, and the double-close guard cannot see that (`E_STALE_TIMER`) |

**A slot is closed iff a `slot_result` row exists for it.** No `closed` flag. `filled == 0` is
*not* a closed-marker — a slot can legitimately close having allocated nothing.

**Money is integer rupees** — every currency field, no paise. `t.f64()` represents these
exactly.

**Ids are `t.u64()` → `bigint`**, which does not survive `JSON.stringify`. The SDK owns
bigint↔string conversion at its boundary; no consumer does it itself.

### Five API corrections vs. the v2 draft

Each would have failed at build on first contact:

1. Optional columns are **`t.option(t.f64())`** — there is no `.optional()` modifier.
2. The **`scheduled:` option lives on the table**, not as `onSchedule` on the reducer. The
   reducer receives the schedule row as its single argument; the runtime deletes it after.
3. `t.u64()` is **`bigint`**, not `number`.
4. Table names snake_case, columns camelCase (client codegen converts case; the server does
   not). `spacetime sql` accepts **either** casing in a query and renders `SELECT *` headers
   snake_cased — verified, so §10's Stage 3 queries are safe as written.
5. **`.primaryKey().autoInc()` does not make the column optional at insert.** `insert()` takes
   the full row type, so every insert must pass a placeholder — `id: 0n` — and read the real
   id off the **returned row**. This bites every table in §2, since all nine have a `u64`
   autoInc PK.

`mode`/`state`/`origin` are **`t.string()`, not `t.enum()`** — 2.8 documents `t.enum()` only as
a tagged union with payloads, and a payload-free variant is undocumented. Literal sets:
`mode ∈ {queue, turn}` · `state ∈ {created, countdown, open, settled}` ·
`origin ∈ {human, bot}` · `bid.state ∈ {pending, won, lost, rejected}`.

---

## 3. Reducer & procedure signatures

**Reducers cannot return values.** Only `spacetimedb.procedure(...)` declares a return type, so
anything that must hand back a generated id is a procedure.

| Name | Kind | Signature |
|---|---|---|
| `create_event` | **procedure** | `(name, mode, startTime, config) -> EventId` |
| `join` | **procedure** | `(eventId, displayName, origin) -> ParticipantId` |
| `start_countdown` | reducer | `(eventId)` — admin only |
| `submit_bid` | reducer | `(eventId, participantId, slotIndex, price)` |
| `open_event` | reducer | `(eventId)` — **admin-called in the 4h scope** (designed as scheduled; `countdown_schedule` cut) |
| `close_slot` | scheduled reducer | `(timer)` — private, scheduler-invoked. The one surviving schedule |
| `settle` | reducer | `(eventId)` — **admin only, `E_NOT_ADMIN`.** Thin wrapper over a private `settleImpl(ctx, eventId)`; `close_slot` and `submit_bid` call `settleImpl` directly (designed as a scheduled fallback; `settle_schedule` cut) |

**`submit_bid` and `close_slot` must remain reducers.** Procedures open short `ctx.withTx`
transactions rather than wrapping the whole call; C2's check-then-insert and the atomic
allocation+debit both depend on full reducer serialization. Do not convert them for signature
convenience.

**No `ctx.sender == module identity` guards.** Scheduled reducers are private by default in
2.x, and `ConnectionId` is `None` for scheduler-invoked calls — such a guard is more likely to
be written wrong than to catch anything. The real guard is "no `SlotResult` exists for this
slot."

### SDK surface (`clients/sdk/FairDropClient`)

```ts
join(eventId, displayName, origin): Promise<ParticipantId>
createEvent(config): Promise<EventId>                  // admin
startCountdown(eventId): void                          // admin
submitBid(eventId, participantId, slotIndex, price): void
listEvents(): Event[]
subscribeEvent(eventId, cb): Unsubscribe
subscribeAllocations(eventId, cb): Unsubscribe
subscribeSlotResults(eventId, cb): Unsubscribe
getWalletBalance(participantId): number
```

Nothing outside `clients/sdk` imports generated bindings directly (TC-SDK-02).

---

## 4. Error semantics

Failure = **throw**. `SenderError` (from `spacetimedb/server`) for caller-fault, carrying a
stable code. Throwing **rolls back the whole transaction** — this is what makes "ticket XOR
nothing" structural, and why no reducer needs compensating writes.

**Two classes.** *Expected rejections* are normal traffic (a bot entering a slot it can't
afford is the mechanism working) — `SenderError` + code, rendered by the UI, swallowed by bots.
*Invariant violations* are module bugs — plain `Error`, must never reach a user; TC-CLR-12/13
assert they **never fire** rather than exercising them.

**`settle` is neither, and it must be split in two.** `settleImpl(ctx, eventId)` is a private
helper whose `state == "open"` check is a silent **no-op, not an error** — queue mode settles on
sell-out *and* on an admin call, so a second call is expected. This is the one guard in the
module that must not throw. The `E_NOT_ADMIN` check lives on the **exported `settle` reducer
only**.

**Do not merge them.** "Called internally" is untestable — an internal call is a plain function
call, so `ctx.sender` stays the outermost caller. A single guarded `settle` throws on the queue
sell-out path (`submit_bid` → `settle`, sender = the participant), and since a throw rolls back
the whole transaction, **the last ticket purchase fails**. `close_slot` and `submit_bid` call
`settleImpl`; only the admin goes through `settle`.

| Reducer | Codes |
|---|---|
| `create_event` | `E_FLOORS_EMPTY` · `E_FLOORS_NOT_INCREASING` · `E_TICKET_PRICE_INVALID` · `E_FRACTION_INVALID` |
| `start_countdown` | `E_NOT_ADMIN` · `E_WRONG_STATE` · `E_NO_PARTICIPANTS` |
| `join` | `E_EVENT_SETTLED` · `E_HANDLE_COLLISION` *(retryable — pool regenerates the suffix)* |
| `submit_bid` | `E_EVENT_NOT_OPEN` · `E_UNKNOWN_PARTICIPANT` · `E_WRONG_EVENT` · `E_ALREADY_WON` · `E_STALE_SLOT` · `E_PRICE_MISMATCH` · `E_INSUFFICIENT_BALANCE` · `E_SOLD_OUT` · `E_DUPLICATE_ENTRY` |
| `close_slot` | `E_WRONG_STATE` · `E_SLOT_ALREADY_CLOSED` |

**Guard order is frozen**, because the code returned depends entirely on which guard runs first:

```
E_EVENT_NOT_OPEN → E_UNKNOWN_PARTICIPANT → E_WRONG_EVENT → E_ALREADY_WON
  → E_STALE_SLOT → E_PRICE_MISMATCH → E_INSUFFICIENT_BALANCE → E_SOLD_OUT / E_DUPLICATE_ENTRY
```

Identity questions before offer questions before contention questions. C5 sits high: a winner
is out of the event entirely, so their balance and the remaining inventory are moot. Tests
assert on **codes**, never on message text.

### Determinism — two random sources, never confused

- **Wallet draw → `ctx.random.integerInRange(20_000, 150_000)`.** Never `Math.random()`.
- **Allocation draw → MUST NOT touch `ctx.random`.** It is a pure function of `drawSeed`, which
  is a pure function of committed state. If `close_slot` reaches for `ctx.random`, TC-CLR-09
  and TC-INV-11 become impossible — a third party has no access to the module's RNG stream, and
  the verifiability claim dies *silently*, since the draw still looks uniform and every
  behavioural test still passes.
- `now()` means **`ctx.timestamp`**, never `Date.now()`.

---

## 5. Wallet-debit contract

**A debit happens if and only if an allocation happens, in the same reducer call, for exactly
the slot's uniform price.** There is no other way money moves.

1. **Co-transactional** with the allocation write. Never two calls, never a follow-up reducer,
   never a saga.
2. **The amount is the slot's uniform price** — `ticketPrice` (queue) or `slot.floor` (turn) —
   and equals the `pricePaid` on the `Allocation`. Under pay-the-floor there is no per-winner
   price, so a debit differing from the row beside it is a bug by definition.
3. **A losing entry costs nothing** — byte-identical balance, because a loser's path touches no
   wallet field at all.
4. **No reservation / hold / escrow / pending state anywhere.** Grep-able: no column named
   `reserved`, `held`, `pending`, `locked`. Serialized reducers are exactly why a hold would be
   redundant.
5. **Never negative** — guarded on entry, guarded again defensively at clearing (unreachable
   under C5; assert it never fires rather than exercising it).

**Reconciliation.** Sweepable over every participant after every test:

```
initialBalance - walletBalance == sum(pricePaid) over Allocation for that participant
```

C5 caps a participant at one ticket per event, so the right-hand side is always `0` or a single
slot price. Without `initialBalance` this invariant has nothing to compare against and TC-WAL-04
cannot be written at all.

**Clients never do arithmetic on `walletBalance`.** Render the subscribed row. A phone view
computing `balance - price` to predict a post-purchase figure will eventually disagree with the
module — that is TC-WAL-10's entire purpose.

No top-up, no refund, no persistence across a reset. Money moves once, in one direction, per
participant per event.

---

## 6. Derived-inventory rule

```
totalTickets := round(ticketFraction × participants_in_this_event)   // at start_countdown only
base         := floor(totalTickets / slotCount)
remainder    := totalTickets − base × slotCount
baseQuota[i] := base + (i < remainder ? 1 : 0)
```

- **`round` is half-away-from-zero** (JS `Math.round`). Pinned because *no existing test
  exercises it* — TC-EVT-10's populations all divide exactly, so a wrong mode ships green.
- **Remainder spreads over the EARLIEST slots**, not the last. §1a's original "remainder to the
  final slot" is pathological below ~13 participants: at 10 participants `totalTickets = 4`,
  `base = 0`, and slots 0–3 get zero while slot 4 takes all four — the whole event sells at the
  top floor where most wallets don't qualify. Identical whenever the division is exact
  (every demo-scale number), strictly better otherwise.
- **Zero participants → `E_NO_PARTICIPANTS`.** Resolves the escalation `saksham.md` flags at
  Gate 2. Allowing it yields a dead event on a projector with no explanation.
- **The headcount is per-event.** Unqualified `count(Participant)` would size the second event
  in `test:core` off both populations — silently, and undetectably in any single-event test.
- **`participantsAtOpen` is a snapshot** (taken at countdown, despite the name, which stays
  because §8's dashboard depends on it). Late joins are allowed and do **not** resize inventory.
  Assertions must read the snapshot, never re-count.

**`ticketsRemaining` cannot go negative** — a conservation property, not a guard. Total capacity
is exactly `totalTickets`, and rollover moves only the unfilled portion forward, neither
creating nor destroying any. Do not add a defensive clamp; it would mask a real allocation bug.

**Rollover is implemented but never fires at the locked parameters — this is expected.**
Measured 2026-09-05 over 1,000 simulated events at every turnout from H = 8 to H = 250:
**zero runs with any unfilled quota.** Per-slot quota is `0.40 / 5` = 8% of the population,
while even the ₹55,000 top floor leaves 56% of the U[₹20k, ₹1.5L] wallet distribution
eligible; at H = 10 the eligible field runs 50 → 46 → 41 → 34 → 28 against a quota of 4.

Making rollover appear needs a top floor near **₹1,30,000**, at which point tickets start
going **unsold** (19.6 of 20; 16 of 20 at ₹1.5L) because the final slot cannot fill and there
is nowhere left to roll — so **rollover firing and full sell-out are mutually exclusive at
five slots**, and the demo asserts sell-out. It would also push average price paid from
₹32,400 toward ₹45,000 against a ₹15,000 face value, reintroducing the markup §5a of the HLD
rejects pay-as-bid for.

Consequences, all deliberate: keep the rollover code path (the arithmetic is right and the
parameters are not frozen forever); test it only against the **pure inventory module** with a
hand-built entry set (`TC-ROLL-*`); and do **not** make it a stage check — `DEMO-RECIPE.md`
Stage 2.2 previously carried `TC-ROLL-01` as a blocking `✅` that could never pass.

---

## 7. Invariants — enforcement points

| | Property | Enforced by |
|---|---|---|
| C1 | Allocation independent of arrival order | `drawSeed` derived from `(eventId, slotIndex, sorted(entry ids))`; ranking by `hash(drawSeed, entry.id)`. `seq` and insertion order never read for ordering |
| C2 | ≤1 entry per participant per slot | check-then-insert in `submit_bid`; safe **only** because reducers serialize. No schema constraint exists |
| C3 | All clients act on one committed state | single serialized `slot_result` write per slot |
| C4 | No client acts before commit | seed derives from data that exists only at close — unpredictable in advance |
| C5 | ≤1 ticket per participant per event | `participant.hasWon`, checked in `submit_bid` and again in `close_slot`; per-event by construction via `participant.eventId` |

`entry.id` **is** read by the allocator — but only as a hash input, never as an ordering, and
the seed uses the sorted *set*. This distinction is the hinge C1 turns on.

**That hinge holds only if the hash avalanches.** `bid.id` is a sequential `autoInc` PK, so it
encodes arrival order; any hash that preserves input locality turns "hash input" back into
"ordering" and C1 fails **silently** — the demo still looks correct on stage. The draw hash must
therefore have full 64-bit avalanche, and the requirement is a contract term, not an
implementation detail. `digest64` = FNV-1a + SplitMix64 finalizer (`src/pure/hash.ts`), mirrored
byte-for-byte in `integration/verify/recompute.mjs`; change one, change both.

Raw FNV-1a alone was shipped on 2026-09-05 and measured biased: of 24 sequential ids, 6 could
never place first and consecutive ids ranked adjacently (mean rank-gap 2.59 against 8.33 for a
uniform draw). **TC-CLR-11 guards this and must not be cut again** — TC-INV-01 cannot detect it,
because permuting the input array never changes the ids inside it.

---

## 8. Ownership

| Path | Owner |
|---|---|
| `fair-drop-db/spacetimedb/**` | Saksham — tables, reducers, allocation, wallet, C1–C5 |
| `clients/sdk/**` | Saksham |
| `integration/experiment/**` | Saksham |
| `clients/web/**` (the display), `clients/bots/**` (the bot script) | Vaibhav |

`services/bot-runner/**` appears nowhere — the HTTP service is cut from the 4h build; bots are a
script, not a service.

Neither edits the other's paths. A UI need that the module doesn't publish is a **new
subscription or reducer**, never client-side math.

---

## 9. Architecture decisions with recorded tradeoffs

**Pooled connections, decoupled participants.** Identity is per-connection in SpacetimeDB, so
pooling means one `Identity` backs many bots — which is why `participant` is keyed on `id` and
reducers take an explicit `participantId`. *Tradeoff, accepted:* any connection can then act
for any participant. For a demo with no adversary this is fine, and it actively **preserves**
the property that the module cannot tell a bot's `submit_bid` from a human's — both now have
identical call shape. The alternative (one connection per bot) is what LLD §5a rules out as
unsurvivable at 1,000 bots.

**Bots remain async tasks in one process, never child processes.** This is the half of §5a
that would actually kill a demo rig, and it holds.

**The bounded connection pool is deferred** for the 4h build — 40 bots get one connection each;
the constraint existed for 1,000. The schema is deliberately **not** reverted along with it:
`participant.id` stays the PK and `identity` stays non-unique, so the pool returns later with
no migration and no rework across the seam. Deferring an implementation is not reversing the
design, and re-coupling the schema to `identity` now would have to be undone the moment bot
count rises.

---

## 10. Verified against a running build — 2026-09-05

Stage 0 of `DEMO-RECIPE.md` was executed. Everything below is **build-proven, not
docs-derived**. No open questions remain from this list.

| Claim | Result |
|---|---|
| `t.option(t.f64())` / `t.option(t.timestamp())` | ✅ compiles; `.optional()` does not exist |
| `scheduled: (): any => reducerRef` on the **table** | ✅ compiles and registers |
| Multi-column btree via `indexes: [{accessor, algorithm, columns}]` | ✅ compiles |
| `t.identity().index('btree')` non-unique | ✅ **three participants created from one identity** — Blocker A's fix works in practice |
| `t.string().unique()` on `handle` | ✅ duplicate insert **throws and rolls back** — the row does not land, so `E_HANDLE_COLLISION` is a real, catchable path |
| **Procedures return values to the caller** | ✅ `join_proc` returned `[1.0, 69565.0]` — the id and wallet. **The §3 fallback is NOT needed** |
| `ctx.random.integerInRange(20_000, 150_000)` | ✅ distinct integers in range: 69565 / 147207 / 101813 |
| `ctx.withTx(tx => ...)` inside a procedure | ✅ insert + return in one transaction |
| CLI 2.10.0 vs lib 2.10.0 (matched) | ✅ publish, `call`, `sql` all round-trip |
| `.primaryKey().autoInc()` insert | ⚠️ the column is **still required** in the insert argument — pass `id: 0n` and read the assigned id off the returned row |

**Reproducing this table.** `fair-drop-db/spacetimedb/spike/verify-api.ts` is the artifact —
run instructions are in its header. It publishes to a **separate** database (`fairdrop-spike`)
and never overwrites the real module. The whole table above was reproduced from it on
2026-09-05 against CLI 2.10.0 + lib 2.10.0; the recorded run:

```
$ spacetime call --server local fairdrop-spike join_proc '"Asha"'    → [1.0,69565.0]
$ spacetime call --server local fairdrop-spike join_proc '"Bilal"'   → [2.0,147207.0]
$ spacetime call --server local fairdrop-spike join_proc '"Chitra"'  → [3.0,101813.0]
$ spacetime sql  --server local fairdrop-spike "SELECT * FROM participant"
  3 rows, one shared identity, handles Asha-b014 / Bilal-952 / Chitra-a711
$ spacetime call --server local fairdrop-spike force_handle_collision '"dupe"'   → ok
$ spacetime call --server local fairdrop-spike force_handle_collision '"dupe"'   → error, row NOT inserted
```

**If the spike stops building, that is a finding about this table, not a bug in the spike.**
Escalate before working around it.

**One naming rule discovered:** the CLI exposes exported members **snake_cased** —
`export const joinProc` is called as `join_proc`, `closeSlot` as `close_slot`. This happens to
match the reducer names in §3, so nothing changes — but call them by the snake_case name.

**Operational gotchas that cost real minutes:**

- `--server local` is required on **every** `call`/`sql`/`logs` — `spacetime.json` says
  `maincloud`, so they otherwise fail with *"failed to find database"* after a successful publish.
- Run `call`/`sql` from **outside** `fair-drop-db/`, or `spacetime.local.json` overrides the
  database name.
- `spacetime publish -p <path>` — **not** `--project-path`, which does not exist in 2.9.
- Republish over a changed schema with `--delete-data=always`, not `-c always`.
- SQL has no `GROUP BY`. Aggregate in the client or the display.
- **SQL has no `COUNT(*)` either** — same rule, same fix. `SELECT COUNT(*) FROM t` 400s.
- **`floor` is a reserved SQL keyword.** `SELECT slotIndex, floor FROM slot` is a parse error;
  quote it as `"floor"`. It is the one column name in §2 that collides.
- **Procedures log a spurious `ERROR` on every successful call** — `create_event` and `join`
  both emit *"External attempt to call nonexistent reducer … Have you run `spacetime generate`
  recently?"* while returning the right value and committing the row. Verified 2026-09-05: ids
  came back and the rows landed. Stage 0 keeps `spacetime logs` open on a third screen, so
  expect a wall of red during joins and do **not** debug it live.
- **The local instance serves no web UI.** `http://127.0.0.1:3000/` returns 404 *by design* —
  it is the API root. A 404 there means the server is up; a dead port gives connection refused.
  Check with `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/v1/ping` → 200.
- **Local databases never appear on spacetimedb.com.** That dashboard shows Maincloud only, so
  an empty Databases list there is expected and is not a symptom. `spacetime list --server local`
  is the local equivalent.
- **The demo database is `fairdrop-demo`.** The bare name `fairdrop` is claimed on the local
  instance by an earlier pre-login identity and 403s on publish (*"not authorized … reset
  database"*). Renaming was chosen over resetting the instance — see DEMO-RECIPE Stage 0.

---

## 11. Change control

Anything in this document changes **only by agreement of both engineers**, recorded here with
the reason. Specifically frozen against silent revision:

- `seq` (deletion looks obviously correct and breaks TC-INV-03 / TC-SCH-05)
- the `ctx.random` prohibition in `close_slot` (violating it passes every behavioural test)
- guard order in `submit_bid`
- `baseQuota` immutability
- the remainder-to-earliest-slots rule

If a test seems to require breaking one of these, the test is wrong or the need is an
escalation — not a reason to edit this file.
