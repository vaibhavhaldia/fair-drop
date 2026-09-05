# Saksham — Module (critical path)

> **SCOPE CUT 2026-09-05 · target 3.5–4h, build-and-test at each stage.** The original 8-gate
> plan assumed 30–35h per engineer (LLD §14) and is abandoned. This file is the replacement.
> Gates 5–8 as previously written **do not happen**; what survives is listed under
> [Cut](#what-was-cut-and-why-its-safe). The frozen contract is `docs/CONTRACT.md` — it is the
> authority; `LLD.md` carries the reasoning.
>
> Timings below include verification. **Test as you go — do not batch it to the end.** Each
> gate ends with a `spacetime sql` check, not a promise to check later.

> **For the `sdd-engine` agent**: gate specs below. Trigger with `"Saksham Gate <N> go"`.
> Test paths are `fair-drop-db/spacetimedb/tests/` — **not** `module/`, which does not exist.

**The one thing this build must show:** same population, flip `mode: "queue"` → `"turn"`,
allocation stops being determined by speed. Everything that does not serve that is cut.

Owned paths: `fair-drop-db/spacetimedb/**`, plus the thin client wrapper.

---

## Ground rules that changed at Gate 0

**Reducers cannot be unit-tested.** `spacetimedb/server` imports `spacetime:sys@2.0`, a
host-only module scheme; any file importing it is unloadable in vitest. Verified, not assumed.
There is no in-process harness and building one is not an option.

Therefore:

- **The draw and the inventory math are pure modules** — plain TS, zero spacetimedb imports,
  no `ctx`. `close_slot` and `start_countdown` are thin callers. This is the only code that can
  be tested at all, and it happens to be the code that matters.
- Everything else is verified by **running it** — `spacetime call`, `spacetime sql`, and the
  demo itself. Do not spend time building test scaffolding for reducers.

**Write exactly three tests.** Not three suites — three tests:

| Test | Why this one |
|---|---|
| TC-INV-01 | Shuffle insertion order ≥100 ways over ≥20 entries → identical `Allocation` rows. Pure, milliseconds, no server. **This is the thesis.** |
| TC-CLR-09 | Recompute the draw outside the module from `drawSeed` + committed entries → exact match. ~10 lines once the draw is pure, and it is the whole differentiator over FCFS. |
| TC-CLR-11 | χ² over win rates across 500 synthetic slots. **Restored 2026-09-05 after cutting it shipped a real bug** — see below. |

If you find yourself writing a fourth, stop and ask whether it beats spending the time on a
second rehearsal.

**Why TC-CLR-11 came back — do not cut it a second time.** This file originally said two tests,
on the reasoning that TC-INV-01 carried C1 by itself. It does not. C1 has two failure modes and
TC-INV-01 covers one:

- *reads arrival order directly* (`seq`, insertion order) → TC-INV-01 catches it.
- *reads something that correlates with arrival order* → TC-INV-01 is **structurally blind**,
  because permuting the input array never changes the ids inside it.

`bid.id` is a sequential `autoInc` PK, so it *is* arrival order. The first implementation ranked
by raw FNV-1a, which barely avalanches on the tail of its input — so the draw ranked in very
nearly id order. 6 of 24 entries could never win. All six tests passed throughout. The bug is
invisible on stage, because human and bot ids interleave and the share still looks right.

Related: Gate 3 below says "pick any stable hash … **do not escalate this one**." That was
correct about seed *values* and wrong about the choice being free — what made it free was
TC-CLR-11, which had already been cut. The hash now has a contract term (CONTRACT §7): it must
avalanche.

---

## Gate 1 — Toolchain, then schema + lifecycle · target 0:00–1:15

**No branch ceremony.** Commit to `saksham-dev`, merge often.

### 1a. Toolchain spike — ✅ ALREADY DONE 2026-09-05, skip it

Stage 0 of `DEMO-RECIPE.md` ran green. `npm ci` clean (**2.10.0**, 0 vulnerabilities); CLI
**v2.10.0** at `~/.local/bin/spacetime` (**not on PATH** — `export PATH="$HOME/.local/bin:$PATH"`);
publish, `call`, `sql` and `logs` all round-trip against a local instance.

**CLI and lib are both 2.10.0** — matched on purpose, so there is no version-skew step to
remember. 2.10.0 is already `current`; `spacetime --version` should just pass. The full §10
table was re-run end-to-end on this pair, so nothing in it is inherited from the older
2.9.0/2.8.3 pairing.

**Every contract claim is now build-proven** — see `CONTRACT.md` §10 for the table. The two
that were open are both resolved in our favour:

- **Procedures DO return values** (`join_proc` → `[1, 26029.0]`). The reducer fallback is not
  needed; build `create_event` and `join` as procedures as specified.
- **One identity CAN back many participants** — verified with three rows. Blocker A's fix is
  real, not theoretical.

Start at 1b. Read `CONTRACT.md` §10's gotchas first; they are worth ~20 minutes each:
`--server local` on every command, run `call`/`sql` from outside `fair-drop-db/`,
`publish -p` not `--project-path`, `--delete-data=always` to republish, and **no `GROUP BY`
in SQL** — aggregate client-side.

### 1b. Schema + lifecycle

- Replace the `person`/`sayHello` scaffold with **seven tables**: `event`, `slot`,
  `participant`, `bid`, `allocation`, `slot_result`, `slot_schedule`. (`CONTRACT.md` §2 lists
  nine — `countdown_schedule` and `settle_schedule` are cut in the 4h re-plan; see below.)
- `create_event` + `join` (**procedures** — they return ids), `start_countdown`,
  `open_event` (**admin-called, not scheduled** — see below), `settle` (admin-called).
- Verify by CLI: create an event, join 10 participants, `start_countdown`, `open_event`,
  confirm state transitions with `spacetime sql`.

**Only `slot_schedule` survives.** Turn mode genuinely needs slots to auto-advance, so that one
scheduled table earns its keep. `countdown_schedule` and `settle_schedule` are cut: the admin
calls `open_event` and `settle` directly. This removes two scheduled-table wirings and, with
them, the two ways a demo event can hang forever (queue event that never sells out; countdown
row that never fires). The 60s countdown becomes a display timer before the admin clicks —
every bot still starts from the same instant, because they all learn `state == "open"` from
the same subscription broadcast.

**Watch for:** `t.option(...)` not `.optional()`; `scheduled:` on the *table*; `t.u64()` is
`bigint`. All three are build-breakers and all three were wrong in the pre-Gate-0 draft.

**⚠ Guard `open_event` and `settle` with `E_NOT_ADMIN`.** Cutting the scheduled tables made both
**client-callable**, so they lose the scheduled-reducers-are-private protection they relied on.
Unguarded, any participant could open the event early — destroying Round 1's equal-start
premise — or settle it mid-round. This is the one place where the scope cut *added* a required
guard rather than removing one (TC-LC-15).

### DoD
- [ ] CLI round-trip works against a real local instance.
- [ ] Seven tables published; `create_event` → `join` ×10 → `start_countdown` → `open` observed
      via `spacetime sql`.

### Escalate immediately if
- **Procedures don't return values to the caller.** Fallback is pre-decided in `CONTRACT.md`
  §10 (keep them as reducers, await the row by unique `handle`) — but say so before adopting it.

---

## Gate 2 — Round 1, queue mode · target 1:15–1:50

`submit_bid` queue branch + `settle`. Full path: create → join → start_countdown → open →
submit_bid → allocation + wallet debit, atomically, one reducer call.

Guard order is frozen (`CONTRACT.md` §4) — do not reorder for convenience.

**Two settle triggers**, or the Round 1 event never ends and you cannot get to Round 2:
sell-out inside `submit_bid`, and an **admin call** (replacing the scheduled fallback).

**Settle is two functions, and merging them breaks the sell-out path.** `settleImpl(ctx, eventId)`
is private, has **no sender guard**, and its `state == "open"` check is a **silent no-op** — it
must not throw, because both triggers firing is the normal case. The exported `settle` reducer
is a thin wrapper carrying `E_NOT_ADMIN` and nothing else. `submit_bid` and `close_slot` call
`settleImpl`.

If you put `E_NOT_ADMIN` inside `settleImpl`: participant #N buys the last ticket → `submit_bid`
→ `settle` → sender is the participant, not the admin → throw → **the whole transaction rolls
back and the final purchase fails.** "Called internally" is not a condition the module can
test — an internal call is a plain function call and `ctx.sender` is unchanged. See LLD §2.

### DoD
- [ ] One human buys → ticket + debited wallet, verified by `spacetime sql`.
- [ ] Event reaches `settled` on both paths.
- [ ] **The sell-out purchase itself succeeds** — buy the literal last ticket and confirm the
      `allocation` row and the debit both persisted. This is the case the settle split exists
      to protect, and a merged guard fails exactly here and nowhere else.

---

## Gate 3 — Round 2, turn mode · target 1:50–2:50

The most important gate. `close_slot`, with the draw extracted as a pure module.

```
drawSeed := hash(eventId, slotIndex, sorted(entry ids))
ranked   := entries sorted by hash(drawSeed, entry.id) ASC
walk ranked, allocate 1 + debit slot.floor until effectiveQuota spent
mark winners hasWon; roll unfilled into next slot's effectiveQuota
```

**The `slot_schedule` row carries `slotIndex`** — guard `timer.slotIndex == currentSlotIndex`
(`E_STALE_TIMER`). Reading `currentSlotIndex` alone lets a stale timer close a slot it was never
scheduled for, and the double-close guard cannot detect that.

**`close_slot` must never call `ctx.random`** (TC-CLR-14). The draw is a pure function of
committed state or the verifiability claim dies — and it dies *silently*, because an
RNG-seeded draw still looks uniform and still passes every behavioural check.

Pick any stable hash **with full 64-bit avalanche** (CONTRACT §7 — this is now a contract term,
not a free choice) and note it. No test asserts a specific seed *value*, so you need not escalate
the choice — but a hash that preserves input locality silently violates C1, because `bid.id` is
a sequential `autoInc` PK. `digest64` in `src/pure/hash.ts` is the one to use; TC-CLR-11 guards it.

Write the two tests here, against the pure module.

### DoD
- [ ] 5 slots clear in sequence; every winner in a slot pays exactly that slot's floor.
- [ ] Unfilled quota rolls forward.
- [ ] TC-INV-01 and TC-CLR-09 green.

### Escalate if
- TC-INV-01 fails on a genuine order-dependency after 3 attempts. This is the single most
  important test in the repo; do not let it linger.

---

## Gate 4 — Integration + rehearsal · target 2:50–4:00

Wire Vaibhav's bot driver against the real module. Then run **`docs/DEMO-RECIPE.md`** end to
end, twice, exactly as it will run on stage. This is not buffer, it is the gate — the second
run is where reuse-of-state bugs surface.

The recipe's checks name the test case each one enforces, so a failure points at a spec line
rather than a vague "something's off." Ship criterion: **two consecutive runs, zero manual
repair between them.**

### DoD
- [ ] Queue round: fast bots take the overwhelming majority. Round 1 is *supposed* to look unfair.
- [ ] Turn round, same population: human share ≈ population share.
- [ ] Two clean run-throughs, no manual repair between them.

---

## What was cut, and why it's safe

| Cut | Reasoning |
|---|---|
| Port of `sim.py` to TS | It already works in Python. Run `python3 integration/experiment/sim.py`. The port bought nothing today |
| `clients/sdk` as an enforced layer + TC-SDK-02 import-graph lint | Keep one thin wrapper file. Import discipline is for a codebase with a future |
| 1,250-participant load test | Run 40 bots. §1a's entire argument is that observables are turnout-**invariant**, so small N demonstrates the same property |
| `countdown_schedule` + `settle_schedule` | Admin-triggered instead. Removes two scheduled wirings and the two ways an event can hang forever. `slot_schedule` stays — turn mode needs auto-advance |
| The bounded connection pool | At 40 bots, one connection each is fine. **The schema is unchanged** (`participant.id` PK, non-unique `identity`), so the pool can return later with no migration |
| ~200 of 219 test cases | Reducers are not unit-testable (above); the rest are verified by running the demo. **TC-CLR-11 was wrongly in this bucket** and is restored — it is pure, cheap, and cutting it shipped a C1 violation |
| Gates 5–8 (invariance suite, subscription audit, bot-runner polish, dashboard) | Their one irreplaceable item — C1 invariance — is pulled forward into Gate 3 as TC-INV-01 |

**Kept deliberately despite the crunch:** TC-INV-01, TC-CLR-09 and TC-CLR-11. They are cheap once the draw
is pure, and they are the only evidence that the mechanism does what the demo claims. Cutting
them would leave a demo that looks right and proves nothing.
