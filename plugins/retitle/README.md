# Retitle

A bb plugin that titles the threads bb's automatic titling leaves untitled, and
adds `bb retitle` to title any thread again. See
[PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what it does and its limits.

## Why it exists

bb titles a thread once, when it starts, and drops the title when its AI service
takes more than 8 seconds (`Thread title generation timed out` in
`~/.bb/logs/server.*.log`). Nothing retries it, and bb has no API to run its
titler again. bb also builds the title prompt from agent-only input parts, so a
`!plan` thread's title prompt is mostly the attached `plan.md` body.

## Develop

```sh
npm install && npm test && npm run typecheck && bb plugin build
bb plugin install "path:$PWD" --yes
bb plugin reload retitle   # after each build
```

The plugin logs each automatic title to `~/.bb/plugins/retitle/logs/plugin.log`.
