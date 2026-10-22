Titles the threads that bb's automatic titling leaves untitled.

bb asks its AI service for a title once, when a thread starts, and gives up if the answer takes more than 8 seconds. The thread then keeps the first 80 characters of your message as its name. Retitle notices and titles it with the Shopify AI proxy.

## What you get

- Automatic retry: about 10 seconds after a thread starts running, Retitle titles it if it is still untitled. Threads you renamed, hidden threads and prompts under five words (which bb leaves untitled on purpose) are left alone.
- `bb retitle <thread>` titles one thread again, even one that already has a title. Run inside a thread, `bb retitle` titles that thread.
- `bb retitle --untitled` backfills the newest 20 untitled, unarchived threads. Add `--limit <n>`, `--project <id>`, `--dry-run` to list them first, or `--json`.

## Better titles for command prompts

bb titles from everything in the first message, including the instructions a `!command` mention attaches out of your sight, such as the whole body of `~/.agents/commands/plan.md`. Retitle reads only what you typed and tells the model which commands you invoked, so a `!plan` thread is titled after the work, not the planner instructions.

## How it works

Retitle uses bb's own title prompt and the title model chosen in the Shopify AI plugin's settings (`bb plugin config shopify-ai`), and falls back to GLM 5.3 Flash when that plugin is missing or its model is not a chat-completions model. The proxy token comes from `SHOPIFY_PROXY_KEY` or `devx llm-gateway print-token --key` on the machine that runs the bb server.

## Limits

- Shopify only: it needs access to the Shopify AI proxy.
- Threads that start while the plugin is not loaded are not retried; run `bb retitle --untitled` to catch them.
- The automatic retry runs once per thread per bb server run.
