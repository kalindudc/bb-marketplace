#!/usr/bin/env bash
# End-to-end check for the Press composer: run a real pi session that compacts, then
# assert the summary it produced keeps the constraint verbatim and carries a resume block.
#
#   tools/press-e2e/verify-composer.sh [--model z-ai/glm-5.3-flash] [--keep]
#
# Needs pi on PATH with working provider credentials. Costs one small model call.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSER="$REPO_ROOT/plugins/press/composer/index.ts"
MODEL="z-ai/glm-5.3-flash"
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -f "$COMPOSER" ]] || { echo "composer not found at $COMPOSER" >&2; exit 1; }
command -v pi >/dev/null || { echo "pi is not on PATH" >&2; exit 1; }

CONSTRAINT="Never commit unless I ask."
WORK="$(mktemp -d -t press-e2e-XXXXXX)"
PROJECT="$WORK/project"
SESSIONS="$WORK/sessions"
mkdir -p "$PROJECT/.pi" "$PROJECT/.bb/press" "$SESSIONS"

cleanup() {
  if [[ "$KEEP" -eq 1 ]]; then
    echo "kept: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# A file big enough that reading it crosses the compaction threshold below.
python3 - "$PROJECT/big.ts" <<'PY'
import sys
lines = [f'export function handler{i}(input: string): string {{ return input.trim() + "-{i}"; }}' for i in range(1200)]
open(sys.argv[1], "w").write("\n".join(lines) + "\n")
PY

# reserveTokens just under the window makes the first turn cross the threshold, so the
# run compacts without waiting for a long session.
cat > "$PROJECT/.pi/settings.json" <<'JSON'
{
  "compaction": { "enabled": true, "reserveTokens": 1040000, "keepRecentTokens": 2000 }
}
JSON

cat > "$PROJECT/.bb/press/policy.json" <<JSON
{
  "composer": { "model": "$MODEL", "maxSummaryTokens": 3000, "ledger": true, "resumeContract": true }
}
JSON

echo "running pi in $PROJECT with $MODEL"
( cd "$PROJECT" && pi -p -a \
    --no-extensions --no-skills --no-context-files --no-mcp \
    -e "$COMPOSER" \
    --model "$MODEL" --thinking low \
    --session-dir "$SESSIONS" \
    "Read big.ts fully. $CONSTRAINT Then tell me the line count." >"$WORK/pi.out" 2>&1 ) || {
      echo "FAIL: pi exited non-zero"; sed -n '1,40p' "$WORK/pi.out"; exit 1;
    }

failures=0
check() {
  local label="$1" ok="$2"
  if [[ "$ok" == "1" ]]; then
    echo "PASS  $label"
  else
    echo "FAIL  $label"
    failures=$((failures + 1))
  fi
}

compaction_count=$(grep -c '"type":"compaction"' "$SESSIONS"/*.jsonl 2>/dev/null || true)
compaction_count=${compaction_count:-0}
check "a compaction happened" "$([[ "$compaction_count" -gt 0 ]] && echo 1 || echo 0)"

summary=$(python3 - "$SESSIONS" <<'PY'
import glob, json, sys
for path in sorted(glob.glob(sys.argv[1] + "/*.jsonl")):
    for line in open(path):
        try:
            row = json.loads(line)
        except Exception:
            continue
        if row.get("type") == "compaction":
            print(row.get("summary", ""))
            raise SystemExit
PY
)

check "summary has the Press header" "$(grep -qF '# Pressed context' <<<"$summary" && echo 1 || echo 0)"
check "summary keeps the constraint verbatim" "$(grep -qF "$CONSTRAINT" <<<"$summary" && echo 1 || echo 0)"
check "summary has a resume block" "$(grep -qF '## Resume' <<<"$summary" && echo 1 || echo 0)"
check "resume names a verification step" "$(grep -qE '^verify: ' <<<"$summary" && echo 1 || echo 0)"
check "ledger was written" "$([[ -f "$PROJECT/.bb/press/ledger.json" ]] && echo 1 || echo 0)"
check "ledger records the constraint" "$(grep -qF "$CONSTRAINT" "$PROJECT/.bb/press/ledger.json" 2>/dev/null && echo 1 || echo 0)"
check "the composer, not the fallback, wrote it" \
  "$(grep -qF '"fromExtension":true' "$PROJECT/.bb/press/composer.log" 2>/dev/null && echo 1 || echo 0)"
check "the full summary is kept for a UI to show" \
  "$(ls "$PROJECT"/.bb/press/summaries/*.md >/dev/null 2>&1 && echo 1 || echo 0)"
check "the ledger row points at that summary" \
  "$(grep -qF '"summaryPath"' "$PROJECT/.bb/press/ledger.json" 2>/dev/null && echo 1 || echo 0)"

if [[ "$failures" -eq 0 ]]; then
  echo
  echo "all checks passed"
  if [[ "${PRESS_E2E_VERBOSE:-0}" == "1" ]]; then
    echo "--- summary ---"
    echo "$summary"
    echo "--- composer log ---"
    cat "$PROJECT/.bb/press/composer.log"
  fi
  exit 0
fi

echo
echo "$failures check(s) failed"
[[ "$KEEP" -eq 0 ]] && KEEP=1 && echo "keeping $WORK for inspection"
exit 1
