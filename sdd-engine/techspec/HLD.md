# Fair Drop — High-Level Design

Status: Draft v3 — revised for random-among-qualifying clearing, turnout-scaled inventory,
and one-ticket-per-participant
Source material: `sdd-engine/context/fair-drop-brief.pdf`, `sdd-engine/context/chat.md`,
`README.md`, the demo-flow walkthrough (2026-09-05), and the stakeholder review (2026-09-05).

**What changed from v2.** v2 specified price-descending pay-as-bid clearing, a fixed
20-ticket event, a flat ₹5,00,000 wallet, and unlimited multi-slot winning. Simulation across
the real turnout range (50–250 humans, 4:1 bots) invalidated all four — see §5a for the
evidence. v3 locks in:

1. **Clearing rule is random-among-qualifying, pay-the-floor** — not price-ranked pay-as-bid.
2. **Inventory scales with turnout** — `totalTickets = 40%` of registered participants,
   computed when the event opens, not when it is created.
3. **One ticket per participant per event** — winners are excluded from all later slots.
4. **Wallet is a random draw**, ₹20,000–₹1,50,000, replacing both the flat ₹5,00,000 balance
   and the separate `ceiling` field (which is deleted — the wallet *is* the ceiling).

The four invariants (C1–C4) are unchanged. A fifth (C5) is added for the one-ticket rule.

## 1. Problem

First-come-first-served ticket sales allocate inventory on `t_arrival` — a value determined by
automation rate, network RTT, geographic proximity, retry aggression, and connection
concurrency. None of these correlate with demand. The sale is not being cheated; it is
selecting on infrastructure quality while presenting itself as selecting on eagerness. Bot
detection cannot fix this because it is not a classification problem — it is an objective-function
problem: automation is the *optimal* strategy against the stated rule.

## 2. Design constraints (invariants)

These five constraints are the spec. Every component below exists to satisfy them.

| ID | Invariant | Statement |
|----|-----------|-----------|
| C1 | `weight(t_arrival) = 0` within a turn | Submitting first vs. last inside an open slot must produce identical allocation outcomes for the same entry set. This extends to the draw itself: which qualifying entries win must be independent of arrival order — see §5. |
| C2 | `entries(identity, turn) ≤ 1` | One entry per identity per slot, enforced as a uniqueness constraint. |
| C3 | One authoritative clearing state | Clearing is a single serialized write; every subscriber observes the same resulting state — the outcome is checkable, not asserted. |
| C4 | State fan-out creates no second latency race | Published state (clearing price, remaining inventory) must reach all participants simultaneously, or whoever learns first regains the speed advantage through the information channel instead of the submission channel. |
| C5 | `allocations(identity, event) ≤ 1` | A participant may win at most one ticket per event. Once allocated, they are ineligible for every later slot. Enforced in the module, not by client behaviour. |

C4 is the constraint most designs miss, and it is why the platform choice matters (§7).

## 3. Demo user flow (source of truth for UX scope)

### 3.1 Onboarding (mode-agnostic)

```
Scan QR → enter display name → participant created
   → server mints identity (unique id) + display name
   → wallet credited randomUniform(₹20,000, ₹1,50,000) (dummy, session-scoped)
   → 4 bot participants auto-spawned alongside this human (see §6)
   → land on "all events" list
```

The wallet is a **random draw, not a flat grant**. A flat ₹5,00,000 for everyone would mean
every participant clears every floor, so nobody ever drops out and willingness-to-pay carries
no information. The random draw simulates heterogeneous real paying capacity: participants
progressively fall out as floors rise past their balance, which is what makes the later slots
thin out visibly. The minimum draw (₹20,000) sits above Slot 1's floor (₹15,000) so every
participant can contest at least the first slot.

### 3.2 Queue mode (Round 1 — FCFS baseline)

```
open event page → see ticket price (fixed, ₹15,000) → tap Buy
   → 60s pre-open countdown visible to everyone, Buy disabled until it hits zero
   → at zero: sale OPENS, all requests race
   → server resolves contention atomically per request
   → outcome: ticket allocated + wallet debited ₹15,000
        OR: rejected, wallet untouched
```

The countdown exists so every participant (and every bot) starts the race from the same
wall-clock instant — it is a fairness device for the *comparison*, not part of the fix. It has no
effect on the allocation rule itself: within the OPEN window, arrival order still fully
determines the winner (that is the point of Round 1).

C5 applies here too: one ticket per participant per event, in both modes, so the two rounds
are comparing like with like.

