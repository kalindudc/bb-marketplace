See every worktree your parallel agents work in, review what each one changed, and send your comments back to the agent that made the change: on a full-screen page for every recent thread, or inside one thread.

## What you get

- A Vantage page in bb's left navigation. While it is open, its worktree list replaces bb's thread list: worktrees grouped by what needs doing (Waiting on you, Ready to review, Still working, Done, Unavailable, Archived) or by project, with search and filter chips. Each row is two lines: the thread and its line counts, then one plain sentence such as "The agent asked you a question" or "Shares README.md with Banner". bb's title bar says where you are.
- One worktree at a time, never a second index beside the list: the page opens the worktree that needs you first, then one switch for all, uncommitted, committed or one commit's changes, a file tree with folders that fold, and every diff in one stream, unified or side by side, with unchanged lines you can expand and long lines that can wrap (`W`). Collapse all and Expand all (or `X`) fold and open every file at once. Vantage remembers these choices, and what you fold, across reloads.
- Comments on files, optionally quoting selected lines. They collect into one message you preview, then send to the agent now or after its current turn. The agent's chat opens in the page's Agent tab.
- An overlaps page for files that two worktrees both changed, with a guess at whether merging will conflict and a ready-made "ask to rebase" comment.
- All changes: everything the threads changed, by repository, including checkouts agents edited by path, archived branches and files outside any repository.
- In a thread: a Vantage tab with the same list, review and All changes; a one-line summary above the composer that stays folded until you open it and shows only once a child thread has changes; a Worktrees section in the Info tab; and "Review changes in Vantage" in the thread menu.
- Each worktree shows its branch, how far it is behind its base, its uncommitted files and commits, its pull request (from bb's GitHub PR Status plugin), and a terminal and copy path for its folder.

## Nothing to turn on

- Every thread shows its real state, the one bb's sidebar shows: a thread waiting for your answer or with a failed turn is under Waiting on you.
- Every file has a Reviewed tick. A ticked file folds away, and a worktree shows its progress once you tick one of its files. A file that changes after you tick it shows as changed.
- Two settings choose the alerts: a badge on the Vantage icon counting threads that need you (on by default) and a toast when one starts waiting (off by default).

## For agents

`bb vantage worktrees` prints one line for each worktree, then the shared files. `bb vantage worktree <thread>` prints one thread's files and commits. `bb vantage changes` prints All changes. Each accepts `--json`; `--thread <id>` reads another thread, and `--all` (with `--hours <n>`) reads every recent thread, grouped by project, and `--archived` adds the archived ones.

## How it works

Vantage never stages, commits or changes a file. It keeps reviewed marks in its plugin storage, and comment drafts and view choices in the browser. Counts come from bb's status call; other checkouts are read with git on the machine that owns them. Results are kept for 60 seconds and reloaded where an agent's edit or a workspace change touched.

## Limits

- 500 files per list, 100 commits per worktree, patches cut at 1 MiB.
- Comments are per file, not per line. The conflict guess compares changed line ranges; it is not a real merge.
- A checkout outside bb gets its own row only after the thread has both edited a file in it and changed into it with `cd`, `pushd` or `git -C`.
