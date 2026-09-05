#!/usr/bin/env bash
#
# DEMO-RECIPE Stage 2 — Round 2 (turn / Fair Drop), as a rehearsal script.
#
#   ./scripts/rehearse-round2.sh [label]
#
# Runs ~5.5 minutes: five 60s slots, plus the countdown. Nothing here can be hurried — the slot
# window is SLOT_WINDOW_SECONDS in the module (Saksham's side), not a client-side timer.
#
# CRITICAL (recipe §2.1): this creates a NEW event with a NEW population. Reusing Round 1's
# participants means every winner carries hasWon and C5 blocks them — the round looks broken at
# the worst possible moment.
#
# The humans are driven from this shell, entering each slot at ~t+55s of its 60s window —
# deliberately last, which is exactly what TC-INV-05 claims cannot hurt them. Unlike Round 1,
# no reaction-time lag is modelled here and none is needed: the draw does not read arrival
# time, so when the human enters is the thing under test rather than a rig artifact.

set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

DB="${DB:-fairdrop-scratch}"
SERVER="${SERVER:-local}"
H="${H:-10}"
FRACTION="${FRACTION:-0.40}"
FLOORS="${FLOORS:-[15000,22000,30000,40000,55000]}"
ENTER_AT="${ENTER_AT:-55}"     # seconds into each 60s slot that the humans enter
LABEL="${1:-round2}"

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
q()    { spacetime sql --server "$SERVER" "$DB" "$1" 2>/dev/null; }
nrows(){ q "$1" | grep -cE '^ +[0-9]+'; }
napm() { perl -e "select undef,undef,undef,$1"; }

echo "Round 2 — turn (Fair Drop)   db=$DB  H=$H  floors=$FLOORS"

# --- 2.1 Arrange --------------------------------------------------------------------------
# TC-EVT-07 first, as its own throwaway event — a good beat on stage, and it must not pollute
# the real one.
rej=$(spacetime call --server "$SERVER" "$DB" create_event '"floors-probe"' '"turn"' "$FRACTION" '0' '[15000,22000,22000]' 2>&1)
echo "$rej" | grep -q 'E_FLOORS_NOT_INCREASING' \
  && ok "TC-EVT-07 — non-increasing floors rejected with E_FLOORS_NOT_INCREASING" \
  || bad "TC-EVT-07 — expected E_FLOORS_NOT_INCREASING, got: $(echo "$rej" | head -2 | tr '\n' ' ')"

EV=$(spacetime call --server "$SERVER" "$DB" create_event "\"$LABEL\"" '"turn"' "$FRACTION" '0' "$FLOORS" 2>/dev/null | tr -d '[:space:]')
[ -n "$EV" ] || { bad "create_event returned nothing"; exit 1; }
echo "  event=$EV"

nslots=$(nrows "SELECT id FROM slot WHERE event_id = $EV")
zeroq=$(q "SELECT base_quota, effective_quota FROM slot WHERE event_id = $EV" | grep -cE '^ +0 +\| +0')
sc=$(q "SELECT slot_count FROM event WHERE id = $EV" | grep -oE '^ +[0-9]+' | tr -d ' ')
{ [ "$nslots" = 5 ] && [ "$zeroq" = 5 ] && [ "$sc" = 5 ]; } \
  && ok "TC-EVT-02/TC-SCH-15 — 5 slot rows, baseQuota=0, effectiveQuota=0, slotCount=5" \
  || bad "TC-EVT-02/TC-SCH-15 — slots=$nslots zeroQuota=$zeroq slotCount=$sc"

HUMANS=""
for i in $(seq 1 "$H"); do
  pid=$(spacetime call --server "$SERVER" "$DB" join "$EV" "\"Human-$i\"" '"human"' 2>/dev/null | tr -d '[:space:]')
  HUMANS="$HUMANS $pid"
done

BOTLOG="$(mktemp -t rehearse-turn)"
node --experimental-strip-types clients/bots/src/turn.ts "$H" "$EV" "$DB" >"$BOTLOG" 2>&1 &
BOTPID=$!

want=$(( H * 5 ))
for _ in $(seq 1 120); do
  grep -q "READY joined=" "$BOTLOG" && break
  napm 0.5
done
n=$(nrows "SELECT id FROM participant WHERE event_id = $EV")
[ "$n" = "$want" ] && ok "TC-JOIN-10 — fresh population of $want, none reused from Round 1" \
  || { bad "TC-JOIN-10 — $n participants, wanted $want"; kill $BOTPID 2>/dev/null; exit 1; }

