# Changelog

Notable changes to Vantage, newest first. Releases are tagged `vantage/vX.Y.Z` in this repository.

## 0.8.0 (2026-10-28)

### Changed

- The Vantage page no longer draws an overview beside the worktree list: the list is the only index. With no worktree in the address it opens the one that most needs a person, in order Waiting on you, Ready to review, Still working, Done, Unavailable, and rewrites the address to that worktree. Escape no longer goes back to an overview.
- Status names changed: Needs you became Waiting on you, To review became Ready to review, Working became Still working, Reviewed became Done, and the Overlaps chip became Shared files.
- A row is two lines with one plain sentence about why the worktree matters, such as "The agent asked you a question", "3 files to read" or "Shares README.md with Banner", instead of a line of commit and file counts. Review progress reads "2 of 5 files checked", and a Done row reads "All files checked".
- The summary above the composer counts child worktrees and shared files, such as "4 child worktrees · 1 waiting on you · 2 shared files". Expanded, it lists only the worktrees waiting on you or sharing a file, plus one row that opens the panel for the rest.
- The Info tab's Worktrees section shows counts for Waiting on you, Ready to review and shared files instead of the first three child worktrees, and each row opens the worktree it counts.
- The page header has an All changes button, and the sidebar above the search box gains a Worktrees heading with the number of worktrees that have changes.

### Fixed

- The page no longer selects a worktree and rewrites the address while the overview is still partial, so a slow load cannot leave a row selected before its data arrives.
- The empty state respects the active filter and says "No worktree matches the filter" instead of claiming nothing has changed, and its link reads "See every change by repository".

## 0.7.0 (2026-10-24)

### Added

- Diffs can wrap long lines instead of scrolling sideways, from a wrap button or `W`.
- The file tree nests files in folders that fold, joins a chain of folders holding only one folder into one row such as `src/ui/forms`, and keeps a folded row folded when a change scope joins or splits it. A folded folder shows how many files it holds and still carries the overlap mark, comment count and reviewed tick of the files inside.
- Vantage remembers view state on this device across reloads: the diff layout, wrapping, Collapse all, files folded by hand, each worktree's change scope, folded tree folders, folded list groups, whether the file tree shows, and Hide reviewed. Collapse all carries over to the next worktree you open.

### Changed

- Watch and Track reviews are gone. Vantage always shows each thread's real state, the one bb's sidebar shows, so Waiting-on-you rows, the strips, the composer summary and the Info section count every thread. Every file has a Reviewed tick, and progress with Hide reviewed appears once you tick one.
- Two settings replace the two defaults: "Badge the Vantage icon when a thread needs you" (on by default) and "Show a toast when a thread needs you" (off by default).
- The Changed group is now To review, and a worktree that cannot be read sits under a new Unavailable group instead of To review.

### Removed

- The Watch worktrees and Track reviews switches on the thread's Vantage tab, and the thread menu's Vantage entry that carried them.
- The `prefs` and `setThreadPref` RPCs and the `watchByDefault` and `reviewsByDefault` settings.

### Compatibility

- No migration. Reviewed marks and comment drafts from 0.6 are read as before; the per-thread watch and review choices stored by 0.6 are ignored.

## 0.6.2 (2026-10-24)

### Fixed

- A comment edited while its message was being sent is kept as a draft. Send used to remove the sent comments by id after bb accepted the message, so a comment edited in that moment lost its new text while the agent got the old text. Sending now removes only the comments exactly as they were sent, comparing text and quote as well as id.

## 0.6.1 (2026-10-24)

### Fixed

- Installing from the marketplace works again. 0.6.0 failed with "Could not resolve @get-bb/plugin-sdk" because the page took `defineRpcContract` from the SDK's root package, which a git install without dev dependencies does not have; the contract now uses a local copy that returns its argument. A test follows every file the app entry imports and fails if one takes a value from that root package.

## 0.6.0 (2026-10-24)

### Added

