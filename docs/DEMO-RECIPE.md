# Fair Drop — Demo Recipe

**Run this exactly as it will run on stage, from the first build onward.** Every check names the
test case it enforces, so a failure points at a spec line rather than a vague "something's off."

**Rule: never run a step out of order to "just check one thing."** Order is what surfaces state
bugs — an event that only works when created fresh is a bug you want at hour 1, not hour 4.

Legend: **A**rrange · **A**ct · **C**heck.
`✅` = must pass before continuing · `👀` = watch, don't block · `🎤` = what you say on stage.

---

## Stage 0 — Rig (once, ~10 min)

| | |
|---|---|
| **A** | `cd fair-drop-db/spacetimedb && npm ci --ignore-scripts` |
| **A** | `export PATH="$HOME/.local/bin:$PATH"` — the CLI is installed but **not on PATH** |
| **A** | `spacetime --version` → must read **2.10.0**, matching `spacetimedb@2.10.0` in `package.json`. It is `current`, so this normally just passes; if it reads anything else, `spacetime version use 2.10.0`. CLI and lib are pinned to the same version on purpose — CONTRACT §1 |
| **A** | `spacetime start` in its own terminal — leave it running, it is the demo |
| **Act** | `./scripts/smoke.sh` |
| **C** ✅ | Prints **Stage 0 passed — 9 checks**. **If it fails, stop — nothing downstream matters.** |

> **Stage 0 is a script, not a checklist, and that is deliberate.** It used to be four commands
> in this table; when the scaffold was deleted at Gate 1 it went on describing `add` and
> `person`, neither of which existed any more, and nothing noticed — prose that rots stays
> confident, a script that rots *fails*. `scripts/smoke.sh` checks the CLI pin, that the
> instance is actually up, that `$DB` holds no live event it is about to destroy, the publish,
> the procedure return path, the row landing, the pure tests, that `recompute.mjs` still agrees
> with the module's own hash, and that `close_slot` is still private to non-owners.
>
> **It refuses to run if `$DB` holds a live or completed event.** Stage 0 publishes with
> `--delete-data=always`; running it to "just check the rig" mid-demo would delete the event on
> the projector, and a settled event is the evidence Stage 3 recomputes from. Use
> `DB=fairdrop-scratch ./scripts/smoke.sh` to check the rig without touching the demo, or
> `FORCE=1` to wipe on purpose.
>
> **The verifier cross-check fails, it never skips.** It used to print a note and pass when
> `node --experimental-strip-types` was unavailable — which silently removed the only guard on
> TC-CLR-09 and pointed you at `npm test`, a suite that at the time could not catch the drift
> at all because every test in it imported the module's own hash. `npm test` now covers it
> directly (`tests/verifier-parity.unit.test.ts` shells out to `recompute.mjs`).

> **The database is `fairdrop-demo`, not `fairdrop`.** The bare name `fairdrop` is already
> claimed on the local instance by an earlier (pre-login) identity, and publishing to it fails
> with a 403 *"not authorized … reset database"*. Check what you own with
> `spacetime list --server local`. Nothing about the demo depends on the name.
>
> **The local instance has no web UI.** `http://127.0.0.1:3000/` returns 404 by design — that
> is the API root, not a dashboard, and a 404 there means the server is *up* (a dead port gives
> connection refused). Local databases never appear on spacetimedb.com, which shows Maincloud
> only. Inspect with `spacetime sql` / `logs`, or `curl /v1/ping`.
>
> **`--server local` is required on every command.** `fair-drop-db/spacetime.json` says
> `"server": "maincloud"`, so `call`/`sql`/`logs` go looking there and fail with
> *"failed to find database"* even though the publish succeeded. Also run `call`/`sql` from
> **outside** `fair-drop-db/`, or `spacetime.local.json` overrides the database name to
> `fair-drop-db-q9eli`. Both cost 10 minutes to diagnose the first time. Republish over an
> existing schema with `--delete-data=always` (not `-c always`).

**Rig checklist before every rehearsal and before the real run:**

- [ ] `spacetime start` running, database published, `spacetime logs --server local fairdrop-demo` open in a third terminal
- [ ] Display open on the projector, **font size checked from the back of the room**
- [ ] Bot script ready, count set to **4 × H** (40 at the target H = 10) — the 4:1 ratio is what the Round 2 claim rests on
- [ ] `spacetime sql` terminal open for live verification — the audience seeing you query raw state is the *point*
- [ ] Laptop on mains power, screen sleep disabled, notifications silenced

