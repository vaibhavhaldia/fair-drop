#!/usr/bin/env bash
#
# One command to take a fresh clone to a running demo. Idempotent — safe to re-run.
#
# WHY THIS EXISTS: the dependency graph is not guessable from the directory names. The bot
# driver has no runtime dependencies of its own, but it will not start until `clients/sdk` is
# installed, because it reaches through the SDK into `generated/`, which imports `spacetimedb`.
# The failure is `ERR_MODULE_NOT_FOUND ... imported from clients/sdk/generated/index.ts`, which
# points at a directory the person never touched. Verified from a clean clone.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

DB="${FAIRDROP_DB:-fairdrop-scratch}"
SERVER="${FAIRDROP_SERVER:-local}"

step "Checking tools"
node_major=$(node --version | sed 's/v\([0-9]*\).*/\1/')
if [ "$node_major" -lt 22 ]; then
  echo "  node $(node --version) is too old — vite 8 and --experimental-strip-types need 22+."
  exit 1
fi
ok "node $(node --version)"

if command -v spacetime >/dev/null 2>&1; then
  ok "spacetime $(spacetime --version 2>/dev/null | sed -n 's/.*tool version \([0-9.]*\).*/\1/p')"
else
  warn "spacetime CLI not found. Install it, then re-run:"
  echo "      curl -sSf https://install.spacetimedb.com | sh"
  echo "      (it lands in ~/.local/bin — this script already looks there)"
  exit 1
fi

# `clients/bots` has no runtime dependencies but does have vitest, so it is installed too —
# otherwise `npm test` in that package is the next thing to fail.
step "Installing dependencies"
for pkg in clients/sdk clients/web clients/bots fair-drop-db/spacetimedb; do
  npm --prefix "$pkg" ci --silent >/dev/null 2>&1 || npm --prefix "$pkg" install --silent >/dev/null 2>&1
  ok "$pkg"
done

step "Publishing the module to $SERVER/$DB"
if ! curl -sf -o /dev/null "http://127.0.0.1:3000/v1/ping" 2>/dev/null; then
  warn "nothing is listening on 127.0.0.1:3000."
  echo "      Start it in another terminal, then re-run this script:"
  echo "      spacetime start"
  exit 1
fi
ok "module host is up"

# --delete-data=on-conflict, not always: re-running setup must not silently destroy a database
# someone is mid-rehearsal on. It clears ONLY when the schema changed in a way that cannot be
# migrated in place — which is exactly the case that would otherwise leave the pages decoding
# rows the module no longer writes, and that failure looks like the module being down.
spacetime publish --server "$SERVER" --module-path fair-drop-db/spacetimedb \
  "$DB" --delete-data=on-conflict -y >/dev/null 2>&1
ok "published $DB"

LAN=$(ipconfig getifaddr en0 2>/dev/null || echo localhost)
cat <<NEXT

$(printf '\033[1mReady.\033[0m') Three terminals, in this order:

  1. $(printf '\033[36mspacetime start\033[0m')                        (already running)

  2. $(printf '\033[36mnpm --prefix clients/web run dev\033[0m')
       admin        http://$LAN:5173/admin.html
       participant  http://$LAN:5173/            (phones on the same wifi use this host)

     Create the event from the ADMIN PAGE, not the CLI — create_event records the caller as
     the admin, and a CLI-created event can never be locked or opened from the browser.

  3. $(printf '\033[36mcd clients/bots && node --experimental-strip-types src/turn.ts auto <eventId> %s\033[0m' "$DB")
       Start this BEFORE locking inventory; supply is sized from the headcount at lock.
       Queue mode (round 1) uses src/index.ts instead of src/turn.ts.

  Tests: npm --prefix fair-drop-db/spacetimedb test && npm --prefix clients/bots test \\
         && npm --prefix clients/web test
NEXT
