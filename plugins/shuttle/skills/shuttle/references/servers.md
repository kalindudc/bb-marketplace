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
reviewed = "sh ~/.config/shuttle/delta.sh"
# mentioned left out: Delta refuses the mentions: qualifier
# Managing your own PRs from Shuttle; draft is left out because Delta can't go back to draft.
ready = "sh ~/.config/shuttle/delta.sh"
close = "sh ~/.config/shuttle/delta.sh"
reopen = "sh ~/.config/shuttle/delta.sh"
edit_labels = "sh ~/.config/shuttle/delta.sh"
edit_reviewers = "sh ~/.config/shuttle/delta.sh"
# Merging, and writing on the PR's conversation.
merge_options = "sh ~/.config/shuttle/delta.sh"
merge = "sh ~/.config/shuttle/delta.sh"
comment = "sh ~/.config/shuttle/delta.sh"
review = "sh ~/.config/shuttle/delta.sh"
reply = "sh ~/.config/shuttle/delta.sh"
resolve = "sh ~/.config/shuttle/delta.sh"
```

`delta.sh` next to this file is a working adapter for Delta through `dt` and `jq`; copy it to
`~/.config/shuttle/delta.sh`. `view` is required; every other operation is optional.

## How commands run

Each command runs with `/bin/sh -c` in bb's server process, with the user's environment plus
the usual tool directories on `PATH`, and a 60-second limit. It gets:

| Variable | When |
|---|---|
| `SHUTTLE_OPERATION` | always: the operation's name, such as authored or edit_labels |
| `SHUTTLE_SERVER` | always: the server id |
| `SHUTTLE_STATE` | authored: `open`, or `closed` for merged and closed PRs |
| `SHUTTLE_SINCE` | authored with `closed`: YYYY-MM-DD, the start of the Done window |
| `SHUTTLE_REPO`, `SHUTTLE_NUMBER`, `SHUTTLE_URL` | view, activity and every operation below that reads or changes one PR |
| `SHUTTLE_ADD`, `SHUTTLE_REMOVE` | edit_labels: label names; edit_reviewers: user logins; one per line |
| `SHUTTLE_ADD_TEAMS`, `SHUTTLE_REMOVE_TEAMS` | edit_reviewers: team slugs, one per line |
| `SHUTTLE_METHOD` | merge: `squash`, `merge` or `rebase` |
| `SHUTTLE_HEAD` | merge: the head commit the PR must still be at; review: the commit the comments' lines refer to, empty for the current head |
| `SHUTTLE_AUTO`, `SHUTTLE_DELETE_BRANCH` | merge: `1` or `0`, turn on auto-merge instead of merging now, and delete the branch after the merge |
| `SHUTTLE_SUBJECT` | merge: the squash or merge commit's title, empty for the server's own |
| `SHUTTLE_BODY` | comment, review and reply: the text, in Markdown; it may be empty for an approving review |
| `SHUTTLE_VERDICT` | review: `comment`, `approve` or `changes` |
| `SHUTTLE_COMMENTS` | review: a JSON array of `{"path", "line", "body"}`, where `line` is a line of the new file, or `null` for a comment on the whole file |
| `SHUTTLE_THREAD` | reply and resolve: an activity item's `thread` |
| `SHUTTLE_RESOLVED` | resolve: `1` to resolve the thread, `0` to reopen it |

A command must exit 0 and print one JSON document. A non-zero exit, output that is not JSON or
JSON in the wrong shape fails that operation, with the reason on the Servers page; the other
operations still run, and the server's PRs keep their last good data.

## What each command prints

`whoami`: `{"login": "<the user on this server>"}`, or the login alone on one line. Shuttle
uses it to tell your PRs and your own comments apart.

`authored`, `review_requested`, `team_requested`, `mentioned`, `reviewed`: an array of PR
summaries, or `{"items": [...], "complete": false}` when the server cut the list short.
`reviewed` lists open PRs of other people that you have reviewed, whether or not you are still
asked. Shuttle never drops a
PR from a list it knows is incomplete, so an old request cannot come back looking new.
`view`: one PR summary.

```json
{"repo": "shop/world", "number": 2269437, "title": "Upgrade Envoy", "author": "sam.lee",
 "state": "open", "draft": false, "url": "https://…", "head": "9f3c2a1…", "head_ref": "sam/envoy",
 "base": "main", "updated_at": "2026-10-23T14:58:00Z", "checks": "passed", "review": "required",
 "additions": 1204, "deletions": 388, "files": 23, "teams": ["@shop/edge-routing"]}
