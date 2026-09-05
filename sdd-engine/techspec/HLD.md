# Fair Drop — High-Level Design

Status: Draft v2 — revised for the concrete demo flow (wallet, multi-event, bots, countdowns)
Source material: `sdd-engine/context/fair-drop-brief.pdf`, `sdd-engine/context/chat.md`,
`README.md`, and the demo-flow walkthrough (2026-09-05).

**What changed from v1:** the original brief scoped wallets, price tiers, and multi-lot support
*out* as demo-simplification cuts. The actual demo requirement reintroduces all three
(dummy wallet, multi-slot pricing, a real event catalog) because they make the stage
demonstration legible to a live audience. This version keeps the four invariants (C1–C4) and the
core mechanism unchanged, and specifies the product surface around them.

## 1. Problem

First-come-first-served ticket sales allocate inventory on `t_arrival` — a value determined by
automation rate, network RTT, geographic proximity, retry aggression, and connection
concurrency. None of these correlate with demand. The sale is not being cheated; it is
selecting on infrastructure quality while presenting itself as selecting on eagerness. Bot
detection cannot fix this because it is not a classification problem — it is an objective-function
problem: automation is the *optimal* strategy against the stated rule.

## 2. Design constraints (invariants)

These four constraints are the spec. Every component below exists to satisfy them.

| ID | Invariant | Statement |
|----|-----------|-----------|
| C1 | `weight(t_arrival) = 0` within a turn | Submitting first vs. last inside an open slot must produce identical allocation outcomes for the same bid set. This extends to ties: when two bids match exactly, the winner between them must also be independent of arrival order — see the tie-break rule in §5. |
| C2 | `entries(identity, turn) ≤ 1` | One bid per identity per slot, enforced as a uniqueness constraint. |
| C3 | One authoritative clearing state | Clearing is a single serialized write; every subscriber observes the same resulting state — the outcome is checkable, not asserted. |
| C4 | State fan-out creates no second latency race | Published state (clearing price, remaining inventory) must reach all participants simultaneously, or whoever learns first regains the speed advantage through the information channel instead of the submission channel. |

C4 is the constraint most designs miss, and it is why the platform choice matters (§5).

## 3. Demo user flow (source of truth for UX scope)

### 3.1 Onboarding (mode-agnostic)

```
Scan QR → enter display name → participant created
   → server mints identity (unique id) + display name
   → wallet credited ₹5,00,000 (dummy, session-scoped)
   → 4 bot participants auto-spawned alongside this human (see §6)
   → land on "all events" list
```

### 3.2 Queue mode (Round 1 — FCFS baseline)

```
open event page → see ticket price (fixed, e.g. ₹15,000) → tap Buy
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

### 3.3 Turn mode (Round 2 — Fair Drop)

The event is divided into a fixed sequence of **slots**, each with its own floor price and its
own ticket quota, configured at event creation:

```
Slot 1 — floor ₹15,000,  quota 6 tickets
Slot 2 — floor ₹30,000,  quota 5 tickets
Slot 3 — floor ₹50,000,  quota 4 tickets
Slot 4 — floor ₹75,000,  quota 3 tickets
Slot 5 — floor ₹1,00,000, quota 2 tickets
```

Floors widen and quotas shrink across slots on purpose — see LLD §1a for the sizing rationale
(the goal is a visible price-discovery arc, not just five identical rounds at different prices).

Per slot:

```
slot opens → 60s countdown, everyone may submit at most one sealed bid ≥ floor
   → at zero: bids resolved simultaneously — rank strictly by bid amount, descending
   → highest bid gets ticket #1, next-highest #2, ... until this slot's quota is exhausted
   → each winner pays *their own bid* (pay-as-bid, not a single clearing price)
   → wallet debited only for winners; everyone else's wallet is untouched
   → result published to everyone at the same instant → next slot opens (higher floor)
```

Submitting at second 2 of the window vs. second 59 produces the same outcome — the countdown
is a bid-collection window, not a race. This is C1 made literal at the UI level. A participant
who already won a ticket in an earlier slot may still bid in later slots (no artificial
one-ticket-per-event cap is imposed by the mechanism); if a slot's quota is not filled by
qualifying bids, the unfilled remainder rolls forward and adds to the next slot's quota, so
total tickets sold across all slots is conserved. *(Flagged assumption — confirm before build;
the alternative is "unsold quota is simply lost," which changes the total-tickets-sold math.)*

### 3.4 Wallet semantics

- Dummy wallet, ₹5,00,000, granted at participant creation, **scoped to the current demo
  session** (not persisted across separate demo runs/resets).
- Debited exactly once, atomically, in the same transaction as the allocation write — never as
  a separate step. A participant either receives a ticket and loses the money, or neither
  happens. There is no reservation/hold state.
- A bid or buy request is rejected up front if it would exceed the participant's remaining
  balance (guards against a wallet going negative even in the failure path).

## 4. Admin flows

### 4.1 Event (Sale) management

```
Create event → { name, mode: queue|turn, totalTickets, startTime, endTime,
                  queueMode: { ticketPrice },
                  turnMode: { slots: [{ floor, quota }, ...] } }
