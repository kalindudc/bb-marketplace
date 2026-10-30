# Changelog

Notable changes to Retitle, newest first. Releases are tagged `retitle/vX.Y.Z` in this repository.

## 0.1.0 (2026-10-22)

### Added

- Automatic retitling. About 10 seconds after a thread starts running, Retitle titles it if it is still untitled. bb asks for a title once and gives up after 8 seconds, and nothing retried it before. Threads you have already titled and hidden threads are left alone, and each thread is tried once per bb server run.
- `bb retitle <thread>` titles one thread again, including one that already has a title. Run inside a thread with no thread id, it titles the thread you run it from.
- `bb retitle --untitled` backfills the threads bb left untitled, newest first. `--limit <n>` titles at most that many, 20 by default and up to 500; `--project <id>` keeps it to one project; `--dry-run` lists the threads without titling them; and `--json` prints the outcomes as JSON.
- Each line of output is the thread id and its title, or the thread id with `skipped: <reason>` or `failed: <reason>`. The command exits 1 when any thread failed.
- A first message under five words is skipped, because bb leaves those untitled on purpose. Name the thread explicitly to title one of those.
- Titles are written from the text you typed only. The instructions a `!command` mention attaches out of sight, such as the whole body of `plan.md`, are left out of the prompt and the command is named instead, so a `!plan` thread is titled after the work and not after the planner instructions.
- Retitle asks for the title with the model chosen in the Shopify AI plugin's settings, set with `bb plugin config shopify-ai`, so its titles match bb's own. When that plugin is missing, or its model is not a chat-completions model, it uses GLM 5.3 Flash.
- The Shopify AI proxy token comes from `SHOPIFY_PROXY_KEY`, or from `devx llm-gateway print-token --key` when that variable is unset. The token is kept for 5 minutes and fetched again once when the proxy answers 401 or 403.
- Each automatic title is logged to `~/.bb/plugins/retitle/logs/plugin.log`, with a warning when a title request fails.
- A `retitle` skill tells agents to use `bb thread update <id> --title "..."` when the user dictates a title, since Retitle always generates one.

### Compatibility

- Retitle needs bb 0.46 or later and plugin SDK 0.6.49 or later.
- It needs access to the Shopify AI proxy.
- A thread that starts while the plugin is not loaded is not retried; run `bb retitle --untitled` to catch it.
