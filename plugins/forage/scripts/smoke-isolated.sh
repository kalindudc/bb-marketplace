#!/bin/bash
set -euo pipefail
[[ "${FORAGE_SMOKE_ACK:-}" == isolated-candidate-only ]] || { echo "Set FORAGE_SMOKE_ACK=isolated-candidate-only explicitly." >&2; exit 64; }
: "${RUN_DIR:?Supply an already-initialized fresh corrected harness run}"
: "${FORAGE_PROJECT_ID:?Supply its zero-turn project ID}"
: "${FORAGE_THREAD_ID:?Supply its zero-turn thread ID}"
: "${FORAGE_ZERO_TURN_EVIDENCE:?Supply current zero-turn evidence JSON}"
[[ -f "$RUN_DIR/config/run-dir" && -x "$RUN_DIR/launchers/isolated-bb.sh" ]] || { echo "Corrected harness is missing" >&2; exit 65; }
[[ "$( < "$RUN_DIR/config/run-dir" )" == "$RUN_DIR" ]] || { echo "Harness identity mismatch" >&2; exit 66; }
node --input-type=module - "$FORAGE_ZERO_TURN_EVIDENCE" "$FORAGE_PROJECT_ID" "$FORAGE_THREAD_ID" <<'JS'
import { readFileSync } from "node:fs";
const [file, projectId, threadId] = process.argv.slice(2);
const proof = JSON.parse(readFileSync(file, "utf8"));
if (proof.projectId !== projectId || proof.threadId !== threadId || proof.modelTurns !== 0 || proof.activeAgents !== 0 || proof.queuedMessages !== 0) throw new Error("Zero-turn evidence mismatch");
JS
OUT="$RUN_DIR/evidence/forage-smoke-$(date -u +%Y%m%dT%H%M%SZ)-$$"
[[ ! -e "$OUT" ]] || { echo "Refusing evidence overwrite" >&2; exit 67; }
mkdir -p "$OUT"
BB="$RUN_DIR/launchers/isolated-bb.sh"
"$BB" check forage status > "$OUT/status.json"
"$BB" check forage doctor > "$OUT/doctor.json"
"$BB" check forage bench > "$OUT/bench.json"
"$BB" check forage sources list --project "$FORAGE_PROJECT_ID" --thread "$FORAGE_THREAD_ID" --input '{"limit":10}' > "$OUT/sources.json"
"$BB" check forage crawl list --project "$FORAGE_PROJECT_ID" --thread "$FORAGE_THREAD_ID" > "$OUT/jobs.json"
"$BB" check forage diagnostics > "$OUT/diagnostics.json"
printf '%s\n' "$OUT"