---

## Stage 1 — Round 1: the queue (FCFS baseline)

🎤 *"This is how tickets are sold today. First come, first served. Watch who wins."*

### 1.1 Arrange

| | |
|---|---|
| **A** | `create_event` — `mode: "queue"`, `ticketPrice: 15000`, `ticketFraction: 0.40` |
| **C** ✅ | `state == "created"`, `totalTickets == 0`, `ticketsRemaining == 0` · **TC-LC-01** |
| **C** ✅ | `adminIdentity` is populated · **TC-EVT-03** |
| **A** | Join **H humans** — each join auto-spawns **4 bots** (HLD §6). Target **H = 10 → 50 participants**. Each bot draws its own delay `U(0, DELTA_MS)`, `DELTA_MS = 500` — **not** a fixed 500ms for all |
| **C** ✅ | `5H` (= 50) `participant` rows, all with `eventId` set; exactly `4H` have `origin == "bot"` · **TC-JOIN-01/02** |
| **C** ✅ | `5H` **distinct** `handle` values; `walletBalance` values differ and are integers in [20000, 150000] · **TC-JOIN-03, TC-SCH-11** |
| **C** ✅ | `initialBalance == walletBalance` for every row · **TC-SCH-12** |

> ### ⚠ How many humans you need, and why it is not 1
>
> The headline number is the human **share of allocations**, and with too few humans that share
> is not a measurable quantity — it is a coin flip. At the fixed 4:1 ratio: `H` humans → `5H`
> participants → `T = 2H` tickets, and each ticket goes to a human with probability ≈ 1/5. So
> the expected human winners is `0.4H`, and the chance Round 2 hands humans **nothing at all**
> is ≈ `0.8^(2H)`:
>
> | H humans | participants | tickets | expected human winners | P(zero human winners) |
> |---|---|---|---|---|
> | 1 | 5 | 2 | 0.4 | **64%** |
> | 3 | 15 | 6 | 1.2 | **26%** |
> | 5 | 25 | 10 | 2 | 11% |
> | 8 | 40 | 16 | 3.2 | 2.8% |
> | **10** | **50** | **20** | **4** | **1.2%** |
>
> At H = 1 the Round 2 check below fails on roughly two runs in three — not because anything is
> broken, but because one person either wins or doesn't. A shutout is then indistinguishable
> from Round 1, on stage, with no way to tell the audience which it was.
>
> **Run H ≥ 8; target H = 10.** If fewer than 8 people join from the floor, top up with
> seeded `origin: "human"` participants before `start_countdown` — the module cannot tell the
> difference and the ratio is what the claim rests on.

### 1.2 Act

| | |
|---|---|
| **Act** | `start_countdown` |
| **C** ✅ | `totalTickets == round(0.40 × 5H) == 2H` (= 20 at H=10); `ticketsRemaining == 2H`; `participantsAtOpen == 5H` · **TC-EVT-10, TC-EVT-17** |
| **C** ✅ | `state == "countdown"`. Bots are idle — **no `bid` or `allocation` rows exist** · **TC-LC-05** |
| **Act** | Display counts down 60s. 🎤 *"Everyone starts at the same instant — nobody has a head start."* |
| **Act** | `open_event` at zero |
| **C** ✅ | `state == "open"`; bots fire within milliseconds |

### 1.3 Check — the payoff

| | |
|---|---|
| **C** ✅ | Exactly **2H** (= 20) `allocation` rows; `ticketsRemaining == 0` · **TC-Q-03** |
| **C** ✅ | **Bots took ~all of them.** Record the human count — it should be 0 or 1, against an expected 4 under a fair rule · **TC-Q-09** |
| **C** ✅ | Allocation order == arrival order (`allocation.id` ascending tracks bid arrival) · **TC-Q-05** |
| **C** ✅ | Every winner: `initialBalance - walletBalance == 15000`. Every loser: `initialBalance == walletBalance`, **byte-identical** · **TC-WAL-02/03/04** |
| **C** ✅ | `state == "settled"` on sell-out, without an admin call · **TC-LC-12** |

🎤 *"We lost. Not because we wanted it less — because we have human reaction time. Forty bots, twenty tickets, and the humans in this room got"* — read the number — *"out of an expected four. The auction selected for network latency, and it did exactly what it was designed to do."*