List events   → past + current, with state (created/countdown/open/settled)
```

The system supports creating and listing **multiple events**, because the stage demo may need
several independent runs back-to-back (reset and go again). Operationally, only one event is
expected to be active (non-`settled`) at a time — this is a live-demo convention, not a
mechanism constraint; nothing in the schema prevents two events being open concurrently.

### 4.2 Dashboard

Per event, live-updating:

```
Tickets total / remaining / allocated
Allocated to humans vs. allocated to bots     ← the headline number for the room
Per-slot (turn mode): floor, quota, filled, clearing/cutoff price
```

"Human vs. bot" is a first-class split on `Participant.origin`, not inferred — see LLD §1.

## 5. Mechanism: discrete-slot sealed clearing (unchanged core)

```
slot opens → bids accumulate (sealed, invisible to other participants)
           → scheduled close fires at t + 60s
           → rank bids strictly by price, descending (pay-as-bid)
           → allocate 1 ticket per bid, walking down the ranking, until this slot's quota is spent
           → write allocations + turn_result (single serialized write, wallet debit included)
           → simultaneous fan-out to all subscribers
           → participants/bots observe result, adapt for the next (higher-floor) slot
           → next slot opens, or settle() once all slots are done or inventory hits 0
```

Two event **modes** share one entrypoint (`submit_bid` / `buy_ticket`) so the only variable
between rounds is the clearing rule itself — queue mode allocates immediately on arrival; turn
mode seals bids for a window and clears by price, not arrival. This substitution — same
entrypoint, one branch different — is the entire demonstration.

**Tie-break rule.** Two bids at the exact same price are resolved by a value derived from the
closed slot's own data (a hash of that slot's bid IDs, computed only once the slot closes) —
never by arrival order, and never by anything correlated with when a participant *joined* the
event either. The latter matters: assigning ties to "whoever has the lower participant ID" looks
neutral but usually isn't, since IDs are typically handed out in join order — that would make
ties resolve by *join*-order-arrival instead of *bid*-order-arrival, which is the same C1
violation through a different door. See LLD §2 (`close_slot`) for the exact construction.

## 6. Bots

- **Ratio.** Every human participant creation spawns exactly 4 bot participants alongside it.
  This is fixed, not configurable per the current requirement.
- **Trigger point.** The onboarding flow itself (participant creation) is responsible for
  triggering the spawn, as a side effect — not something a human does separately, and not
  something baked into the SpacetimeDB module as a special reducer. See LLD §5 for why this
  has to live outside the module (reducers are transactional; they cannot run a timer or an
  async decision loop).
- **Identity.** Bots are participants like any other — `displayName = "Bot-<random>"`,
  `origin = "bot"` — with their own wallet, subject to the same guards as a human, including a
  randomly assigned `ceiling` (simulated paying capacity, ₹20,000–₹1,50,000 at join — see LLD
  §1a/§2) that caps every bid they ever place, in either mode.
- **Behaviour — queue mode.** Hit the buy endpoint at `t_open + random(0, δ)` for a small δ,
  then wait for the result. Fast, but still "arrival-order" behaviour — this is what Round 1 is
  supposed to reward.
- **Behaviour — turn mode.** Each slot, bid a fresh random amount between the current slot's
  floor and the bot's own ceiling — re-rolled every slot, not a fixed position relative to the
  ceiling (LLD §5). If the ceiling falls below the current floor, the bot simply stops
  bidding for the rest of the event — a real budget dropout, not a scripted weakening. Same
  effort level as queue mode throughout — the point of the demo is that turn mode neutralizes
  the speed strategy without the bot having to behave any differently.
- **Visibility.** Bots appear on the admin dashboard's human/bot split and are indistinguishable
  from humans in the allocation/turn_result data model — only `Participant.origin` marks them.

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
│ bot-spawner │ │              │ Phone / Event   │    │  process for       │
│ service     │ │              │ list / Admin    │    │  humans — they ARE │
│ (Node)      │ │              │ dashboard       │    │  the React client)  │
└──┬──────────┘ │              └─────────────────┘    └─────────────────────┘
   │ spawns     │
┌──▼──────────┐ │
│ Bot processes│◄┘ each bot talks to the module the same way a human client does
│ (Node, 4 per │
│  human)      │
└──────────────┘
```

