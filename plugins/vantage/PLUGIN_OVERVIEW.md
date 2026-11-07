See every worktree your parallel agents work in, review what each one changed, and send your comments back to the agent that made the change: on a full-screen page for every recent thread, or inside one thread.

## What you get

- A Vantage page in bb's left navigation. Its worktree list replaces bb's thread list while it is open, grouped by what needs doing (Waiting on you, Ready to review, Still working, Done) or by project, with search and filters. Each row gives the thread, its line counts and one plain sentence such as "Shares README.md with Banner".
- One worktree at a time: the page opens the one that needs you first, with a switch for all, uncommitted, committed or one commit's changes, a folding file tree, and every diff in one stream, unified or side by side, with expandable context and wrapping (`W`). An image change renders as pictures — Before and After, each clickable full size — instead of "Binary file". Collapse all (`X`) and what you fold are remembered.
- Comments on files, optionally quoting lines, sent to the agent as one message now or after its turn. The page's Agent tab holds its chat.
- An overlaps page for files two worktrees both changed, with a guess at whether merging will conflict and an "ask to rebase" comment.
- All changes: everything the threads changed, by repository, including checkouts edited by path and archived branches.
- In a thread: a Vantage button in the header that opens a tab on a strip of its worktrees, its own first; a Worktrees section in bb's thread context card, which bb shows only when the pane has room; without the card, a small segment above the composer that shrinks to its numbers when the row is full; counts in the Info tab; and an optional line under each sidebar row.

## Honest counts

- Vantage compares each worktree with the closest base: the base bb records, that branch on origin, origin's default branch, origin/main or origin/master, whichever the branch is fewest commits ahead of. A checkout compared with a stale `master` no longer counts thousands of commits it did not make.
- A branch far ahead of its base whose threads made few of those commits shows and counts only their commits and the uncommitted files.
- An untracked folder with many files, or one holding a clone, is one entry no count includes.
- A worktree's numbers belong to its own thread; read-only reviewers beside it are only named.
- The review says when any of this applied, with a button to see the whole branch. Four settings change the rules.

## Nothing to turn on

- Every thread shows its real state, the one bb's sidebar shows, and every file has a Reviewed tick that folds it away and shows as changed if the file changes again.
- Two settings choose the alerts: a badge counting threads that need you (on) and a toast when one starts waiting (off).

## For agents

`bb vantage worktrees` prints one line per worktree, then the shared files; `bb vantage worktree <thread>` one thread's files and commits; `bb vantage changes` All changes. Each takes `--json`, `--thread <id>`, and `--all` with `--hours <n>` and `--archived`.

## How it works

Vantage never stages, commits or changes a file. It reads git on the machine that owns each repository and keeps results for 60 seconds, reloading where an agent's edit or a workspace change touched. Reviewed marks live in its plugin storage; drafts and view choices in the browser. Needs bb 0.48.1. With Vantage, `bb plugin config bb--git set showGitChanges false` leaves one summary per thread.

## Limits

- 500 files per list, 100 commits per worktree, patches cut at 1 MiB, image sides sent at 8 MiB.
- Comments are per file. The conflict guess compares line ranges, not a real merge.
- A checkout outside bb gets a row once a thread both edited a file in it and changed into it with `cd`, `pushd` or `git -C`.
