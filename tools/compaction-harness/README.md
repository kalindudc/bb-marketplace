# compaction-harness

An offline replay harness that scores how well **any candidate context summary**
preserves what a coding agent needs, using real pi session transcripts already on
this machine. No model API calls, no network, zero runtime dependencies
(`node:` builtins only). Tests use `node:test` against a synthetic fixture that
`tests/make-fixture.mjs` generates; real sessions are read-only inputs and are
never copied into this repo.

## Commands

All commands are deterministic. Run from `tools/compaction-harness/`.

```sh
# mechanical state block (ledger contract v1 `state` shape) from a session
node src/cli.js extract <session.jsonl> [--out <file>]

# probe set: concrete recurring details a summary must retain
node src/cli.js probes <session.jsonl> [--out <file>] [--max <n>]   # per-kind cap, default 60

# score ANY candidate summary (file, or - for stdin) against a probe set
node src/cli.js score <probes.json> --candidate <file|->

# build + score both baselines (none, pi-native-serialisation)
node src/cli.js baseline <session.jsonl> [--out-dir <dir>]

# tests (synthetic fixture only)
node tests/make-fixture.mjs && npm test
```

## How it works

- **extract** — pure rules over the JSONL: `filesRead`/`filesWritten` with
  `sha256:` of content when a hash appears in the tool result text, `commands`
  with exit codes (from `isError` or `exit code N` in output), `failingTests`
  from test-runner output patterns, `branch`/`head` from git output, and
  constraint-looking user sentences captured **verbatim** with their JSONL line
  index (`user#N`). Unknown line roles, row types and content block types are
  skipped, never fatal.
- **probes** — one probe per recurring detail: `{id, kind, expected, source, at}`
  with kinds `path`, `command`, `branch`, `head`, `error`, `constraint`. Expected
  values are verbatim strings from the transcript.
- **score** — matching is evidential, not fuzzy-gamed:
  - `path`: exact path after normalisation (case, slashes, trailing slash) as a substring
  - `command`: exact command text after whitespace collapse (matching also
    tries the JSON-string-escaped form candidates use inside `[Assistant tool
    calls]`, so a command serialised by pi's own serialiser still matches)
  - `branch`/`head`: value on a word boundary
  - `constraint`/`error`: a run of at least 6 consecutive significant words
    from the expected text appears verbatim (normalised) in the candidate
- **baseline** — two reference contexts for the same span, no model:
  `none` (empty; the floor) and `pi-native-serialisation`, a port of pi's own
  `serializeConversation()` — `[User]` / `[Assistant]` / `[Assistant tool calls]` /
  `[Tool result]`, thinking omitted, tool results truncated to 2000 chars.
  The serialisation is what a summariser model would actually receive, so it is
  the ceiling; `none` is the floor.

## Note on comparability

Scores are **only comparable within one probe set**. Probe sets are derived from
a specific session file; a different session (or a different `--max` cap) yields a
different set, so percentages across probe sets mean nothing. Use `score` with a
pinned `probes.json` when comparing candidate summaries against each other.

## Layout

```
src/session.js    JSONL parser, tolerant of unknown shapes
src/normalize.js  path/command/constraint matching rules
src/extract.js    mechanical state block + constraint capture
src/probes.js     probe derivation
src/score.js      probe scorer + markdown table
src/baseline.js   none + pi-native-serialisation reference contexts
src/cli.js        extract | probes | score | baseline
tests/            node:test suite + generated synthetic fixture
```