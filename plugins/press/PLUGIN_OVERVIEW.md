Compaction is the one thing every long thread does badly: it fires when the window is nearly full, so the summary is the most expensive request of the session and the most likely to lose what matters.

Press splits the job in two. The plugin decides **when**; a companion pi extension decides **what the summary is**.

## What you get

- **Compaction points you choose.** A soft and a hard window percentage, phase boundaries (a plan approved, tests green, a pull request opened), an agent hint, tool-output volume, turns since the last compaction, idle time, and thrash signals such as the same file read three times or the same command failing twice.
- **Vetoes that keep it out of the way.** Never mid-turn, a cooldown, a minimum number of turns between compactions, a token floor, and no retry straight after a failed compaction.
- **Three modes.** `observe` records what it would have done, `advisor` proposes and waits for you, `auto` acts. The default is `advisor`.
- **A decision log.** Every evaluation that reaches a trigger or a veto is one row: the point, the reason, the percentage, the estimate, and the outcome once the compaction lands or fails. `bb press log` reads it and `bb press status` shows one line per thread.
- **A ledger per workspace.** `.bb/press/ledger.json` holds the constraints the user stated, the files and commands that matter, the failing tests, and a three-line resume contract. It is plain JSON you can read and fix.
- **The composer.** `pi install <this-plugin>/composer` makes pi write the summary from that ledger: constraints verbatim, state extracted by rules rather than paraphrased, the model's narrative, and a resume block. On any error it falls back to pi's own summary.
- **A row in the thread context card.** The thread's context percentage and the point that would fire next, so you can see a thread filling up before it is a problem.
- **Compaction always goes through Press.** `/press [focus]` is Press's own command in a pi session. `/compact` still works and still produces a Press summary, because the composer hooks every compaction pi runs, and Press's hard window fires well before pi's own threshold.

## Why it is built this way

Measured on real coding sessions, a compaction summary keeps at most 16% of the recurring details a task needs, while mechanical extraction keeps 79%. Instructions about how to work are dropped about six times more often than specifications of what to build, and a summary can turn an open question into an apparent conclusion.

So the parts that must survive are extracted, not summarised, and the summary is asked to write "unverified" rather than guess.

## A compaction point

The plugin compacts when a point fires and no veto blocks it. Each point answers one question:

- `window` - is the context near the limit? The hard percentage outranks every veto; the soft one only asks.
- `phase` - did a phase just end? A plan approved, tests green, a pull request opened. The prefix cache breaks at a task switch anyway.
- `agent` - did the agent say so? `bb press point` from any agent records a hint.
- `volume` - has tool output piled up? The largest input source in a coding session.
- `turns` - has it been too many turns? Long threads drift even at a flat token count.
- `idle` - is the thread waiting? Compacting while nobody is looking costs no wall-clock time.
- `thrash` - is the agent re-reading the same file or re-running the same failing command? That is lost state showing before the token count does.

## Limits

- Press asks the provider to compact; it never rewrites a transcript itself. Providers that expose no manual compaction are logged and skipped.
- The composer is a pi extension. Codex and Claude Code compact inside their own runtimes.
- `keepRecentTurns` is advisory: pi still chooses the cut point.
- Needs bb 0.48.1 or later.
