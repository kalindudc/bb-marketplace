# Forage

A bb plugin that gives every agent web search and web fetch as bb's own tools,
so calls render as timeline rows instead of raw tool calls. See
[PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what it does and its limits.

## Why it exists

The pi-web extension works well in the pi terminal, where it draws its own
result renderer. Under bb the same tool call arrived as an unlabeled generic
row with its markdown output shown literally. A bb plugin's tools are injected
into pi, Codex, Claude Code and ACP threads by bb itself and carry a
`presentation`, so the row gets a label, an icon and a duration without any
per-agent work.

## Layout

```
server.ts          wiring: settings, tools, CLI
src/settings.ts    setting descriptors -> WebConfig
src/tools.ts       the web_search and web_fetch registrations
src/format.ts      plain-text output for bb's monospace row body
src/cli.ts         bb forage status | clear
src/web/           the engine (search, fetch, html, net, config)
test/              engine tests (ported from pi-web) + the tools
```

`src/web/` is a copy of the pi-web extension's engine. Keep it dependency-free:
the only runtime dependency is zod, for tool parameters.

## Develop

```sh
npm install && npm test && npm run typecheck && bb plugin build
bb plugin remove forage                              # the marketplace copy, if installed
bb plugin install "path:$PWD" --yes
bb plugin reload forage                              # after each build
bb forage status
```

The plugin logs to `~/.bb/plugins/forage/logs/plugin.log`.
