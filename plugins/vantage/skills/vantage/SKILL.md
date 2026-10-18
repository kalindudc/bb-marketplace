---
name: vantage
description: Check on the child threads of a parent. `bb vantage worktrees` lists every child's worktree with its status, branch, commits ahead and behind, uncommitted files and the files two worktrees both changed; `bb vantage worktree <thread>` shows one worktree's files and commits; `bb vantage changes` groups everything the thread tree changed by repository, including archived children and files edited by absolute path in other repositories.
---

# Vantage

Vantage shows the worktrees of a thread and all of its descendant threads, and groups what they changed by repository. It reads only; it never stages, commits or edits anything.

## Check on parallel children

    bb vantage worktrees                     # the current thread's tree
    bb vantage worktrees --thread <id>       # another thread's tree
    bb vantage worktrees --json
    bb vantage worktree <thread>             # one thread's worktree: files and commits
    bb vantage worktree <thread> --json

`worktrees` prints one row for each workspace in the tree: the columns STATUS, THREAD, AHEAD/BEHIND, UNCOMMITTED and BRANCH, then the files that more than one worktree changed (a merge-conflict risk). STATUS is `archived` (an archived child's kept branch), `unavailable`, `running`, `failed`, or the thread's own status. A branch that no longer exists is not listed. `worktree <thread>` finds the whole tree the thread belongs to and prints the worktree that thread works in: its uncommitted files, its files committed on the branch and its commits (at most 50 files of each kind and 20 commits, then `… N more`). It fails with `worktree_not_found` for a thread without a worktree.

### Worktree JSON fields

`worktrees --json` prints `{ threadId, threads, worktrees, sharedFiles }`; `worktree <thread> --json` prints one worktree. A worktree has:

- `key`, `threadIds` (the threads in it, in tree order), `kind` (`workspace` or `branch`) and `label` (the project).
- `state` (`ready` or `unavailable`) and `message` (why it is unavailable).
- `branch`, `base`, `aheadCount` and `behindCount` (commits ahead of and behind the base; null when there is no base).
- `uncommitted[]` and `committed[]`: `path`, `status`, `additions`, `deletions`, `previousPath`. An archived branch has no uncommitted files.
- `commits[]`: `sha`, `shortSha`, `subject`, `authorName`, `authoredAt` (milliseconds), newest first.
- `sharedFiles[]` at the top level: `path`, `projectId` and `worktreeKeys`, for files two or more worktrees of one project changed.
- `threads[]`: `id`, `title`, `status`, `archived`, to name the threads in `threadIds`.

## Group the changes by repository

    bb vantage changes                       # the current thread, uncommitted changes
    bb vantage changes --thread <id>         # another thread
    bb vantage changes --scope branch        # everything since the base branch
    bb vantage changes --json                # the full overview

Without `--thread`, the command uses the thread it runs in. Outside a thread it fails with the code `thread_required`.

## Repository kinds

- `workspace`: a thread's own workspace, read through bb's diff API (the same numbers as bb's Changes tab).
- `checkout`: another checkout that an agent edited by path. Files the agents edited are in `files`; the repository's other changes are in `otherFiles` and are not the agents' work.
- `branch`: an archived child whose worktree bb removed. Vantage compares its branch with its base branch in the project checkout.
- `recorded`: no repository could be read, so the files come from the agents' recorded edits only. The same applies to `otherFiles` at the top level, which are files outside any repository such as thread storage or /tmp.

A file with status `clean` was edited by an agent and has no change now, for example because it was committed.

## JSON fields

Read these from `--json` output:

- `repos[].label`, `kind` (inside `ref.kind`), `branch`, `base`, `aheadCount` (commits on an archived branch), `state` (`ready` or `unavailable`) and `message` (why it is unavailable).
- `repos[].files[]`: `path`, `status`, `additions`, `deletions`, `previousPath` for renames, and `edits.threadIds` for the threads that edited the file.
- `repos[].otherFiles[]`: changes in a checkout that the agents did not make.
- `repos[].threadIds` and `threads[]`: which threads touched the repository, with `title`, `archived` and `depth`.
- `otherFiles[]`, `warnings[]` (for example an unreachable machine) and `truncatedThreads`.

## Limits

- At most 500 files per repository or worktree list, 100 commits per worktree, 200 other files and 200 threads. Text output shows 50 files per repository and ends with `… N more`. JSON is cut from the end of each list to stay under bb's output limit.
- Edits made only by shell commands in another repository are not found unless an agent also edited a file there.
- A machine that is offline marks only its own repositories as unavailable.
