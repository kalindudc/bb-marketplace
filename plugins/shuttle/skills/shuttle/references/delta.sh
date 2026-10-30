#!/bin/sh
# A Shuttle command adapter for Delta (shop/world), through dt and jq. Point every command of a
# Delta server at this script; it reads SHUTTLE_OPERATION and prints the JSON Shuttle expects.
# team_requested needs SHUTTLE_DELTA_TEAMS: your team slugs, comma separated (Delta has no
# "my teams" search), for example `SHUTTLE_DELTA_TEAMS=edge-infrastructure sh delta.sh`.
# ready, close, reopen, edit_labels and edit_reviewers change the PR through dt pr. Delta has no
# way back to draft, so there is no draft operation.
# merge_options reads the merge gate; merge runs dt pr merge (squash or merge, never rebase, and no
# auto-merge: Delta has none). comment, review, reply and resolve write through dt pr and dt api.
# The lists search SHUTTLE_DELTA_REPO (default shop/world); every operation on one PR works on that
# PR's own repository, SHUTTLE_REPO.
set -eu
# Where sh has pipefail, a pipe fails with its first failing command; the dt calls below never rely on it.
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi
fail() { echo "delta.sh: $1" >&2; exit 2; }
REPO="${SHUTTLE_REPO:-${SHUTTLE_DELTA_REPO:-shop/world}}"
case "$REPO" in
  */*/* | /* | */ | . | .. | ./* | ../* | */. | */.. | *[!A-Za-z0-9._/-]*) fail "$REPO is not owner/name" ;;
  */*) ;;
  *) fail "$REPO is not owner/name" ;;
esac
HOST="https://delta.shopify.io"
# A compare lists every changed file, about 1KB each, where the PR view keeps 100; past 100 the
# files endpoint's first page, patches and all, is the smaller read.
COMPARE_FILES=100

# Runs dt and prints its answer. A failed dt fails the script with dt's own error and exit code:
# piped straight into jq, it would leave jq to print nothing and exit 0. What dt says on stderr is
# passed on either way, so an answer that is not JSON still comes with its reason.
dtq() {
  dterr=$(mktemp)
  if out=$(dt "$@" 2>"$dterr"); then code=0; else code=$?; fi
  cat "$dterr" >&2
  if [ "$code" -eq 0 ]; then
    rm -f "$dterr"
    printf '%s\n' "$out"
    return 0
  fi
  if grep -Eiq '(^|[^0-9])401([^0-9]|$)|unauthori[sz]ed|not (logged|signed) in' "$dterr"; then
    echo 'delta.sh: Delta did not accept your sign-in; run `dt auth login`, then sync again' >&2
  fi
  rm -f "$dterr"
  exit "$code"
}
get() { dtq api "$1" -X GET --host "$HOST" -R "$REPO"; }
# Waits for every background job named, then fails with the first failure's exit code. Stopping at
# the first failure would leave the others running, still holding the stderr Shuttle reads.
wait_all() {
  first=0
  for job in "$@"; do
    if wait "$job"; then :; else
      status=$?
      if [ "$first" -eq 0 ]; then first=$status; fi
    fi
  done
  return "$first"
}
pr() { dt pr "$@" --host "$HOST" -R "$REPO" >&2; }
# Every page of a list endpoint as one array, up to 1000 items.
all() {
  page=1
  acc='[]'
  while :; do
    chunk=$(get "$1?per_page=100&page=$page") || exit
    acc=$(printf '%s\n%s\n' "$acc" "$chunk" | jq -cs 'add')
    if [ "$(printf '%s' "$chunk" | jq 'length')" -lt 100 ] || [ "$page" -ge 10 ]; then break; fi
    page=$((page + 1))
  done
  printf '%s\n' "$acc"
}
# Runs `pr edit <number> <flag> <value>` once per line of $2, skipping blank lines.
each() {
  printf '%s\n' "$2" | while IFS= read -r value; do
    if [ -n "$value" ]; then pr edit "$SHUTTLE_NUMBER" "$1" "$value"; fi
  done
}

SUMMARY='{repo: $repo, number, title, author: (.user.login // ""),
  state: (if (.merged == true) or (.merged_at != null) or ((.pull_request.merged_at? // null) != null) then "merged"
          elif (.state | ascii_downcase) == "open" then (if .draft == true then "draft" else "open" end) else "closed" end),
  url: .html_url, head: .head.sha, head_ref: .head.ref, base: .base.ref, updated_at, created_at,
  closed_at: (if (.state | ascii_downcase) == "open" then null else (.merged_at // (.pull_request.merged_at? // null) // .closed_at) end),
  additions, deletions, files: .changed_files, teams: [(.requested_teams // [])[] | "@" + .slug],
  labels: [(.labels // [])[] | {name, color}]}'

# From [pull, reviews]: each reviewer's latest submitted review, then requested reviewers, then
# everyone else; a requested reviewer keeps the time and commit of their last review.
REVIEWERS='.[0] as $pr | ([.[1][] | select(.state != "PENDING")] | group_by(.user.login) | map(last)) as $latest
  | ($latest | map({key: .user.login, value: {at: .submitted_at, head: .commit_id}}) | from_entries) as $when
  | ([$pr.requested_reviewers[]? | {login, state: "requested", bot: (.type == "Bot")} + ($when[.login] // {at: null, head: null})]
    + [$pr.requested_teams[]? | {login: .slug, team: true, state: "requested"}]) as $req
  | $req + ([$latest[] | select(.user.login != $pr.user.login)
      | {login: .user.login, state: ({APPROVED: "approved", CHANGES_REQUESTED: "changes", DISMISSED: "dismissed"}[.state] // "commented"),
         at: .submitted_at, head: .commit_id, bot: (.user.type == "Bot")}]
    | map(select(.login as $l | $req | any(.login == $l and (.team // false) == false) | not)))'
MY_REVIEW='[.[1][] | select(.state != "PENDING") | select(.user.login == $me)] | last
  | if . == null then null else {state: ({APPROVED: "approved", CHANGES_REQUESTED: "changes", DISMISSED: "dismissed"}[.state] // "commented"),
      at: .submitted_at, head: .commit_id} end'
FAILED='IN("failure", "error", "timed_out", "cancelled", "action_required", "startup_failure")'
# From the merge gate's answer: every check and status on the head, by outcome.
CHECK_COUNTS='if (.status_check_rollup.contexts? | type) != "array" then null else
  [.status_check_rollup.contexts[] | if .status != "completed" then "pending"
    elif (.conclusion | IN("success", "neutral", "skipped")) then "passed"
    elif (.conclusion | '"$FAILED"') then "failed"
    else "pending" end]
  | {passed: map(select(. == "passed")) | length, failed: map(select(. == "failed")) | length,
     pending: map(select(. == "pending")) | length, total: length} end'
# From the PR, its reviews, review comments, issue comments and merge gate. A failed check's id is
# the check and the head it ran on, so the same failure on a new head is new again.
ACTIVITY='($pull[0].head.sha) as $head | ($gate[0] // null) as $g
  | {head: $head, items: (
    [$reviews[0][] | select(.state != "PENDING") | select(.state != "COMMENTED" or ((.body // "") != ""))
      | {id: "\(.node_id):\(.state)", kind: "review", author: .user.login, bot: (.user.type == "Bot"),
         state: (.state | ascii_downcase | gsub("_"; " ")), body, url: .html_url, at: .submitted_at}
        + (if $detail == "1" then {review: .id} else {} end)]
    + [$threads[0][]
      | {id: .node_id, kind: "thread", author: .user.login, bot: (.user.type == "Bot"), body, path, line, url: .html_url,
         at: .created_at, thread: .thread_id, resolved: (.resolved == true)}
        + (if $detail == "1" then {hunk: (if .in_reply_to_id == null then .diff_hunk else null end), review: .pull_request_review_id} else {} end)]
    + [$comments[0][] | {id: .node_id, kind: "comment", author: .user.login, bot: (.user.type == "Bot"), body, url: .html_url, at: .created_at}]
    + (if $g == null then [] else ($g.head // $head) as $on | [$g.status_check_rollup.contexts[]?
      | select(.status == "completed" and (.conclusion | '"$FAILED"'))
      | {id: (("\(.kind):\(.producer // ""):\(.name // "")" | .[0:240]) + ":\($on)"), kind: "check", author: null, bot: false,
         state: "failed", body: "\(.name // "check") failed", url: .details_url}] end))}'
# The merge gate's blockers in plain words.
BLOCKERS='[.blockers[]? | (.context // "" | sub("^[^:]*:"; "")) as $name
  | if .code == "stacked" then "it is part of a stack"
    elif .code == "conflict" then "it has conflicts with the base branch"
    elif .code == "merged" then "it is already merged"
    elif .code == "draft" then "it is a draft"
    elif (.code | test("failing$")) then "\($name) is failing"
    elif (.code | test("pending$")) then "\($name) has not finished"
    elif .message then .message
    else (.code | gsub("_"; " ")) + (if $name != "" then " (\($name))" else "" end) end]'
MERGE_OPTIONS='([.viewer.allowed_methods[]? | select(. == "squash" or . == "merge")] | if length == 0 then ["squash", "merge"] else . end) as $methods
  | [.blockers[]?.code] as $codes | ('"$BLOCKERS"') as $why
  | (if ($codes | index("conflict")) or .merge_state_status == "dirty" or .mergeable == false then "conflicts"
     elif .merge_state_status == "behind" then "behind"
     elif ($codes | length) == 0 then (if .viewer.can_merge == true or .merge_state_status == "clean" then "clean" else "unknown" end)
     elif ($codes | all(test("pending$"))) then "pending"
     else "blocked" end) as $state
  | {methods: $methods, default: $methods[0], delete_branch: false, can_auto: false, state: $state,
     detail: (if $state == "clean" then null elif ($why | length) == 0 then null
       else ($why | join("; ") | (.[0:1] | ascii_upcase) + .[1:]) + "." end)}'

# With SHUTTLE_DETAIL=1, what the PR view shows besides the conversation: every check on the head
# from the merge gate, the last 100 commits, the first 100 changed files (paths and counts only) and
# whether it can merge. A failed check's item is the id its check item has in the conversation.
# The commits and files come from one compare of the PR's base and head, whose files carry no
# patches; it lists every file at once, so a PR with more than COMPARE_FILES files reads the PR's
# own files endpoint instead, a page of 100 with their patches, and its commits on their own.
CHECK_RUN='{name: (.name // "check"), group: ((.producer // "") | sub("@.*$"; "") | if . == "" then null else . end),
  state: (if .status != "completed" then "running" elif (.conclusion | IN("success", "neutral")) then "passed"
          elif (.conclusion | IN("skipped", "stale")) then "skipped" elif (.conclusion | '"$FAILED"') then "failed" else "running" end),
  detail: (if .status != "completed" then ((.status // "") | gsub("_"; " ") | if . == "" then null else . end)
           elif (.conclusion | IN("success", "failure", "skipped")) then null else ((.conclusion // "") | gsub("_"; " ") | if . == "" then null else . end) end),
  url: .details_url, started_at: (.started_at // null), completed_at: (.completed_at // null),
  item: (if .status == "completed" and (.conclusion | '"$FAILED"') then (("\(.kind):\(.producer // ""):\(.name // "")" | .[0:240]) + ":\($on)") else null end)}'
DETAIL='($pull[0]) as $p | ($gate[0] // null) as $g
  | {checks: (if $g == null or (($g.status_check_rollup.contexts? | type) != "array") then null
      else ($g.head // $p.head.sha) as $on | [$g.status_check_rollup.contexts[] | '"$CHECK_RUN"'] | {total: length, items: .[0:100]} end),
     commits: (if $commits[0] == null then null else {total: ($p.commits // 0),
       items: ([($before[0] // [])[], $commits[0][]] | .[-100:] | map({sha, message: ((.commit.message // "") | split("\n")[0]),
         author: (.author.login // .commit.author.name // null), at: (.commit.committer.date // .commit.author.date // null)}))} end),
     files: (if $files[0] == null then null else {total: ($p.changed_files // ($files[0] | length)),
       items: [$files[0][0:100][] | {path: .filename, additions, deletions,
         change: ({added: "added", removed: "removed", modified: "modified", renamed: "renamed", copied: "copied"}[.status] // "changed")}]} end),
     merge: (if $g == null then null else ($g | '"$MERGE_OPTIONS"' | {state, detail}) end)}'

search() {
  q=$(printf 'repo:%s is:pr %s' "$REPO" "$1" | jq -sRr @uri)
  found=$(get "search/issues?q=$q&sort=updated&order=desc&per_page=100") || exit
  printf '%s\n' "$found" | jq --arg repo "$REPO" "{items: [.items[]? | $SUMMARY], complete: ((.total_count // 0) <= ((.items // []) | length))}"
}

case "${SHUTTLE_OPERATION:?}" in
  whoami)
    me=$(dtq auth status --host "$HOST" -R "$REPO" --json) || exit
    printf '%s\n' "$me" | jq '{login: .principal}' ;;
  authored)
    if [ "${SHUTTLE_STATE:-open}" = closed ]; then search "author:@me is:closed updated:>=${SHUTTLE_SINCE:?}"
    else search "author:@me is:open"; fi ;;
  review_requested) search "is:open review-requested:@me" ;;
  team_requested)
    teams=$(printf '%s' "${SHUTTLE_DELTA_TEAMS:?set SHUTTLE_DELTA_TEAMS to your team slugs}" | tr ',' ' ')
    found=$(for team in $teams; do search "is:open team-review-requested:$team" || exit; done) || exit
    printf '%s\n' "$found" | jq -s '{items: ([.[].items[]] | unique_by(.number)), complete: all(.[]; .complete)}' ;;
  reviewed) search "is:open reviewed-by:@me -author:@me" ;;
  view)
    n="${SHUTTLE_NUMBER:?}"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    get "repos/$REPO/pulls/$n" > "$tmp/pull" & pull=$!
    all "repos/$REPO/pulls/$n/reviews" > "$tmp/reviews" & reviews=$!
    dtq auth status --host "$HOST" -R "$REPO" --json > "$tmp/me" & me=$!
    get "repos/$REPO/pulls/$n/merge-readiness" > "$tmp/gate" 2>/dev/null & gate=$!
    failed=0
    wait_all "$pull" "$reviews" "$me" || failed=$?
    # The merge gate only adds check counts; without it the view still stands.
    wait "$gate" || : > "$tmp/gate"
    if [ "$failed" -ne 0 ]; then exit "$failed"; fi
    jq -n --arg repo "$REPO" --arg me "$(jq -r .principal "$tmp/me")" \
      --slurpfile pull "$tmp/pull" --slurpfile reviews "$tmp/reviews" --slurpfile gate "$tmp/gate" \
      "[\$pull[0], \$reviews[0]] as \$both | (\$pull[0] | $SUMMARY + {body: (.body // \"\")})
        + {reviewers: (\$both | $REVIEWERS), my_review: (\$both | $MY_REVIEW), check_counts: (\$gate[0] // null | $CHECK_COUNTS)}" ;;
  activity)
    n="${SHUTTLE_NUMBER:?}"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    get "repos/$REPO/pulls/$n" > "$tmp/pull" & pull=$!
    all "repos/$REPO/pulls/$n/reviews" > "$tmp/reviews" & reviews=$!
    all "repos/$REPO/pulls/$n/comments" > "$tmp/threads" & threads=$!
    all "repos/$REPO/issues/$n/comments" > "$tmp/comments" & comments=$!
    get "repos/$REPO/pulls/$n/merge-readiness" > "$tmp/gate" 2>/dev/null & gate=$!
    detail="${SHUTTLE_DETAIL:-0}"
    echo null > "$tmp/commits"
    echo null > "$tmp/before"
    echo null > "$tmp/files"
    failed=0
    wait_all "$pull" "$reviews" "$threads" "$comments" || failed=$?
    # Without the merge gate the reviews and comments still arrive; failed checks come with a later read.
    wait "$gate" || : > "$tmp/gate"
    if [ "$failed" -ne 0 ]; then exit "$failed"; fi
    if [ "$detail" = 1 ]; then
      # The PR view's extras never fail the conversation: a part that cannot be read is left out.
      count=$(jq '.commits // 0' "$tmp/pull")
      changed=$(jq '.changed_files // 0' "$tmp/pull")
      base=$(jq -r '.base.sha // empty' "$tmp/pull")
      head=$(jq -r '.head.sha // empty' "$tmp/pull")
      compared=0
      if [ "$changed" -le "$COMPARE_FILES" ] && [ -n "$base" ] && [ -n "$head" ]; then
        # Its first page holds every file and the first 100 commits, oldest first.
        if (get "repos/$REPO/compare/$base...$head?per_page=100") > "$tmp/compare"; then
          jq '.files' "$tmp/compare" > "$tmp/files"
          if [ "$count" -le 100 ]; then jq '.commits' "$tmp/compare" > "$tmp/commits"; fi
          compared=1
        fi
      fi
      if [ "$compared" = 0 ]; then get "repos/$REPO/pulls/$n/files?per_page=100" > "$tmp/files" & files=$!; fi
      if [ "$compared" = 0 ] || [ "$count" -gt 100 ]; then
        # The API lists commits oldest first, 100 a page; the last 100 can span the last two pages.
        last=$(( (count + 99) / 100 ))
        if [ "$last" -lt 1 ]; then last=1; fi
        (get "repos/$REPO/pulls/$n/commits?per_page=100&page=$last") > "$tmp/commits" || echo null > "$tmp/commits"
        if [ "$last" -gt 1 ] && [ $((count % 100)) -ne 0 ]; then
          (get "repos/$REPO/pulls/$n/commits?per_page=100&page=$((last - 1))") > "$tmp/before" || echo null > "$tmp/before"
        fi
      fi
      if [ "$compared" = 0 ]; then
        if wait "$files"; then :; else echo null > "$tmp/files"; fi
      fi
    fi
    jq -n --arg detail "$detail" --slurpfile pull "$tmp/pull" --slurpfile reviews "$tmp/reviews" --slurpfile threads "$tmp/threads" \
      --slurpfile comments "$tmp/comments" --slurpfile gate "$tmp/gate" \
      --slurpfile commits "$tmp/commits" --slurpfile before "$tmp/before" --slurpfile files "$tmp/files" \
      "$ACTIVITY + (if \$detail == \"1\" then ($DETAIL) else {} end)" ;;
  merge_options)
    gate=$(get "repos/$REPO/pulls/${SHUTTLE_NUMBER:?}/merge-readiness") || exit
    printf '%s\n' "$gate" | jq "$MERGE_OPTIONS" ;;
  merge)
    : "${SHUTTLE_NUMBER:?}" "${SHUTTLE_HEAD:?}"
    if [ "${SHUTTLE_AUTO:-0}" = 1 ]; then fail "Delta has no auto-merge"; fi
    if [ "${SHUTTLE_DELETE_BRANCH:-0}" = 1 ]; then fail "dt pr merge cannot delete the branch; merge without deleting it"; fi
    # dt pr merge takes no commit title, so SHUTTLE_SUBJECT has nowhere to go.
    case "${SHUTTLE_METHOD:?}" in
      squash) pr merge "$SHUTTLE_NUMBER" --squash --sha "$SHUTTLE_HEAD" ;;
      merge) pr merge "$SHUTTLE_NUMBER" --sha "$SHUTTLE_HEAD" ;;
      *) fail "Delta merges with squash or merge, not $SHUTTLE_METHOD" ;;
    esac ;;
  comment) pr comment "${SHUTTLE_NUMBER:?}" --body="${SHUTTLE_BODY:?}" ;;
  review)
    n="${SHUTTLE_NUMBER:?}"
    comments="${SHUTTLE_COMMENTS:-[]}"
    count=$(printf '%s' "$comments" | jq 'length')
    case "${SHUTTLE_VERDICT:?}" in
      approve) event=APPROVE ;;
      changes) event=REQUEST_CHANGES ;;
      comment) event=COMMENT ;;
      *) fail "no verdict $SHUTTLE_VERDICT" ;;
    esac
    if [ "$event" = COMMENT ] && [ "$count" -eq 0 ] && [ -z "${SHUTTLE_BODY:-}" ]; then fail "a comment review needs a body or at least one comment"; fi
    err=$(mktemp)
    trap 'rm -f "$err"' EXIT
    # Every review goes through the reviews API so it lands on SHUTTLE_HEAD; dt pr review has no --sha.
    # The comments ride in the review's comments[], the way dt pr review --file-comment batches them.
    post() {
      jq -n --arg body "$2" --arg event "$event" --arg head "${SHUTTLE_HEAD:-}" --argjson comments "$1" \
        '{event: $event} + (if $body == "" then {} else {body: $body} end) + (if $head == "" then {} else {commit_id: $head} end)
         + (if ($comments | length) == 0 then {} else {comments: [$comments[] | if .line == null then {path, body, subject_type: "file"} else {path, line, side: "RIGHT", body} end]} end)' \
        | dt api "repos/$REPO/pulls/$n/reviews" -X POST --input - --host "$HOST" -R "$REPO" > /dev/null 2> "$err"
    }
    if post "$comments" "${SHUTTLE_BODY:-}"; then
      printf '{"placed": %s, "in_body": 0}\n' "$count"
    # Only a 422 about where a comment goes is posted again; one that names the commit means the head moved on.
    elif [ "$count" -gt 0 ] && grep -Eq '(^|[^0-9])422([^0-9]|$)' "$err" \
        && grep -Eiqw 'line|start_line|path|position|side|start_side|subject_type|diff|diff_hunk' "$err" \
        && ! grep -Eiqw 'commit|commit_id|sha|head' "$err"; then
      body=$(jq -rn --arg body "${SHUTTLE_BODY:-}" --argjson comments "$comments" \
        '[($body | select(. != "")), ($comments | map("- `\(.path)\(if .line == null then "" else ":\(.line)" end)` \(.body | gsub("\n"; "\n  "))") | join("\n"))] | join("\n\n")')
      if post '[]' "$body"; then printf '{"placed": 0, "in_body": %s}\n' "$count"
      else cat "$err" >&2; exit 1; fi
    else
      cat "$err" >&2
      exit 1
    fi ;;
  reply)
    n="${SHUTTLE_NUMBER:?}"
    # dt pr comment --reply-to takes a comment id; Shuttle names the thread, so reply to its first comment.
    threads=$(all "repos/$REPO/pulls/$n/comments") || exit
    root=$(printf '%s\n' "$threads" | jq -r --arg thread "${SHUTTLE_THREAD:?}" \
      '[.[] | select(.thread_id == $thread)] | ((map(select(.in_reply_to_id == null)) + .) | first | .id // empty)')
    if [ -z "$root" ]; then fail "no review comment in thread $SHUTTLE_THREAD"; fi
    pr comment "$n" --reply-to "$root" --body="${SHUTTLE_BODY:?}" ;;
  resolve)
    if [ "${SHUTTLE_RESOLVED:?}" = 1 ]; then pr resolve "${SHUTTLE_NUMBER:?}" "${SHUTTLE_THREAD:?}"
    else pr unresolve "${SHUTTLE_NUMBER:?}" "${SHUTTLE_THREAD:?}"; fi ;;
  ready) pr ready "${SHUTTLE_NUMBER:?}" ;;
  close) pr close "${SHUTTLE_NUMBER:?}" ;;
  reopen) pr reopen "${SHUTTLE_NUMBER:?}" ;;
  edit_labels)
    : "${SHUTTLE_NUMBER:?}"
    each --add-label "${SHUTTLE_ADD:-}"
    each --remove-label "${SHUTTLE_REMOVE:-}" ;;
  edit_reviewers)
    : "${SHUTTLE_NUMBER:?}"
    each --add-reviewer "${SHUTTLE_ADD:-}"
    each --remove-reviewer "${SHUTTLE_REMOVE:-}"
    each --add-team-reviewer "${SHUTTLE_ADD_TEAMS:-}"
    if [ -n "${SHUTTLE_REMOVE_TEAMS:-}" ]; then
      # Withdrawing a team request takes its numeric id, not its slug.
      pull=$(get "repos/$REPO/pulls/$SHUTTLE_NUMBER") || exit
      ids=$(printf '%s\n' "$pull" | jq -r --arg slugs "$SHUTTLE_REMOVE_TEAMS" \
        '($slugs | split("\n")) as $s | [.requested_teams[]? | select(.slug as $x | $s | index($x)) | .id | tostring] | join("\n")')
      each --remove-team-reviewer "$ids"
    fi ;;
  *) echo "delta.sh: no $SHUTTLE_OPERATION here" >&2; exit 2 ;;
esac
