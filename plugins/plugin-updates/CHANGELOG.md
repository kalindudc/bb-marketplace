# Changelog

Notable changes to Plugin Updates, newest first. Releases are tagged `plugin-updates/vX.Y.Z` in this repository.

## 0.1.0 (2026-10-28)

### Added

- A group at the top of bb's **Plugins → Installed** page that lists every plugin with a waiting update: its name, the installed version and the new one. It is the same set of plugins bb marks with an Update signal on their cards, gathered in one place, so an update is no longer lost among dozens of cards or on a page of cards that has not loaded yet. It is not a separate page: it sits between the page's toolbar and its cards, and leaves bb's own cards, filters and Update dialog as they are.
- **What's new** on each row reads the new release's changelog from its source:
  - the sections of the plugin's `CHANGELOG.md` newer than the installed version, rendered like a chat message;
  - when the changelog has no entry for the release, the commits that changed the plugin's directory since the installed commit, each linked to GitHub;
  - a link to the full comparison on GitHub.
  It reads GitHub with the GitHub CLI when it is signed in, so private repositories work, and otherwise with GitHub's public API. A changelog is read only when a row is opened, and kept until the update changes.
- **Update** on each row, and **Update all** in the group's header after one confirmation. Both go through bb's own update queue, one plugin at a time, with bb's compatibility checks and rollback. Plugin Updates updates itself last, because that reloads it.
- Each row shows its update's progress: queued, the phase bb reports while it updates, or the reason it failed or was rolled back, with a Retry.
