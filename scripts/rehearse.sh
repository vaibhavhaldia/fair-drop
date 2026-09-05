#!/usr/bin/env bash
#
# One full rehearsal — DEMO-RECIPE Stage 1 + Stage 2, in order, on one rig.
#
#   ./scripts/rehearse.sh run1
#   DB=fairdrop-demo ./scripts/rehearse.sh stage
#
# Runs ~7 minutes (Round 2 is five 60s slots and cannot be hurried). Prints the row to paste
# into DEMO-RECIPE.md's rehearsal log at the end.
#
# The ship criterion is TWO consecutive runs with zero manual repair between them
# (tasks/vaibhav.md Gate 3), so run this twice back to back and do not touch anything in
# between. Repairing between runs and calling it two clean runs is the exact failure this
# criterion exists to catch: run 2 is where reuse-of-state bugs surface.
#
# It does NOT run Stage 0 for you. Stage 0 publishes with --delete-data=always; running it
# between the two runs would destroy run 1's evidence, and running it here would make that
# automatic. Run ./scripts/smoke.sh yourself, once, before the first run.

set -uo pipefail
cd "$(dirname "$0")/.."
LABEL="${1:-run}"

./scripts/rehearse-round1.sh "${LABEL}-r1" || { echo "Round 1 failed — stopping."; exit 1; }
echo
./scripts/rehearse-round2.sh "${LABEL}-r2" || { echo "Round 2 failed — stopping."; exit 1; }
