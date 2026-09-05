#!/usr/bin/env python3
"""Fair Drop — experiment runner (offline simulation).

Seed implementation for LLD §10. Not part of the live demo: this validates parameters
before they are on stage, and its output is what produced HLD §5a.

Covers TC-EXP-02..07:
  * turnout sweep              — derived inventory holds every observable flat (TC-EXP-04)
  * rule comparison arm        — random-among-qualifying vs retired pay-as-bid (TC-EXP-06)
  * seeded determinism         — same seed, same output (TC-EXP-05)

Usage:
    python3 integration/experiment/sim.py               # full report
    python3 integration/experiment/sim.py --seed 42
"""

import argparse
import random
import statistics

# --- LLD §1a locked parameters ------------------------------------------------
FLOORS = [15_000, 22_000, 30_000, 40_000, 55_000]
WALLET_MIN, WALLET_MAX = 20_000, 150_000
TICKET_FRACTION = 0.40
BOTS_PER_HUMAN = 4
QUEUE_PRICE = 15_000


def size_inventory(participants, fraction=TICKET_FRACTION, slots=len(FLOORS)):
    """LLD §2 start_countdown: derive totalTickets and per-slot quotas from turnout."""
    total = round(fraction * participants)
    base = total // slots
    quotas = [base] * slots
    quotas[-1] += total - base * slots          # remainder to the final slot (TC-EVT-11)
    assert sum(quotas) == total                 # TC-EVT-09
    return total, quotas


def build_pool(humans, bots, rng):
    return [{"w": rng.uniform(WALLET_MIN, WALLET_MAX), "won": False, "human": i < humans}
            for i in range(humans + bots)]


def run_turn(humans, bots, rule, seed, fraction=TICKET_FRACTION):
    """One turn-mode event. `rule` is "random" (production) or "price" (retired, TC-EXP-06)."""
    rng = random.Random(seed)
    pool = build_pool(humans, bots, rng)
    total, quotas = size_inventory(len(pool), fraction)

    carry, human_wins, bot_wins, paid, rows = 0, 0, 0, [], []
    for floor, base_quota in zip(FLOORS, quotas):
        quota = base_quota + carry
        # eligible = has not won (C5) and wallet covers the floor
        eligible = [p for p in pool if not p["won"] and p["w"] >= floor]

        if rule == "random":
            winners = [(floor, p) for p in rng.sample(eligible, min(quota, len(eligible)))]
        elif rule == "price":                   # retired comparator, HLD §5a only
            bids = sorted(((rng.uniform(floor, p["w"]), p) for p in eligible),
                          key=lambda x: -x[0])
            winners = bids[:quota]
        else:
            raise ValueError(f"unknown rule {rule!r}")

        for price, p in winners:
            p["won"] = True
            paid.append(price)
            if p["human"]:
                human_wins += 1
            else:
                bot_wins += 1

        carry = quota - len(winners)
        rows.append({"floor": floor, "quota": quota, "eligible": len(eligible),
                     "filled": len(winners),
                     "clearing": winners[-1][0] if winners else None})

    won = [p for p in pool if p["won"]]
    richest = {id(p) for p in sorted(pool, key=lambda p: -p["w"])[:len(won)]}
    overlap = sum(1 for p in won if id(p) in richest) / max(1, len(won))
    binding = sum(1 for r in rows if r["clearing"] and r["clearing"] < r["floor"] * 1.25)

    return {"total": total, "sold": human_wins + bot_wins, "human": human_wins,
            "bot": bot_wins, "human_win_rate": human_wins / humans,
            "overlap": overlap, "avg_paid": statistics.mean(paid) if paid else 0,
            "binding": binding, "rows": rows}


def run_queue(humans, bots, seed, delta=0.5, human_delay=(1.0, 4.0),
              fraction=TICKET_FRACTION):
    """Round 1 baseline: allocation strictly by arrival time (TC-Q-05)."""
    rng = random.Random(seed)
    pool = build_pool(humans, bots, rng)
    total, _ = size_inventory(len(pool), fraction)

    arrivals = []
    for p in pool:
        t = rng.uniform(0, delta) if not p["human"] else rng.uniform(*human_delay)
        if p["w"] >= QUEUE_PRICE:
            arrivals.append((t, p))
    arrivals.sort(key=lambda x: x[0])

    human_wins = bot_wins = 0
    for _, p in arrivals[:total]:                # C5: one ticket each, so no repeats
        if p["human"]:
            human_wins += 1
        else:
            bot_wins += 1
    return {"total": total, "human": human_wins, "bot": bot_wins,
            "human_win_rate": human_wins / humans}


