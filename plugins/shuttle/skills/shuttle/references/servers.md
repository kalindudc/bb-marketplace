# Shuttle servers

## A command server

```toml
[[server]]
id = "forge"                     # lowercase, the first part of every key: forge:acme/app#1234
name = "Forge"
kind = "command"
pattern = '^https://forge\.example\.com/(?<repo>[^/]+/[^/]+)/pull/(?<number>\d+)'
link = "https://forge.example.com/{repo}/pull/{number}"
sep = "#"                        # or "!" for GitLab-style group/project!77
read = "forge pr view {number} -R {repo} --comments"   # how an agent reads the PR; shown in prompts

[server.commands]
whoami = 'sh ~/shuttle/forge.sh'
authored = 'sh ~/shuttle/forge.sh'
review_requested = 'sh ~/shuttle/forge.sh'
view = 'sh ~/shuttle/forge.sh'
activity = 'sh ~/shuttle/forge.sh'
team_requested = 'FORGE_TEAMS=platform sh ~/shuttle/forge.sh'
reviewed = 'sh ~/shuttle/forge.sh'
# mentioned left out, for a server that cannot search for mentions
# Managing your own PRs from Shuttle; draft left out, for a server that can't go back to draft.
ready = 'sh ~/shuttle/forge.sh'
close = 'sh ~/shuttle/forge.sh'
reopen = 'sh ~/shuttle/forge.sh'
edit_labels = 'sh ~/shuttle/forge.sh'
edit_reviewers = 'sh ~/shuttle/forge.sh'
# Merging, and writing on the PR's conversation.
merge_options = 'sh ~/shuttle/forge.sh'
merge = 'sh ~/shuttle/forge.sh'
comment = 'sh ~/shuttle/forge.sh'
review = 'sh ~/shuttle/forge.sh'
reply = 'sh ~/shuttle/forge.sh'
resolve = 'sh ~/shuttle/forge.sh'
```

`forge.sh` stands for your adapter: one script can serve every operation by reading
`SHUTTLE_OPERATION`, or each operation can have its own command. Keep it outside Shuttle's
install folder, which an upgrade replaces. `view` is required; every other operation is optional.

## How commands run

Each command runs with `/bin/sh -c` in bb's server process, with the user's environment plus
the usual tool directories on `PATH`, and a 60-second limit. It gets:

| Variable | When |
|---|---|
| `SHUTTLE_OPERATION` | always: the operation's name, such as authored or edit_labels |
| `SHUTTLE_SERVER` | always: the server id |
| `SHUTTLE_SCRIPTS` | always, when the installed Shuttle has it: this file's folder in the installed Shuttle |
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
JSON in the wrong shape fails that operation; the other operations still run, and the PRs of
the lists that failed keep their last good data. When a command fails, print the reason on
stderr: Shuttle keeps the end of it, with the exit code, and shows it on Insights › Sync, in
Settings › Servers and in `bb shuttle status`. An exit 0 that prints nothing counts as a failure
too, with whatever went to stderr. A line such as ``run `forge auth login` `` on stderr becomes the
fix Shuttle offers to copy. Do not pipe a server call straight into `jq`: without `pipefail`, a
failed call leaves `jq` to print nothing and exit 0. Capture the answer first, then parse it.

Shuttle tries a failed list once more after a server error (HTTP 5xx), a network error or an empty
answer, at most twice a sync per server, and never after a rate limit (HTTP 429) or a timeout.
A command does not need retries of its own.

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
{"repo": "acme/app", "number": 1234, "title": "Upgrade Envoy", "author": "sam.lee",
 "state": "open", "draft": false, "url": "https://…", "head": "9f3c2a1…", "head_ref": "sam/envoy",
 "base": "main", "updated_at": "2026-10-23T14:58:00Z", "checks": "passed", "review": "required",
 "additions": 1204, "deletions": 388, "files": 23, "teams": ["@acme/routing"]}
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

