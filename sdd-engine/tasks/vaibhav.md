# Vaibhav — Web UI + Bot-Runner/Worker Pool

> **For the `sdd-engine` agent** (`sdd-engine/agents/sdd-engine.md`): this file is the gate spec
> for owner `vaibhav`. Trigger a gate with `"Vaibhav Gate <N> go"`. Every RED test ID below is
> defined in `sdd-engine/acceptance/test-cases.md` — look it up there for exact expected
> behavior before writing the test. Every GREEN target traces to `sdd-engine/techspec/LLD.md` —
> follow its exact shapes. Do not start a gate whose prerequisite gate's DoD isn't met.

Traces: `techspec/HLD.md` §12 (Engineer B, UI-scoped), `techspec/LLD.md` §5, §5a, §5b, §8–§9,
§13–§14. Owned paths: `clients/web/**`, `services/bot-runner/**`. You never touch allocation
logic, wallet math, or the module's reducers/tables directly (`fair-drop-db/spacetimedb/**`) —
every read comes from a subscription Saksham's module publishes, every write goes through
`FairDropClient`. If a screen needs a fact the module doesn't expose, that's an escalation
(cross-owner contract change), never a client-side workaround or a direct edit to his files.

**Your "extra" assignment**, split evenly with Saksham: the **bot-runner service + bounded
worker pool + bot behaviour** (`services/bot-runner/`, LLD §5/§5a/§5b). Bots call the same
reducer surface your UI drives, so this sits naturally next to your client work.

---

## Gate 0 — Contract (with Saksham, human-run, not agent-run)

Not a gate the agent executes. Same session as his Gate 0. Do not trigger
`"Vaibhav Gate 1 go"` until the contract is frozen.

---

## Gate 1 — Hello-world integration

**Branch:** `vaibhav/gate-1-sdk-shell` off `staging`.
**Prereq:** Gate 0 contract frozen; Saksham's Gate 1 has published a schema + generated bindings
(check `fair-drop-db/spacetimedb/src/` for the real schema and that
`spacetime generate --lang typescript` output exists before starting).

### RED
| TC ID | Test file | Notes |
|---|---|---|
| TC-SDK-02 | `clients/sdk/tests/imports.test.ts` | No file outside `clients/sdk` imports generated bindings directly — lint/import-graph check |
| TC-SDK-04 | `clients/sdk/tests/client.test.ts` | `subscribeEvent` fires on insert/update/delete; `Unsubscribe` stops callbacks |

### GREEN
- Consumer-facing shell around Saksham's `FairDropClient`: confirm `join()` + subscriptions to
  `Event`/`Participant` work, per LLD §6. No React UI yet — this is plumbing only.

### Definition of Done
- [ ] Both RED tests green.
- [ ] **Milestone check:** you can call `join()` and see a `Participant` row come back via
      subscription, verifiable from a script or the test suite — no UI required yet.

### Escalate if
- Generated bindings from Saksham's Gate 1 don't match the frozen Gate-0 contract (a field
  renamed, a reducer signature changed without notice) — that's a contract break, flag it rather
  than adapting silently.

---

## Gate 2 — ROUND 1: Queue mode UI (FCFS baseline)

**Branch:** `vaibhav/gate-2-queue-ui`.
**Prereq:** Gate 1 DoD met; Saksham's Gate 2 (queue reducers) merged or at least available on
his branch to develop against.

Full build-out of Round 1's client side (HLD §3.2) — this screen is what the audience watches
lose fairly, so it needs the whole shape, not a placeholder.

### RED (Playwright, `clients/web/e2e/`)
| TC ID | Test file | Notes |
|---|---|---|
| TC-UI-01 | `onboarding.spec.ts` | QR landing → name → participant created, wallet shows the *drawn* balance |
| TC-UI-02 | `onboarding.spec.ts` | Empty name blocked with inline error |
| TC-UI-03 | `onboarding.spec.ts` | Events list live-updates on new event |
| TC-UI-04 | `queue-round.spec.ts` | Fixed price shown, Buy disabled during 60s pre-open countdown, ticking |
| TC-UI-05 | `queue-round.spec.ts` | Buy enabled exactly at zero; forced-early click rejected by module |
| TC-UI-06 | `queue-round.spec.ts` | Successful buy → confirmation, wallet decreases by ticket price |
| TC-UI-07 | `queue-round.spec.ts` | Sold-out buy → clear "not allocated" state, wallet unchanged |

### GREEN
- Onboarding form → event list → queue-mode event page against the real `FairDropClient`.

