# Update Shelf

Groups every plugin with a waiting update at the top of bb's **Plugins → Installed** page, with each one's
changelog from its source and one-click **Update** or **Update all**. There is no separate page: the group sits
between the page's toolbar and its plugin cards.

```sh
bb plugin install update-shelf@kalindudc
bb plugin update update-shelf               # after a new release is tagged
```

## What it shows

| Part | Where it comes from |
|---|---|
| Which plugins have an update | `bb.sdk.plugins.list()`: the same `updateState.availableVersion` bb uses for each card's Update signal |
| Version labels | The installed package version, and the release tag of the candidate (a short commit id when it tracks a branch) |
| What's new | The candidate's `CHANGELOG.md` sections newer than the installed version, otherwise the commits that touched the plugin's directory since the installed commit |
| Progress | `bb.sdk.plugins.experimental_updateJobs.list()`: each job's place in the queue, its phase with the seconds so far, and how it finished. bb keeps finished jobs for ten minutes, and so does the group |

Updates start with `bb.sdk.plugins.experimental_startUpdate`, so they go through bb's own queue (one at a time),
its compatibility checks and its rollback. **Update all** asks once, then starts every update that is not already
running; this plugin is always updated last, because updating it reloads its backend.

bb runs one update at a time, and each takes about a minute: it downloads and builds the new version, activates it,
then watches it for 30 seconds (`checking`) and rolls back if it fails. bb clears the plugin's waiting update when it
starts activating, so the group keeps each job's versions from when it was queued and keeps its row until bb forgets
the job.

## Changelogs

- Sources on github.com only. The backend runs `gh api` (your sign-in, so private repositories work) and falls back
  to the anonymous public API when `gh` is missing or signed out.
- Commits are listed from the candidate commit by path, since the installed commit's date. GitHub's compare endpoint is
  not used: it returns the oldest commits of a range first and stops at 250, so in a busy monorepo a plugin's own commits
  fall outside it.
- Version sections are headings that start with a version: `## 1.2.0`, `## [1.2.0] - 2026-10-01`, `## v1.2.0 (date)`.
- A changelog is read when What's new is opened, and cached per installed and candidate commit until bb restarts the
  plugin. A failed read is not cached.

## How it attaches to the page

bb has no slot on the Installed page, so an `experimental_appOverlay` watches the page for its plugin cards
(`[data-testid^="plugin-row-"]`) and portals the group into an element placed just before their grid. That selector,
in `src/anchor.ts`, is the only part of bb's markup this plugin depends on. If a bb release renames it, the group stops
appearing and bb's page is unaffected. The test ids ship in bb's production bundle (checked against bb 0.47.1).

## Develop

```sh
npm install
npm test          # vitest
npm run typecheck
bb plugin build .
```
