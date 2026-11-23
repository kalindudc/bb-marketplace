---
name: press
description: Press schedules context compaction for bb threads. Use when a phase of work ends, when checking context usage, or when explaining why Press compacted, waited, or held a message. A compaction point is a hint, not a request to compact during the current turn.
---

# Press

Press decides when to ask the provider to compact. A separate pi extension, the composer, writes pi summaries.

## Mark a good time to compact

Call `compaction_point` after a coherent phase of work, such as finishing a plan or passing a test run. The tool stores its `note` as the hint's reason. If the tool is unavailable, run `bb press point --reason "tests green"` in the thread. Both record a hint that Press considers when the turn ends. The tool's reply is a preview, not confirmation that compaction happened.

Press NEVER compacts a running turn. The policy, mode, and vetoes still apply. The soft line enables points but does not trigger compaction by itself. A failed turn counts as idle once it ends. Force at still waits for idle and cooldown, even though it bypasses the other vetoes. An automatic retry waits at least 60 seconds after a failed attempt. Do not retry a declined point in a loop.

Observe records what Press would do. Advisor records a proposal and waits for the user. In auto mode, Press may hold the next message while it compacts before starting that turn. The hold waits for one compaction attempt, for at most 10 minutes. A separate wait of about 3 seconds may appear as “Press is checking this thread before the next turn” while Press reads the timeline. Neither wait means a message failed. Do not tell the user to resend it.

## Read the state

- Use `bb press status <thread> --json` for context usage, mode, blockers, the next candidate, and compaction or hold status.
- Use `bb press log --thread <id>` to see recorded decisions and outcomes.
- Use `bb press ledger [thread] --json` to read the thread's pi composer ledger, including saved constraints and resume state.
- Use `bb press policy show --thread <id>` to see the resolved policy.

In bb, the chip shows only a usage ring and a percentage. The ring changes colour at the thresholds and spins during a hold or compaction unless reduced motion is enabled. Open the Press tab for the Runway panel: it shows thresholds, the expected next step, current vetoes and recent decisions, history and saved summaries, and thread controls. Off means the provider is disabled in Press policy. Press does not start new compactions for it.

Compact now and submitting only `/compact` in bb's follow-up composer with no attachments or mentions are user actions. Both bypass automatic mode and scheduling vetoes but still require an idle thread and an enabled provider. `bb press compact` is different: it evaluates the policy and only acts in auto mode.
