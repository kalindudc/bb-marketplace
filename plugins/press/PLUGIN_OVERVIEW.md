Press gives bb threads a chance to compact before the next turn. It watches context usage and signals such as a phase ending, an agent hint, or tool output piling up. In pi threads, a companion extension writes a summary with selected user constraints verbatim and state extracted by rules.

## When Press acts

The soft line lets eligible points fire; it does not trigger compaction on its own. The hard line, Force at, still waits for the thread to become idle and for cooldown to end. Press never compacts during a running turn. A thread whose last turn failed counts as idle.

Choose observe to record what would happen, advisor to record a proposal, or auto to let Press act. Auto is the default. When compaction is due before the next turn, Press can hold the next message while it compacts. A hold waits for one compaction attempt and lasts at most 10 minutes. A message arriving right as a turn ends can also wait about 3 seconds while Press checks the timeline. Disabling a provider in policy stops Press from starting new compactions or holding messages to check for one.

## What you see in bb

The Press chip shows a ring and the context percentage. The ring changes colour at the thresholds and spins while Press is compacting or holding a message. Open the Press tab for the Runway panel: see the thresholds, why Press is waiting, how many messages are held, and how much context past compactions freed. Change the mode or point switches for this thread there. The panel shows Off when the provider is disabled and no compaction or hold is in progress.

The Pressed line in chat marks a finished compaction and opens the summary if one is available. To request compaction yourself, use Compact now or submit just `/compact` in bb's follow-up composer with no attachments or mentions. Both work independently of mode and still require an idle thread and an enabled provider.

## The pi composer

Press installs the composer automatically by default. Do not also install it with `pi install`. Use `bb press composer --status` to check for duplicates and `pi remove <source>` to remove an old pi package. The composer only runs in bb threads. After pi compacts, it saves extracted constraints and state even if pi used another summary. Codex and Claude Code compact in their own runtimes.

Use `bb press status` to inspect context usage, `bb press log` to read decisions, and `bb press ledger` to read the thread's saved ledger. Press requires bb 0.48.1 or later.