# --- 2.2 Act ------------------------------------------------------------------------------
spacetime call --server "$SERVER" "$DB" start_countdown "$EV" >/dev/null 2>&1
expect_t=$(( (H * 5 * 40 + 50) / 100 ))
tt=$(q "SELECT total_tickets FROM event WHERE id = $EV" | grep -oE '^ +[0-9]+' | tr -d ' ')
sumq=$(q "SELECT base_quota FROM slot WHERE event_id = $EV" | grep -E '^ +[0-9]+' | awk '{s+=$1} END{print s+0}')
quotas=$(q "SELECT slot_index, base_quota FROM slot WHERE event_id = $EV" | grep -E '^ +[0-9]+' | awk '{printf "%s,", $3}' | sed 's/,$//')
{ [ "$tt" = "$expect_t" ] && [ "$sumq" = "$expect_t" ]; } \
  && ok "TC-EVT-09/11/16 — sum(baseQuota)=totalTickets=$expect_t, quotas [$quotas]" \
  || bad "TC-EVT-09/11/16 — totalTickets=$tt sum(baseQuota)=$sumq quotas [$quotas]"
BASEQ_BEFORE="$quotas"

spacetime call --server "$SERVER" "$DB" open_event "$EV" >/dev/null 2>&1
echo "  opened — five 60s slots; humans enter at t+${ENTER_AT}s of each"

declare -a HUMAN_CODES
for slot in 0 1 2 3 4; do
  # wait until the module says this slot is current
  for _ in $(seq 1 240); do
    cur=$(q "SELECT current_slot_index, state FROM event WHERE id = $EV")
    echo "$cur" | grep -q '"settled"' && break 2
    echo "$cur" | grep -qE "^ +$slot +\|" && break
    napm 0.5
  done
  napm "$ENTER_AT"
  floor=$(q "SELECT slot_index, \"floor\" FROM slot WHERE event_id = $EV" | grep -E "^ +$slot +\|" | awk '{print $3}')
  codes=""
  for p in $HUMANS; do
    c=$(spacetime call --server "$SERVER" "$DB" submit_bid "$EV" "$p" "$slot" "$floor" 2>&1 | grep -oE 'E_[A-Z_]+' | head -1)
    codes="$codes ${c:-ok}"
  done
  HUMAN_CODES[$slot]="$codes"
  echo "  slot $slot (floor $floor) human entries:$codes"
  # let the scheduled close_slot land
  for _ in $(seq 1 60); do
    nrows "SELECT id FROM slot_result WHERE event_id = $EV AND slot_index = $slot" | grep -q '^1$' && break
    napm 0.5
  done
done

wait $BOTPID 2>/dev/null

# --- 2.2 per-slot checks ------------------------------------------------------------------
nres=$(nrows "SELECT id FROM slot_result WHERE event_id = $EV")
[ "$nres" = 5 ] && ok "TC-CLR-01 — one slot_result per slot (5)" || bad "TC-CLR-01 — $nres slot_result rows"

badprice=0; badalloc=0
for slot in 0 1 2 3 4; do
  fl=$(q "SELECT slot_index, \"floor\", effective_quota FROM slot WHERE event_id = $EV" | grep -E "^ +$slot +\|" | awk '{print $3, $5}')
  set -- $fl; sfloor=$1; equota=$2
  rr=$(q "SELECT slot_index, clearing_price, allocated FROM slot_result WHERE event_id = $EV" | grep -E "^ +$slot +\|" | awk '{print $3, $5}')
  set -- $rr; cprice=$1; alloc=$2
  [ "$cprice" = "$sfloor" ] || badprice=$((badprice+1))
  [ "${alloc:-0}" -le "${equota:-0}" ] || badalloc=$((badalloc+1))
  # TC-CLR-03 — every winner in the slot paid exactly that floor
  wrong=$(q "SELECT slot_index, price_paid FROM allocation WHERE event_id = $EV" | grep -E "^ +$slot +\|" | awk -v f="$sfloor" '$3!=f{c++} END{print c+0}')
  [ "$wrong" = 0 ] || badprice=$((badprice+1))
done
[ "$badprice" = 0 ] && ok "TC-CLR-01/03 — clearingPrice == slot floor, every winner paid it" || bad "TC-CLR-01/03 — $badprice slots wrong"
[ "$badalloc" = 0 ] && ok "TC-CLR-01 — allocated <= effectiveQuota in every slot" || bad "TC-CLR-01 — $badalloc slots over quota"