**Write the Round 1 human count on the whiteboard.** Round 2's claim is a comparison against
this number, not against an abstraction — and if you don't record it live, the audience has
only your word for it.

**If bots do NOT dominate**, something is wrong with the *demo*, not the code: check `DELTA_MS` is 500 and the bots aren't throttled. Round 1 must look unfair.

🎤 **Say the δ number out loud** — it is the strongest line in Round 1: *"These bots aren't superhuman. Each one waits a random amount of time — anywhere from instant to half a second, a quarter second on average. That's about as fast as a person can possibly tap a screen. They still took everything, because there are forty of them. You don't need to be fast to win first-come-first-served. You need to be reliably fast enough, at scale."*

---

## Stage 2 — Round 2: the turn (Fair Drop)

🎤 *"Same people. Same tickets. Same wallets. One thing changes: the rule."*

### 2.1 Arrange

| | |
|---|---|
| **A** | `create_event` — `mode: "turn"`, floors `[15000, 22000, 30000, 40000, 55000]`, fraction `0.40` |
| **C** ✅ | 5 `slot` rows, `baseQuota == 0`, `effectiveQuota == 0`, `slotCount == 5` · **TC-EVT-02, TC-SCH-15** |
| **C** ✅ | Floors `[15000, 22000, 22000, ...]` **rejected** with `E_FLOORS_NOT_INCREASING` — try it live, it is a good beat · **TC-EVT-07** |
| **A** | **New** population: the same **H humans + 4H bots**, freshly joined (never reuse Round 1's rows — §1b) |
| **C** ✅ | Fresh wallet draws; Round 1 participants untouched · **TC-JOIN-10** |

> **Critical:** a *new* event with *new* participants. Reusing Round 1's rows means every winner
> carries `hasWon == true` and is blocked by C5 — the round would look broken for the right reason,
> at the worst possible moment.

### 2.2 Act — per slot, five times

| | |
|---|---|
| **Act** | `start_countdown`, then `open_event` |
| **C** ✅ | `sum(baseQuota) == totalTickets == 2H`; at H=10 that is 20 → quotas `4,4,4,4,4`. At H=8 it is 16 → `4,3,3,3,3`, remainder to the **earliest** slots · **TC-EVT-09/11/16** |
| **Act** | Slot opens 60s. Enter **at second ~55** — deliberately last. 🎤 *"I'm entering last, on purpose."* |
| **C** ✅ | No entry count or other participant's entry visible before close · **TC-UI-11** |
| **Act** | Slot closes automatically via `slot_schedule` |
| **C** ✅ | One `slot_result` row: `clearingPrice == slot.floor`, `allocated <= effectiveQuota` · **TC-CLR-01** |
| **C** ✅ | Every winner in the slot paid **exactly** that floor · **TC-CLR-03** |
| **C** ✅ | `baseQuota` **unchanged** by the close — rollover writes to `effectiveQuota` only · **TC-EVT-09** |
| **C** 👀 | `effectiveQuota == baseQuota` on every slot. **Expect no rollover — that is correct, not a failure.** See the box below |
| **C** 👀 | Eligible field visibly shrinks as floors rise past wallets — the visual drama |

> ### ⚠ Rollover will not fire, and you must not "fix" it on stage
>
> Under the locked parameters — floors 15/22/30/40/55k, wallets U[₹20k, ₹1.5L], fraction 0.40 —
> **unfilled quota never occurs.** Measured over 1,000 simulated runs at every turnout from
> H = 8 to H = 250: **0 runs with any rollover.** At H = 10 the eligible field goes
> 50 → 46 → 41 → 34 → 28 against a quota of 4; it thins visibly but never falls below quota.
>
> This is structural. Quota is 8% of the population (`0.40 / 5`), while even the ₹55,000 top
> floor leaves 56% of the wallet distribution eligible. Making rollover appear requires a top
> floor around **₹1,30,000** — and at that point tickets start going **unsold** (19.6 of 20 at
> ₹1.3L, 16 of 20 at ₹1.5L), because the last slot cannot fill and there is nowhere left to
> roll. **Rollover firing and "the event sells out" are mutually exclusive at five slots**, and
> Stage 2.3 asserts the sell-out. Raising the floor also pushes average price paid from
> ₹32,400 toward ₹45,000 against a ₹15,000 face value — reintroducing exactly the markup
> HLD §5a rejected pay-as-bid for.
>
> So: the rollover path is **built and correct, but not exercised by this demo**. `TC-ROLL-01`
> is a unit test against the pure inventory module, not a stage check — it was previously
> listed here as a blocking `✅`, which could never pass. If you see rollover on stage,
> something has changed in the parameters; check the floors before anything else.

### 2.3 Check — the claim

| | |
|---|---|
| **C** ✅ | **Humans won more than in Round 1.** Expect ≈ `0.4H` human winners (4 at H=10) against Round 1's 0–1. This is a comparison of two recorded numbers, not a threshold · **TC-INV-04** |
| **C** 👀 | Human share ≈ 20% ± 6pp at H=10. Treat the band as context, **not** a pass/fail gate — `0.4H` winners out of `2H` tickets has real variance, and a run landing at 2 or 6 is the mechanism working, not a bug |
| **C** ✅ | Entering at second 55 did not hurt you · **TC-INV-05** |
| **C** ✅ | A slot-1 winner is rejected in slots 2–5 with `E_ALREADY_WON` · **TC-INV-10** |
| **C** ✅ | `sum(allocation) == 2H`; `ticketsRemaining == 0`; `state == "settled"` · **TC-DASH-01** |
| **C** ✅ | **Wallet sweep, every participant:** `initialBalance - walletBalance == sum(pricePaid)`, always `0` or exactly one floor · **TC-WAL-04** |

---

## Stage 3 — Verifiability (the part nobody else can do)

🎤 *"You don't have to trust me. Here's the seed. Recompute it yourself."*

| | |
|---|---|
| **A** | `spacetime sql --server local fairdrop-demo "SELECT slotIndex, drawSeed, clearingPrice, allocated FROM slot_result"` |
| **Act** | Read a `drawSeed` aloud. Run the standalone recompute script against that slot's committed entries |
| **C** ✅ | Recomputed winner set matches the module's **exactly** · **TC-CLR-09** |
| **Act** | `npx vitest run` — TC-INV-01 shuffles insertion order ≥100 ways |
| **C** ✅ | Identical allocations every permutation · **TC-INV-01** |

🎤 *"Arrival order was recorded — `bid.seq` is right there — and the allocator never read it. That's the difference between promising fairness and proving it."*

---

## Failure playbook

Rehearse these too. Knowing the recovery is the difference between a pause and a dead demo.

| Symptom | Most likely cause | Recovery |
|---|---|---|
| Bots don't appear | `join` throwing; check `spacetime logs` | `E_HANDLE_COLLISION` should retry, not abort |
| `totalTickets == 0` | `start_countdown` before bots joined | `E_NO_PARTICIPANTS` should have blocked it — **TC-EVT-12** |
| Slots don't advance | `slot_schedule` row not inserted by `open_event` | Verify `SELECT * FROM slot_schedule`; the surviving schedule is the one thing that must work |
| Queue event won't settle | Never sold out and no admin call | Call `settle` — that is why it is admin-callable |
| Round 2 looks like Round 1 | **Reused Round 1's participants** — everyone `hasWon` | Create a new event with a new population |
| Human wins in Round 1 | Not a failure; with independent `U(0,500ms)` draws the spread occasionally leaves a gap | Say so honestly and move on — the *rate* is the claim, not one run |
| **Zero human winners in Round 2** | At H ≥ 8 this is a ~3% run of bad luck. Below H = 5 it is **expected** and the recipe is being run wrong | Check `H` first. If H ≥ 8, say the honest thing: *"That's the variance — four expected, we drew zero."* Then show the per-slot `slot_result` entry counts, which tell the same story without depending on one draw. **Do not re-run to get a better number** in front of the audience |
| Round 2 human share looks low but non-zero | Normal — `0.4H` winners has a standard deviation of roughly `0.6·√H` | Compare against Round 1's recorded number, which is the actual claim |

**Never** hand-edit rows mid-demo to fix an outcome. The whole thesis is that state is
authoritative and checkable; patching it live forfeits the argument.

---

## Rehearsal log

Run this twice clean before stage. Not a formality — the second run is where reuse-of-state
bugs surface.

| Run | Time | H | R1 human wins | R2 human wins | Expected (`0.4H`) | Failures | Notes |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| Stage | | | | | | | |

Log **counts**, not just shares — a share hides the denominator, and the denominator (`H`) is
the thing most likely to drift between rehearsal and stage.

**Ship criterion:** two consecutive runs with **zero manual repair** between them.
