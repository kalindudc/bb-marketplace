Shuttle puts every pull request that needs you in one place, whatever server hosts it: GitHub out of the box, and Delta, GitLab or any other server you describe with a few shell commands that print JSON.

**What you see**

- **Needs you:** a finished review waiting for you to choose what to post, your PR approved and green, or your PR with changes requested and no thread acting on them.
- **Review requests:** PRs that ask for you by name, PRs that ask one of your teams, and PRs that mention you.
- **Your PRs:** in flight and done, with checks, review decision and the threads linked to each.
- **Look up any PR** by pasting its link, whether or not you are part of it, and open it in your browser.

**Threads and reviews**

- Link a PR to any thread, or start a new thread for it. A thread can own several PRs, such as a stack, and a PR can have several threads.
- Start a review in one click with a preset: the skill to use, the agent, model and thinking level, the workspace and the prompt. Pick another preset from the arrow next to Review, or change one run.
- Auto review starts a review thread by itself when someone requests you by name, with a daily limit and a repository filter. Requests that were already waiting when you installed Shuttle never start one.
- Watch a PR, and new reviews, review comments and failed checks go to its owner threads, batched into one message per thread, either to read or to act on.

Shuttle never writes to a pull request. The review threads draft their findings and ask you before anything is posted.

**Settings** live on Shuttle's page in bb's Settings: servers (with a Test button), review presets, automations, the sidebar section review threads go to, and import or export as TOML. Agents get the `shuttle_link`, `shuttle_unlink` and `shuttle_prs` tools, and `bb shuttle` covers the same from the command line.
