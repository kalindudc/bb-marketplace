#!/bin/bash
set -euo pipefail
: "${FORAGE_SANDBOX_PROFILE:?Supply the fixtures-only OS egress sandbox profile}"
: "${FORAGE_EVIDENCE_DIR:?Supply a fresh evidence directory}"
[[ -f "$FORAGE_SANDBOX_PROFILE" && ! -e "$FORAGE_EVIDENCE_DIR" ]] || { echo "Need a profile and a fresh evidence directory" >&2; exit 64; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$FORAGE_EVIDENCE_DIR"
cd "$ROOT"
/usr/bin/sandbox-exec -f "$FORAGE_SANDBOX_PROFILE" /usr/bin/env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" CI=1 /bin/bash -c '
 set -euo pipefail
 npm test -- --reporter=default --reporter=json --outputFile.json="$1/tests.json"
 npm run typecheck
 npm run build
' fixture-check "$FORAGE_EVIDENCE_DIR" 2>&1 | tee "$FORAGE_EVIDENCE_DIR/check.log"
