# Agent Commands

A bb plugin that makes the prompt files in `~/.agents/commands` usable from
every bb composer. See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what users
get.

## How it works

`server.ts` registers two things and has no frontend bundle:

- A mention provider on the `!` trigger. `search` lists the folder on every
  keystroke and ranks name prefixes first, then name matches, then description
  matches. `resolve` reads the picked file again at send time and returns its
  body as agent-only context. A file deleted after it was picked blocks the send
  with an error that names the missing path.
- An agent configuration callback. It adds a short list of `/name` commands
  and how to run them to every thread's instructions, so agents that do not
  know the folder can still run a typed `/name`. It adds nothing to pi
  threads when `~/.pi/agent/prompts` resolves to the same folder, because pi
  expands its own prompt templates there. bb caps the text at 4096 characters;
  the list stops early and says how many commands it left out.

`src/commands.ts` holds the file parsing, search and text building, and follows
pi's prompt-template rules for names and descriptions.

## Why `!` and not `/`

bb builds the `/` menu from its own built-in commands, from skills, and from
command folders that only a provider plugin can declare
(`experimental_nativeCommandRoots`). Mention providers accept `@`, `#`,
`$`, `!` and `~`, so a non-provider plugin cannot add `/` entries.

## Develop

```sh
npm install && npm test && npm run typecheck && bb plugin build
bb plugin install "path:$PWD" --yes
bb plugin reload agent-commands   # after each build
```
