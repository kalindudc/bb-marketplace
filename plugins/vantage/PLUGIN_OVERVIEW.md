See what your agents changed. Review their worktrees in a thread or on the Vantage page, then send comments to the agent that made the change.

## What you get

- In a thread, the Trail shows its descendants and distinguishes checkout Git from edits each thread recorded. Pick a source to see its collapsible file tree, or hide the navigator to focus on diffs.
- The Vantage page in bb's navigation lists recent worktrees by what needs doing: Waiting on you, Ready to review, Still working or Done. Search or group by project. All changes groups the work by repository, and Overlaps shows which worktrees edited the same files.
- Review uncommitted changes, committed changes or one commit. Read unified or side-by-side diffs, expand unchanged lines and open before-and-after images. Mark files Reviewed to fold them away until they change again.
- Quote lines and send your comments as one message to the thread now or after its current turn. Archived threads can show a retained branch or recorded edits. Copy your review when you cannot send it.
- The thread context card, composer summary, Info tab and sidebar can show worktree counts. An optional toast tells you when a thread starts waiting for you.

## What counts as a thread's work

Vantage can compare a worktree with the closest base branch instead of counting history its threads did not write. Untracked folders with many files and nested clones are shown as single entries and left out of the counts. The review shows when it left out old commits and offers to show the whole branch.

Vantage reads Git on the machine that owns the repository. It never stages, commits or changes files. It caches Git results for up to 60 seconds and invalidates them on workspace changes. Review marks live in plugin storage; drafts and view choices stay in the browser.

## Exclude checkouts from Git reads

- `excludedPaths`: Absolute folder paths or paths like `~/checkouts`. The host expands `~` to its own home directory. The exclusion covers descendants and resolved aliases.
- `excludedProviders`: Exact bb environment provider IDs whose checkouts Vantage should not read with Git.

Both settings are empty by default. Use one item per line or separate items with commas. Live Git is unavailable for excluded checkouts, but recorded edits can still be reviewed.

An exclusion keeps Git out of the folder and everything below it. Git run at a repository root above an excluded folder still walks it, so exclude the repository root to keep Git out of the whole checkout.

## Limits

- 2,000 files per list and 100 commits per worktree. Patches are cut at 1 MiB, a file over 1 MiB on either side gets no diff, and image sides are shown up to about 3 MiB.
- Comments are per file. The overlap check compares line ranges, not a real merge.
- A checkout outside bb gets a row once a thread both edited a file in it and changed into it with `cd`, `pushd` or `git -C`.

## For agents

`bb vantage worktrees` lists worktrees and overlaps. `bb vantage worktree <thread>` shows a thread's files and commits. `bb vantage changes` groups changes by repository. Use `--json` for structured output or `--all` for recent threads across projects.

## Install

Requires bb 0.49 or later.

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install vantage@kalindudc
```