```

`view` may add `"body"`, the description in Markdown; the PR's drawer shows it. Any summary
may add `"labels"`, as names or `{"name", "color", "description"}` with a hex colour. `view` may
add `"reviewers"`: `[{"login": "ana", "team": false, "state": "requested"}]`, where `state` is
`requested`, `approved`, `changes`, `commented` or `dismissed`. List requested reviewers first,
then the latest review of everyone else. Leave a field out when the server's answer has no such
data; Shuttle then keeps what it read before.

Any summary may also add these, and Shuttle uses whichever it gets:

| Field | What it is |
|---|---|
| `created_at` | When the PR was opened |
| `closed_at` | When it merged or closed; `null` while it is open |
| `check_counts` | `{"passed", "failed", "pending", "total"}`: the head's checks by outcome |
| `my_review` | Your own latest review: `{"state", "at", "head"}`, where `state` is `approved`, `changes`, `commented` or `dismissed` and `head` is the commit it reviewed. Keep it when you are asked again since |
| `auto_merge` | `true` when the PR will merge by itself once its checks pass |
| `author_bot` | `true` when a bot opened it |
| `requested_at` | When you or your team were last asked to review it |
| `first_review_at` | When someone other than the author, and not a bot, first reviewed it |

A reviewer may add `"at"` and `"head"`: when their latest review was submitted, and on which
commit. Times are ISO 8601 strings or milliseconds since the epoch.
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

`kind` is `review`, `thread` (a review comment on a line or file), `comment` or `check` (a
failed check). An `id` must stay the same while the item does not change and change when it does
(a new reply, a check run again): Shuttle sends each id to a thread once. When a PR is first
watched, every item already there counts as seen.

Each item may add `"at"`, when it was written or submitted. A `thread` item may add `"thread"`,
the review thread's identifier as the `reply` and `resolve` commands take it, and
`"resolved": true` when that thread is resolved; Shuttle never sends a resolved thread to a
watching thread.

## Managing your own PRs

These optional operations let you change your own PRs from Shuttle's PR panel. Each one runs
once per change and only has to exit 0; its output is ignored, apart from the error text when
it fails. Shuttle offers a change only when the server has its command, and only on PRs whose
author is you.

| Operation | What it does |
|---|---|
| `ready` | Marks a draft ready for review |
| `draft` | Turns an open PR back into a draft |
| `close`, `reopen` | Closes the PR without merging it, or reopens it |
| `edit_labels` | Adds the labels in `SHUTTLE_ADD` and removes those in `SHUTTLE_REMOVE` |
| `edit_reviewers` | Requests and withdraws the reviewers and teams in the four variables |
| `edit_options` | Prints what the pickers offer: `{"labels": [...], "people": ["login"]}` |

Without `edit_options`, the pickers offer the labels and reviewers Shuttle has seen on the repo's
PRs and the teams your review requests named, and you can type any other name.

## Merging and writing on a PR

These optional operations merge a PR and post on its conversation. Like the changes above, each
runs once per action and must exit 0; a non-zero exit fails the action with the command's error
text. Shuttle offers an action only when the server has its command. A server test never runs
`merge`, `comment`, `review`, `reply` or `resolve`.

`merge_options`: how the PR can merge, printed before the merge dialog opens.

```json
{"methods": ["squash", "merge"], "default": "squash", "delete_branch": false, "can_auto": false,
 "state": "blocked", "detail": "It needs an approving review."}
