#!/usr/bin/env bash
#
# DEMO-RECIPE Stage 1 — Round 1 (queue / FCFS), as a rehearsal script.
#
#   ./scripts/rehearse-round1.sh [label]
#   DB=fairdrop-demo ./scripts/rehearse-round1.sh stage
#
# Why a script: the ship criterion is "two consecutive runs, zero manual repair between them"
# (tasks/vaibhav.md Gate 3). Two runs typed by hand are two different runs.
#
# ---------------------------------------------------------------------------------------------
# HUMAN_LAG_MS — read this before changing it.
#
# The humans are driven from this shell by `spacetime call`, which lands in ~19ms against a
# local instance. The bots deliberately wait U(0, DELTA_MS=500), mean 250ms. So an unlagged
# hand-issued human bid is ~13x FASTER than a bot, and Round 1 comes out ~10 humans / 10 bots —
# measured, 2026-09-06, and it is not a module bug: it is the rehearsal rig beating the field
# with a local CLI. On stage the human taps a phone after seeing the display flip, which is
# 1-3 seconds, not 19 milliseconds.
#
# So the operator-issued bids are lagged to human reaction time. This is the one number in the
# rehearsal that models rather than measures, and it is here, named, rather than buried.
# Setting it to 0 does not make Round 1 "more real" — it makes the humans robots.
# ---------------------------------------------------------------------------------------------

set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

DB="${DB:-fairdrop-scratch}"
SERVER="${SERVER:-local}"
H="${H:-10}"                      # humans; recipe requires >= 8, targets 10
TICKET_PRICE="${TICKET_PRICE:-15000}"
# 0.20 since v4, matching Round 2 — the rounds must share every parameter but the rule, or
# "same people, same tickets, same wallets" stops being true. See DEMO-RECIPE Stage 2.
FRACTION="${FRACTION:-0.20}"
HUMAN_LAG_MS="${HUMAN_LAG_MS:-1500}"   # see the box above
LABEL="${1:-round1}"

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
q()    { spacetime sql --server "$SERVER" "$DB" "$1" 2>/dev/null; }
nrows(){ q "$1" | grep -cE '^ +[0-9]+'; }

echo "Round 1 — queue (FCFS)   db=$DB  H=$H  humanLag=${HUMAN_LAG_MS}ms"

# --- 1.1 Arrange --------------------------------------------------------------------------
EV=$(spacetime call --server "$SERVER" "$DB" create_event "\"$LABEL\"" '"queue"' "$FRACTION" "$TICKET_PRICE" '[]' '0' 2>/dev/null | tr -d '[:space:]')
[ -n "$EV" ] || { bad "create_event returned nothing"; exit 1; }
echo "  event=$EV"

row=$(q "SELECT state, total_tickets, tickets_remaining FROM event WHERE id = $EV")
if echo "$row" | grep -q '"created"' && echo "$row" | grep -qE '\| +0 +\| +0'; then
  ok "TC-LC-01 — state=created, totalTickets=0, ticketsRemaining=0"
else bad "TC-LC-01 — $row"; fi
q "SELECT admin_identity FROM event WHERE id = $EV" | grep -q '0x' \
  && ok "TC-EVT-03 — adminIdentity populated" || bad "TC-EVT-03 — adminIdentity empty"

HUMANS=""
for i in $(seq 1 "$H"); do
  pid=$(spacetime call --server "$SERVER" "$DB" join "$EV" "\"Human-$i\"" '"human"' 2>/dev/null | tr -d '[:space:]')
  HUMANS="$HUMANS $pid"
done

BOTLOG="$(mktemp -t rehearse-bots)"
node --experimental-strip-types clients/bots/src/index.ts "$H" "$EV" "$DB" >"$BOTLOG" 2>&1 &
BOTPID=$!

want=$(( H * 5 )); wantbots=$(( H * 4 ))
for _ in $(seq 1 60); do
  n=$(nrows "SELECT id FROM participant WHERE event_id = $EV")
  [ "$n" -ge "$want" ] && break
done
n=$(nrows "SELECT id FROM participant WHERE event_id = $EV")
nb=$(nrows "SELECT id FROM participant WHERE event_id = $EV AND origin = 'bot'")
[ "$n" = "$want" ] && [ "$nb" = "$wantbots" ] \
  && ok "TC-JOIN-01/02 — ${want} participants, exactly ${wantbots} bots" \
  || { bad "TC-JOIN-01/02 — $n participants, $nb bots (wanted $want/$wantbots)"; kill $BOTPID 2>/dev/null; exit 1; }

tot=$(q "SELECT handle FROM participant WHERE event_id = $EV" | grep -cE '^ +"')
uniq=$(q "SELECT handle FROM participant WHERE event_id = $EV" | grep -E '^ +"' | sort -u | wc -l | tr -d ' ')
[ "$tot" = "$uniq" ] && ok "TC-JOIN-03 — $uniq distinct handles" || bad "TC-JOIN-03 — $tot handles, $uniq distinct"

q "SELECT initial_balance, wallet_balance FROM participant WHERE event_id = $EV" \
  | grep -E '^ +[0-9]+' \
  | awk -v OK=0 '{i=$1;w=$3;n++; if(i!=w)mm++; if(i<20000||i>150000)oob++; if(i!=int(i))frac++; d[i]=1}
      END{u=0; for(k in d)u++;
          printf "%d %d %d %d %d\n", n, mm+0, oob+0, frac+0, u}' > /tmp/wallets.$$
