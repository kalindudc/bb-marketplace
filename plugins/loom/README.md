# Loom

A bb plugin that runs a software project with agents. You describe a goal on the
Loom page, or give it to any thread. A planner agent turns it into a validated spec: the tickets with acceptance
criteria, the checks that must pass, the review policy and the merge strategy.
You approve the spec and start the project. Worker agents then take the tickets
one by one, each in its own git worktree. Separate reviewer agents approve their
work or ask for changes, and approved work merges into an integration branch or
opens as pull requests. The plugin, not an agent, owns every state change;
agents get narrow tools for their role. A project can stay in one repository or
span several, with each ticket in one of them.

## How a project runs

1. Plan: press New project on the Loom page and describe the goal, or ask any thread to plan it; every thread has the `loom-plan` skill. The planner asks a round of questions and calls `loom_propose` with a TOML spec. The plugin validates it and saves a draft, then starts a spec reviewer: a fresh agent that checks the spec against the human's request and for work the goal does not need, and sends any findings back to the planner, for up to three rounds.
2. Approve: once the spec review passes, the human reads the spec and approves it. The tickets appear on the board. `bb loom approve <slug> --skip-review` approves a draft whose review has not passed.
3. Start: the human starts the project. The plugin picks ready tickets (dependencies done, no scope overlap with work in flight) and starts a worker thread for each.
4. Work: a worker calls `loom_note` as it goes, then `loom_submit`, or `loom_block` when it needs help.
5. Check: the plugin commits the worktree and runs the ticket's and the project's check commands. A failure goes back to the worker.
6. Review: reviewer threads read the diff and call `loom_approve` or `loom_request_changes`. Requested changes go back to the worker as numbered findings.
7. Merge: the plugin merges exactly the commit that was reviewed, one ticket at a time, into the integration branch and runs the `after_merge` checks on the result. On the pull request strategy it opens one pull request per ticket and follows it.
8. Land: on the integration strategy the human reads what lands on the project's Changes tab, then runs `bb loom land` to push the branch and open one pull request upstream, or `bb loom land --direct` to merge the remote's base branch in when it moved, run the `after_merge` checks on the result, and push straight to the base branch. A multi-repo project lands each repo, or one with `--repo` or from that repo's section of the Changes tab.

A ticket that gets stuck is blocked. The planner hears about blocked tickets in a
triage round and answers with its board tools (`loom_board`, `loom_ticket`,
`loom_post`, `loom_requeue`, `loom_edit_ticket`, `loom_add_tickets` and
`loom_cancel_ticket`), or the human answers on the ticket. The human's reply on a
blocked ticket goes to the planner at once, as a message that names the ticket,
so the planner can answer with the same board tools.

When bb refuses to start a worker or a reviewer with a client error (an HTTP 4xx
status other than 408, 409 and 429), the ticket blocks at once with bb's message
as the reason, because the same request would fail again. Network errors, server
errors and those three statuses are retried up to `budget.max_attempts` times.
Approving a pending spec version, on the page or with `bb loom approve`, queues
again every blocked ticket whose worker never started, resets its failure counts
and tells the planner which tickets it requeued. A ticket blocked because bb
refused its reviewer goes back to review instead, in a new review round for the
same commit: its work already passed the checks, so no worker starts again.

Each `provider` in `[agents.worker]` and `[agents.reviewer]` must be a bb
provider id, such as `claude-code`, `codex` or `pi`. Loom checks them against
the providers bb has when the spec is proposed and refuses an unknown one,
naming the ids bb has. When bb's list cannot be read, the spec is accepted
unchecked.

`skills/loom/references/spec.md` lists every key of the spec with its default.

## Multi-repo projects

A spec with `[[repo]]` tables spans several repositories. Each `[[repo]]` names
a bb project, which needs a checkout on the machine the planner runs on, where
the workers run too. It can set its own base, remote, checks, `after_merge`
checks and protected paths; what it leaves out comes from the top-level
settings. Every ticket names its repo and changes only that repo, and its scope
is relative to that repo's root. Work that spans repos is split into one ticket
per repo, linked with `depends_on`.

