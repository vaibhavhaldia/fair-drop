#!/usr/bin/env bash
#
# DEMO-RECIPE Stage 0, as a script rather than a table of commands.
#
# WHY THIS IS A SCRIPT: Stage 0 used to be prose. It went stale the moment the scaffold was
# deleted at Gate 1 — it still called `add` and queried `person`, neither of which existed —
# and nothing noticed, because prose that rots stays confident. A script that rots FAILS.
#
#   ./scripts/smoke.sh            # publish + verify against the demo database
#   DB=fairdrop-scratch ./scripts/smoke.sh
#
# Exit 0 means Stage 0's check passed and it is safe to proceed. Any non-zero exit means STOP —
# nothing downstream matters, which is what the recipe has always said.

set -uo pipefail

DB="${DB:-fairdrop-demo}"
SERVER="${SERVER:-local}"
MODULE="fair-drop-db/spacetimedb"
EXPECTED_VERSION="2.10.0"

export PATH="$HOME/.local/bin:$PATH"   # the CLI is installed but NOT on PATH
cd "$(dirname "$0")/.."                # always run from the repo root, never from inside
                                       # fair-drop-db/, or spacetime.local.json overrides $DB

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
note() { printf '       %s\n' "$1"; }

echo "Stage 0 — rig smoke test   (database: $DB, server: $SERVER)"
echo

# --- 1. toolchain -----------------------------------------------------------------------
if ! command -v spacetime >/dev/null 2>&1; then
  bad "spacetime CLI not found (expected ~/.local/bin/spacetime)"; exit 1
fi
version="$(spacetime --version 2>&1 | grep -oE 'version [0-9]+\.[0-9]+\.[0-9]+' | head -1 | awk '{print $2}')"
if [ "$version" = "$EXPECTED_VERSION" ]; then
  ok "CLI $version matches the pin"
else
  bad "CLI is $version, expected $EXPECTED_VERSION — run: spacetime version use $EXPECTED_VERSION"
fi

# --- 2. is the instance up? -------------------------------------------------------------
# 404 at / is CORRECT — that is the API root, not a UI. Ping the real endpoint instead.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/v1/ping 2>/dev/null)"
if [ "$code" = "200" ]; then
  ok "instance responding on 127.0.0.1:3000"
else
  bad "instance not responding (/v1/ping gave '${code:-no response}') — is \`spacetime start\` running?"
  note "a 404 at http://127.0.0.1:3000/ is expected and means the server is UP"
  exit 1
fi

# --- 3. is it safe to wipe? ---------------------------------------------------------------
# This script publishes with --delete-data=always, which DESTROYS everything in $DB. That is
# correct before a rehearsal and catastrophic during one: running Stage 0 to "check the rig"
# mid-demo would silently delete the event on the projector. A completed event is just as
# precious — it is the evidence Stage 3 recomputes from.
if [ "${FORCE:-0}" = "1" ]; then
  ok "FORCE=1 — wiping '$DB' without checking for live data"
else
  ev_rows="$(spacetime sql --server "$SERVER" "$DB" 'SELECT id, state FROM event' 2>/dev/null || true)"
  al_rows="$(spacetime sql --server "$SERVER" "$DB" 'SELECT id FROM allocation' 2>/dev/null || true)"
  n_alloc="$(printf '%s\n' "$al_rows" | grep -cE '^[[:space:]]+[0-9]+[[:space:]]*$' || true)"
  if printf '%s' "$ev_rows" | grep -qE '"(countdown|open|settled)"' || [ "${n_alloc:-0}" -gt 0 ]; then
    bad "refusing to wipe '$DB' — it holds a live or completed event (${n_alloc:-0} allocations)"
    note "publishing here uses --delete-data=always and would destroy the demo and its evidence"
    note "use a scratch db:  DB=fairdrop-scratch ./scripts/smoke.sh"
    note "or wipe on purpose: FORCE=1 ./scripts/smoke.sh"
    exit 1
  fi
  ok "'$DB' holds no live demo data — safe to republish"
fi

# --- 4. publish -------------------------------------------------------------------------
if spacetime publish -p "$MODULE" "$DB" --server "$SERVER" -y --delete-data=always >/tmp/smoke-publish.log 2>&1; then
  ok "published to $DB"
else
  bad "publish failed — see /tmp/smoke-publish.log"
  if grep -q "not authorized" /tmp/smoke-publish.log; then
    note "403: '$DB' is owned by another identity. Check: spacetime list --server $SERVER"
  fi
  exit 1
fi

# --- 5. the real smoke test: a procedure returns a value and the row lands ---------------
# Procedures log a spurious "nonexistent reducer" ERROR on success (CONTRACT §10) — the
# return value and the committed row are what count, not the log.
eid="$(spacetime call --server "$SERVER" "$DB" create_event '"smoke"' '"queue"' '0.40' '15000' '[]' 2>/dev/null | tr -d '[:space:]')"
if [ "$eid" = "1" ]; then
  ok "create_event returned an id ($eid) — procedure return path works"
