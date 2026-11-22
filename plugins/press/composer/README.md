# Press composer

The pi half of [Press](../README.md). It writes the summary when a pi session compacts, so
the next turn keeps the constraints verbatim and the state mechanically instead of trusting a
model to remember them.

```
pi install <path-to-this-directory>
```

It rides pi's own `session_before_compact` hook, so pi keeps its cut point, split-turn
handling, iterative previous summary and file lists. On any error it returns nothing and pi
compacts natively.

## Every compaction goes through it

The hook fires for all three ways a session compacts — `/compact`, pi's own threshold, and
overflow recovery — so a Press summary is what replaces the transcript in every case.

`/press [focus]` is Press's own command: it compacts through the same hook and passes `focus`
to the summariser. `/compact` is not replaced as a name, because pi drops an extension command
that collides with a built-in one; it needs no replacing, since it runs through this hook too.

The ledger records each compaction with the point that triggered it (`manual`, `threshold`,
`overflow`), which is how the governor sees a compaction it did not request.

## What the summary becomes

Five parts, in this order:

1. **Constraints** — every user instruction that looks like a rule, verbatim, deduped, with
   the message it came from. Never summarised. This is the part compaction usually loses:
   measured on real sessions, instructions about *how to work* are dropped about six times
   more often than specifications of *what to build*.
2. **State** — extracted by rules, not by a model: goal, branch and HEAD, files read and
   written, commands with exit codes, failing tests, open questions. Mechanical extraction
   retains 79.1% of recurring details where LLM summaries retain at most 16.0%.
3. **Working summary** — the model's narrative: Goal, Progress, Key Decisions, Next Steps,
   Critical Context.
4. **Resume** — three lines the next turn must honour: `state:`, `next:`, `verify:`. The
   cheapest known counter to a summary turning an open question into a conclusion.
5. **Provenance** — the token count it compacted at, so a reader can tell a 40K compaction
   from an 800K one.

## Configuration

Read from `<workspace>/.bb/press/policy.json`, then `~/.bb/press/policy.json`, under the
`composer` key. The same file the Press plugin reads.

```jsonc
{
  "composer": {
    "model": "z-ai/glm-5.3-flash",   // provider/modelId; null uses the thread's model
    "keepRecentTurns": 6,            // advisory: pi still chooses the cut point
    "maxSummaryTokens": 2500,
    "ledger": true,
    "resumeContract": true,
    "inputBudgetRatio": 0.7          // share of the summariser's window the transcript may fill
  },
  "providers": { "pi": { "enabled": true } }
}
```

`providers.pi.enabled: false` turns the composer off without uninstalling it.

## Files it writes

| Path | What |
|---|---|
| `<workspace>/.bb/press/ledger.json` | constraints, state, resume, compaction history. Atomic write, previous copy kept as `.bak`, capped at 24 KB |
| `<workspace>/.bb/press/composer.log` | one JSON line per compaction attempt, including failures |

Add `.bb/press/` to the workspace `.gitignore` unless you want the ledger committed.

## What it does not do

- It does not choose *when* to compact. That is the Press plugin's job.
- It does not override pi's cut point. `keepRecentTurns` is advisory until a cut-point
  override lands; raise pi's `compaction.keepRecentTokens` if you want a longer verbatim tail.
- It does not summarise for providers other than pi. Codex and Claude Code compact inside
  their own runtimes.

## Development

```sh
npm install
npm test          # node --test, 31 cases, no network
npx tsc --noEmit
```

The pure modules (`src/config.ts`, `src/ledger.ts`, `src/extract.ts`, `src/prompt.ts`) import
nothing from pi, so they run under plain `node --test`. Only `index.ts` touches the pi API.