quotas_after=$(q "SELECT slot_index, base_quota FROM slot WHERE event_id = $EV" | grep -E '^ +[0-9]+' | awk '{printf "%s,", $3}' | sed 's/,$//')
[ "$quotas_after" = "$BASEQ_BEFORE" ] \
  && ok "TC-EVT-09 — baseQuota unchanged by the closes [$quotas_after]" \
  || bad "TC-EVT-09 — baseQuota mutated: [$BASEQ_BEFORE] -> [$quotas_after]"

roll=$(q "SELECT base_quota, effective_quota FROM slot WHERE event_id = $EV" | grep -E '^ +[0-9]+' | awk '$1!=$3{c++} END{print c+0}')
[ "$roll" = 0 ] && ok "effectiveQuota == baseQuota on every slot — no rollover, which is CORRECT (CONTRACT §6)" \
  || echo "  \033[33mnote\033[0m rollover fired on $roll slot(s) — check the floors before anything else"

# dropout curve — TC-BOT-08
entries=$(q "SELECT slot_index, entries_received FROM slot_result WHERE event_id = $EV" | grep -E '^ +[0-9]+' | awk '{printf "%s,", $3}' | sed 's/,$//')
echo "  entries per slot: [$entries]  (TC-BOT-08: the eligible field thins as floors rise)"

# --- 2.3 Check the claim ------------------------------------------------------------------
hw=$(q "SELECT origin FROM participant WHERE event_id = $EV AND has_won = true" | grep -c '"human"')
bw=$(q "SELECT origin FROM participant WHERE event_id = $EV AND has_won = true" | grep -c '"bot"')
alloc=$(nrows "SELECT id FROM allocation WHERE event_id = $EV")
rem=$(q "SELECT tickets_remaining FROM event WHERE id = $EV" | grep -oE '^ +[0-9]+' | tr -d ' ')
{ [ "$alloc" = "$expect_t" ] && [ "$rem" = 0 ]; } \
  && ok "TC-DASH-01 — sum(allocation)=$expect_t, ticketsRemaining=0" \
  || bad "TC-DASH-01 — $alloc allocations, ticketsRemaining=$rem"
q "SELECT state FROM event WHERE id = $EV" | grep -q '"settled"' && ok "state=settled" || bad "not settled"

already=$(printf '%s\n' "${HUMAN_CODES[@]}" | grep -c 'E_ALREADY_WON' || true)
[ "$already" -gt 0 ] \
  && ok "TC-INV-10 — an earlier winner was refused in a later slot with E_ALREADY_WON" \
  || echo "  note  no E_ALREADY_WON seen (only fires if a human won before slot 4)"

q "SELECT id, initial_balance, wallet_balance FROM participant WHERE event_id = $EV" \
  | grep -E '^ +[0-9]+' | awk '{print $1, $3-$5}' | sort -k1,1n > /tmp/r2wal.$$
q "SELECT participant_id, price_paid FROM allocation WHERE event_id = $EV" \
  | grep -E '^ +[0-9]+' | awk '{s[$1]+=$3} END{for(k in s) print k, s[k]}' | sort -k1,1n > /tmp/r2pay.$$
mismatch=$(awk 'NR==FNR{p[$1]=$2; next} {want=($1 in p)?p[$1]:0; if($2!=want) c++} END{print c+0}' /tmp/r2pay.$$ /tmp/r2wal.$$)
rm -f /tmp/r2wal.$$ /tmp/r2pay.$$
[ "$mismatch" = 0 ] \
  && ok "TC-WAL-04 — initialBalance - walletBalance == sum(pricePaid) for every participant" \
  || bad "TC-WAL-04 — $mismatch participants fail the sweep"

echo "  turn driver: $(grep -E 'READY|turn run complete' "$BOTLOG" | tr '\n' ' ')"
rm -f "$BOTLOG"

echo
echo "ROUND2 event=$EV humans_won=$hw bots_won=$bw tickets=$expect_t expected_humans=$(echo "$H" | awk '{printf "%.1f", $1*0.4}')"
if [ "$fail" -eq 0 ]; then printf '\033[32mRound 2 passed\033[0m — %d checks.\n' "$pass"; exit 0
else printf '\033[31mRound 2 FAILED\033[0m — %d passed, %d failed.\n' "$pass" "$fail"; exit 1; fi
