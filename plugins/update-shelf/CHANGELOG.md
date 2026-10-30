# Changelog

Notable changes to Update Shelf, newest first. Releases are tagged `update-shelf/vX.Y.Z` in this repository.

## 0.3.0 (2026-10-28)

### Added

- The Installed page now shows that the group is reading, so a page with nothing to report no longer looks like a plugin that isn't working:
  - A skeleton in the group's place while the first read is out. It appears only if that read takes longer than 200 ms, so a fast one never flashes it.
  - checked just now, then checked 12 s ago and checked 2 min ago, beside the title, ticking once a second.
  - Checking… with a spinner while a read is in flight, shown only once it takes 300 ms so the label doesn't flicker on every poll.
  - With nothing waiting, one quiet line — **No plugin has an update waiting · checked just now** — in place of the group, instead of the page looking as though this plugin were absent.

## 0.2.1 (2026-10-28)

### Changed

- One runtime dependency, pinned: `zod` 4.6.6. `@radix-ui/react-slot` is gone; nothing used it.

### Fixed

- What's new no longer says "No changelog entry or commits" when it couldn't read them. When the commits couldn't be read (for example in a private repository without the GitHub CLI signed in), or the changelog couldn't be read, it now says so with the reason and a Try again, and the partial result is no longer kept until bb restarts.
- Only a source whose host is github.com itself is read from GitHub. A host or path that merely contains `github.com`, such as `notgithub.com` or `git.example.com/mirrors/github.com/…`, was read as a GitHub repository, which could show another project's changelog.
- An open What's new reads the changelog again when bb offers a newer version while the page is open, instead of keeping the previous version's notes.

## 0.2.0 (2026-10-28)

### Added

- While updates run, the header shows how many are done ("Updating plugins · 3 of 7 done") with a progress bar, and explains why each takes about a minute.
- Each row says where its update is: "Queued · next" or "Queued · 3rd in line"; "Downloading and building", "Starting the new version" or "Checking the new version · 12 of 30 s" with the seconds so far; then "Updated", "Already up to date", "Rolled back" or "Failed" with the reason and a Retry.
- Clear finished removes the finished rows for the rest of the session.

### Fixed

- Update all no longer looks stuck. bb clears a plugin's waiting update as soon as it starts activating the new version, then watches that version for 30 seconds before it keeps it. The group listed only plugins with a waiting update, so the update that was running disappeared and only the queued ones were left, unchanged for a minute at a time. The group now keeps a row for every update in bb's queue and every update that finished in the last ten minutes.
- The group asks bb for the list one request at a time. It used to ask every 2 seconds whether or not the last answer had come back, so while bb was busy building an update the requests piled up.

## 0.1.0 (2026-10-28)

### Added

- A group at the top of bb's **Plugins → Installed** page that lists every plugin with a waiting update: its name, the installed version and the new one. It is the same set of plugins bb marks with an Update signal on their cards, gathered in one place, so an update is no longer lost among dozens of cards or on a page of cards that has not loaded yet. It is not a separate page: it sits between the page's toolbar and its cards, and leaves bb's own cards, filters and Update dialog as they are.
- What's new on each row reads the new release's changelog from its source:
  - the sections of the plugin's `CHANGELOG.md` newer than the installed version, rendered like a chat message;
  - when the changelog has no entry for the release, the commits that changed the plugin's directory since the installed commit, each linked to GitHub;
  - a link to the full comparison on GitHub.
  It reads GitHub with the GitHub CLI when it is signed in, so private repositories work, and otherwise with GitHub's public API. A changelog is read only when a row is opened, and kept until the update changes.
- Update on each row, and Update all in the group's header after one confirmation. Both go through bb's own update queue, one plugin at a time, with bb's compatibility checks and rollback. Update Shelf updates itself last, because that reloads it.
- Each row shows its update's progress: queued, the phase bb reports while it updates, or the reason it failed or was rolled back, with a Retry.
