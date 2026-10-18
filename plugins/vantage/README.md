# Vantage

A bb plugin for a parent thread that runs many agents at once. Its side-panel
tab shows how every child's worktree is doing, lets you look inside any one of
them without leaving the parent, and groups everything the thread tree changed
by repository. Open it from the thread header, from the palette ("Vantage:
Show changes across repositories") or from the thread's side-panel tabs. The
command has no default shortcut; you can bind one under Settings, Keyboard.

bb's Changes tab shows the diff of one thread's own workspace. Agents often
work beyond it: a parent spawns child threads in their own worktrees, agents
edit files in other repositories by absolute path, and bb removes a child's
worktree when the child is archived. Vantage gathers all of that for the thread
and every descendant, archived and hidden children included. A switch at the
left of the toolbar chooses between two views, and the choice is remembered on
this device.

## The Worktrees view

This is the default. It lists one row for each workspace in the thread tree:
the parent's own checkout (it reads "This thread"), every child's worktree, and
the kept branch of every archived child. A row shows bb's own status glyph
(running, needs you, failed, finished), the branch, how many commits it is
ahead of and behind its base branch, how many files are uncommitted, the line
counts and the pull request, if there is one. Rows are grouped by project. A
banner warns when files are changed in more than one worktree of the same
project, because those branches may conflict when merged; it opens to list the
files and the threads. Repositories that agents edited by path, and files
outside any repository, are listed under "Changed outside worktrees" and link
to the Repositories view.

Click a row to open that worktree inside the parent's panel:

- **Changes** lists the uncommitted files and the files committed on the
  branch, each with its diff, and marks a file that other worktrees also
  changed.
- **Commits** lists the commits ahead of the base branch. Open one to see its
  files and their diffs.
- **Chat** shows the child's conversation in bb's own chat component, so you
  can approve a request or steer the agent from there. The parent's own row has
  no Chat tab.
- **Open thread** opens the child in a split pane. **Terminal here** starts a
  shell in the worktree's folder in the parent's terminal panel; it needs a
  worktree on disk, on the same machine as the parent thread. **Copy path**
  copies the folder. The ⋯ button is bb's own thread menu (stop, archive and
  the other usual actions).
- `[` and `]` step to the previous and next worktree, and Escape returns to the
  list. The keys do nothing while you type in a text field.

## The Repositories view

A toolbar with a summary ("3 repos · 12 files · +120 −30 · 5 threads"), a scope
switch, Expand all and Refresh, then one section for each repository. A section
header has the repository's project name, its branch, a caption, the totals and
a chip for every thread that touched it. A chip opens that thread in a split;
an archived thread's chip has an archive mark. Open a file to see its diff in
bb's own viewer.

| Kind | Caption | Where it is read from |
| --- | --- | --- |
| Thread workspace | Thread workspace | bb's environment diff API, so the numbers match the Changes tab |
| Another checkout an agent edited by path | Edited by path | git, on the machine that owns the checkout |
| An archived child's branch | Archived branch · N commits | git in the project checkout, comparing the branch with its base branch |
| No repository could be read | Recorded edits only | the file edits bb keeps in each thread's history |

In a checkout, the files the agents edited come first. The repository's other
changes sit under a folded "N other changes in this repo" row, so changes made
by commands such as code generators are not lost and your own unrelated edits
stay out of the way. A file that an agent edited but that has no change now
(for example because it was committed) is listed as clean, and opening it
shows the agent's recorded edits. Files outside any repository, such as thread
storage or /tmp, are listed under "Other files" the same way.

The switch chooses between **Uncommitted** (working-tree changes) and **Branch**
(everything since the base branch). The tab refreshes within about two seconds
of an agent's edit and on the Refresh button. A machine that is offline, or a
repository that fails, marks only its own section as unavailable; the rest
still shows.

## For agents

```sh
bb vantage worktrees                  # one row per worktree of the current thread's tree
bb vantage worktrees --thread <id>    # another thread's tree
bb vantage worktrees --json
bb vantage worktree <thread>          # that thread's worktree: files and commits
bb vantage worktree <thread> --json
bb vantage changes                    # the Repositories view, as text
bb vantage changes --thread <id>      # another thread
bb vantage changes --scope branch     # everything since the base branch
bb vantage changes --json             # the full overview
```

