# Forge profiles

A forge is the server that hosts a repository's pull requests. Loom talks to GitHub through `gh` by itself. For any other
server, it runs shell commands that you write: one opens a pull request, one reads its state, one reads its checks and
reviews, and so on. A forge profile keeps those commands in Loom's settings, in one place, instead of in every spec:

```toml
[merge.forge]
profile = "forge"
```

A spec that names a profile stores only its id. When you fix a command in the profile, every project that uses it runs
the fixed command at its next call to the forge, without a new spec version. Loom records each change: the project gets
an event with the profile's old and new version, and each ticket whose pull request Loom follows on it gets a post that
says so.

This page is for the person who sets up a server: what a profile holds, what each command gets and must print, how Loom
reads a failure, and how to test a profile before a project relies on it.

## Where profiles live

- In bb's settings for Loom, under **Forges**: a card per profile with its version, the projects that use it and a Test
  field, and a form to add or edit one. **Import and export** shows every profile as TOML and imports one you paste,
  after showing what it changes.
- From a terminal:

  ```sh
  bb loom forge list                      # each profile, its version and the projects that use it
  bb loom forge show forge                # one profile as TOML
  bb loom forge test forge https://forge.example.com/acme/shop/pull/12
  bb loom forge export > forges.toml      # every profile, as [[forge]] tables
  bb loom forge import forges.toml        # what importing would change
  bb loom forge import forges.toml --apply
  ```

Loom checks a profile before it saves it, from the form, the CLI or an import: each key's shape, the keys that go
together (`review_start` with `review_read`, `review_rounds` only with them), and, for an edit, every project that uses
the profile, as `loom_propose` would check its spec with the edited profile. An edit that would leave a project unable to
run, such as one that drops the `ready` command a project with `merge.publish` needs, is refused with the project, the
spec version and the field, and the profile stays as it was. An edit still makes no new spec version.

An import adds the profiles the file has and changes the ones that differ. It never removes a profile the file leaves
out. Loom keeps a profile that any stored spec version names, an archived project's or an older version's too, since
reading those versions fills their forge in from it; Settings shows which projects use it now, and offers Delete only for
a profile no spec names. A profile's id cannot
change, since specs name it.

Keep the scripts a profile calls outside Loom's install folder, which an update replaces, for example in
`~/.local/share/loom-forge/`.

## What a profile holds

```toml
[[forge]]
id = "forge"                 # what a spec names; 1 to 32 lowercase letters, digits or dashes, starting with a letter
name = "Forge"
kind = "command"             # the only kind a profile has
open = 'sh ~/.local/share/loom-forge/forge.sh open'
state = 'sh ~/.local/share/loom-forge/forge.sh state'
feedback = 'sh ~/.local/share/loom-forge/forge.sh feedback'
edit = 'sh ~/.local/share/loom-forge/forge.sh edit'
reply = 'sh ~/.local/share/loom-forge/forge.sh reply'
retarget = 'sh ~/.local/share/loom-forge/forge.sh retarget'
ready = 'sh ~/.local/share/loom-forge/forge.sh ready'
request_reviews = 'sh ~/.local/share/loom-forge/forge.sh request_reviews'
merge = 'sh ~/.local/share/loom-forge/forge.sh merge'
review_start = 'sh ~/.local/share/loom-forge/forge.sh review_start'
review_read = 'sh ~/.local/share/loom-forge/forge.sh review_read'
after_open = ['forge ci run --pr "$LOOM_PR_NUMBER"']
after_push = ['forge ci run --pr "$LOOM_PR_NUMBER"']
ignore_checks = ["Review Bot*"]
bots = ["*@robots.forge.example.com", "merge-bot*"]
notes = "The review bot clears a finding once a push fixes it. Answer a finding only to disagree, once, and never resolve the bot's threads."
```

`open` and `state` are required; everything else is optional. Each command is the same key a spec's own
`[merge.forge]` table takes, with the same meaning. A spec may set any of them beside `profile`, and the spec's value wins
for that project:

```toml
[merge.forge]
profile = "forge"
ignore_checks = ["lint (advisory)"]      # replaces the profile's list for this project
auto_merge = { method = "command", rejected = ["Merge refused*"] }
```

`auto_merge` and `reviewers` are a project's decisions, so they stay in the spec.

- `ignore_checks`: globs of check names Loom drops before it counts anything, such as a review bot's advisory status. A
  glob matches the whole name, case-sensitively; `*` is any run of characters and `?` one character.
- `bots`: globs of author names. An item whose author matches counts as a bot's, as when `feedback` prints
  `"bot": true`: a bot's top-level comment starts no fix round. Use it for service accounts that the server reports as
  people and that post routine notices. Loom's own **Bot authors** setting adds globs for every forge.
- `notes`: up to 4,000 characters that Loom adds to the brief of every worker and reviewer of a pull request on this
  forge, and to each fix round, under "About this forge". Say what an agent needs to know about the server that its code
  cannot tell it, such as how the review bot clears a finding.

## A review gate

A profile, or a spec's forge, may add a review gate: an outside review that runs on each draft before Loom publishes it,
such as a review bot's private review that publishes nothing. It runs only on projects that set `merge.publish`.

```toml
review_start = 'sh ~/.local/share/loom-forge/forge.sh review_start'
review_read = 'sh ~/.local/share/loom-forge/forge.sh review_read'
review_rounds = 3
```

- `review_start` runs once for each push of the ticket's own work (the opening, each fix round's push, and a fix round's
  approved title and description that Loom set with no push; never a restack or a refresh, and never while approved text
  still waits to be set, so the gate reads the text people will read), with `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_SHA` (the commit to review), `LOOM_HEAD` and
  `LOOM_BASE`. Exit 0 when the review is asked for, and non-zero, with the reason, when it was not. A command that runs out
  of its 2 minutes may have asked, so Loom never runs it again for that push: it reads the gate instead, so make
  `review_read` print `pending` for a review that never started, and the run times out after 90 minutes.
- `review_read` runs at each read until the gate is done, with `LOOM_URL`, `LOOM_PR_NUMBER` and `LOOM_SHA`, and prints one
  JSON object on its last line:

  ```json
  {"state": "done", "findings": [{"id": "f1", "title": "Guard empty rows", "body": "The mapper fails on an order with no rows.", "path": "src/rows.ts", "line": 12, "severity": "medium"}]}
  ```

  `state` is `pending` while the review runs, `done` when it finished, or `failed` with an optional `message`. Only
  `state`, and each finding's `id` and `title`, are required; print the same `id` for the same finding on a later commit.
  When the server says it has no review for that commit yet, print `pending`.
- The gate is clean only when it lists no finding for the commit. Its findings go to the worker as a fix round, and a
  finding still listed after the worker's next push goes again, at most `review_rounds` rounds in all (3 when left out);
  after that the draft waits for you, with one post that names what is left. A gate that fails, or
  is still pending 90 minutes after it started, keeps the draft a draft, with a post on the ticket; the project keeps
  running.

## How commands run

Each command runs with `/bin/sh -c` on the machine with the project's checkout, in the repository's checkout, with a
2-minute limit (`after_open`, `after_push` and `retarget`: 5 minutes; `merge`: 5 minutes). The environment is the user's,
plus these variables:

| Command | Variables | Standard input | Must print |
|---|---|---|---|
| `open` | `LOOM_REMOTE`, `LOOM_BASE`, `LOOM_HEAD` (the pushed branch), `LOOM_TITLE`, `LOOM_DRAFT` (`1` or `0`) | the description | the pull request's URL; Loom takes the last `http(s)://` URL. When one is already open for the branch, print that one: a restart can run `open` again |
| `state` | `LOOM_URL`, `LOOM_PR_NUMBER` (the last run of digits in the URL) | nothing | a last line whose first word is `open`, `merged` or `closed` |
| `feedback` | `LOOM_URL`, `LOOM_PR_NUMBER` | nothing | one JSON object on its last line; see below |
| `edit` | `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_TITLE` | the whole new description | nothing; exit 0 means it is set |
| `reply` | `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_ITEM` (the item's key, such as `thread:9`), `LOOM_ITEM_KIND` (`review`, `thread` or `comment`), `LOOM_RESOLVE` (`1` or `0`) | the reply | optionally the reply's URL; exit 0 means it is posted |
| `retarget` | `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_BASE` (the branch to move to) | nothing | nothing; exit 0 means it moved |
| `ready` | `LOOM_URL`, `LOOM_PR_NUMBER` | nothing | nothing; exit 0 means the draft is ready for review |
| `request_reviews` | `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_REVIEWERS` (logins, comma-separated) | nothing | nothing; exit 0 means every login was asked |
| `merge` | `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_HEAD`, `LOOM_BASE`, `LOOM_SHA` (the commit Loom pushed), `LOOM_ATTEMPT` | nothing | exit 0 when merged or taken by the merge service, 3 when turned away in a way the worker can fix, 4 otherwise, with the reason in the output |
| `review_start` | `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_SHA`, `LOOM_HEAD`, `LOOM_BASE` | nothing | nothing; exit 0 means the review is asked for |
| `review_read` | `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_SHA` | nothing | one JSON object on its last line; see "A review gate" |
| `after_open` | `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_HEAD`, `LOOM_BASE` | nothing | nothing; a failure is posted and holds nothing |
| `after_push` | `LOOM_URL`, `LOOM_PR_NUMBER`, `LOOM_HEAD`, `LOOM_SHA`, `LOOM_BASE` (the branch it builds on now) | nothing | nothing; a failure is posted and holds nothing |

The full rules of each command, such as when Loom runs `after_push` and how often it tries `request_reviews`, are in
`spec.md` under [merge.forge].

### What feedback prints

```json
{"state": "open", "head": "9f3c2a1", "author": "ana", "draft": true, "review": "review_required", "base": "main", "mergeable": true,
 "title": "Add order rows", "body": "…",
 "checks": [{"id": "1", "name": "build", "state": "passed", "url": "https://ci.forge.example.com/1",
             "started_at": "2026-11-06T10:00:00Z", "completed_at": "2026-11-06T10:06:00Z"},
            {"id": "2", "name": "test", "state": "pending", "started": true, "progress": 60}],
 "items": [{"id": "r7", "kind": "review", "author": "sam", "bot": false, "body": "Rename it.", "state": "changes_requested"},
           {"id": "t3", "kind": "thread", "author": "sam", "body": "Off by one?", "path": "src/rows.ts", "line": 12, "url": "https://forge.example.com/acme/shop/pull/12#t3"}]}
```

- `state`, `head` and `checks` and `items` (each may be empty) are what Loom needs; `author` lets it ignore the replies a
  worker posted through Loom.
- A check's `state` is `pending`, `passed`, `failed` or `neutral`. An item's `kind` is `review`, `thread` (an unresolved
  review thread, with `path` and `line`) or `comment`.
- `draft`, `review` (`approved`, `changes_requested` or `review_required`), `base` and `mergeable` let Loom show drafts,
  reviews and conflicts on the Merge order tab, mark drafts ready, ask for reviewers, and keep pull requests fresh. Print
  `null` when the server cannot tell.
- `title` and `body` let Loom refresh its merge and deploy section of the description.
- An `id` stays the same while what it names does not change, and changes when it does, such as a check that runs again
  or an edited comment: Loom sends each id to the worker once.

Every field and its meaning is in `spec.md` under [merge.forge].

## How Loom reads a failure

A command fails when it exits non-zero, runs out of time, or prints something Loom cannot read. Print the reason on
standard error: Loom keeps the end of the output with the exit code, shows it on the ticket, and the test shows it too.

- For `open`, `state` and `feedback`, Loom reads the end of the output for the kind of failure. A network failure, a server
  error (`HTTP 500`, `502`, `503`, `504`, or a line starting with one) or a rate limit (`HTTP 429`) is waited out: the
  pull request's next read waits longer, and the project pauses only after an hour of them. Anything else pauses the
  project. So a command needs no retries or watchdogs of its own.
- Exit non-zero when the server's CLI fails. Without `set -o pipefail`, a failed call piped into `jq` leaves `jq` to print
  nothing and exit 0, which Loom reads as a wrong answer, not a failure. Capture the answer first, then parse it.
- `feedback` output that is not JSON, or JSON in the wrong shape, fails with the field Loom refused, such as
  `checks.0.state: Invalid option: expected one of "pending"|"passed"|"failed"|"neutral"`.

## Testing a profile

Test a profile before a project uses it, and after each change:

```sh
bb loom forge test forge https://forge.example.com/acme/shop/pull/12
```

The Test field on the profile's card, and the one in its form, do the same; the form's tests the profile as you typed
it, before you save it. A test runs only `state` and `feedback`, which read the pull request and change nothing, on the
machine bb's server runs on, in its user's home directory. It prints the state, then everything Loom reads from
`feedback`: draft, review, base, mergeable, head, author, each check with its state, the checks `ignore_checks` drops,
each item with its kind, author and key, and whether the description has Loom's markers. A failed command prints its
error, how a poll would treat it, and each field Loom refused. The command exits 1 when a command failed.

Once a project uses the profile, `bb loom forge check <slug> <KEY or url>` reads a pull request as that project's poll
does, on the project's machine and in its checkout, and names the profile version it ran.

## A full example

A fictional server, Forge, at `forge.example.com`, with a CLI named `forge`. One script serves every command:

```sh
#!/bin/sh
# ~/.local/share/loom-forge/forge.sh <command>
set -eu
case "$1" in
  open)
    existing=$(forge pr list --head "$LOOM_HEAD" --json url --jq '.[0].url // empty')
    if [ -n "$existing" ]; then echo "$existing"; exit 0; fi
    draft=$([ "$LOOM_DRAFT" = 1 ] && echo --draft || echo --ready)
    forge pr create --base "$LOOM_BASE" --head "$LOOM_HEAD" --title "$LOOM_TITLE" --body-file - $draft --json url --jq .url ;;
  state)
    forge pr view "$LOOM_URL" --json state --jq .state ;;
  feedback)
    answer=$(forge pr view "$LOOM_URL" --json state,head,author,draft,review,base,mergeable,title,body,checks,comments)
    printf '%s' "$answer" | jq -c '{state, head, author, draft, review, base, mergeable, title, body,
      checks: [.checks[] | {id: (.id | tostring), name, state, url}],
      items: [.comments[] | {id: (.id | tostring), kind: .kind, author: .author, bot: (.author_type == "bot"), body, path, line, url}]}' ;;
  edit)
    forge pr edit "$LOOM_URL" --title "$LOOM_TITLE" --body-file - ;;
  reply)
    forge pr reply "$LOOM_URL" --to "${LOOM_ITEM#*:}" --body-file -
    [ "$LOOM_RESOLVE" = 1 ] && forge pr resolve "$LOOM_URL" --thread "${LOOM_ITEM#*:}" || true ;;
  retarget)
    forge pr edit "$LOOM_URL" --base "$LOOM_BASE" ;;
  ready)
    forge pr ready "$LOOM_URL" ;;
  request_reviews)
    forge pr edit "$LOOM_URL" --add-reviewer "$LOOM_REVIEWERS" ;;
  review_start)
    forge review request "$LOOM_URL" --commit "$LOOM_SHA" --private ;;
  review_read)
    answer=$(forge review show "$LOOM_URL" --commit "$LOOM_SHA" --json state,findings 2>/dev/null) || { echo '{"state": "pending"}'; exit 0; }
    printf '%s' "$answer" | jq -c '{state, findings: [.findings[] | {id: (.id | tostring), title, body, path, line, severity}]}' ;;
  *)
    echo "forge.sh: unknown command $1" >&2; exit 2 ;;
esac
```

Import the profile from the example in "What a profile holds", test it, then name it in a spec:

```sh
bb loom forge import forge.toml --apply
bb loom forge test forge https://forge.example.com/acme/shop/pull/12
```

```toml
[merge]
strategy = "pr"
publish = {}                 # drafts until they can ship, after the review gate

[merge.forge]
profile = "forge"
```