### Definition of Done
- [ ] All RED tests green.
- [ ] **Milestone check:** a human can onboard, see the event, watch the countdown, and buy a
      ticket through the real UI, wallet debiting live.

### Escalate if
- Nothing module-side is ready to drive the UI against (Saksham's Gate 2 isn't merged) — don't
  build against a mock and call the gate done; either wait, or explicitly build against his
  branch and note the temporary coupling in your report.

---

## Gate 3 — ROUND 1 at scale: bot-runner + pool

**Branch:** `vaibhav/gate-3-bot-pool`.
**Prereq:** Gate 2 DoD met. Runs **before** any turn-mode UI work, per LLD §13's explicit
ordering.

### RED (`integration/pool.spec.ts`, `integration/bots.spec.ts` unless noted)
| TC ID | Notes |
|---|---|
| TC-POOL-01 | `POST /onboard { displayName }` → `{ identity, walletBalance }`, exactly one human participant |
| TC-POOL-02 | Each onboarding → exactly 4 `origin: "bot"` participants, no more no fewer |
| TC-POOL-03 | **Bots are async tasks, never child processes** — OS process count bounded, independent of bot count, at 1,000 bots |
| TC-POOL-04 | **Connections pooled** — 1,000 bots don't open 1,000 WebSocket connections |
| TC-POOL-07 | Distinct `Bot-<random>` names, no collisions across 1,000 registrations |
| TC-POOL-11 | 250 concurrent `/onboard` calls → 250 humans + 1,000 bots, no dupes, no drops |
| TC-BOT-01 | Round-1 bot: buys at `t_open + random(0, δ)`, never before `t_open` |
| TC-NFR-01 | **Joint with Saksham** — 1,250 concurrent subscribers, one slot, no drops |

### GREEN
- `services/bot-runner/`: onboarding proxy calling `FairDropClient.join(...)` for the human,
  then fire-and-forget registering 4 bots into **one bounded worker pool** (LLD §5a — async
  tasks in a single Node process or a small fixed number sized to cores, never sized to bot
  count; a bounded set of pooled SpacetimeDB connections).
- Round-1-only bot behaviour for now (turn-mode logic is Gate 4).

### Definition of Done
- [ ] All RED tests green, including the joint 1,250-subscriber load test (coordinate timing
      with Saksham — his module needs to be far enough along on Gate 3 too).
- [ ] **Milestone check:** 10 humans / 40 bots race Round 1 through the real UI + real bot pool;
      fast bots disproportionately win. Load test passes at 1,250.

### Escalate if
- You find yourself reaching for one process/connection per bot to make a test pass faster —
  that is the exact failure mode LLD §5a calls out as "not survivable on a demo rig." Stop and
  redesign around the pool constraint rather than shipping a version that merely passes at small
  N.
- TC-NFR-01 fails and the bottleneck looks like it's on the module side, not your pool — report
  jointly with Saksham rather than tuning your pool further against a problem that isn't yours.

---

## Gate 4 — ROUND 2: Turn mode (Fair Drop) UI

**Branch:** `vaibhav/gate-4-turn-ui`.
**Prereq:** Gate 3 DoD met; Saksham's Gate 4 (turn-mode reducers) available.

