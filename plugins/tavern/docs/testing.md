# Testing

Run tests, type checks, and marketplace checks before landing changes to `plugins/tavern`.

## Running checks

From `plugins/tavern` (avoid `npx`, which writes launcher logs before test isolation starts):

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=1
node node_modules/vitest/vitest.mjs run test/scope --maxWorkers=1
node_modules/.bin/tsc -p . --noEmit
bb plugin build .
```

Use `--maxWorkers=1` (or `2` when the machine is idle) because Tavern's Git-heavy tests can saturate local I/O if run with many workers. Placement, transport, and snapshot suites run longest.

From the repository root (required for GitHub's Check workflow):

```sh
npm test
npm run check
git diff --check
```

`npm run check` validates `entries/tavern.json`, `PLUGIN_OVERVIEW.md` (character limit, no `# ` title, no HTML/images/relative links), `CHANGELOG.md` format, and checks that `marketplace.json` is up to date (rebuild with `npm run build` after changing `PLUGIN_OVERVIEW.md` or `entries/tavern.json`).

## Test filesystem isolation

Vitest creates one temporary suite root before starting workers and points `HOME`, `PI_CODING_AGENT_DIR`, XDG directories, npm/Git config paths, Vite's cache, and `TMPDIR`/`TMP`/`TEMP` inside it. The suite root is deleted on clean exit (send `SIGINT`, not `SIGTERM`, if aborting a run so cleanup runs).

Worker setup installs a Node filesystem tripwire that blocks writes outside the suite root and reads of the real home directory outside the checkout and allowed `node_modules` (covering sync, callback, promise, stream, descriptor APIs, symlinks, and hard links). Any attempted escape fails the test even if application code catches the error.

### Fixture rules

- Use `tmpdir()` for ordinary test fixtures.
- Use `TAVERN_TEST_FIXTURES` for project fixtures that must sit outside the scope engine's scratch roots (it is a sibling of the suite's temp directory, outside the checkout).
- Keep all Git, shell/sandbox, and SQLite fixture paths inside the suite root: the tripwire polices Node FS APIs, not native child processes or `better-sqlite3` syscalls.
- Real `sandbox-exec` probes run on macOS under `/private/tmp` and clean up after themselves.
- Optional private scope replay (`test/scope/effect-containment.test.ts`) is skipped unless `TAVERN_SCOPE_REPLAY` points to a scrubbed fixture file.
