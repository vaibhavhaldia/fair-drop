# Vaibhav — Bot driver + display

> **SCOPE CUT 2026-09-05 · target 3.5–4h, build-and-test at each stage.** The original 8-gate
> plan assumed 30–35h per engineer (LLD §14) and is abandoned. This file is the replacement.
> The frozen contract is `docs/CONTRACT.md` — it is the authority.
>
> Timings include verification. **Test as you go — do not batch it to the end.**

> **For the `sdd-engine` agent**: trigger with `"Vaibhav Gate <N> go"`.

Owned paths: the bot driver and the display. You never touch allocation logic, wallet math, or
`fair-drop-db/spacetimedb/**`.

**You are not blocked.** The contract is frozen, so Gate 1 is fully specified before Saksham's
schema exists. Build against the contract, wire at ~1:50.

---

## What changed, and why your gates collapsed

The bot-runner **service** is cut — no Express, no `POST /onboard`, no QR flow, no fire-and-
forget registration path, no pool-size config plumbing. What survives is the part the demo
actually needs: **N bots that join and bid.** A script, not a service.

The reason the original design needed a service was the QR onboarding flow. A text input on the
display does the same job for a projector demo, and costs 15 minutes instead of 3 hours.

**The bounded connection pool is deferred** in the 4h re-plan. At 40 bots, one connection each
is fine — the constraint existed for 1,000. Bots remain **async tasks in one process** (never
child processes); that half of LLD §5a still stands and is the half that would actually kill a
demo rig.

**Do not undo the schema on this basis.** `participant.id` stays the primary key and `identity`
stays non-unique, so the pool can return later with no migration and no rework on Saksham's
side. Deferring an implementation is not the same as reversing the design.

---

## Gate 1 — Bot driver + display, against the contract · target 0:00–1:50

Nothing here needs the module to exist. Build against `docs/CONTRACT.md` §3 and fixture data.

### Bot driver

```
4 bots per human who joins — 4H async tasks in ONE process (one connection each; pool deferred)
Target H = 10 → 40 bots. The 4:1 ratio is HLD §6 and the Round 2 claim rests on it:
below H = 8, "human share ≈ population share" is a coin flip, not a measurement.
See DEMO-RECIPE Stage 1.1 for the shutout-probability table.
each bot:
  join(eventId, `Bot-${randomId}`, "bot")   → ParticipantId
  queue mode: submitBid(eventId, participantId, 0, ticketPrice)
              at t_open + uniform(0, DELTA_MS)     // per-bot independent draw.
                                                   // DELTA_MS = 500 is the BOUND, not the delay
  turn mode (LLD §5b):
    if hasWon                        → do nothing (C5)
    else if walletBalance < floor    → abstain permanently (floors only rise)
    else                             → submitBid(eventId, participantId, slotIndex, floor)
```

**δ = 500ms is the *upper bound*, not the delay.** Each bot draws its own value independently,
uniformly on `[0, 500ms]`, on every run — some near-instant, some near the full 500ms, mean
250ms. Do **not** sleep a fixed 500ms in every bot: that turns the field into a synchronised
block arriving at the same instant, which is both unrealistic and would make the arrival-order
result meaningless. It is a named constant (`DELTA_MS`), not a literal — the delay sweep
(TC-EXP-07) and the on-stage "what if bots were faster?" question both need to change it in one
place. Bots therefore average a 250ms reaction: best-case *human* speed. They will still take
essentially all of Round 1's inventory, and that is the point — FCFS rewards being reliably
slightly faster at scale, not being superhuman. Do not lower δ to make Round 1 look worse; it
would make the finding easier to dismiss.

Turn-mode bot logic is **deliberately trivial** — under a draw at a posted price there is no
amount to choose, for anyone. Do not add strategy; its absence is the finding, not a gap.

**Handle collisions are retryable, not fatal:** on `E_HANDLE_COLLISION`, regenerate the suffix
and retry. This is the only error a bot should handle specially — swallow the rest and move on.
`E_INSUFFICIENT_BALANCE` is normal traffic, not a failure.

**Ids are `bigint`** and do not survive `JSON.stringify`. Convert at the boundary.

### Display

One page. The human/bot allocation split is the only element that needs to look good — it is
what the audience reads. Everything else is a table.

```
totalTickets · ticketsRemaining · participantsAtOpen
allocatedTo: { human, bot }        ← Allocation JOIN Participant.origin, derived on read
slots (turn): [{ index, floor, effectiveQuota, entriesReceived, filled }]
```

**Never compute a balance client-side** — render the subscribed row. A phone view doing
`balance - price` will eventually disagree with the module.

### DoD
- [ ] Bot driver runs 4 bots per human (40 at H = 10) as async tasks in **one process** —
      process count independent of bot count. Connection pooling is deferred, not the process
      constraint.
- [ ] Bot count is **derived from the human count**, not hardcoded to 40. The display needs to
      top up to H ≥ 8 when fewer people join from the floor.
- [ ] Display renders from fixture data shaped like `CONTRACT.md` §3.

---

## Gate 2 — Wire to the real module · target 1:50–2:50

Point the driver and display at Saksham's published module. Expect signature friction; the
contract is the tiebreaker.

### DoD
- [ ] 40 bots join a real event and bid.
- [ ] Display updates live from subscriptions, no refresh.

---

## Gate 3 — Run both rounds + rehearse · target 2:50–4:00

Run **`docs/DEMO-RECIPE.md`** end to end, twice. Note Stage 2.1: Round 2 needs a **new event
with a new population** — reusing Round 1's participants means everyone carries `hasWon` and
the round looks broken at the worst possible moment.

Ship criterion: **two consecutive runs, zero manual repair between them.**

### DoD
- [ ] Round 1: fast bots take the overwhelming majority — Round 1 is *supposed* to look unfair.
- [ ] Round 2: humans win materially more than in Round 1 (expect ≈ `0.4H` winners against
      Round 1's 0–1); the eligible field visibly thins as floors rise. Record **counts**, not
      just shares — the share hides `H`, which is the number most likely to drift.
- [ ] Two clean run-throughs with no manual repair between them.

---

## What was cut

| Cut | Reasoning |
|---|---|
| `services/bot-runner/` as an HTTP service | The demo needs bots that bid, not an onboarding API |
| QR onboarding flow (TC-UI-01/02, TC-POOL-01/05/06) | A text input works on a projector |
| All Playwright / E2E (~25 cases) | No time, and the demo itself is the test |
| Phone view | The display carries the story; per-participant view is a nice-to-have |
| Dashboard polish (TC-DASH-*) | One table. Only the human/bot split gets styling |
| 1,250-participant load test | Run 40 — observables are turnout-invariant by design (§1a) |
| The bounded connection pool | 40 bots, one connection each. Schema unchanged, so it returns later with no migration |
| Waiting on scheduled `open_event` / `settle` | Admin triggers both. Bots poll for `state == "open"` — same simultaneous start, two fewer ways to hang |

**Kept:** bots as async tasks in a single process. That is the constraint LLD §5a calls
"not survivable on a demo rig" if broken, and unlike the connection pool it costs nothing to
honour at 40 bots.