- **Module** — owns `event` (formerly `sale`), `participant`, `bid`, `allocation`,
  `turn_result` tables and the `create_event` / `open_event` / `join` / `submit_bid` /
  `close_slot` / `settle` reducers. Nothing outside the module decides allocation or moves
  wallet balance.
- **Onboarding / bot-spawner service** — a small Node/Express service the QR-scan web page
  calls on participant creation. It creates the human participant (via the module) and then
  spawns 4 bot processes, each of which independently joins and runs its own bid loop against
  the module through the shared client SDK. This is the *only* place bot logic lives; the
  module has no bot-specific code path.
- **React client** — event list, phone view (a participant's own state + result), admin
  dashboard/projector. All three read the same subscriptions.

All of these talk to the module only through a single shared client layer (`FairDropClient`,
see LLD §7) — nothing calls low-level subscription/reducer APIs directly.

## 9. Core loop

```
admin creates event → participants join (humans trigger 4 bots each) → event opens
                                                     │
                              ┌──────────────────────┴──────────────────────┐
                              ▼                                             ▼
                        QUEUE MODE (FCFS)                             TURN MODE (Fair Drop)
                  countdown → race → immediate alloc                countdown → sealed bids →
                                                                     close_slot → rank by price,
                                                                     descending → pay-as-bid alloc
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

**In scope (this revision):** wallet (session-scoped, atomic debit-on-win), multi-event
catalog with admin CRUD, per-slot floor + quota configuration in turn mode, pay-as-bid
resolution, automatic 4:1 bot spawning, admin dashboard with human/bot split, both clearing
modes behind one reducer, invariant tests for C1–C4.

**Still out of scope:** real payments, price tiers *within* a slot (seat maps), authentication
beyond a QR-issued display name + generated identity, cross-session wallet persistence. This
system does not solve scarcity (more demand than tickets always exists) and does not solve
resale by itself — that requires non-transferable tickets, a separate composable change.

**Ranking comparator for turn mode is fixed for this build:** strictly price-descending,
pay-as-bid, per the clarified demo requirement. The brief's alternative
(random-ranked-among-qualifying, to preserve face price) is documented in the original HLD v1
history but is **not** the default anymore — note this if the "which is fairer" panel
discussion point still needs to be made live, since price-ranked alone forecloses that half of
the argument.

## 11. Known risks

| Risk | Mitigation |
|------|------------|
| A blind-bid round resolving in seconds is unreadable | 60s per slot, 5 slots — same total duration as before but it visibly ticks: price rank, wallet balances, quota fill all update live. |
| "Pay-as-bid" reads as dynamic pricing (unpopular) | Pitch leads with *who wins*, never with revenue; dashboard emphasizes the human/bot split, not price paid. |
| Two clearing modes must both work — the contrast *is* the demo | Build queue mode + dashboard first (demoable alone); turn mode is scheduled close + sort, addable second. |
| Demo depends on network/venue | Nothing in the critical path makes an outbound call; runs on a local standalone server over venue LAN or hotspot. |
| Bot-spawner service is a new moving part not covered by SpacetimeDB's transactional guarantees | Bot spawn failure must not block human onboarding — spawn is fire-and-forget from the onboarding flow's perspective, with its own retry/logging, never on the human's critical path. |
| Unsold-quota rollover assumption (§3.3) is unconfirmed | Confirm with stakeholder before building `close_slot`; it changes the quota math for every slot after the first. |

## 12. Ownership split (2 engineers)

Split by system boundary, not by feature, meeting through one frozen module contract.

| | Engineer A — Allocation Engine | Engineer B — Simulation + Experience |
|---|---|---|
| Owns | Schema, reducers, allocation algorithms, event/slot lifecycle, wallet debit, invariants C1–C4 | Client SDK, onboarding/bot-spawner service, bot behaviour, admin dashboard, phone + event-list UI |
| Responsibility | Make the mechanism (and the money) mathematically and transactionally correct | Build the adversarial environment and the surfaces that prove the mechanism works |

Full breakdown, merge gates, and build schedule are in `LLD.md` §12–§14.
