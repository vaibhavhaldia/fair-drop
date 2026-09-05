#!/usr/bin/env bash
#
# DEMO-RECIPE Stage 3 — verifiability. Run AFTER a turn round, against its settled event.
#
#   ./scripts/rehearse-stage3.sh <eventId>
#
# This is the part nobody else can do, and it is the one stage that reads the demo's evidence
# rather than producing it — so it must run against a real settled event, never a fresh one.
#
# `--ids` takes BID ids, not participant ids. The seed derives from `entries.map(e => e.id)`
# over `bid` rows (index.ts, close_slot); passing participant ids yields a plausible-looking
# seed that silently disagrees with the module.

set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

DB="${DB:-fairdrop-scratch}"
SERVER="${SERVER:-local}"
EV="${1:?usage: rehearse-stage3.sh <eventId>}"

pass=0; fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
q()   { spacetime sql --server "$SERVER" "$DB" "$1" 2>/dev/null; }

echo "Stage 3 — verifiability   db=$DB  event=$EV"
q "SELECT slot_index, draw_seed, cutoff_price, allocated FROM slot_result WHERE event_id = $EV" | grep -v WARNING

for slot in 0 1 2 3 4; do
  seed=$(q "SELECT slot_index, draw_seed FROM slot_result WHERE event_id = $EV" | grep -E "^ +$slot +\|" | awk '{print $3}' | tr -d '"')
  [ -n "$seed" ] || { bad "slot $slot — no slot_result row"; continue; }
  quota=$(q "SELECT slot_index, effective_quota FROM slot WHERE event_id = $EV" | grep -E "^ +$slot +\|" | awk '{print $3}')
  # id:price pairs — the verifier ranks by price first and uses the hash only within a tier, so
  # bare ids would have it recompute a v3-shaped ranking and disagree with every real slot.
  ids=$(q "SELECT id, price FROM bid WHERE event_id = $EV AND slot_index = $slot" \
    | grep -E '^ +[0-9]+' | awk '{printf "%s:%s,", $1, $3}' | sed 's/,$//')

  out=$(node integration/verify/recompute.mjs --event "$EV" --slot "$slot" --ids "$ids" --quota "$quota" 2>&1)
  rseed=$(printf '%s' "$out" | grep -oE '[0-9a-f]{16}' | head -1)
  [ "$rseed" = "$seed" ] || { bad "slot $slot — seed mismatch: module=$seed verifier=$rseed"; continue; }

  # TC-CLR-09: the recomputed winner SET must match the module's, exactly.
  rwin=$(printf '%s' "$out" | grep -oE 'bid [0-9]+' | awk '{print $2}' | sort -n | paste -sd, -)
  mwin=$(q "SELECT id, slot_index, state FROM bid WHERE event_id = $EV" \
          | grep -E "^ +[0-9]+ +\| +$slot +\| +\"won\"" | awk '{print $1}' | sort -n | paste -sd, -)
  if [ "$rwin" = "$mwin" ]; then
    ok "TC-CLR-09 slot $slot — seed $seed reproduced; winners match exactly [$mwin]"
  else
    bad "TC-CLR-09 slot $slot — winners differ: module=[$mwin] verifier=[$rwin]"
  fi
done

echo "  running the pure tier (TC-INV-01: >=100 shuffled permutations -> identical allocations)"
if npm test --prefix fair-drop-db/spacetimedb >/tmp/stage3-tests.log 2>&1; then
  n=$(sed -E $'s/\033\\[[0-9;]*m//g' /tmp/stage3-tests.log | grep -oE 'Tests +[0-9]+ passed' | head -1)
  [ -n "$n" ] && ok "TC-INV-01 — pure tier green ($n)" || bad "pure tier exited 0 with no summary line"
else
  bad "pure tier failed — see /tmp/stage3-tests.log"
fi

echo
if [ "$fail" -eq 0 ]; then printf '\033[32mStage 3 passed\033[0m — %d checks.\n' "$pass"; exit 0
else printf '\033[31mStage 3 FAILED\033[0m — %d passed, %d failed.\n' "$pass" "$fail"; exit 1; fi
