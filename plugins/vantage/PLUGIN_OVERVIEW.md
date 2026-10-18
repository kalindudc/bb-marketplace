See how every child's worktree is doing from the parent thread, open any one of them to read its diffs, commits and conversation, and see everything the thread tree changed across repositories.

## What you get

- A Vantage tab in the thread's side panel, with a button in the thread header and a command in the palette. It opens on the Worktrees view.
- One row for each worktree in the thread tree: the parent's own checkout, every child's worktree, and the kept branch of every archived child. A row shows bb's status glyph (running, needs you, failed, finished), the branch, commits ahead and behind, uncommitted files, line counts and the pull request.
- A warning when files are changed in more than one worktree of a project, so you see a possible merge conflict before you merge.
- Click a row to open that worktree without leaving the parent. Changes shows uncommitted and committed files with diffs, Commits shows each commit and its files, and Chat shows the child's conversation, where you can approve a request or steer the agent.
- Terminal here opens a shell in the worktree's folder in the parent's terminal panel. Open thread opens the child in a split, and bb's own thread menu offers stop, archive and the rest. The keys [ and ] step between worktrees and Escape goes back.
- The Repositories view, one switch away, groups everything the thread tree changed by repository: thread workspaces, other checkouts agents edited by path, archived children's branches, and recorded edits for files outside any repository. A machine that is offline marks only its own part as unavailable.

## For agents

`bb vantage worktrees` prints one line for each worktree with its status, ahead and behind, uncommitted files and branch, then the shared files. `bb vantage worktree <thread>` prints one thread's files and commits. `bb vantage changes` prints the Repositories view. Each accepts `--json`, and `--thread <id>` reads another thread.

## How it works

Vantage only reads. It never stages, commits or changes a file, and it keeps nothing on disk except which view you chose. Each worktree's counts and commits come from one bb status call, and its status, title and pull request come from data bb's sidebar already loads. Other checkouts are read with git on the machine that owns them.

## Limits

- 500 files per list, 100 commits per worktree, 200 threads, and patches cut at 1 MiB.
- Terminal here needs a worktree on disk, on the same machine as the parent thread.
- Edits made only by shell commands in another repository are missed unless an agent also edited a file there.
