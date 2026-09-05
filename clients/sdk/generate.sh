#!/usr/bin/env bash
#
# Regenerates clients/sdk/generated/ from the published module and patches the relative
# imports to carry explicit `.ts` extensions.
#
# WHY THE PATCH STEP: `spacetime generate --lang typescript` emits extensionless relative
# specifiers (`from "./event_table"`), which is fine for a bundler but unresolvable by
# `node --experimental-strip-types` — the same runtime `clients/bots/src/index.ts` is
# documented to use, and the same reason `fair-drop-db/spacetimedb/src/index.ts` already
# carries explicit `.ts` extensions on every intra-`src/` import (see that file's header).
# Without this, importing `FairDropClient.ts` from a strip-types entry point throws
# ERR_MODULE_NOT_FOUND on the very first generated re-export.
#
# Re-run this after any schema/reducer/procedure change (CONTRACT.md §1: "generated bindings
# ... do not hand-write table/reducer types on the client, or the two sides will drift
# silently"). Never hand-edit files under generated/ directly — this script is the only thing
# that touches them after codegen.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."   # clients/

rm -rf sdk/generated
spacetime generate \
  --module-path ../fair-drop-db/spacetimedb \
  --lang typescript \
  --out-dir sdk/generated \
  -y

# Add `.ts` to every relative import/export specifier that doesn't already have an extension.
# Matches `from "./foo"` / `from "../foo"`, not `from "spacetimedb"` (no leading `.`).
find sdk/generated -name '*.ts' -print0 | xargs -0 sed -i '' \
  -E 's#(from "\.\.?/[^"]+)(")#\1.ts\2#'

echo "Regenerated + patched sdk/generated/ for node --experimental-strip-types compatibility."