When Shuttle opens a PR's view it runs `activity` with `SHUTTLE_DETAIL=1`, and the command may
add what the view shows besides the conversation. Watching runs it without `SHUTTLE_DETAIL`, so
syncs stay as light as before; a command that ignores the variable works as it always did, and
the view leaves out the parts it did not get. Every part is optional:

```json
{"head": "a41f7c3…", "items": [
  {"id": "c12", "kind": "thread", "body": "Reuse the buffer.", "path": "src/cpu.rs", "line": 42,
   "hunk": "@@ -40,2 +40,3 @@\n fn run() {\n+    let buf = vec![];", "review": "r7"}],
 "checks": {"total": 41, "items": [{"name": "lint", "group": "CI", "state": "failed", "detail": "timed out",
   "required": true, "url": "https://…", "started_at": "…", "completed_at": "…", "item": "check:lint:a41f7c3"}]},
 "commits": {"total": 4, "items": [{"sha": "a41f7c3…", "message": "Fix the retry", "author": "ana", "at": "…"}]},
 "files": {"total": 2400, "items": [{"path": "src/cpu.rs", "additions": 12, "deletions": 3, "change": "modified"}]},
 "timeline": [{"kind": "labeled", "at": "…", "actor": "ana", "subject": "ship"}],
 "merge": {"state": "blocked", "detail": "It needs an approving review."}}
```

- An item's `hunk` is the diff hunk its review thread is on, in unified format; the view shows its
  last lines. `review` names the review an item belongs to: a review's own id, or the review a
  line comment was posted in.
- `checks` is every check on the head, up to 5000. `state` is `failed`, `running`, `passed` or
  `skipped`, and `item` is the id of a failed check's `check` item, so the view can say what its
  agent got.
- `commits` are the last 100, oldest first, and `files` the first 100, with paths and line counts
  only. Shuttle never reads file contents. `total` says how many there are in all; a bare array
  counts as all of them. A longer list, up to 5000, is cut to its last 100 commits or first 100
  files.
- `timeline` kinds are `review_requested`, `review_request_removed`, `labeled`, `unlabeled`,
  `ready_for_review`, `converted_to_draft`, `force_pushed`, `merged`, `closed`, `reopened`,
  `renamed`, `auto_merge_enabled`, `auto_merge_disabled`, `review_dismissed`, `branch_deleted`
  and `base_changed`. `subject` is who or what it is about (the reviewer, the label, the new title,
  the new head or base, the merge commit) and `detail` what it was before.
- `merge.state` takes the same values as `merge_options` prints.

A part in the wrong shape fails the read with the field it is about, as any other field does.

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
| `merge` | Merges with `SHUTTLE_METHOD`, only while the head is `SHUTTLE_HEAD`. Exit 0 means the server took the merge, or with `SHUTTLE_AUTO=1` that auto-merge is on. Exit non-zero, with the reason on stderr, for what the server cannot do |
| `comment` | Posts `SHUTTLE_BODY` on the PR's conversation |
| `review` | Submits a review with `SHUTTLE_VERDICT`, `SHUTTLE_BODY` and the comments in `SHUTTLE_COMMENTS` |
| `reply` | Replies with `SHUTTLE_BODY` in the review thread `SHUTTLE_THREAD` |
| `resolve` | Resolves the review thread `SHUTTLE_THREAD`, or reopens it with `SHUTTLE_RESOLVED=0` |

Shuttle runs `view` just before `merge`, and merges only while the PR is open and still at the head
the user saw. It runs `view` again afterwards and decides from that what happened: `merged` there
means it merged, and a PR still open after an exit 0 counts as taken but not merged yet, as in a
repository's own merge queue. When the first `view` fails, Shuttle does not merge; when only the
second one fails, it trusts the exit code.

`review` may print `{"placed": 3, "in_body": 1}`: how many comments landed on their lines, and
how many it could not place and wrote into the review's body instead. When it prints nothing,
Shuttle counts every comment as placed.

The other commands' output is ignored.

## Review workspace

