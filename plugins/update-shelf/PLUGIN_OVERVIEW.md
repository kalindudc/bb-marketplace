bb marks a plugin with a waiting update on its own card, but the Installed page has no filter or grouping, so the updates are easy to miss among dozens of cards. Update Shelf adds one group to the top of that page instead of a separate view.

## What you get

- A **N plugins have updates** group above the Installed cards, listing every plugin with a waiting update and its installed and new version.
- **What's new** on each row: the sections of the plugin's CHANGELOG.md newer than the version you run, read from the new release on GitHub. When the changelog has no entry, it lists the commits that changed the plugin since your version, with a link to the full comparison on GitHub.
- **Update** on each row and **Update all** in the header (after one confirmation). Updates run through bb's own update queue, one at a time, with bb's compatibility checks and rollback.
- Progress and failures on each row: queued, the phase bb reports while it updates, and the reason with a Retry when an update fails or is rolled back.

## How it works

The backend reads the update state bb already keeps for each plugin, and the source bb records for it. Changelogs are read with the GitHub CLI when it is installed and signed in, so private repositories work; otherwise it falls back to GitHub's public API. A changelog is read only when you open What's new, and kept until the update changes.

## Requirements

- Changelogs come from GitHub sources only. Plugins from npm, other git hosts or a local path still show in the group and update normally, but What's new explains it has nothing to read.
- Private repositories need the GitHub CLI (`gh`) signed in on the machine running bb.
- bb has no plugin slot on the Installed page, so the group is placed next to the page's plugin cards by their markup. If a bb release changes that markup, the group stops appearing until this plugin is updated; bb's own page keeps working.