### 3.3 Turn mode (Round 2 — Fair Drop)

The event is divided into **5 slots**, each with its own floor price and its own ticket quota:

```
Slot 1 — floor ₹15,000
Slot 2 — floor ₹22,000
Slot 3 — floor ₹30,000
Slot 4 — floor ₹40,000
Slot 5 — floor ₹55,000
```

Floors strictly increase (enforced at event creation, not merely recommended). Quota is split
**evenly** across the five slots — `quota = totalTickets / 5` — because inventory now scales
with turnout (below), so the drama comes from the shrinking eligible field rather than from
shrinking quotas.

**Inventory scales with turnout.** `totalTickets` is *not* fixed at event creation. When the
event opens, the module computes:

```
totalTickets := round(0.40 × registered participants)
quota per slot := totalTickets / 5
```

Turnout is the one demo variable nobody controls — it may be 50 humans (250 participants) or
250 humans (1,250 participants). Fixed inventory makes the demo swing wildly across that
range: at 100 tickets, the share of humans who win anything ranges from 40% down to 8%. Worse,
sizing for the top end backfires — 500 tickets against a 50-human turnout leaves slots 4 and 5
with no bidders at all, showing an empty projector. Scaling to 40% of participants holds every
observable flat: always sells out exactly, always ~40% of the room wins, always the same
clearing prices. See §5a.

Per slot:

```
slot opens → 60s window; every participant who has not yet won and whose wallet covers
             the floor may submit at most one entry, committing to pay exactly the floor
   → at zero: entries close and are resolved simultaneously
   → winners drawn uniformly at random from the qualifying entries, using a seed derived
     from the closed slot's own entry IDs (deterministic and re-checkable — see §5)
   → every winner pays exactly slot.floor — one clearing price, not a per-winner price
   → wallet debited only for winners; everyone else's wallet is untouched
   → winners are marked ineligible for all later slots (C5)
   → unfilled quota rolls forward and adds to the next slot's quota
   → result published to everyone at the same instant → next slot opens (higher floor)
```

Submitting at second 2 of the window vs. second 59 produces the same outcome — the countdown
is an entry-collection window, not a race. This is C1 made literal at the UI level.

**Unsold quota rolls forward** (confirmed with stakeholder, 2026-09-05): if a slot's quota is
not filled by qualifying entries, the remainder adds to the next slot's quota, so total
tickets sold across all slots is conserved. Unfilled quota in the final slot rolls nowhere.

### 3.4 Wallet semantics

- Dummy wallet, `randomUniform(₹20,000, ₹1,50,000)`, granted at participant creation,
  **scoped to the current demo session** (not persisted across separate demo runs/resets).
- Debited exactly once, atomically, in the same transaction as the allocation write — never as
  a separate step. A participant either receives a ticket and loses the money, or neither
  happens. There is no reservation/hold state.
- An entry is rejected up front if the participant's balance does not cover the slot floor
  (guards against a wallet going negative even in the failure path).
- Because of C5, a participant is debited at most once per event.

## 4. Admin flows

### 4.1 Event (Sale) management

```
Create event → { name, mode: queue|turn, startTime, endTime,
                  ticketFraction (default 0.40),
                  queueMode: { ticketPrice },
                  turnMode: { floors: [15000, 22000, 30000, 40000, 55000] } }
Start countdown → registration closes; totalTickets and per-slot quotas are computed
List events     → past + current, with state (created/countdown/open/settled)
```

`totalTickets` and per-slot quotas are **derived, not supplied** — see §3.3. The admin
supplies floors and a fraction; the module computes inventory when the countdown starts and
the participant count is final.

The system supports creating and listing **multiple events**, because the stage demo may need
several independent runs back-to-back. Operationally, only one event is expected to be active
(non-`settled`) at a time — this is a live-demo convention, not a mechanism constraint.

### 4.2 Dashboard

Per event, live-updating:

```
Tickets total / remaining / allocated
Allocated to humans vs. allocated to bots     ← the headline number for the room
Per-slot (turn mode): floor, effective quota (post-rollover), entries received, filled
```

Note there is no separate "cutoff price" column any more. Under pay-the-floor every winner in
a slot pays the same amount, so the floor *is* the clearing price — the two concepts that were
distinct under pay-as-bid have collapsed into one. What varies per slot, and what the room
should watch, is **entries received vs. quota**: the oversubscription ratio.

"Human vs. bot" is a first-class split on `Participant.origin`, not inferred — see LLD §1.

## 5. Mechanism: discrete-slot random clearing among qualifying entries

