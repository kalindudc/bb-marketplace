#!/bin/sh
# A Shuttle command adapter for Delta (shop/world), through dt and jq. Point every command of a
# Delta server at this script; it reads SHUTTLE_OPERATION and prints the JSON Shuttle expects.
# team_requested needs SHUTTLE_DELTA_TEAMS: your team slugs, comma separated (Delta has no
# "my teams" search), for example `SHUTTLE_DELTA_TEAMS=edge-infrastructure sh delta.sh`.
# ready, close, reopen, edit_labels and edit_reviewers change the PR through dt pr. Delta has no
# way back to draft, so there is no draft operation.
set -eu
REPO="${SHUTTLE_DELTA_REPO:-shop/world}"
HOST="https://delta.shopify.io"

get() { dt api "$1" -X GET --host "$HOST" -R "$REPO"; }
pr() { dt pr "$@" --host "$HOST" -R "$REPO" >&2; }
# Runs `pr edit <number> <flag> <value>` once per line of $2, skipping blank lines.
each() {
  printf '%s\n' "$2" | while IFS= read -r value; do
    if [ -n "$value" ]; then pr edit "$SHUTTLE_NUMBER" "$1" "$value"; fi
  done
}

SUMMARY='{repo: $repo, number, title, author: (.user.login // ""),
  state: (if (.merged == true) or (.merged_at != null) or ((.pull_request.merged_at? // null) != null) then "merged"
          elif (.state | ascii_downcase) == "open" then (if .draft == true then "draft" else "open" end) else "closed" end),
  url: .html_url, head: .head.sha, head_ref: .head.ref, base: .base.ref, updated_at,
  additions, deletions, files: .changed_files, teams: [(.requested_teams // [])[] | "@" + .slug],
  labels: [(.labels // [])[] | {name, color}]}'

# Requested reviewers, then the latest review of everyone else, from [pull, reviews].
REVIEWERS='.[0] as $pr | ([$pr.requested_reviewers[]? | {login, state: "requested"}]
    + [$pr.requested_teams[]? | {login: .slug, team: true, state: "requested"}]) as $req
  | $req + ([.[1][] | select(.state != "PENDING") | select(.user.login != $pr.user.login)
      | {login: .user.login, state: ({APPROVED: "approved", CHANGES_REQUESTED: "changes", DISMISSED: "dismissed"}[.state] // "commented")}]
    | group_by(.login) | map(last) | map(select(.login as $l | $req | any(.login == $l and (.team // false) == false) | not)))'

search() {
  q=$(printf 'repo:%s is:pr %s' "$REPO" "$1" | jq -sRr @uri)
  get "search/issues?q=$q&sort=updated&order=desc&per_page=100" \
    | jq --arg repo "$REPO" "{items: [.items[]? | $SUMMARY], complete: ((.total_count // 0) <= ((.items // []) | length))}"
}

case "${SHUTTLE_OPERATION:?}" in
  whoami) dt auth status --host "$HOST" -R "$REPO" --json | jq '{login: .principal}' ;;
  authored)
    if [ "${SHUTTLE_STATE:-open}" = closed ]; then search "author:@me is:closed updated:>=${SHUTTLE_SINCE:?}"
    else search "author:@me is:open"; fi ;;
  review_requested) search "is:open review-requested:@me" ;;
  team_requested)
    for team in $(printf '%s' "${SHUTTLE_DELTA_TEAMS:?set SHUTTLE_DELTA_TEAMS to your team slugs}" | tr ',' ' '); do
      search "is:open team-review-requested:$team"
    done | jq -s '{items: ([.[].items[]] | unique_by(.number)), complete: all(.[]; .complete)}' ;;
  view)
    n="${SHUTTLE_NUMBER:?}"
    { get "repos/$REPO/pulls/$n"; get "repos/$REPO/pulls/$n/reviews?per_page=100"; } \
      | jq -s --arg repo "$REPO" "(.[0] | $SUMMARY + {body: (.body // \"\")}) + {reviewers: ($REVIEWERS)}" ;;
  activity)
    n="${SHUTTLE_NUMBER:?}"
    {
      get "repos/$REPO/pulls/$n" | jq '{head: .head.sha}'
      get "repos/$REPO/pulls/$n/reviews" | jq '[.[] | select(.state != "PENDING") | select(.state != "COMMENTED" or ((.body // "") != ""))
        | {id: "\(.node_id):\(.state)", kind: "review", author: .user.login, bot: (.user.type == "Bot"),
           state: (.state | ascii_downcase | gsub("_"; " ")), body, url: .html_url}]'
      get "repos/$REPO/pulls/$n/comments" | jq '[.[] | select(.resolved != true)
        | {id: .node_id, kind: "thread", author: .user.login, bot: (.user.type == "Bot"), body, path, line, url: .html_url}]'
      get "repos/$REPO/issues/$n/comments" | jq '[.[] | {id: .node_id, kind: "comment", author: .user.login, bot: (.user.type == "Bot"), body, url: .html_url}]'
    } | jq -s '{head: .[0].head, items: (.[1] + .[2] + .[3])}' ;;
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
      ids=$(get "repos/$REPO/pulls/$SHUTTLE_NUMBER" | jq -r --arg slugs "$SHUTTLE_REMOVE_TEAMS" \
        '($slugs | split("\n")) as $s | [.requested_teams[]? | select(.slug as $x | $s | index($x)) | .id | tostring] | join("\n")')
      each --remove-team-reviewer "$ids"
    fi ;;
  *) echo "delta.sh: no $SHUTTLE_OPERATION here" >&2; exit 2 ;;
esac
