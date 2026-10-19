---
name: vantage
description: Check on the child threads of a parent, or on every recent thread. `bb vantage worktrees` lists every child's worktree with its status, branch, commits ahead and behind, uncommitted files and the files two worktrees both changed; `bb vantage worktree <thread>` shows one worktree's files and commits; `bb vantage changes` groups everything the thread tree changed by repository, including archived children and files edited by absolute path in other repositories. Add `--all` to read every thread active in the last 24 hours, grouped by project; archived threads are left out unless `--archived` is added.
---

# Vantage

Vantage shows the worktrees of a thread and all of its descendant threads, and groups what they changed by repository. With `--all` it does the same for every thread active in a time window, not one tree. It reads only; it never stages, commits or edits anything.

## Check on every recent thread

    bb vantage worktrees --all               # every thread active in the window, grouped by project
    bb vantage worktrees --all --hours 6     # the last 6 hours instead of the setting
    bb vantage changes --all --json
    bb vantage worktrees --all --archived    # include archived threads

`--all` covers the threads active in the last 24 hours (the user's setting, 1 to 720 hours), plus any thread that is running and any thread archived in that window, newest first, up to the thread limit (200 by default). `--hours <n>` overrides the window for one call and needs `--all`. `--all` cannot be combined with `--thread`: that fails with `target_conflict`, and `--hours` without `--all` fails with `hours_requires_all`. The text output has a heading for each project, such as `Shop · 2 worktrees`, and says when it stopped at the thread limit. In the JSON, `target` is `{ "kind": "all" }`, `windowHours` is the window, `threadId` is empty, `truncatedThreads` says the limit cut the list, each `threads[]` entry has `rootThreadId` (the top of its tree among the threads read; a thread whose parent was not read is its own root), and each `repos[]` entry has `projectId`. A repository's result can be up to 60 seconds old, and `--all` is much faster on a second call because of that.

`--all` leaves out archived threads, as the full-screen page does, and counts them: when some were left out the text output ends with `N archived threads hidden (use --archived)`, and the JSON has `archivedHidden` (0 when they are included). `--archived` includes them, listed after the active ones, and needs `--all`; without it the command fails with `archived_requires_all`. A thread's own tree (`--thread`, the default thread, `bb vantage worktree`) always includes its archived children. `changes --json` also has `partial`, which is always false on the command line (true only in the page's quick first answer, where worktrees and repositories have `state` `loading` and no numbers).

## Check on parallel children

    bb vantage worktrees                     # the current thread's tree
    bb vantage worktrees --thread <id>       # another thread's tree
    bb vantage worktrees --json
    bb vantage worktree <thread>             # one thread's worktree: files and commits
    bb vantage worktree <thread> --json

`worktrees` prints one row for each workspace in the tree: the columns STATUS, THREAD, AHEAD/BEHIND, UNCOMMITTED and BRANCH, then the files that more than one worktree changed (a merge-conflict risk). STATUS is `archived` (an archived child's kept branch), `unavailable`, `running`, `failed`, or the thread's own status. A branch that no longer exists is not listed. `worktree <thread>` finds the whole tree the thread belongs to and prints each worktree that thread works in, its own workspace first and then any thread checkout: its uncommitted files, its files committed on the branch and its commits (at most 50 files of each kind and 20 commits, then `… N more`). It fails with `worktree_not_found` for a thread without a worktree.

### Worktree JSON fields

`worktrees --json` prints `{ threadId, target, windowHours, threads, archivedHidden, worktrees, sharedFiles }`; `worktree <thread> --json` prints one worktree, the thread's own workspace when it has one. A worktree has:

- `key`, `threadIds` (the threads in it, in tree order), `kind` (`workspace`, `branch` or `checkout`), `label` (the project's name) and `projectId`. A `checkout` worktree is a thread checkout: a checkout outside bb, such as a world tree from `dev tree add`, that a thread both edited a file in and ran commands in (`cd`, `pushd` or `git -C` with an absolute or `~/` folder). It is compared with `origin/HEAD`.
- `state` (`ready` or `unavailable`; `loading` only in the page's quick first answer) and `message` (why it is unavailable).
- `branch`, `base`, `aheadCount` and `behindCount` (commits ahead of and behind the base; null when there is no base).
- `uncommitted[]` and `committed[]`: `path`, `status`, `additions`, `deletions`, `previousPath`. An archived branch has no uncommitted files.
- `commits[]`: `sha`, `shortSha`, `subject`, `authorName`, `authoredAt` (milliseconds), newest first.
- `sharedFiles[]` at the top level: `path`, `projectId` and `worktreeKeys`, for files two or more worktrees of one project changed.
- `threads[]`: `id`, `title`, `status`, `archived`, `rootThreadId`, to name the threads in `threadIds`.

## Group the changes by repository

    bb vantage changes                       # the current thread, uncommitted changes
    bb vantage changes --thread <id>         # another thread
    bb vantage changes --scope branch        # everything since the base branch
    bb vantage changes --json                # the full overview

Without `--thread` or `--all`, the command uses the thread it runs in. Outside a thread it fails with the code `thread_required`.

## Repository kinds

- `workspace`: a thread's own workspace, read through bb's diff API (the same numbers as bb's Changes tab).
- `checkout` with `ref.worked: true` (caption "Thread checkout"): a checkout outside bb that a thread works in. Every change in it is in `files`, like a workspace, and it also has a worktree.
- `checkout` without `worked`: another checkout that an agent edited by path. Files the agents edited are in `files`; the repository's other changes are in `otherFiles` and are not the agents' work.
- `branch`: an archived child whose worktree bb removed. Vantage compares its branch with its base branch in the project checkout.
- `recorded`: no repository could be read, so the files come from the agents' recorded edits only. The same applies to `otherFiles` at the top level, which are files outside any repository such as thread storage or /tmp.

A file with status `clean` was edited by an agent and has no change now, for example because it was committed.

## JSON fields

Read these from `--json` output:

- `repos[].label`, `projectId`, `kind` (inside `ref.kind`), `branch`, `base`, `aheadCount` (commits on an archived branch), `state` (`ready` or `unavailable`) and `message` (why it is unavailable).
- `partial` and `archivedHidden` (see above).
- `repos[].files[]`: `path`, `status`, `additions`, `deletions`, `previousPath` for renames, and `edits.threadIds` for the threads that edited the file.
- `repos[].otherFiles[]`: changes in a checkout that the agents did not make.
- `repos[].threadIds` and `threads[]`: which threads touched the repository, with `title`, `archived` and `depth`.
- `otherFiles[]`, `warnings[]` (for example an unreachable machine) and `truncatedThreads`.

## Limits

- At most 500 files per repository or worktree list, 100 commits per worktree, 200 other files and 200 threads. Text output shows 50 files per repository and ends with `… N more`. JSON is cut from the end of each list to stay under bb's output limit.
- Shell-only work in another repository is found only in a thread checkout: one where the same thread also edited a file and changed into it with an absolute or `~/` folder. Elsewhere it is not found unless an agent also edited a file there.
- A machine that is offline marks only its own repositories as unavailable.