```
slot opens → entries accumulate (each is an opt-in at the slot floor, invisible to others)
           → scheduled close fires at t + 60s
           → collect entries from participants who have not yet won and can cover the floor
           → derive drawSeed = hash(eventId, slotIndex, sorted(entry ids))
           → rank entries by hash(drawSeed, entry.id) ascending
           → allocate 1 ticket each, walking the ranking, until this slot's quota is spent
           → every winner pays exactly slot.floor
           → write allocations + slot_result (single serialized write, wallet debit included)
           → mark winners ineligible for later slots (C5)
           → simultaneous fan-out to all subscribers
           → next slot opens at a higher floor, or settle()
```

Two event **modes** share one entrypoint (`submit_bid`) so the only variable between rounds is
the clearing rule itself — queue mode allocates immediately on arrival; turn mode collects
entries for a window and then draws. Both modes validate the submitted price against a
server-known value (`ticketPrice` in queue, `slot.floor` in turn), so the two paths are
structurally identical up to that one branch. This substitution is the entire demonstration.

**The draw is random but not arbitrary.** The seed is derived from data that exists only once
the slot has closed — the sorted set of that slot's entry IDs — so it cannot be predicted or
positioned for in advance, and re-running the draw over the same committed entry set
reproduces the same winners exactly. That is the property that matters on stage: the outcome
looks random to every participant beforehand and is fully verifiable by anyone afterwards.

The seed deliberately does **not** use arrival sequence, insertion order, or participant
identity. The last one matters: seeding from "whoever has the lower participant ID" looks
neutral but usually isn't, since IDs are typically handed out in join order — that would make
the draw resolve by *join*-order-arrival instead of *bid*-order-arrival, which is the same C1
violation through a different door. See LLD §2 (`close_slot`) for the exact construction.

### 5a. Why random-among-qualifying, not price-ranked pay-as-bid

v2 specified price-descending pay-as-bid. Simulating it against the real turnout range
(`integration/experiment/sim.py`, seeded, 200 trials per configuration) showed two
disqualifying results. All figures below are under the locked v3 configuration — floors
15/22/30/40/55k, wallets U[₹20k, ₹1.5L], inventory at 40% of participants — and are
reproducible with `python3 integration/experiment/sim.py`.

**The price ladder never binds.** Under pay-as-bid the slots clear at 101k / 95k / 90k / 85k /
81k against floors of 15k / 22k / 30k / 40k / 55k — **0 of 5 floors bind**, at every turnout
from 250 to 1,250 participants. With hundreds of bidders per slot the top bids sit near the
wallet ceiling and the floor is decoration. Worse, the clearing price *falls* across the
ladder while the floor rises, because the deepest wallets win early and leave: the
price-discovery arc v2 was architected around not only fails to appear, it runs backwards.

**Price-ranking allocates to the deepest wallets, visibly.** 89% of winners come from the
richest cohort, and the average price paid is ₹1,06,000 against a ₹15,000 face value. The
effect is turnout-independent (88.8% at 50 humans, 89.1% at 250). On stage that reads as: we
replaced "the fastest win" with "the richest win, at a 7x markup."

Both rules on identical populations:

| Rule | Human share | Winners from richest cohort | Avg price paid | Floors binding | Slot clearing prices |
|---|---|---|---|---|---|
| Price-ranked pay-as-bid | 19.8% | 89.1% | ₹1,06,000 | 0 / 5 | 101k, 95k, 90k, 85k, 81k |
| **Random among qualifying** | **19.9%** | **45.1%** | **₹32,400** | **5 / 5** | 15k, 22k, 30k, 40k, 55k |

Identical human share — the headline number is unaffected by the choice — with the wealth
correlation roughly halved, every floor doing real work by construction, and face-value
pricing restored. That is what the original brief proposed before v2 traded it away for price
discovery that turns out not to be observable at this scale.

Note the 45.1% residual wealth correlation under the random rule: it is not zero, and should
not be described as zero. The floor ladder itself screens by wallet — you cannot enter slot 5
without ₹55,000 — so richer participants remain eligible for more slots and win somewhat more
often. What the random rule removes is the *within-slot* advantage of having more money than
the person next to you, not the eligibility effect of the posted prices.

**What the mechanism now claims:** anyone willing to pay the posted price for a slot has an
equal, verifiable chance at it, and no amount of speed or money improves those odds within
that slot. That is a narrower claim than "efficient price discovery," and it is the one the
system can actually support.

## 6. Bots

