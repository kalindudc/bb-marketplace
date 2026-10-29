#!/bin/bash
set -euo pipefail
[[ "${FORAGE_KEYLESS_ACK:-}" == one-bounded-keyless-attempt ]] || { echo "Set FORAGE_KEYLESS_ACK=one-bounded-keyless-attempt explicitly." >&2; exit 64; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/smoke-isolated.sh"
BB="$RUN_DIR/launchers/isolated-bb.sh"
STAMP="$RUN_DIR/evidence/forage-keyless-$(date -u +%Y%m%dT%H%M%SZ)-$$"
[[ ! -e "$STAMP" ]] || exit 65
mkdir -p "$STAMP"
"$BB" check forage doctor --live > "$STAMP/doctor-live.json"
"$BB" mutate forage fetch --project "$FORAGE_PROJECT_ID" --thread "$FORAGE_THREAD_ID" --input '{"url":"https://example.org/","resolve":"direct","reader":"direct","maxChars":2000}' > "$STAMP/public-fetch.txt"
"$BB" check forage diagnostics > "$STAMP/diagnostics.json"
printf '%s\n' "$STAMP"