else
  bad "create_event returned '$eid', expected 1"
fi

row="$(spacetime sql --server "$SERVER" "$DB" 'SELECT id, name, mode, state FROM event' 2>/dev/null)"
if echo "$row" | grep -q '"created"'; then
  ok "event row reads back with state = created"
else
  bad "event row missing or wrong state"; note "$row"
fi

# --- 6. the pure tier ---------------------------------------------------------------------
# TC-INV-01, TC-CLR-09, TC-CLR-11. These need no server and take under a second.
if npm test --prefix "$MODULE" >/tmp/smoke-tests.log 2>&1; then
  ok "pure tests green ($(grep -oE 'Tests +[0-9]+ passed' /tmp/smoke-tests.log | head -1))"
else
  bad "pure tests failed — see /tmp/smoke-tests.log"
fi

# --- 7. the verifier must agree with the module -------------------------------------------
# TC-CLR-09's whole claim is that an outsider can recompute the draw. If recompute.mjs and
# src/pure/hash.ts drift apart, that claim is void and nothing else here would notice.
seed_a="$(node integration/verify/recompute.mjs --event 42 --slot 2 --ids 1,2,3,4,5 2>/dev/null | grep -oE '[0-9a-f]{16}' | head -1)"
seed_b="$(node --experimental-strip-types --input-type=module -e "
import { deriveDrawSeed } from './fair-drop-db/spacetimedb/src/pure/draw.ts';
console.log(deriveDrawSeed(42n, 2, [1n,2n,3n,4n,5n]));" 2>/dev/null | tr -d '[:space:]')"
if [ -n "$seed_a" ] && [ "$seed_a" = "$seed_b" ]; then
  ok "standalone verifier agrees with the module ($seed_a)"
elif [ -z "$seed_b" ]; then
  # NOT a skip. This used to `note` and pass, which meant the single guard on TC-CLR-09's
  # whole claim quietly disappeared on any box with Node < 22.6 — and the advice it printed
  # ("run npm test instead") pointed at a suite that structurally cannot catch the drift,
  # because every test in it imported the module's own hash. `npm test` now DOES cover this
  # (tests/verifier-parity.unit.test.ts shells out to recompute.mjs), so a failure here is a
  # real toolchain problem, not an acceptable degradation.
  bad "cannot run the verifier cross-check — node could not load the module's TS"
  note "need node >= 22.6 for --experimental-strip-types; this box: $(node -v 2>/dev/null || echo 'no node')"
  note "TC-CLR-09 is unverified until this runs. Do not proceed on the assumption it passed."
else
  bad "verifier and module DISAGREE — verifier=$seed_a module=$seed_b"
  note "TC-CLR-09 is void until these match. Change one, change both."
fi

# --- 8. scheduled reducers must stay private to non-owners --------------------------------
# `close_slot` carries NO sender guard (index.ts), on the grounds that the host makes scheduled
# reducers private. Verified true on 2.10 (2026-09-06) and pinned here, because if a version
# bump ever revokes it the module has no second line of defence: any client could close a slot
# the instant it opens, on an entry set of one, and C1/C4 would be gone with no error anywhere.
#
# The control matters as much as the probe. An anonymous identity CAN reach ordinary reducers
# (open_event turns it away with the module's own E_NOT_ADMIN), so a 404 on close_slot is real
# privacy enforcement rather than an unauthenticated caller being bounced at the door.
anon_ctrl="$(spacetime call --server "$SERVER" --anonymous "$DB" open_event '1' 2>&1)"
anon_close="$(spacetime call --server "$SERVER" --anonymous "$DB" close_slot \
  '{"scheduled_id":1,"scheduled_at":{"Time":[1]},"event_id":1,"slot_index":0}' 2>&1)"

if ! printf '%s' "$anon_ctrl" | grep -q 'E_NOT_ADMIN'; then
  bad "privacy control inconclusive — anonymous open_event did not reach the reducer"
  note "expected E_NOT_ADMIN, got: $(printf '%s' "$anon_ctrl" | grep -iv warning | head -2 | tr '\n' ' ')"
elif printf '%s' "$anon_close" | grep -qi 'no such procedure'; then
  ok "close_slot is private to non-owners (anon: 404; control open_event: E_NOT_ADMIN)"
else
  bad "SCHEDULED-REDUCER PRIVACY LOST — a non-owner was not refused by close_slot"
  note "close_slot has no sender guard; a bot can now close a slot early and break C1/C4"
  note "got: $(printf '%s' "$anon_close" | grep -iv warning | head -2 | tr '\n' ' ')"
  note "add a guard in index.ts (ctx.senderAuth.isInternal) before running the demo"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mStage 0 passed\033[0m — %d checks. Safe to proceed.\n' "$pass"; exit 0
else
  printf '\033[31mStage 0 FAILED\033[0m — %d passed, %d failed. STOP; nothing downstream matters.\n' "$pass" "$fail"; exit 1
fi