### RED (`clients/web/e2e/turn-round.spec.ts` unless noted)
| TC ID | Notes |
|---|---|
| TC-UI-08 | Current slot index, floor (labelled as price you'll pay), effective quota, countdown; entry control is a **single confirm at floor price, no amount to type** |
| TC-UI-09 | Entry control disabled + explained when `walletBalance < slot.floor` |
| TC-UI-10 | After entering, control locks for that slot — no second submission offered |
| TC-UI-11 | Entries **sealed** — no other participant's entry or running count visible before close, on DOM and network |
| TC-UI-12 | At close, phone view shows won/lost; win price == slot floor exactly |
| TC-UI-13 | **C5 at UI layer** — after winning, later slots show "you already have a ticket," no entry control |
| TC-UI-14 | Next slot's higher floor appears without a refresh |
| TC-BOT-02..04 | Turn-mode bot: enters at floor if eligible; abstains permanently once wallet < floor; does nothing once `hasWon` |

### GREEN
- Turn-mode event page + phone view against `FairDropClient`'s slot subscriptions.
- Turn-mode bot behaviour (LLD §5b) — deliberately trivial: no amount to choose, so don't add
  one; the simplicity is the point, not a gap.
- Minimal admin dashboard scaffold if not already started (full pass is Gate 8) — needed to show
  slots clearing at this milestone.

### Definition of Done
- [ ] All RED tests green.
- [ ] **Milestone check:** same population, flip to `mode: "turn"` → 5 slots visibly clear on
      the phone view and dashboard, floors rising, eligible field shrinking.

### Escalate if
- TC-UI-11 (sealed entries) is hard to satisfy because a subscription is over-broadcasting
  slot-in-progress state — that's a module subscription-shape issue, escalate to Saksham rather
  than filtering it client-side (filtering client-side means the data left the wire, which is
  the actual violation TC-UI-11 checks for).

---

## Gate 5 — C1 invariance + verifiability (supporting role)

**Branch:** `vaibhav/gate-5-late-entrant`.
**Prereq:** Gate 4 DoD met.

### RED
| TC ID | Test file | Notes |
|---|---|---|
| TC-E2E-04 | `clients/web/e2e/acceptance.spec.ts` | Human enters at second 58, bot at second 0.05, same slot, ≥30 reps → indistinguishable win rates. "The demo's money shot" — a rate claim, not a single scripted win. |

### GREEN
- Nothing new to build if Gate 4 is solid — this is a scenario test proving Saksham's invariance
  guarantee is visible through the real UI + bot pool.

### Definition of Done
- [ ] TC-E2E-04 green over ≥30 repetitions.

### Escalate if
- Win rates are statistically distinguishable — do not treat this as a flaky test and retry past
  the 3-attempt rule; this would mean C1 is actually violated, which is Saksham's gate, not
  yours to silently patch.

---

## Gate 6 — Subscription correctness (C3/C4) + wallet atomicity

**Branch:** `vaibhav/gate-6-subscription-audit`.
**Prereq:** Gate 5 DoD met.

### RED
| TC ID | Test file | Notes |
|---|---|---|
| TC-INV-09 | `integration/subscriptions.spec.ts` | Artificially delaying one client's subscription 5s must not change that client's next-slot outcome |
| TC-WAL-10 | `clients/web/e2e/` | Phone view's displayed balance matches module row after every clearing, no client-side arithmetic |

### GREEN
- Every client (UI instance + each bot worker) records `{slot_result_id, state_version,
  received_at}` on every `SlotResult` observed (LLD §11 Gate 6).

### Definition of Done
- [ ] Both RED tests green.

### Escalate if
- The phone view ever computes a balance itself instead of rendering the subscribed row —
  fix immediately, this is exactly the class of bug TC-WAL-10 exists to catch.

---

## Gate 7 — Bot-runner + onboarding polish

**Branch:** `vaibhav/gate-7-onboarding-polish`.
**Prereq:** Gate 6 DoD met.

### RED
| TC ID | Notes |
|---|---|
| TC-POOL-05 | `/onboard` response returns **before** bot registration completes, even with registration artificially slowed 5s |
| TC-POOL-06 | Bot registration failure → human onboarding still succeeds; failure logged + retried independently |

### GREEN
- Fire-and-forget bot registration, independent retry/logging path, per LLD §5/§9.

### Definition of Done
- [ ] Both RED tests green.

---

## Gate 8 — UI (wire everything together; last consumer per LLD §14)

**Branch:** `vaibhav/gate-8-dashboard-polish`.
**Prereq:** Gate 7 DoD met.

### RED (`clients/web/e2e/dashboard.spec.ts` unless noted)
| TC ID | Notes |
|---|---|
| TC-DASH-01 | `allocated + ticketsRemaining == totalTickets` at every observed moment |
| TC-DASH-02 | Human/bot split from `Allocation` JOIN `Participant.origin`, not inferred |
| TC-DASH-03 | Split updates live, no manual refresh |
| TC-DASH-04 | Per-slot rows match module exactly; **no cutoff-price column** |
| TC-DASH-05 | Oversubscription ratio (`entriesReceived/quota`) displayed, visibly changes per slot |
| TC-DASH-12 | Published `drawSeed` visible/copyable for live verification |
| TC-UI-13 | (re-verify end to end) C5 "already have a ticket" state |
| TC-UI-18 | Reload mid-slot restores session/wallet/entered-state from subscriptions |

### GREEN
- Full admin dashboard per LLD §8, human/bot split as the visually dominant element.
- Final UI pass across event list + phone view.

### Definition of Done
- [ ] All RED tests green.
- [ ] `clients/web/e2e/` full suite green against `staging`.

---

## Test ownership reference

`TC-UI-*` (Round 1: 01–07; Round 2: 08–18), `TC-DASH-*`, `TC-POOL-*`, `TC-BOT-*`, the UI-driven
halves of `TC-E2E-*`, and `TC-NFR-01/02/04` (pool side; module-under-load correctness is
Saksham's).