A review preset whose workspace is "its own checkout" gets bb's git worktree, unless the PR's
server says otherwise. Some repositories refuse worktrees outside their own place, such as a monorepo
that keeps them in its own trees folder. A server can then name a bb environment provider:

```toml
[server.workspace]
kind = "provider"
provider = "my-trees"
inputs = { tree = "shuttle-{number}" }
```

or a command that prepares a checkout and prints its absolute path on its last line (it runs
with `/bin/sh` in bb's server process, with a 10-minute limit, so it must be safe to run again):

```toml
[server.workspace]
kind = "command"
command = "cd ~/src/app && (git worktree add ../app-{number} >&2 || true) && echo ~/src/app-{number}"
```

Provider inputs and the command may use `{number}`, `{repo}`, `{repo_name}`, `{head_ref}`,
`{base}`, `{head}`, `{server}` and `{slug}` (the key as lowercase letters, digits and dashes).
In the command they are shell-quoted. The thread opens in the review's project on the machine
that holds its default checkout, unless the provider's workspace names a machine.

### Reviews on a new machine

A provider's workspace can start each review on a new machine of its own, from any bb machine
provider (`bb machine providers --json` lists them with their inputs schemas), instead of on the
machine with the project's checkout. `machine.inputs` takes the same placeholders as `inputs`
and defaults to none. Shuttle names no provider: any machine provider and any environment
provider that runs on its machines work. bb's `git-worktree` provider gives a plain worktree on
the new machine.

```toml
[server.workspace]
kind = "provider"
provider = "example-checkout"
inputs = { branch = "review/{slug}" }

[server.workspace.machine]
provider = "example-sandbox"
inputs = { cores = 8 }
```

Some environments make a new machine for each thread themselves: `bb environment providers
--json` shows their `machineProviderId`. Such an environment still needs `machine`, set to that
machine provider, as bb refuses any other machine for it:

```toml
[server.workspace]
kind = "provider"
provider = "example-sandbox-checkout"
machine = { provider = "example-sandbox-checkout", inputs = { paths = ["src/{repo_name}"] } }
```

In the settings, the server form lists bb's providers as you type and fills in that machine
provider when you pick such an environment. The server's Test checks the workspace against what
bb has now: that both providers exist, that an environment which makes its own machine has that
machine provider, and that the inputs and machine inputs match their schemas (with sample values
for the placeholders). It starts no thread, so whether a provider has room is bb's answer when a
review starts. Empty machine inputs go to bb as none, which a machine provider without inputs
needs; empty environment inputs go as `{}`, so an environment provider that takes no inputs
cannot be a review workspace.

What changes when reviews run on new machines:

- A review with a preset whose workspace is the project's default workspace stays where it is;
  only a preset that asks for its own checkout uses the server's workspace.
- A machine provider that removes its machines when their threads end, such as a sandbox
  provider marked ephemeral, keeps the machine while the review thread is unarchived. With
  "Archive finished review threads" on, Shuttle archives the thread once its review is done,
  which lets bb remove the machine. A draft you have not posted or discarded keeps both.
- The PR's next review brings its last review thread back only while that thread's machine is
  there. Once bb removed it, the review starts in a new thread on a new machine, and the
  Automation log says why.
- When bb cannot start a machine now, because its machine provider has no room or is not ready,
  or the environment provider says it is unavailable, a review you start shows bb's message.
  An auto review waits instead: the Automation log says so once, with bb's reason, Shuttle tries
  again at each sync, and after an hour of waiting it records the review as one that could not
  start. bb gives the same answer when a machine provider refuses the inputs themselves, so that
  waits too. Waiting does not count toward the daily limit, and a review that comes back after
  more than an hour without a try, such as a request made again, waits afresh.
- The review thread works on the new machine, but Shuttle's tools, `shuttle_review_draft`
  among them, run in bb's server, so the draft comes back to Shuttle as from any review. The
  read command in the prompt (`{view_command}`) runs on the new machine and must work there.

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
