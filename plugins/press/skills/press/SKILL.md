---
name: press
description: Press is the compaction governor for bb threads. Use the `compaction_point` tool when a phase of your work finishes and it is a good moment to compact this thread's context, and read `bb press status` for the thread's context usage and what Press would do next. Press decides when to compact from a policy of points and vetoes; it never writes summaries.
---

# Press

Press watches a thread's context usage and decides when to compact. It is a governor: it decides and records, and a separate extension (the Press composer) writes the actual summary. It never edits messages and never rewrites the transcript.

## When to call a compaction point

When a coherent phase of your work just finished — a plan approved, tests went green, a pull request opened, a milestone landed — run `bb press point` through bash. That is the cheapest moment to compact: the next phase needs different context anyway. `bb press point [--reason "tests green"]` records a hint for this thread (defaults: the thread you run it in, reason "agent hint") and prints `hint recorded for <thread> at <time>`; the Press service consumes it on its next evaluation, so the `agent` point fires once.

If the `compaction_point` tool is available, it does the same in one call. Either way Press applies the policy and the vetoes, so it may record a proposal instead of compacting (advisor mode), or decline (mid-turn, cooldown, minimum turns since the last compaction, below the token floor, or the previous compaction failed). Do not retry in a loop; a declined point is final for that moment.

## Reading the state

- `bb press status [thread]` — the thread's context percent, the mode Press runs in, the next point that would fire, and when the last compaction landed.
- `bb press log [--thread <id>] [--limit n]` — every decision Press recorded: which point fired or which veto blocked it, at what percent, with what estimate and outcome.
- `bb press ledger [thread]` — the workspace ledger: constraints pinned verbatim, mechanical state, the resume contract, and one row per compaction.
- `bb press policy [show|set|reset]` — the resolved policy, or a workspace/per-thread override.

## Using Press in bb

The Press chip shows a usage ring and the context percent, then the next point if one is ready: `77% · window`. While Press is in the footer, it hides bb’s duplicate context circle. If that footer is unavailable, look for Press in the thread context row or card, or open the Press tab directly.

The Press tab shows compaction history, lets you open a saved summary, and lets you override the mode and compaction points for the current thread. **Compact now** and an exact `/compact` in bb’s follow-up composer are explicit: Press skips scheduling thresholds and vetoes, but requires an idle thread and refuses a duplicate or disabled provider. Automated decisions and `bb press compact` still use the governor’s policy. Change the plugin defaults in Settings → Plugins → Press.

## What Press never does

- It never writes or edits the summary itself; the composer does that from the ledger.
- It never compacts mid-turn, never retries a failed compaction, and never compacts a thread below the token floor.
- It does not answer questions about the ledger's content; read it with `bb press ledger`.