- Planning: the planner asks which repos the work spans, finds them with
  `bb project list --json` and `bb project discover`, and offers to clone a repo
  that has no checkout on this machine with
  `bb project source add <id> --clone --machine <host>`. It runs that only after
  you agree. `loom_propose` refuses a repo without a checkout and names the same
  command.
- Workers: one worker per ticket, in a worktree of its ticket's repo. Its brief
  names the repo and lists the other repos' checkout paths, to read but never
  edit. Scopes collide only within one repo, so tickets in different repos run
  side by side.
- Checks and review run in the ticket's repo, with the repo's own checks and
  protected paths.
- Merging: `bb loom start` creates an integration branch of the same name in
  every repo, from each repo's base, and the plugin keeps a Loom worktree per
  repo. The merge queue still runs one merge at a time per project, across
  every repo. On the pull request strategy each pull request opens in its
  ticket's repo, on that repo's remote and base.
- Landing: `bb loom land <slug>` lands every repo with merged work, each with
  its own pull request, `bb loom land <slug> --repo <name>` lands one repo, and
  `--direct` pushes each repo to its own base. When one repo fails, the repos
  before it stay landed and the error says what to run next. The project is done
  when every ticket is done or cancelled and every repo with merged work has
  landed.
- Changes tab: one section per repo, in the spec's order. Each section has the
  repo's integration branch compared with that repo's remote base branch, what
  each of its merges added, and its tickets not merged yet; on the pull request
  strategy, its tickets compared with that repo's remote base. The panel on a
  repo's branch lands that repo alone. A repo that cannot be read, such as one
  with no checkout on the project's machine, says why in its own section.
- Done hook: the hook also gets `LOOM_PROJECT_URLS`, every repo's pull request
  one per line in the spec's order, and `LOOM_PROJECT_URL` is the first of them,
  the first repo's pull request when it has one. The record lists each repo and its outcome: the pull request it landed as or
  the base it was pushed to, merged work not landed yet, or no merged work.
- `bb loom show` lists each repo with its bb project, base, integration branch,
  pull request and land, and `bb loom tickets` adds a repo column.
- After approval, a new spec version may add repos but cannot remove or rename
  one, or change its bb project, base or remote.

## Commands

```sh
bb loom list                                 # every project with its state and ticket count
bb loom show <slug>                          # state, goal, merge setup, spec versions, ticket counts, next step
bb loom spec <slug> [--version N]            # the spec as TOML
bb loom tickets <slug> [--state s,s]         # the board
bb loom ticket CSV-1                         # a ticket and its reply thread
bb loom metrics <slug> [--days N] [--json]   # flow and agent metrics, one line each; --days sets the window (default 14)
bb loom feed <slug> [--after <id>] [--json]  # the newest events as sentences
bb loom report <slug> [--send]               # the project's record as Markdown; --send runs the done hook again
bb loom approve <slug> [--version N] [--skip-review]  # approve a draft (creates the tickets) or a pending version; --skip-review skips a spec review that has not passed
bb loom start <slug>                         # workers start by themselves
bb loom pause <slug> [--now]                 # --now also stops the worker threads
bb loom resume <slug>
bb loom post CSV-1 "text" --reply-to <id>    # your reply; a worker that holds the ticket gets it, or the planner when it is blocked
bb loom block CSV-1 "reason"
bb loom requeue CSV-1 --note "answer"        # a blocked ticket back to the queue
bb loom cancel CSV-1 "reason"
bb loom land <slug> [--title t] [--ready]    # integration strategy: push the branch, open one pull request
bb loom land <slug> --direct                 # integration strategy: merge in the remote's base, check, push to it, no pull request
bb loom land <slug> --repo <name>            # multi-repo project: land only this repo, with or without --direct
bb loom archive <slug>
```

Every command takes `--json`. Each project gets a sidebar section named
`Loom · <name> (<slug>)`; the planner, workers and reviewers move into it.
When the project is done or archived, Loom deletes its sidebar section, and its
threads go back to the ungrouped list. If the section is deleted while a project
is ready or paused, starting or resuming it makes the section again and moves
the planner back into it.

## Agent tools