- **Ratio.** Every human participant creation spawns exactly 4 bot participants alongside it.
  Fixed per the current requirement. At the top of the expected turnout range (250 humans)
  this is 1,000 bots and 1,250 total participants — see §8 for what that means structurally.
- **Trigger point.** The onboarding flow itself (participant creation) is responsible for
  triggering the spawn, as a side effect — not something a human does separately, and not
  something baked into the SpacetimeDB module. See LLD §5 for why this has to live outside the
  module (reducers are transactional; they cannot run a timer or an async decision loop).
- **Identity.** Bots are participants like any other — `displayName = "Bot-<random>"`,
  `origin = "bot"` — with a wallet drawn from the same `randomUniform(₹20,000, ₹1,50,000)`
  distribution as humans, and subject to the same guards.
- **Behaviour — queue mode.** Hit the buy endpoint at `t_open + random(0, δ)` for a small δ,
  then wait for the result. Fast, but still "arrival-order" behaviour — this is what Round 1 is
  supposed to reward.
- **Behaviour — turn mode.** Each slot: if the bot has already won, it is ineligible (C5) and
  does nothing. Otherwise, if `walletBalance ≥ slot.floor` it enters; if not, it abstains for
  the rest of the event — a real budget dropout, not a scripted weakening. There is no bid
  amount to choose, because under pay-the-floor there is nothing to choose. Same effort level
  as queue mode throughout — the point of the demo is that turn mode neutralizes the speed
  strategy without the bot behaving any differently.
- **Visibility.** Bots appear on the admin dashboard's human/bot split and are indistinguishable
  from humans in the allocation/slot_result data model — only `Participant.origin` marks them.

Note that turn-mode bot behaviour is now nearly trivial. That is the finding, not an oversight:
once the clearing rule is a draw at a posted price, there is no strategy left to encode, which
is precisely the property the mechanism is claiming.

## 7. Why SpacetimeDB

C3 and C4 are the load-bearing requirements — not raw write throughput. Conventionally,
satisfying "one clearing write, simultaneous fan-out" requires hand-building three things:
a database, a scheduler, and a push/fan-out tier, plus hand-written ordering guarantees across
them. SpacetimeDB provides this as an engine property instead of application code: reducers
execute serially (giving C3 for free) and subscribers receive resulting rows without an
application-level broadcast loop (giving C4 for free). Wallet debit riding inside the same
reducer transaction as the allocation write is what keeps "ticket or refund, never a partial
state" true without a separate payments service.

This is an engineering-efficiency claim, not an impossibility claim — the mechanism could be
built on Postgres + a scheduler + a socket tier. We are choosing the platform that makes the
invariants structural rather than something we have to prove by testing.

## 8. Processes / architecture

```
┌───────────────────────────────┐
│  Module (TypeScript, on       │   Sole authority. Tables + reducers.
│  SpacetimeDB)                  │   Owns wallet debit + allocation atomically.
└───────────────┬─────────────────┘
                │ subscriptions / reducer calls
   ┌────────────┼──────────────────────┬───────────────────────┐
   │            │                      │                       │
┌──▼──────────┐ │              ┌───────▼────────┐    ┌─────────▼─────────┐
│ Onboarding /│ │              │ React client    │    │ (no separate agent │
│ bot-runner  │ │              │ Phone / Event   │    │  process for       │
│ service     │ │              │ list / Admin    │    │  humans — they ARE │
│ (Node)      │ │              │ dashboard       │    │  the React client)  │
└──┬──────────┘ │              └─────────────────┘    └─────────────────────┘
   │ schedules  │
┌──▼───────────────────────┐
│ Bot worker pool (Node):  │◄┘ each bot talks to the module the same way a human client does
│ N async tasks over a     │
│ bounded connection pool  │
│ — NOT one OS process/bot │
└──────────────────────────┘
```

- **Module** — owns `event`, `slot`, `participant`, `bid`, `allocation`, `slot_result` tables
  and the `create_event` / `start_countdown` / `open_event` / `join` / `submit_bid` /
  `close_slot` / `settle` reducers. Nothing outside the module decides allocation or moves
  wallet balance.
- **Onboarding / bot-runner service** — a small Node service the QR-scan web page calls on
  participant creation. It creates the human participant (via the module) and registers 4 bot
  participants, each running its own entry loop.

  **Bots are async tasks in a shared worker pool, never child processes.** At 250 humans this
  is 1,000 concurrent bots; one OS process each is not survivable on a demo rig. The pool owns
  a bounded set of SpacetimeDB connections and multiplexes bot logic over them. This is a hard
  architectural constraint, not a tuning preference — see LLD §5.