`worktrees` prints the columns STATUS, THREAD (cut at 30 characters),
AHEAD/BEHIND, UNCOMMITTED and BRANCH, then the files changed in more than one
worktree. The status is `archived`, `unavailable`, `running`, `failed` or the
thread's own status. `worktree <thread>` reads the whole tree the thread belongs
to and prints the worktree the thread works in: at most 50 uncommitted and 50
committed files, then `… N more`, and at most 20 commits.

`worktrees --json` prints `{ threadId, threads, worktrees, sharedFiles }`.
Each worktree has `key`, `threadIds`, `state` (`ready` or `unavailable`),
`message`, `branch`, `base`, `kind` (`workspace` or `branch`), `aheadCount`,
`behindCount`, `uncommitted`, `committed` and `commits`; `sharedFiles` lists
`path` and `worktreeKeys`. `worktree <thread> --json` prints one worktree object.

The text output of `changes` lists each repository with its kind, branch,
totals and the titles of the threads that touched it, then at most 50 files and
a `… N more` line, then other files and warnings. `changes --json` prints the
overview; the fields agents read are `repos[].label`, `ref.kind`, `branch`,
`files`, `otherFiles`, `threadIds` and `state`, plus the `worktrees` and
`sharedFiles` above. The bundled skill (`skills/vantage`) describes them. All
the commands keep their output under bb's limit by cutting files from the end.

## Install

After the first release is tagged:

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install vantage@kalindudc
```

## How it works

Vantage only reads. It never stages, commits or changes a file, and it keeps
nothing on disk.

- The thread tree comes from `threads.get` and `threads.experimental_listDescendants`.
- A thread's own workspace uses `environments.diffFiles` and `diffPatch`.
- Each worktree's branch, commits ahead and behind, and uncommitted and
  committed files come from one `environments.status` call, plus
  `diffFiles` and `diffPatch` for a commit's files and diffs. An archived
  child's branch gets the same numbers from git on the host.
- A row's status, title and pull request come from the data bb's own sidebar
  already loads, so they cost no extra requests.
- Other checkouts and archived branches are read by a host entry (`host.ts`),
  plugin code that bb runs on the machine that owns the repository. It runs
  `git` with `GIT_OPTIONAL_LOCKS=0`, so it never takes the index lock that
  agents running git need, and it checks every path and ref before use.
- Edits made outside a workspace come from each thread's recorded `fileChange`
  events. The server keeps an in-memory index per thread and reads only new
  events on each refresh.
- To place a path in a repository, the host asks git itself
  (`rev-parse --show-toplevel --show-prefix`) instead of comparing path
  prefixes, so `/tmp` and `/private/tmp` agree on macOS.
- The panel refreshes on bb's thread, environment and connection events, with
  at most one request at a time and 1.5 seconds between requests.
- "Terminal here" creates a terminal scoped to the parent thread, because bb
  shows a thread only its own terminals, and starts `cd <folder> && exec $SHELL -l`
  in it.

## Limits

- At most 500 files per repository or worktree list, 100 commits per worktree,
  200 shared files, 200 other files and 200 threads in a tree; patches are cut
  at 1 MiB and recorded diffs at 60,000 characters.
- When a child is archived, bb keeps its worktree on disk for about five
  minutes. Vantage lists it as a worktree (marked archived) during that time,
  then as the kept branch. Uncommitted work is removed with the worktree, so
  only committed work remains.
- A branch that no longer exists is not a worktree, so it is not listed; its
  recorded edits show in the Repositories view.
- Titles and statuses come from bb's sidebar. A thread bb does not list in it
  (a hidden one, or an archived page that was not loaded) shows the title the
  thread tree gave it, with no status.
- Edits are found only from recorded file edits. Changes an agent makes only
  with shell commands in another repository are missed unless an agent also
  edited a file there.
- An archived child's branch is read from the project checkout, which is where
  bb's git-worktree provider leaves it. When the branch no longer exists,
  Vantage shows the recorded edits instead.
- Git must be installed on the machine that owns each repository.

## Develop

```sh
cd plugins/vantage
npm install
npm test
npm run typecheck
npm run build    # bb plugin build
```

With explicit permission to change the local bb plugin installation, a
working copy can be installed and reloaded from this directory:

```sh
bb plugin remove vantage
bb plugin install "path:$PWD" --yes
bb plugin reload vantage
```

## Release

After review, bump the package version for later releases, merge to an
up-to-date `main`, and tag that version. The first release uses:

```sh
git tag vantage/v0.1.0 && git push origin vantage/v0.1.0
```