def mean_over(fn, trials, base_seed, *args, **kw):
    runs = [fn(*args, seed=base_seed + s, **kw) for s in range(trials)]
    keys = [k for k, v in runs[0].items() if isinstance(v, (int, float))]
    return {k: statistics.mean(r[k] for r in runs) for k in keys}


def report(base_seed=0, trials=200):
    print(f"Fair Drop experiment runner — seed={base_seed}, {trials} trials/config")
    print(f"floors={[f // 1000 for f in FLOORS]}k  wallet=U[{WALLET_MIN // 1000}k,"
          f"{WALLET_MAX // 1000}k]  fraction={TICKET_FRACTION}  ratio=1:{BOTS_PER_HUMAN}")

    # TC-EXP-02/03 — the headline comparison
    print("\n=== ROUNDS (250 humans + 1000 bots) ===")
    q = mean_over(run_queue, trials, base_seed, 250, 1000)
    t = mean_over(run_turn, trials, base_seed, 250, 1000, "random")
    print(f"  ROUND 1 — QUEUE (FCFS)      human {q['human']:6.1f} ({q['human']/q['total']:5.1%})"
          f"  bot {q['bot']:6.1f}")
    print(f"  ROUND 2 — TURN (Fair Drop)  human {t['human']:6.1f} ({t['human']/t['sold']:5.1%})"
          f"  bot {t['bot']:6.1f}   richest-overlap {t['overlap']:.1%}"
          f"  avg paid {t['avg_paid']/1000:.1f}k  floors binding {t['binding']:.0f}/5")

    # TC-EXP-04 — turnout sweep: every observable must stay flat
    print("\n=== TURNOUT SWEEP (TC-EXP-04) ===")
    print(f"  {'humans':>7} {'parts':>6} {'tickets':>8} {'sold':>7} {'human share':>12}"
          f" {'humans winning':>15}")
    for h in (50, 100, 150, 250):
        r = mean_over(run_turn, trials, base_seed, h, h * BOTS_PER_HUMAN, "random")
        print(f"  {h:>7} {h*5:>6} {r['total']:>8.0f} {r['sold']:>7.1f}"
              f" {r['human']/r['sold']:>11.1%} {r['human_win_rate']:>14.1%}")

    # TC-EXP-06 — rule comparison arm, regenerates HLD §5a
    print("\n=== RULE COMPARISON (TC-EXP-06 — regenerates HLD §5a) ===")
    print(f"  {'rule':>22} {'human share':>12} {'richest overlap':>16} {'avg paid':>10}"
          f" {'floors binding':>15}")
    for rule, label in (("random", "random-among-qual."), ("price", "pay-as-bid (retired)")):
        r = mean_over(run_turn, trials, base_seed, 250, 1000, rule)
        print(f"  {label:>22} {r['human']/r['sold']:>11.1%} {r['overlap']:>15.1%}"
              f" {r['avg_paid']/1000:>9.1f}k {r['binding']:>14.1f}/5")

    # TC-EXP-07 — delay sweep: queue moves, turn does not
    print("\n=== DELAY SWEEP (TC-EXP-07) ===")
    for delta in (0.01, 0.1, 0.5, 2.0):
        q = mean_over(run_queue, trials, base_seed, 250, 1000, delta=delta)
        print(f"  bot delay δ={delta:<5} queue human share {q['human']/q['total']:6.1%}"
              f"   turn human share {t['human']/t['sold']:6.1%} (unchanged by δ)")


def check_determinism(seed=7):
    """TC-EXP-05 — same seed, identical outcome."""
    a = run_turn(250, 1000, "random", seed=seed)
    b = run_turn(250, 1000, "random", seed=seed)
    assert a == b, "runner is not deterministic under a fixed seed"
    return True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--trials", type=int, default=200)
    args = ap.parse_args()
    check_determinism()
    report(args.seed, args.trials)