read -r wn wmm woob wfrac wu < /tmp/wallets.$$; rm -f /tmp/wallets.$$
[ "$wmm" = 0 ] && ok "TC-SCH-12 — initialBalance == walletBalance on all $wn rows" || bad "TC-SCH-12 — $wmm mismatched"
{ [ "$woob" = 0 ] && [ "$wfrac" = 0 ] && [ "$wu" -gt 1 ]; } \
  && ok "TC-SCH-11 — integer wallets in [20000,150000], $wu distinct values" \
  || bad "TC-SCH-11 — oob=$woob nonInteger=$wfrac distinct=$wu"

# --- 1.2 Act ------------------------------------------------------------------------------
spacetime call --server "$SERVER" "$DB" start_countdown "$EV" >/dev/null 2>&1
row=$(q "SELECT state, total_tickets, tickets_remaining, participants_at_open FROM event WHERE id = $EV")
expect_t=$(( (H * 5 * 20 + 50) / 100 ))   # round(0.20 * 5H), exact at demo scale
if echo "$row" | grep -qE "\"countdown\" +\| +$expect_t +\| +$expect_t +\| +$want"; then
  ok "TC-EVT-10/17 — totalTickets=$expect_t, ticketsRemaining=$expect_t, participantsAtOpen=$want"
else bad "TC-EVT-10/17 — $row"; fi

nb_bids=$(nrows "SELECT id FROM bid WHERE event_id = $EV")
nb_alloc=$(nrows "SELECT id FROM allocation WHERE event_id = $EV")
{ [ "$nb_bids" = 0 ] && [ "$nb_alloc" = 0 ]; } \
  && ok "TC-LC-05 — bots idle in countdown: no bid, no allocation rows" \
  || bad "TC-LC-05 — $nb_bids bids, $nb_alloc allocations before open"

spacetime call --server "$SERVER" "$DB" open_event "$EV" >/dev/null 2>&1

# The humans tap. Lagged to human reaction time — see the HUMAN_LAG_MS box at the top.
perl -e "select undef,undef,undef,$HUMAN_LAG_MS/1000"
for p in $HUMANS; do
  spacetime call --server "$SERVER" "$DB" submit_bid "$EV" "$p" '0' "$TICKET_PRICE" >/dev/null 2>&1 &
done
wait
wait $BOTPID 2>/dev/null

# --- 1.3 Check ----------------------------------------------------------------------------
alloc=$(nrows "SELECT id FROM allocation WHERE event_id = $EV")
rem=$(q "SELECT tickets_remaining FROM event WHERE id = $EV" | grep -oE '^ +[0-9]+' | tr -d ' ')
{ [ "$alloc" = "$expect_t" ] && [ "$rem" = 0 ]; } \
  && ok "TC-Q-03 — $expect_t allocations, ticketsRemaining=0" \
  || bad "TC-Q-03 — $alloc allocations, ticketsRemaining=$rem"

q "SELECT state FROM event WHERE id = $EV" | grep -q '"settled"' \
  && ok "TC-LC-12 — settled on sell-out, no admin call" || bad "TC-LC-12 — not settled"

hw=$(q "SELECT origin FROM participant WHERE event_id = $EV AND has_won = true" | grep -c '"human"')
bw=$(q "SELECT origin FROM participant WHERE event_id = $EV AND has_won = true" | grep -c '"bot"')
if [ "$hw" -le 1 ]; then ok "TC-Q-09 — humans won $hw of $expect_t (bots $bw) — Round 1 looks unfair, as it must"
else bad "TC-Q-09 — humans won $hw of $expect_t (bots $bw) — expected 0-1; check HUMAN_LAG_MS and DELTA_MS"; fi

# TC-WAL-02/03/04 — every winner debited exactly the ticket price, every loser byte-identical.
q "SELECT id, initial_balance, wallet_balance, has_won FROM participant WHERE event_id = $EV" \
  | grep -E '^ +[0-9]+' \
  | awk -v price="$TICKET_PRICE" '{i=$3;w=$5;won=$7; d=i-w;
      if(won=="true"){ if(d!=price) badw++ } else { if(d!=0) badl++ } }
      END{printf "%d %d\n", badw+0, badl+0}' > /tmp/wal.$$
read -r badw badl < /tmp/wal.$$; rm -f /tmp/wal.$$
[ "$badw" = 0 ] && ok "TC-WAL-02/04 — every winner debited exactly $TICKET_PRICE" || bad "TC-WAL-02/04 — $badw winners wrong"
[ "$badl" = 0 ] && ok "TC-WAL-03 — every loser's balance byte-identical" || bad "TC-WAL-03 — $badl losers debited"

grep -E "open detected|bid submitted" "$BOTLOG" | sed 's/^/  bots: /'
rm -f "$BOTLOG"

echo
echo "ROUND1 event=$EV humans_won=$hw bots_won=$bw tickets=$expect_t"
if [ "$fail" -eq 0 ]; then printf '\033[32mRound 1 passed\033[0m — %d checks.\n' "$pass"; exit 0
else printf '\033[31mRound 1 FAILED\033[0m — %d passed, %d failed.\n' "$pass" "$fail"; exit 1; fi