| Role | Tools |
|---|---|
| Any other thread | `loom_propose` |
| Planner | `loom_propose`, `loom_board`, `loom_ticket`, `loom_post`, `loom_requeue`, `loom_edit_ticket`, `loom_add_tickets`, `loom_cancel_ticket` |
| Worker | `loom_note`, `loom_submit`, `loom_block` |
| Reviewer | `loom_note`, `loom_approve`, `loom_request_changes` |
| Spec reviewer | `loom_spec_approve`, `loom_spec_request_changes` |

## The page

Loom adds a full-screen page to bb's left navigation. A first visit, before any
project or planning conversation exists, shows a guide: the five steps from plan to land, who does what, and
a ticket's life. "How Loom works" opens the same guide at any time.

New project shows bb's own new-thread composer, with its project, worktree,
branch, model and permission pickers; the permission picker starts on full. You
can also settle the merge plan and name a reviewer model up front, and pick the
repos the work spans: the repo picker lists bb's standard projects besides the
composer's own, filters them by name, takes up to 10 and marks a project with no
checkout on any machine as "no checkout". The picked repos are a starting point,
not a limit: the planner can add others and offers to clone a repo with no
checkout. Submitting
starts an ordinary bb thread as the planner, with the `loom-plan` skill, and
opens the conversation on the page: the planner's chat beside a card for the
draft. When the planner proposes, the card fills in with the tickets, checks,
reviewer and repos, and the next-step bar above the planner's chat offers Approve and then
Start. Conversations that have not proposed yet are listed on the home page
until their thread is archived. "Don't work in a project" is refused, because
Loom needs a git checkout. The composer starts on the project of the last
planning conversation you started from it.

Once the planner proposes, the conversation also shows the spec dashboard under
the chat and the draft card, with the warnings and the raw spec, the same one as
the project's Spec tab below. Every proposal before
approval is kept as its own version, and older drafts read as superseded. Press
"+ note" on a ticket card or on any part of the spec to leave a note for the
planner. Notes stay in
your browser until you send them, and the planner gets them in one message that
names each part, such as `ticket[csv-export].acceptance[1]`. A sent note then
shows whether the planner's next version changed that part.

The home page opens with five tiles across every project that is not archived:
projects running, agents working against the worker and reviewer slots of the
running and paused projects (a paused project's workers and reviewers finish
their turn), tickets done in the last 7 days, how many things need you, and
the sampled tokens; the "Needs you" tile also says how many projects that is
and how many tickets are blocked. Under them, one table lists every project and
every planning conversation. Its "Needs you" column has a button for each
blocked ticket, draft to review, pending spec version, finished integration
project to land, and project that Loom paused by itself (a budget or a
deadline); each opens its ticket or project, and a row shows three and then
"+N more". Rows that need you come first, most urgent first, with a coloured
edge: red for a blocked ticket, green for a project ready to land, amber for the
rest. A planning conversation is a row with "Continue planning". The table also
shows each project's state, strategy, ticket counts and the reason the plugin
paused it, with a progress bar, its workers and reviewers at work (not the
planner, which stays on call for triage rounds), a 14-day throughput sparkline,
its tokens against the spec's budget and the time of its last event. A search
box above the table filters it by name, key, slug or title as you type. Done and
archived projects that need nothing fold into a "Finished" group at the bottom,
which the page remembers opening; it opens by itself while you search or when
nothing else is active.

