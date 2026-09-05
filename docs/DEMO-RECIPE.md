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
| **A** | `spacetime --version` → must read **2.9.0**. If it reads 2.10.0, run `spacetime version use 2.9.0` — 2.9.0 is the version §10's verification table was recorded against; 2.10.0 against the 2.8.3 lib is untested |
| **A** | `spacetime start` in its own terminal — leave it running, it is the demo |
| **Act** | `spacetime publish -p fair-drop-db/spacetimedb fairdrop --server local -y` |
| **Act** | `spacetime call --server local fairdrop add '"smoke"'` |
| **Act** | `spacetime sql --server local fairdrop "SELECT * FROM person"` |
| **C** ✅ | The row comes back. **If this fails, stop — nothing downstream matters.** |

> **`--server local` is required on every command.** `fair-drop-db/spacetime.json` says
> `"server": "maincloud"`, so `call`/`sql`/`logs` go looking there and fail with
> *"failed to find database"* even though the publish succeeded. Also run `call`/`sql` from
> **outside** `fair-drop-db/`, or `spacetime.local.json` overrides the database name to
> `fair-drop-db-q9eli`. Both cost 10 minutes to diagnose the first time. Republish over an
> existing schema with `--delete-data=always` (not `-c always`).

**Rig checklist before every rehearsal and before the real run:**

- [ ] `spacetime start` running, database published, `spacetime logs --server local fairdrop` open in a third terminal
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
| **C** ✅ | Unfilled quota appears in the next slot's `effectiveQuota`; `baseQuota` **unchanged** · **TC-ROLL-01** |
| **C** 👀 | Eligible field visibly shrinks as floors rise past wallets — the visual drama |

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
| **A** | `spacetime sql fairdrop "SELECT slotIndex, drawSeed, clearingPrice, allocated FROM slot_result"` |
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