- **React client** — event list, phone view (a participant's own state + result), admin
  dashboard/projector. All three read the same subscriptions.

All of these talk to the module only through a single shared client layer (`FairDropClient`,
see LLD §6) — nothing calls low-level subscription/reducer APIs directly.

## 9. Core loop

```
admin creates event → participants join (humans trigger 4 bots each)
        → admin starts countdown: registration closes, totalTickets = 40% of participants
        → event opens
                                                     │
                              ┌──────────────────────┴──────────────────────┐
                              ▼                                             ▼
                        QUEUE MODE (FCFS)                             TURN MODE (Fair Drop)
                  countdown → race → immediate alloc                countdown → sealed entries →
                                                                     close_slot → seeded random
                                                                     draw → pay-the-floor alloc
                              └──────────────────────┬──────────────────────┘
                                                     ▼
                                          publish result + debit wallet
                                                     ▼
                                    participants/bots observe state
                                                     ▼
                             slots/inventory left? → next slot : settle → dashboard/scoreboard
```

The master acceptance property is unchanged: flipping one field (`mode: "queue"` →
`mode: "turn"`) while holding participants, strategies, inventory, UI, and network conditions
constant should be sufficient to change *who wins*. See LLD §11 for the test that proves this.

## 10. Scope boundaries

**In scope (this revision):** wallet (session-scoped, random draw, atomic debit-on-win),
multi-event catalog with admin CRUD, per-slot floor configuration and turnout-derived quotas,
random-among-qualifying pay-the-floor resolution, one ticket per participant per event,
automatic 4:1 bot spawning over a pooled worker, admin dashboard with human/bot split, both
clearing modes behind one reducer, invariant tests for C1–C5.

**Still out of scope:** real payments, multi-ticket purchases (`qty > 1` — deferred, see
LLD §1b), price tiers *within* a slot (seat maps), authentication beyond a QR-issued display
name + generated identity, cross-session wallet persistence. This system does not solve
scarcity (more demand than tickets always exists) and does not solve resale by itself — that
requires non-transferable tickets, a separate composable change.

**Ranking comparator for turn mode is fixed for this build:** random among qualifying entries,
pay-the-floor, per §5a. The price-descending pay-as-bid comparator from v2 is retained in the
experiment runner as a comparison arm — it is what produces the table in §5a — but is not a
production code path.

## 11. Known risks

| Risk | Mitigation |
|------|------------|
| A blind draw resolving in seconds is unreadable | 60s per slot, 5 slots. The live readout is entries-vs-quota (the oversubscription ratio) and the eligible field shrinking as floors rise — both tick visibly. |
| "It's just a lottery" reads as a weaker mechanism than an auction | Lead with the verifiability property (§5): the draw is reproducible from committed state, so the outcome is checkable rather than trusted. That is strictly more than FCFS offers. |
| Turnout is unknown until showtime (50–250 humans) | Inventory is derived from actual registered participants at countdown (§3.3), holding every observable flat across the range. This is the mitigation — do not hardcode `totalTickets`. |
| **1,250 concurrent subscribers on one rig is untested** | Highest-likelihood failure on stage. TC-NFR-01 is sized at 1,250 and must run at Gate 3, not as a polish item. Bot pool is bounded and shares connections (§8). |
| Two clearing modes must both work — the contrast *is* the demo | Build queue mode + dashboard first (demoable alone); turn mode is scheduled close + seeded draw, addable second. |
| Demo depends on network/venue | Nothing in the critical path makes an outbound call; runs on a local standalone server over venue LAN or hotspot. |
| Bot-runner service is a new moving part not covered by SpacetimeDB's transactional guarantees | Bot registration failure must not block human onboarding — it is fire-and-forget from the onboarding flow's perspective, with its own retry/logging, never on the human's critical path. |

## 12. Ownership split (2 engineers)

Split by system boundary, not by feature, meeting through one frozen module contract.

| | Engineer A — Allocation Engine | Engineer B — Simulation + Experience |
|---|---|---|
| Owns | Schema, reducers, allocation algorithms, event/slot lifecycle, turnout-derived inventory, wallet debit, invariants C1–C5 | Client SDK, onboarding/bot-runner service + worker pool, bot behaviour, admin dashboard, phone + event-list UI |
| Responsibility | Make the mechanism (and the money) mathematically and transactionally correct | Build the adversarial environment at scale and the surfaces that prove the mechanism works |

Full breakdown, merge gates, and build schedule are in `LLD.md` §12–§14.