A project with an approved spec shows a health strip above its tabs: progress,
pace (the tickets done in the last 14 days over the time the project ran in
them, so a new or paused project is not paced by days it did not run) and the
running time left at that pace, the token budget and the deadline (each only
when the spec sets it), and worker and reviewer capacity with the ready tickets
that wait for a slot. Every project shows a next-step bar
under its header: the stages from Plan to Land with the current one marked, one
sentence on what happens next, and one button such as "Approve v1 · create 7
tickets" or "Start project · 2 workers". The bar turns yellow when tickets are
blocked or Loom paused the project, and names the reason and what Loom is doing
about it. When every ticket of an integration project is done or cancelled, the
bar offers Land, as does the next step in `bb loom show`, beside Review changes,
which opens the Changes tab on the integration branch. The header's "Land to
<base>" button, beside Land, lands with `--direct` instead. On a multi-repo
project, a repo chip marks each ticket's repo on the board, the ticket page and
the spec dashboard, the Files tab groups paths by repo, the header links each
repo's pull request, and the land buttons name the repos they land ("Land to
each repo's base" when the bases differ). A tab that needs you
carries a badge until the thing is resolved: the Board tab counts the blocked
tickets, the Spec tab shows one while a draft waits for review or a newer
spec version waits for approval, and the Changes tab counts the files of a
project ready to land that you have not marked viewed (on a multi-repo project,
the files of every repo's branch). Open a project for these views:

- Board: one lane per ticket state, with each card's age in its state, its attempt and review round, a link to the thread working on it, and a Changes link that opens the ticket's changes. Queued tickets are split into Ready and Waiting, and a waiting ticket names what it waits on. Before approval, the draft's tickets show as dashed cards in Ready and Waiting, with the keys approval will give them.
- Agents: every planner, worker and reviewer thread. The workers and reviewers working now come first, with their ticket, configured model, running time, timeout, tokens and rate-limit retries, and a Thread button. The planner has its own section, on call for triage rounds, with its tokens and Thread button. Below them are the tokens by role, how threads ended (idle twice, gave a verdict, timed out and so on) and the ended threads. A thread whose provider reports no token usage shows "not reported", and the tokens by role say how many such threads there are.
- Ticket: a header with the state, a one-line summary, a stage tracker from Queued to Done, and chips for the attempts, review rounds, total time, dependencies, the branch (with a copy button) and the pull request. A blocked ticket shows its reason, a link to the post that blocked it, an answer box and Requeue; Block and Cancel ticket sit in the header's ⋯ menu, and each needs a reason. The Activity tab shows one card per worker attempt, newest first (Oldest first switches the order), the newest open and older ones folded to one line. Inside an attempt, posts are cards with their replies under them, each check lists its commands with their result, time and exit code and the failed command's output, each review shows its verdict, findings and the reviewer's notes, and each merge its git steps. The Brief tab shows the brief as Markdown. A side column, or a Details tab on a narrow page, lists the acceptance criteria, the files in scope, the verify command and every worker and reviewer thread with how it ended. The reply box says who gets your reply now.
- Changes: what the project changed, from the start of the work until after it lands. On the integration strategy the list on the left starts with the integration branch compared with the remote's base branch (`origin/main`), which is what Land pushes, then each merged ticket with what its merge commit added to the branch, then the tickets not merged yet: the commit in review, the one that passed the checks and that the reviewers read, compared with the integration branch, and a working ticket's worktree as it is now, uncommitted and untracked files included, read again every 10 seconds while it shows. On the pull request strategy each ticket is compared with the remote's base branch, and a merged one with the base as it was before its merge. Each file shows its status, its added and removed lines and, on the branch, the tickets whose merges changed it; a click opens its patch in bb's own diff viewer, unified or split. Viewed marks stay in your browser and clear by themselves when a file changes again. On the branch, a panel carries Land and "Land to <base>" with what each pushes. A done or archived project shows what it merged, from before its first merge to its last, from the merge commits Loom recorded, so it still works after the branch landed. Work whose commits are no longer in the repository, such as an abandoned ticket whose worktree was cleaned up, is left out and counted. On a multi-repo project the list has one section per repo, in the spec's order and headed by its repo chip, and each section has that repo's integration branch compared with that repo's remote base branch (`<remote>/<base>`), its merges and its tickets not merged yet, or on the pull request strategy its tickets compared with that repo's remote base. The panel on a repo's branch lands that repo alone, with "Land <repo>" and "Land <repo> to <base>", and the other repos do not land. A repo that cannot be read, such as one with no checkout on the project's machine, says why in its section while the other repos still show. Review changes opens the first repo with work to land, and a Viewed mark holds the repo as well as the file. The tab shows once a project has started, and not while the page is rewound.
- Feed: the project's events, newest first.
- Metrics: the numbers below, with charts, and a 7, 14 or 30 day window for throughput and cumulative flow.
- Spec: the spec as a dashboard, with a summary strip and four tabs. Tickets shows the dependency waves from top to bottom, each a wrapping grid of cards that say what they wait for; selecting a ticket lights up everything it waits for and everything it unblocks, says so in a sentence, and dims the rest until you click it again or press Show all. Files starts with Shared files, one row per path that two or more tickets may change, naming the tickets and whether they run in order or one at a time; then every path grouped by folder, with an "All files" or "Shared only" filter and the selected ticket's paths highlighted; then the protected paths. Checks & review and Project & limits show the rest of the spec. Under the tabs a wide card shows the selected ticket: its brief for the worker on the left, cut short with "Show the whole brief" when it is long, and its facts on the right (priority and wave, what it waits for and unblocks, the acceptance criteria, the paths it may change and its verify commands). The dashboard also has a version switcher that marks what each version changed, "Read the raw spec", "+ note" on every ticket card and every part (faint until you hover it, always shown on a touch screen) with a tray beside the tabs, which stays in view as you scroll, that sends the notes to the planner, and Approve for a pending version.
- Planner: the planner thread's chat, embedded in the page, with its open questions above it.

Under the health strip, every project has a Timeline section. Collapsed, it is
one thin strip: the share of tickets in each state over time, with a playhead,
the moment shown ("Now" or the rewound time) and a Play button. Click or drag
the strip, press Play, or open the section and step with First event, Previous
event, Next event and Now to rewind the whole page to that moment; while the
section has focus, the arrow keys step one event and Space plays or pauses.
Rewound, the header shows "rewound" in place of its controls, a "Rewound to …"
bar replaces the next-step bar, and the health strip, Board, Agents, Feed,
Metrics and Spec show the project as it was then. The Spec tab shows the version
in force then, read-only, and the Planner tab is hidden. A ticket opened while
rewound shows its state, posts, checks, reviews and threads as they were, with
every control disabled. Back to now returns the live page; nothing on a rewound
page can change the project. Open, the section plays at 1, 5 or 20 minutes per
second, marks your own actions as diamonds that seek to them, zooms to the whole
project or to 2 hours or 30 minutes around the playhead, and draws a bar per
ticket while it is in flight, or per agent session, packed into shared rows, so
the lanes stay short however many tickets the project has. Trouble only keeps
the tickets that blocked or were sent back to work. Stretches of 15 minutes or
more with no event fold to a narrow band marked ≈. The server rebuilds the past
from the event log and runs the live page's own views on it, so the board's
waits, the health strip and the metrics are the real ones. History from before
Loom 0.7.0 does not keep a ticket's old text or its failure count on each move,
so a moment from then shows today's ticket text and counts no failed attempts.

Every button that changes something asks twice: the first click turns it amber
with "Click again to ..." and a bar that drains over five seconds, beside a
Cancel button. Archive sits in the ⋯ menu. Each button calls the
same engine method as the matching command, and each is logged as a
`human.action` event. The page updates within about a second of an event, without
a reload. Addresses work after a reload: `/plugins/loom/loom/<slug>` opens a
project, `/plugins/loom/loom/<slug>/<KEY>` a ticket and
`/plugins/loom/loom/_plan/<threadId>` a planning conversation. A worker, reviewer or
planner thread shows a small header chip such as `CSV-3 · review` that opens
its ticket; a planning conversation shows "Planning", which opens it on the page.
The chip is hidden on phone-sized screens. A question the planner asks with
Ask User Question appears above its chat on the page, where you can answer it.
The Loom icon in the left navigation rail counts what needs you: the "Needs you"
items and Loom threads waiting on a question or an approval.

## Metrics

All of them are computed from the append-only event log and the plugin's tables,
so they can be recomputed at any time. `bb loom metrics <slug>` prints them and
`--json` prints the same numbers for scripts and agents. `--days N` (1 to 90)
sets the window for throughput and cumulative flow; every other metric covers the
whole project.

| Metric | What it is |
|---|---|
| work in progress | Tickets in working, checking, review, approved, merging or pr_open. |
| throughput | Tickets that reached done, per UTC day, for the last 14 days (or `--days`). |
| cycle time | From a ticket's first move to working until done; p50 and p85. |
| lead time | From the ticket's creation until done; p50 and p85. |
| work item age | For each ticket in flight, the time since its first move to working. |
| first-pass approval | Of the tickets that have a verdict, the share approved (or merged) with no changes requested in their first verdict round. |
| review rounds | Mean number of review rounds of done tickets. |
| check failures | `check` posts, and how many of them failed. |
| blocks | Times a ticket moved to blocked. |
| human interventions | Commands the human ran, apart from `start` and the approval of a draft. |
| tokens (sampled) | Tokens used by the project's threads in total, by role and per done ticket. They are sampled, not exact: the plugin reads each live thread about once a minute and once when it ends it. Some providers report no token usage; the threads that ended, or have run for a minute, with no sample are counted as not reporting (`tokens.unreported` in `--json`). |
| cumulative flow | Tickets in each state at the end of each of 14 days (or `--days`). A ticket counts as queued from its creation. |
| active time | Time the project ran, without the paused spans. `windowActiveMs` in `--json` is the part of it in the last 14 days (or `--days`). |
| time in state and flow efficiency | Over done tickets, the time spent in each state from creation (as queued) until done. Flow efficiency is the share of that time spent working. |
| checks by command | For each check command, its runs, failed runs (a non-zero exit or a timeout) and p50 duration. The plugin's own refusals count under "scope check" and "worktree check". |
| scope flags | Check posts that found files outside the ticket's scope, and check posts that found protected paths. |
| review findings | Over reviews with a verdict: the findings, how many are blocking and should-fix, the review rounds, and the rounds that requested changes. |
| tokens by ticket | The 5 tickets whose threads used the most sampled tokens. |
| reliability | Failed worker attempts, rate-limit retries, worker threads that timed out, and merges sent back to work (a merge conflict or a failed `after_merge` check). |

## When a project finishes

`bb loom report <slug>` prints a project's record as Markdown, built from its
board with no agent: the goal, where the code landed, and for each ticket its
acceptance criteria, its submit summaries, its reviews, its merge, its blocks,
and the planner's and the human's replies. Worker notes and check output are
left out. On a multi-repo project the record lists each repo with its bb
project, base and integration branch, gives one outcome line per repo (the pull
request it landed as or the base it was pushed to, the merged work it has not
landed yet, or no merged work; on the pull request strategy, its tickets' merged
pull requests and the ones still open), and names each ticket's repo. It works
for a project in any state, and `--json` prints `{ slug, markdown }`.

Loom's settings have a done hook, so the record can go to wherever you keep
notes. Set them in bb's settings for Loom, or from a terminal:

```sh
bb plugin config loom set doneHook '<a shell command>'
bb plugin config loom set doneRecord summary   # or full
```

- `doneHook` is a shell command that Loom runs once when a project moves to
  done. It runs in the project's checkout on the project's machine, with a
  2-minute limit. Empty, the default, turns the hook off.
- The command reads the record on standard input and gets six variables:
  `LOOM_PROJECT_SLUG`, `LOOM_PROJECT_NAME`, `LOOM_PROJECT_KEY`,
  `LOOM_PROJECT_URL` (the landed pull request, or empty), `LOOM_PROJECT_URLS`
  and `LOOM_RECORD` (`summary` or `full`). On a single-repo project
  `LOOM_PROJECT_URLS` holds the same pull request as `LOOM_PROJECT_URL`. On a
  multi-repo project it holds every repo's landed pull request, one per line in
  the spec's order, and `LOOM_PROJECT_URL` is its first line: the first repo's
  pull request, or the next repo's that has one when the first has none. A repo
  that never opened a pull request, such as one landed only with `--direct`,
  has no line.
- `doneRecord` chooses what it reads. With `summary`, the default, Loom starts
  one agent on the project's reviewer model that reads the full record and
  writes a short summary (goal, outcome, what was built, decisions, problems
  and fixes, follow-ups and files). The agent starts only when a hook is set.
  When it cannot start, fails or takes longer than 30 minutes, the hook reads
  the full record instead. With `full`, no agent runs.
- The feed says when the record was sent, or why the hook failed. A project
  finished before the hook was set is not sent; `bb loom report <slug> --send`
  sends a finished project's record, for a backfill or after a failure
  (human only).
- The hook runs with the PATH of bb's host process. When a tool is not found,
  give its absolute path.

Examples:

```sh
# Append every record to one file.
bb plugin config loom set doneHook 'cat >> "$HOME/notes/loom-$LOOM_PROJECT_SLUG.md"'

# Save it as a done Cortex task in the repository's lane.
bb plugin config loom set doneHook 'cortex add "Loom: $LOOM_PROJECT_NAME" --lane "$(cortex memory lane)" --status done -t loom --as "loom-$LOOM_PROJECT_SLUG" --body-file -'
```

## Safety

- Only plugin code moves a ticket, runs checks, merges or decides that work is done. A thread's role comes from the plugin's own table, never from thread metadata.
- Agents never merge or push. On the integration strategy nothing is pushed until the human runs `bb loom land`, and only `bb loom land --direct` pushes to the base branch, never with force and only after the `after_merge` checks pass on what it pushes.
- Workers and reviewers run in bb's full permission mode unless the spec sets `permission_mode`, because some providers, such as pi, accept no other mode. An approved spec keeps the mode it was approved with.
- The human's controls (`approve`, `start`, `pause`, `resume`, `archive`, `post`, `block`, `requeue`, `cancel`, `land`, `report --send`) refuse Loom's own planner, worker and reviewer threads with the code `loom_human_only`.
- The page's RPC changes state, and starts a planner thread, only when the call carries `confirm: true`, and it refuses calls from other plugins. bb cannot tell the page from an agent running `bb plugin rpc`, so the skill tells agents never to call Loom's RPC.

## How it works

- `src/states.ts` holds the project and ticket state maps; every move goes
  through one store method that updates the row and appends an event in a
  single transaction (`src/db/store.ts`). The `events` table refuses UPDATE and
  DELETE with triggers (`src/db/schema.ts`).
- `src/spec.ts` parses the spec with `smol-toml`, checks it with strict zod
  schemas, then applies the cross-field rules. `src/repos.ts` gives each repo
  its settings, filled in from the top level, and `src/checkouts.ts` finds each
  repo's checkout on the project's machine.
- `src/projects.ts` is the service: proposals, approval, lifecycle, the board's
  posts and the role lookup.
- `src/tools.ts` registers the agent tools and picks tools per role;
  `src/cli.ts` is `bb loom`; `src/bb-port.ts` is the one adapter over `bb.sdk`,
  faked in tests.
- `src/scheduler.ts` is pure: which tickets are ready, how many slots are free.
  `src/workers.ts`, `src/checks.ts`, `src/triage.ts`, `src/review.ts` and
  `src/merge.ts` are the engine's parts, and `src/engine.ts` is the control loop
  that ticks every 15 seconds, reconciles after a restart and handles bb's
  thread events.
- `host.ts` and `src/host/ops.ts` run on the machine that owns the checkout:
  git through argv, `gh` for pull requests, and check commands in their own
  process group.
- `src/metrics.ts` and `src/feed-text.ts` are pure; `src/reports.ts` reads them
  for the CLI and the page. `src/replay.ts` is pure too: it rewinds a project's
  rows to one event, for a rewound page, and builds the Timeline.
  `src/rpc.ts` serves the page and publishes
  `loom:changed` after a project's events and after any change that writes no
  event (`Store.changed`), at most once every 300 ms per project. A change
  outside any project, such as a new planning conversation, publishes
  `{ slug: null }`.
- `app.tsx` and `src/ui/` are the page. The app imports only types from
  `src/contract.ts`, so zod stays out of its bundle, and its charts are small SVG
  components. It also imports `src/spec-paths.ts` and `src/prompts.ts`, which
  import only types, so the notes preview is the text the planner receives.
  `src/spec-view.ts` serves one spec version to the page, parsed and compared
  with the one before, and `src/activity.ts` groups a ticket's posts, runs and
  threads into worker attempts for the ticket page.

## Credit

The structure follows
[bb-autoresearch](https://github.com/pascal-de-ladurantaye/bb-autoresearch)
(MIT): role-scoped tools re-checked against the plugin's own table, an
append-only events table with triggers, strict zod specs with reworded errors,
and a `BbPort` adapter faked in tests. The claim, retry and reconcile ideas come
from OpenAI's Symphony `SPEC.md`.

## Develop

```sh
npm install --registry https://registry.npmjs.org
npm test
npm run typecheck
bb plugin build
bb plugin install ./plugins/loom   # from this repository's root, to try it
```

The registry flag matters on machines whose configured package proxy cannot
serve the `@get-bb/plugin-sdk` tarball.
