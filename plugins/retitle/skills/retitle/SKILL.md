---
name: retitle
description: Title a bb thread again with the Retitle plugin. `bb retitle <thread>` writes a fresh title for one thread, `bb retitle` inside a thread titles that thread, and `bb retitle --untitled` backfills threads that bb's automatic titling left untitled. Use only when the user asks to retitle or rename threads with a generated title.
---

# Retitle

Retitle writes thread titles with the Shopify AI proxy, from the text the user typed in the thread's first message. It also retries automatically when bb's own title request fails, so most threads need nothing.

## Commands

    bb retitle <thread-id>                 # title one thread again, even a titled one
    bb retitle                             # inside a thread: title that thread
    bb retitle --untitled                  # newest 20 untitled, unarchived, visible threads
    bb retitle --untitled --dry-run        # list them without titling
    bb retitle --untitled --limit 50 --project <id> --json

Each line of output is `<thread-id>  <title>`, or `<thread-id>  skipped: <reason>` / `failed: <reason>`. The command exits 1 when any thread failed.

## Rules

- To set a title the user dictated, use `bb thread update <id> --title "..."` instead; Retitle always generates one.
- `--untitled` skips first messages under five words, as bb does. Name the thread explicitly to title one of those.