```

`methods` are the ones the repository allows, of `squash`, `merge` and `rebase`; `default` is
the one to preselect. `delete_branch` says the repository deletes branches after a merge, and
`can_auto` that the server can merge it by itself once checks pass. `state` is `clean` (it can
merge now), `blocked`, `behind` (the base moved on), `conflicts`, `pending` (checks are running)
or `unknown`, and `detail` says why in one sentence. Every field is optional. A missing field,
or a server without `merge_options`, gets methods `["squash", "merge"]`, the first method as the
default, `delete_branch` and `can_auto` false, and state `unknown`.

| Operation | What it does |
|---|---|
| `merge` | Merges with `SHUTTLE_METHOD`, only while the head is `SHUTTLE_HEAD`. Exit 0 means it merged, or with `SHUTTLE_AUTO=1` that auto-merge is on. Exit non-zero, with the reason on stderr, for what the server cannot do |
| `comment` | Posts `SHUTTLE_BODY` on the PR's conversation |
| `review` | Submits a review with `SHUTTLE_VERDICT`, `SHUTTLE_BODY` and the comments in `SHUTTLE_COMMENTS` |
| `reply` | Replies with `SHUTTLE_BODY` in the review thread `SHUTTLE_THREAD` |
| `resolve` | Resolves the review thread `SHUTTLE_THREAD`, or reopens it with `SHUTTLE_RESOLVED=0` |

`review` may print `{"placed": 3, "in_body": 1}`: how many comments landed on their lines, and
how many it could not place and wrote into the review's body instead. When it prints nothing,
Shuttle counts every comment as placed.

The other commands' output is ignored.

## Review workspace

A review preset whose workspace is "its own checkout" gets bb's git worktree, unless the PR's
server says otherwise. Some repositories refuse worktrees outside their own place: World only
allows them under `~/world/trees`. A server can then name a bb environment provider:

```toml
[server.workspace]
kind = "provider"
provider = "world-tree"
inputs = { tree = "shuttle-{number}" }
```

or a command that prepares a checkout and prints its absolute path on its last line (it runs
with `/bin/sh` in bb's server process, with a 10-minute limit, so it must be safe to run again):

```toml
[server.workspace]
kind = "command"
command = "cd ~/world && (dev tree add shuttle-{number} >&2 || true) && echo ~/world/trees/shuttle-{number}/src"
```

Provider inputs and the command may use `{number}`, `{repo}`, `{repo_name}`, `{head_ref}`,
`{base}`, `{head}`, `{server}` and `{slug}` (the key as lowercase letters, digits and dashes).
In the command they are shell-quoted. The thread opens in the review's project on the machine
that holds its default checkout.

## GitHub

`kind = "github"` needs no commands: Shuttle uses `gh api graphql`. Requested of me is
`user-review-requested:@me`, My teams is `review-requested:@me -user-review-requested:@me`,
Reviewed is `reviewed-by:@me -author:@me`, and each list reads up to 300 of the most recently
updated PRs. Changes to your own PRs go through `gh pr ready` (with `--undo` for back to draft),
`gh pr close`, `gh pr reopen`, and the REST API through `gh api` for labels and requested
reviewers.

Merges go through `gh pr merge` with `--match-head-commit`, so a PR that moved on since you
looked does not merge; `--auto` turns on auto-merge and `--disable-auto` turns it off. Comments
go through `gh pr comment`. A review is one POST to the REST API with its line comments, on the
head commit you reviewed. When GitHub refuses a comment's line or path, Shuttle posts the review
again on the same commit, with every comment written into its body as a `path:line` list; any
other refusal, such as one about the commit, fails the review. Replies and resolving use the GraphQL mutations
`addPullRequestReviewThreadReply`, `resolveReviewThread` and `unresolveReviewThread`.

## Delta

`delta.sh` covers every operation except `mentioned` (Delta refuses the `mentions:` qualifier)
and `draft` (a Delta PR cannot go back to draft). The lists search `SHUTTLE_DELTA_REPO`
(shop/world unless you set it); every operation on one PR works on that PR's own repository,
`SHUTTLE_REPO`, and refuses one that is not `owner/name`.

`merge_options` reads Delta's merge gate, `repos/{repo}/pulls/{number}/merge-readiness`, for the
methods you may use, its blockers and the head's checks; World's main branch always reports
"main advances through the merge queue". `view` counts the head's checks from the same gate, and
`activity` sends each failed one as a `check` item whose id is the check and the head it ran on.

`merge` runs `dt pr merge --sha`, which on a stacked PR merges the stack up to it. It refuses
rebase, auto-merge (Delta has none) and deleting the branch, and leaves out `SHUTTLE_SUBJECT`,
which `dt pr merge` cannot set. Every review is one POST to the reviews API with `commit_id` set
to `SHUTTLE_HEAD`, since `dt pr review` cannot name a commit; its comments ride in the same
request, the way `dt pr review --file-comment` batches them. A 422 about a comment's line or path
posts it again on the same commit with the comments in its body; any other refusal fails.
`reply` answers the thread's first comment, since `dt pr comment --reply-to` takes a comment id.
