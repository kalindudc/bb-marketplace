# Changelog

## 0.1.4

- A server can say how reviews get their own checkout of its PRs, for repositories that refuse bb's git worktree (World only allows worktrees under `~/world/trees`): a bb environment provider such as World tree, with inputs, or a command that prints a checkout's path, such as one around `dev tree add`. Inputs and the command take the PR's number, repo, branches and head; in a command they are shell-quoted. Set it under Review workspace when editing a server.
- Editing a server in Settings no longer drops its read command.

## 0.1.3

- The Review button's preset menu renders above the page, in bb's shared dropdown, instead of being clipped by the PR drawer it sits in.
- Starting a review with the worktree workspace no longer fails with "hostId is required": Shuttle creates the worktree on the machine that has the project's default checkout, or bb's primary machine.
- The PR drawer is wider (up to 640px, at most 45% of the page) and shows the PR's description, rendered as Markdown; a long one is folded until you open it. Lists carry no description, so Shuttle reads it from the server the first time you open a PR. Command servers can send it as `body` from `view`; the Delta adapter does.

## 0.1.2

- Installs from the marketplace. Git installs leave dev dependencies out, and the UI imported `defineRpcContract` from the SDK's root entry, which only a dev dependency provides; the UI now uses its own copy of that identity function.

## 0.1.1

- Adds an `.npmrc` so `npm install` in the plugin uses the public npm registry, which has the plugin SDK Shuttle pins. This did not fix the marketplace install; 0.1.2 does.

## 0.1.0

The first release: every pull request that needs you, from any server, in one place.

- **Servers:** GitHub is built in, through `gh`. Any other server is a command server: a link pattern and one shell command per operation, each printing JSON. A working Delta adapter, with team requests, ships in `skills/shuttle/references/delta.sh`. A list a server cuts short never drops PRs it did not reach.
- **Lists:** Needs you, Requested of me, My teams, Mentioned and Watching, plus your PRs in flight and done. Look up any PR by pasting its link.
- **Threads:** link a PR to any thread, or start a new one for it. A thread can own several PRs, and a PR can have several threads. The thread's Info tab and the line above its composer list every PR it owns, and its Shuttle tab offers to link the PR on the thread's branch.
- **Reviews:** start one from a preset (skill, agent, model, thinking level, workspace and prompt), or change one run. Auto review starts a review thread when you are requested by name, with a daily limit and a repository filter; requests already waiting at the first sync never start one. Review threads can go to a sidebar section of your choice.
- **Watched PRs:** new reviews, review comments and failed checks go to every owner thread, batched into one message per thread, with server text kept in data blocks. Each owner gets each item once, and a failed send is retried for that owner only.
- **Settings:** on Shuttle's page in bb's Settings: sync interval, the Done window, the project and section for review threads, servers with a Test button, review presets, automations, and import or export as TOML.
- **Agents and the CLI:** the `shuttle_link`, `shuttle_unlink` and `shuttle_prs` tools, and `bb shuttle`.
