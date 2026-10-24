# Changelog

## 0.1.0

The first release: every pull request that needs you, from any server, in one place.

- **Servers:** GitHub is built in, through `gh`. Any other server is a command server: a link pattern and one shell command per operation, each printing JSON. A working Delta adapter, with team requests, ships in `skills/shuttle/references/delta.sh`. A list a server cuts short never drops PRs it did not reach.
- **Lists:** Needs you, Requested of me, My teams, Mentioned and Watching, plus your PRs in flight and done. Look up any PR by pasting its link.
- **Threads:** link a PR to any thread, or start a new one for it. A thread can own several PRs, and a PR can have several threads. The thread's Info tab and the line above its composer list every PR it owns, and its Shuttle tab offers to link the PR on the thread's branch.
- **Reviews:** start one from a preset (skill, agent, model, thinking level, workspace and prompt), or change one run. Auto review starts a review thread when you are requested by name, with a daily limit and a repository filter; requests already waiting at the first sync never start one. Review threads can go to a sidebar section of your choice.
- **Watched PRs:** new reviews, review comments and failed checks go to every owner thread, batched into one message per thread, with server text kept in data blocks. Each owner gets each item once, and a failed send is retried for that owner only.
- **Settings:** on Shuttle's page in bb's Settings: sync interval, the Done window, the project and section for review threads, servers with a Test button, review presets, automations, and import or export as TOML.
- **Agents and the CLI:** the `shuttle_link`, `shuttle_unlink` and `shuttle_prs` tools, and `bb shuttle`.
