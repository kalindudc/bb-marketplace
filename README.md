# kalindudc bb marketplace

A [bb](https://getbb.app) plugin marketplace for the plugins I build for my
own setup.

## Use it

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install follow-thinking@kalindudc
bb plugin update follow-thinking     # after a new release is tagged
```

You can also add `git:github.com/kalindudc/bb-marketplace@main` under
**Settings → Plugin marketplaces** and browse the **kalindudc** shelf in the
plugin store.

## Plugins

| Plugin | ID | What it does |
|---|---|---|
| [Follow Thinking](plugins/follow-thinking) | `follow-thinking` | Opens thinking blocks in the timeline automatically and keeps live thinking scrolled to its newest line. Toggle it from the thread header or the command palette. |

## Layout

```
marketplace.base.json   marketplace name, description and categories
entries/<id>.json       one store listing per plugin
plugins/<id>/           plugin source (a plugin can also live in its own repository)
scripts/build.mjs       checks the entries and writes marketplace.json
marketplace.json        generated; bb reads this file, so commit it
```

## Add a plugin

1. Put the plugin in `plugins/<id>/`. Its package name must be
   `bb-plugin-<id>`, and it needs `engines.bb` and a `PLUGIN_OVERVIEW.md`
   (at most 4000 characters, no `#` title).
2. Add `entries/<id>.json` by copying an existing entry. For a plugin in this
   repository, `source.git` uses this repository's URL,
   `"subdir": "plugins/<id>"` and `"tagPrefix": "<id>/"`.
3. Add a row to the table above.
4. Run `npm run build` and commit `marketplace.json` with the change.
5. Tag the first release (see below). Until a tag exists, the listing shows
   in the store but cannot be installed.

A plugin that lives in its own repository needs only steps 2 to 4, with
`source.git.url` pointing at that repository, or an `npm` source instead.

## Release a plugin

Entries follow semver tags scoped to each plugin, so pushing to `main` ships
nothing by itself:

```sh
# bump "version" in plugins/<id>/package.json and commit it to main, then:
git tag <id>/v0.2.0 && git push origin <id>/v0.2.0
```

Entries accept any `0.x` release (`>=0.1.0 <1.0.0`), so a release needs no
catalog change until 1.0. bb records the commit each tag points at and
refuses a tag that moves, so publish a fix as a new version.

## Develop

Each plugin is its own npm package:

```sh
cd plugins/<id>
npm install && npm test && npm run typecheck && bb plugin build
```

To run a working copy in bb, remove the marketplace install and install the
folder instead:

```sh
bb plugin remove <id>                  # also deletes the plugin's bb settings
bb plugin install "path:$PWD" --yes
bb plugin reload <id>                  # after each build
```

To preview changes to the listings, point bb at your checkout. Marketplace
names are unique on a machine, so swap the git source out and back:

```sh
bb marketplace remove kalindudc && bb marketplace add "path:$PWD"
# when done:
bb marketplace remove kalindudc && bb marketplace add git:github.com/kalindudc/bb-marketplace@main
```
