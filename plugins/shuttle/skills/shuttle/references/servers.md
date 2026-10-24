# Shuttle servers

## A command server

```toml
[[server]]
id = "delta"                     # lowercase, the first part of every key: delta:shop/world#2261179
name = "Delta"
kind = "command"
pattern = '^https://delta\.shopify\.io/(?<repo>[^/]+/[^/]+)/pull/(?<number>\d+)'
link = "https://delta.shopify.io/{repo}/pull/{number}"
sep = "#"                        # or "!" for GitLab-style group/project!77
read = "dt pr view {number} -R {repo} --comments"   # how an agent reads the PR; shown in prompts

[server.commands]
whoami = "sh ~/.config/shuttle/delta.sh"
authored = "sh ~/.config/shuttle/delta.sh"
review_requested = "sh ~/.config/shuttle/delta.sh"
view = "sh ~/.config/shuttle/delta.sh"
activity = "sh ~/.config/shuttle/delta.sh"
team_requested = "SHUTTLE_DELTA_TEAMS=edge-infrastructure sh ~/.config/shuttle/delta.sh"
# mentioned left out: Delta refuses the mentions: qualifier
```

`delta.sh` next to this file is a working adapter for Delta through `dt` and `jq`; copy it to
`~/.config/shuttle/delta.sh`. `view` is required; every other operation is optional.

## How commands run

Each command runs with `/bin/sh -c` in bb's server process, with the user's environment plus
the usual tool directories on `PATH`, and a 60-second limit. It gets:

| Variable | When |
|---|---|
| `SHUTTLE_OPERATION` | always: whoami, authored, review_requested, team_requested, mentioned, view or activity |
| `SHUTTLE_SERVER` | always: the server id |
| `SHUTTLE_STATE` | authored: `open`, or `closed` for merged and closed PRs |
| `SHUTTLE_SINCE` | authored with `closed`: YYYY-MM-DD, the start of the Done window |
| `SHUTTLE_REPO`, `SHUTTLE_NUMBER`, `SHUTTLE_URL` | view and activity |

A command must exit 0 and print one JSON document. A non-zero exit, output that is not JSON or
JSON in the wrong shape fails that operation, with the reason on the Servers page; the other
operations still run, and the server's PRs keep their last good data.

## What each command prints

`whoami`: `{"login": "<the user on this server>"}`, or the login alone on one line. Shuttle
uses it to tell your PRs and your own comments apart.

`authored`, `review_requested`, `team_requested`, `mentioned`: an array of PR summaries, or
`{"items": [...], "complete": false}` when the server cut the list short. Shuttle never drops a
PR from a list it knows is incomplete, so an old request cannot come back looking new.
`view`: one PR summary.

```json
{"repo": "shop/world", "number": 2269437, "title": "Upgrade Envoy", "author": "sam.lee",
 "state": "open", "draft": false, "url": "https://…", "head": "9f3c2a1…", "head_ref": "sam/envoy",
 "base": "main", "updated_at": "2026-10-23T14:58:00Z", "checks": "passed", "review": "required",
 "additions": 1204, "deletions": 388, "files": 23, "teams": ["@shop/edge-routing"]}
```

`view` may add `"body"`, the description in Markdown; the PR's drawer shows it.
`state` is `open`, `draft`, `merged` or `closed`. `checks` is `passed`, `failed`, `pending` or
`none`; `review` is `approved`, `changes`, `required` or `none`. Only `repo`, `number`, `title`
and `state` are required.

`activity`: the review activity of one PR.

```json
{"head": "a41f7c3…", "items": [
  {"id": "r7:CHANGES_REQUESTED", "kind": "review", "author": "ana", "bot": false,
   "state": "changes requested", "body": "Split it.", "url": "https://…"},
  {"id": "c12", "kind": "thread", "author": "tom", "body": "Reuse the buffer.", "path": "src/cpu.rs", "line": 42}
]}
```

`kind` is `review`, `thread` (an unresolved review comment), `comment` or `check` (a failed
check). An `id` must stay the same while the item does not change and change when it does (a
new reply, a check run again): Shuttle sends each id to a thread once. When a PR is first
watched, every item already there counts as seen.

## GitHub

`kind = "github"` needs no commands: Shuttle uses `gh api graphql`. Requested of me is
`user-review-requested:@me`, My teams is `review-requested:@me -user-review-requested:@me`, and
each list shows the 50 most recently updated PRs.
