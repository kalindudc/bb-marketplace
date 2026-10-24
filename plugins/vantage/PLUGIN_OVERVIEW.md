See every worktree your parallel agents work in, review what each one changed, and send your comments back to the agent that made the change: on a full-screen page for every recent thread, or inside one thread.

## What you get

- A Vantage page in bb's left navigation. While it is open, its worktree list replaces bb's thread list: worktrees grouped by what needs doing (Needs you, To review, Changed, Working, Reviewed, Archived) or by project, with search and filter chips. bb's title bar says where you are.
- An overview that lists what to look at next, then one worktree at a time: one switch for all, uncommitted, committed or one commit's changes, a file tree, and every diff in one stream, unified or side by side, with unchanged lines you can expand. Collapse all and Expand all (or `X`) fold and open every file at once.
- Comments on files, optionally quoting selected lines. They collect into one message you preview, then send to the agent now or after its current turn. The agent's chat opens in the page's Agent tab.
- An overlaps page for files that two worktrees both changed, with a guess at whether merging will conflict and a ready-made "ask to rebase" comment.
- All changes: everything the threads changed, by repository, including checkouts agents edited by path, archived branches and files outside any repository.
- In a thread: a Vantage tab with the same list, review and All changes; a one-line summary above the composer that stays folded until you open it and shows only once a child thread has changes; a Worktrees section in the Info tab; and Vantage entries in the thread menu.
- Each worktree shows its branch, how far it is behind its base, its uncommitted files and commits, its pull request (from bb's GitHub PR Status plugin), and a terminal and copy path for its folder.

## Quiet by default

Vantage watches no thread and tracks no reviews until you ask.

- Watch a thread, from its menu, its Vantage tab or the summary above its composer, to see when its worktrees need you or fail: a Needs you group, a badge on the Vantage icon and a toast. Unwatched threads show none of this.
- Turn on reviews for a thread to tick files as reviewed, fold them away and see progress. A file that changes after you tick it shows as changed.
- Both choices cover a thread's child threads. Two settings make either the default for every thread.

Diffs and file lists work for every thread either way.

## For agents

`bb vantage worktrees` prints one line for each worktree, then the shared files. `bb vantage worktree <thread>` prints one thread's files and commits. `bb vantage changes` prints All changes. Each accepts `--json`; `--thread <id>` reads another thread, and `--all` (with `--hours <n>`) reads every recent thread, grouped by project, and `--archived` adds the archived ones.

## How it works

Vantage never stages, commits or changes a file. It keeps your watch and review choices and reviewed marks in its plugin storage, and comment drafts in the browser. Counts come from bb's status call; other checkouts are read with git on the machine that owns them. Results are kept for 60 seconds and reloaded where an agent's edit or a workspace change touched.

## Limits

- 500 files per list, 100 commits per worktree, patches cut at 1 MiB.
- Comments are per file, not per line. The conflict guess compares changed line ranges; it is not a real merge.
- A checkout outside bb gets its own row only after the thread has both edited a file in it and changed into it with `cd`, `pushd` or `git -C`.
