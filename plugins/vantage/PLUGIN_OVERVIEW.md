See how every agent's worktree is doing, open any one of them to read its diffs, commits and conversation, and see everything your threads changed across repositories: for one thread's tree in its side panel, or for every recent thread on a full-screen page.

## What you get

- A Vantage tab in a thread's side panel, with a thread header button (not on phones) and a palette command. It opens on the Worktrees view.
- One row for each worktree in the thread tree: the parent's own checkout, every child's worktree, and the kept branch of every archived child. A row shows bb's status glyph (running, needs you, failed, finished), the branch, commits ahead and behind, uncommitted files, line counts and the pull request.
- A row for a checkout a thread made outside bb, such as a clone made from a shell, once the thread both edited a file in it and ran commands in it, with every change in it, even ones made by shell commands.
- A thread working on its base branch, such as `main`, reads "on base" and lists the commits it made there.
- Works with any environment provider, including ones that place a thread in a repository's subfolder or keep its folder after archiving.
- A warning when files are changed in more than one worktree of a project, so you see a possible conflict before you merge.
- Click a row to open that worktree. Changes shows uncommitted and committed files with diffs, Commits shows each commit and its files, and Chat shows the child's conversation, where you can approve a request or steer the agent.
- Terminal here opens a shell in the worktree's folder. Open thread opens the child; bb's thread menu offers stop, archive and more. The keys [ and ] step between worktrees and Escape goes back.
- The Repositories view groups everything the thread tree changed by repository: thread workspaces, other checkouts agents edited by path, archived children's branches, and recorded edits for files outside any repository.
- A full-screen Vantage page in bb's left navigation covers every thread active in the last 24 hours, plus anything running and threads archived in that time. The worktree list, grouped by project, sits on the left; the selected worktree's changes, commits, chat and terminal on the right. Filter by project, by text, or to worktrees with changes only. Each view has an address, so back and forward work. "Open full screen" in a thread's tab opens the page for just that thread's tree.
- Both views paint every row at once and fill in the git numbers as they arrive. The page starts without archived threads; ticking "Include archived" adds them below the active ones without touching the active rows, and the side tab includes them by default.

## For agents

`bb vantage worktrees` prints one line for each worktree, then the shared files. `bb vantage worktree <thread>` prints one thread's files and commits. `bb vantage changes` prints the Repositories view. Each accepts `--json`; `--thread <id>` reads another thread, and `--all` (with `--hours <n>`) reads every recent thread, grouped by project, and `--archived` adds the archived ones.

## How it works

Vantage only reads. It never stages, commits or changes a file. A workspace's counts come from one bb status call that both views share, and its status and pull request from data bb's sidebar already loads. Other checkouts are read with git on the machine that owns them. Results are kept for 60 seconds and reloaded where an agent's edit or a workspace change touched; git roots for 10 minutes. Two settings tune it: the time window (24 hours) and the thread limit (200).

## Limits

- 500 files per list, 100 commits per worktree, patches cut at 1 MiB.
- Terminal here needs a worktree on disk, in the side panel on the thread's machine.
- A checkout outside bb gets its own row only after the thread has both edited a file in it and changed into it with `cd`, `pushd` or `git -C` and an absolute or `~/` path. Shell-only work in a repository the thread never edited is still missed.
