# fair-drop

## Quick start

```bash
spacetime start          # in its own terminal, and leave it running
./scripts/setup.sh       # installs everything, publishes the module, prints the next steps
```

`setup.sh` is idempotent and tells you what to run next. It exists because the dependency
graph is not guessable: the bot driver has no dependencies of its own, but will not start
until `clients/sdk` is installed — it reaches through the SDK into `generated/`, which imports
`spacetimedb`. Without that, the first thing you see is `ERR_MODULE_NOT_FOUND ... imported
from clients/sdk/generated/index.ts`, naming a directory you never touched.

Nothing needs a `.env`. The pages derive the module from the host they were loaded from, so a
local `spacetime start` and a phone on the same wifi both work with no configuration; see
`clients/web/.env.example` for when you want to point a dev server somewhere else, and
`docs/DEPLOYMENT.md` for how the deployed build is configured.

Requires node 22+ and the [SpacetimeDB CLI](https://install.spacetimedb.com).


Ticket bots are playing the existing rules correctly because the sale rewards speed; change the clearing rule so arrival time carries no information.

In high-demand sales, inventory is allocated in order of server-arrival timestamp, but that timestamp is affected by automation rate, network RTT, geographic proximity, retries and connection concurrency.

In high-contention online sales, first-come-first-served uses request arrival time as the allocation signal. Arrival time rewards automation and network advantage rather than providing a neutral allocation mechanism.

## Problem:

Legitimate buyer
↓
waits for drop
↓
taps Buy
↓
request travels over ordinary network
↓
competes against automation + low-latency infrastructure
↓
inventory disappears
↓
same inventory appears in resale market

## Solution:

That's the conceptual breakthrough.

Instead of:

Bad actor
↓
Detect actor
↓
Block actor

you are saying:

Bad incentive
↓
Change mechanism
↓
Bad strategy loses payoff

## Invariants:

Four invariants should become the technical CORE

Your brief already has these, and I would make them the heart of the README/demo.

Invariant 1
weight(t\_arrival) = 0

Within a turn.

Invariant 2
entries(identity, turn) ≤ 1
Invariant 3
one authoritative clearing state
Invariant 4
state information does not create
a second latency race

These are essentially your C1–C4 constraints.

This is much better than defining the project by features.

## Showcase:

```
                FAIR DROP CORE

                ┌───────────┐
                │ Inventory │
                │    100    │
                └─────┬─────┘
                      │
         ┌────────────┴────────────┐
         │                         │
  ROUND A — FCFS             ROUND B — FAIR DROP
         │                         │
 fan + scalper agents       same participants
         │                         │
  race requests              sealed turns
         │                         │
  allocate fastest          clearing reducer
         │                         │
         └────────────┬────────────┘
                      ↓
                 SCOREBOARD
                      ↓
        Compare allocation outcome
```

## Benchmark:

For example:

FCFS
────────────────────────────
Scalper agents: 78 tickets
Human agents:   22 tickets

FAIR DROP
────────────────────────────
Scalper agents: 51 tickets
Human agents:   49 tickets

Then inject artificial network latency:

Human latency:
20 ms → 100 ms → 300 ms → 700 ms

And measure:

FCFS win probability
↓↓↓↓↓

Fair Drop win probability
─────