- The page's worktree list replaces bb's thread list while the page is open, grouped by what needs doing (Needs you, To review, Changed, Working, Reviewed, Archived) or by project, with search and filter chips. bb's title bar names the worktree and holds Refresh and the overlap count.
- An overview that says what to look at next, with counts and an Up next list, a Working list, overlapping files, reviewed worktrees and changes outside worktrees.
- A review with one switch for all, uncommitted, committed or one commit's changes, a file tree, and every diff in one stream, unified or side by side, with unchanged lines that expand and Collapse all and Expand all (`X`).
- Comments on a file, optionally quoting selected lines, collected into one message sent now or queued after the agent's current turn. The page's Agent tab shows that worktree's conversation in bb's own chat.
- An overlaps page for files two worktrees both changed, side by side, with a guess at whether merging will conflict made from the changed line ranges and a ready-made `Ask <agent> to rebase onto <other>` comment.
- In a thread, the Vantage tab gains All changes and the watch and review switches, a folded one-line summary above the composer shows once a child thread has changes, the Info tab has a Worktrees section, and the thread menu has "Review changes in Vantage".
- Watching (Needs you, the navigation badge and toasts) and reviews (reviewed ticks, progress, folding) are chosen per thread and inherited by child threads, with the settings "Watch every thread's worktrees" and "Track reviews in every thread", both off by default. Diffs and file lists work either way.
- A `fileSides` host call reads both sides of a file so unchanged lines can expand.

### Changed

- The Repositories view is replaced by All changes, which lists every change grouped by repository; an address saying `repositories` still opens it.
- Pull requests come from bb's GitHub PR Status plugin, and the thread tab uses `experimental_tab` because SDK 0.6.75 removed the old APIs.
- Watch and review choices and reviewed marks live in Vantage's plugin storage, and comment drafts in the browser's. Vantage still never stages, commits or changes a file.

### Security

- The `fileSides` host call reads only regular files inside the repository, and the untracked-file diff refuses paths that leave it through a symlinked folder.

### Compatibility

- Needs bb 0.47 and plugin SDK 0.6.75, up from bb 0.46 and SDK 0.6.49.

## 0.5.0 (2026-10-21)

### Added

- A worktree whose branch is its base branch reads `on base` instead of ↑0 ↓0 with no changes, and its row, Commits tab, `bb vantage worktree`, `bb vantage worktrees` and `bb vantage changes` list the commits its threads made there. The JSON gains `onBase` and `threadCommits`.
- Those commits come from the checkout's HEAD reflog, kept when one of the thread's `git commit` commands ran and dropped when they are no longer on HEAD, such as an amended commit; pulls, merges and rebases never count. Commits are matched by time, so a commit someone else makes in the same checkout during that window counts as the thread's, and a commit made by a command other than `git commit` is not found.

## 0.4.3 (2026-10-21)

### Fixed

- Agents get Vantage's bundled skill. bb reads each `bb.skills` entry as a folder that holds skill folders, and Vantage listed its one skill's own folder (`./skills/vantage`), so bb found no skill in it. It now lists `./skills`, and the marketplace build fails when a skills entry holds no skill folder with a `SKILL.md`.

## 0.4.2 (2026-10-20)

### Fixed

- On a phone the Vantage button is no longer drawn in bb's thread header, where it made the title shrink, covered the thread actions button and pushed the panel toggle off screen. The tab still opens from the right panel's tab list.

## 0.4.1 (2026-10-19)

### Fixed

- A workspace that bb's status or Branch-scope diff does not answer within 10 seconds is read with git on its machine instead, and stays that way until the server restarts. bb's status can take more than 30 seconds and time out on a repository far behind its base; git answered in under a second on one 110,000 commits behind.
- A workspace whose folder is below its repository root is grouped under that root, and its diffs, a commit's files and its file links are read there, because bb returns empty patches for it.
- An archived thread's kept branch is read in the folder the thread ran in when its project's folder is not a repository, or the project has none, instead of showing as unavailable or as recorded edits only.

## 0.4.0 (2026-10-19)

### Added

- A checkout a thread made and works in outside bb, such as a world tree from `dev tree add`, becomes a thread checkout. It gets a worktree row grouped with the thread's project, with its branch, commits ahead and behind `origin/HEAD`, its commits and every uncommitted and committed change, and the Repositories view lists its changes under "Thread checkout".
- The edit index notes every folder a thread's commands change into with `cd`, `pushd` or `git -C` and an absolute or `~/` path, the 32 most recent per thread. Folders are looked up only for threads that edited files outside their own workspace, and the host expands `~/` itself.
- `bb vantage worktree <thread>` prints every worktree the thread is in, its own workspace first and then any thread checkout.

