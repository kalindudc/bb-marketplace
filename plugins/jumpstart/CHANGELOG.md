# Changelog

Notable changes to Jumpstart, newest first. Releases are tagged `jumpstart/vX.Y.Z` in this repository.

## 0.1.0 (2026-11-05)

The first release: resume the threads a network blip stopped, from one button.

### Added

- A Resume failed threads button in the sidebar footer lists every failed thread that is not archived or hidden, newest failure first, with the error that stopped it and how long ago.
- Threads that stopped on a dropped connection, a timeout or an unavailable or overloaded provider start ticked; other failures, and threads that already have a message waiting, start unticked. All and None tick or untick every row.
- Resume retries the failed turn on each ticked thread through bb's own retry, a few threads at a time, and shows on each row whether it is resuming, queued and why, or could not resume.
- A thread whose agent process died or stopped answering is stopped before its retry, so bb starts a fresh agent on the same conversation instead of failing with "No active Pi session".
- The command palette command Jumpstart: resume failed threads opens the list.
- `bb jumpstart list` prints the failed threads, and `bb jumpstart kick` resumes the threads it is given, every network failure with `--network`, or every failed thread with `--all`.