### Changed

- A thread checkout is read through a new `checkoutStatus` host call that feeds both its worktree row and the Repositories view through the 60-second cache; a checkout only edited by path keeps the cheaper call. The page opens a thread checkout's terminal in its folder on its machine, and committed diffs and a commit's files now work for any checkout.
- The instant outline shows a thread checkout's row when earlier loads already know the edits and roots.

## 0.3.2 (2026-10-18)

### Changed

- Switching from Repositories to Worktrees and back clears the repository filter.

### Fixed

- The Repositories view no longer shows every repository when you came to it for one. Clicking a row under "Changed outside worktrees", or pressing the Repositories switch while a worktree is open, shows only that repository, or only the files outside any repository, with an "Only `<project>` · `<branch>`" chip whose × clears the filter.
- The summary line and Expand all count only what is shown. On the full-screen page the filter is part of the address (`repositories/repo/<key>` and `repositories/other-files`, also under `tree/<id>`), so back, forward and links keep it.

## 0.3.1 (2026-10-18)

### Fixed

- "Show archived (N)" is now an "Include archived (N)" checkbox beside "With changes only". Switching it no longer swaps the view for the quick outline: every active row keeps its place and its numbers while archived rows appear below them or disappear, and the rest reloads in the background.
- Archived rows get their own "Archived · `<project>`" groups after every active group, in the worktree list and on the page's Repositories view; the server lists them after the active rows and the summary counts them.
- Active threads come first under the thread limit, so including archived threads cannot push an active one off the page.
- With "With changes only" ticked, archived rows still being read wait behind one "Loading archived threads…" placeholder instead of flashing up and vanishing.

## 0.3.0 (2026-10-18)

### Added

- The side tab and the page answer a quick outline request first, so every worktree row and repository header draws at once with skeleton placeholders for the git numbers until the full result arrives.
- The page hides archived threads by default, with a "Show archived (N)" toggle remembered on the device; the thread tab keeps showing archived children.
- `bb vantage changes` and `bb vantage worktrees` gain `--archived` for use with `--all`.

### Changed

- The full result is faster: each workspace's status is read once for both views and starts as soon as the threads are known, git roots are remembered for ten minutes, the thread tab shares the page's 60-second cache, and archived threads skip the history scan. A cold full-screen load dropped from about 10 seconds to about 3 on 84 threads.

## 0.2.0 (2026-10-18)

### Added

- A full-screen Vantage page in bb's left navigation covering every thread active in the last 24 hours, anything running, and threads archived in that window. Its Worktrees view lists them by project with the selected worktree's changes, commits, chat and terminal beside the list on a wide window, and its Repositories view groups every changed repository by project.
- Project, text and "With changes only" filters narrow both views, and every view and selection has its own address, so back and forward work.
- A thread's Vantage tab gains an "Open full screen" button that opens the page on that thread's tree.
- `bb vantage changes` and `bb vantage worktrees` gain `--all` and `--hours`, and the time window and thread limit become settings: "Time window for the full-screen page (hours)", 1 to 720, default 24, and "Most threads on the full-screen page", 10 to 500, default 200.

### Changed

- The server caches each repository's result for up to 60 seconds, cleared early by thread and workspace events, so refreshes reload only what changed.

## 0.1.0 (2026-10-18)

### Added

- A Vantage tab in a thread's side panel with a Worktrees view: one row per workspace in the thread and its child threads, with live status, branch, commits ahead and behind, uncommitted files, line counts and the pull request, plus a warning for files changed in more than one worktree.
- Opening a row shows that worktree's changes and commits with diffs, the child thread's chat, a terminal in its directory and bb's thread menu, without leaving the parent thread.
- A Repositories view grouping everything the thread tree changed by repository: thread workspaces through bb's environment diff API, other checkouts agents edited by path through a host entry that runs git on that machine, archived children's kept branches, and recorded edits for files outside any repository.
- `bb vantage changes`, `bb vantage worktrees` and `bb vantage worktree` print the same for agents, and a Vantage button in the thread header opens the tab.
- Vantage only reads: it never stages, commits or changes a file.

### Compatibility

- Needs bb 0.46 and plugin SDK 0.6.49.
