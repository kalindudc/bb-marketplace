# Development and testing

Reference for contributors working in `plugins/tavern`. Tavern is a self-contained TypeScript bb plugin with zero provider- or company-specific dependencies. See [Contracts](contracts.md) for audited SDK usage, settings internals, and public RPCs, and [Requests for bb](host-asks.md) for open upstream host requests.

## Directory layout

```text
plugins/tavern/
├── server.ts            # Plugin server entrypoint (SQLite, migrations, RPCs, tools, CLI, sweep loop)
├── host.ts              # Native host worker entrypoint (Git transport, forges, portable Pi guard)
├── app.tsx              # Browser entrypoint (Tavern page, composer widget, thread panels)
├── classes/*.md         # Shipped class prompts (Keeper, Ranger, Smith, Warden, Wanderer)
├── characters/*.md      # Shipped character presentation files (avatars, crests, bubble lines)
├── skills/              # Agent skills (journal, quest-management, tavern, tavern-keeper)
├── src/
│   ├── shared/          # Strict Zod RPC contracts, settings schema, authority table, shared types
│   ├── server/          # Keeper engine, journal, scopes, away, placement, settings, backup, insights, CLI, RPCs
│   ├── host/            # Native host operations (porcelain Git carry, snapshots, forges, portable guard)
│   ├── scope/           # Scope presets, shell parser, act catalogue, send guard, macOS sandbox, watcher
│   └── ui/
│       ├── engine/      # Pixel-art sprite renderer, animation scheduler, speech bubbles, lantern light
│       ├── kit/         # Shared Tavern UI components, CSS tokens, motion rules
│       ├── page/        # Common room, quest page, map, classes, memory, insights, settings, Closing time
│       └── thread/      # Composer widget, journal segment, member brief, reports tab
└── test/                # Vitest unit, contract, RPC, scope, host, and UI tests
```

## Runtime architecture and core invariants

- **No separate daemon:** `server.ts` runs on bb's main server thread sharing its SQLite WAL database (`data.db`). Keep work non-blocking with async Git execution and frozen cached store reads (`src/server/freeze-json.ts`).
- **One background loop:** A five-second sweep handles ticks, stale checks, retries, and deferred cleanup; wake events trigger the same gated tick path so reports and ask answers do not wait out the sweep.
- **Native host worker (`host.ts`):** Bundled by `bb plugin build` as a self-contained Node 22 ESM artifact that executes Git transport, snapshot capture and carry, forge commands, and portable Pi guard setup on the target host.
- **Never edit shipped migrations:** bb validates shipped migration text verbatim (`SEED_QUEST_CHANGE_SEEN` has no trailing semicolon). Add new migrations instead.
- **Respect the Keeper instruction budget:** `test/server/keeper-instructions.test.ts` enforces a 34,754-byte cap across the Keeper prompt, skill, and tool deltas. Pay for additions by trimming rather than raising the cap.
- **Never mutate cached store records in place:** Stores return frozen snapshots; editing `data.db` outside Tavern requires a plugin reload.
- **Keep authority explicit:** User-only controls flow through `src/shared/authority.ts` and `src/server/authority.ts`. Never infer human attribution from unmarked client calls or bypass approval gates.
- **Stay provider- and company-agnostic:** Machine placement and model lists come from bb's catalog; never hardcode internal hosts, providers, or forge tools.
- **Respect the UI motion contract:** Follow the "Never animate" list in `src/ui/kit/README.md` so asks, counts, evidence, and reduced-motion views stay still.

## Build, test, and marketplace checks

From `plugins/tavern` (avoid `npx`, which writes launcher logs before test isolation starts):

```sh
npm ci
node node_modules/vitest/vitest.mjs run --maxWorkers=1
node node_modules/vitest/vitest.mjs run test/scope --maxWorkers=1
node_modules/.bin/tsc -p . --noEmit
bb plugin build .
bb plugin reload tavern
```

Use `--maxWorkers=1` (or `2` on an idle machine) because Git-heavy placement, transport, and snapshot suites can saturate local I/O.

From the repository root (matching GitHub's Check workflow):

```sh
npm test
npm run check
git diff --check
```

`npm run check` validates `entries/tavern.json`, `PLUGIN_OVERVIEW.md` (4,000-character limit, no `# ` title, no raw HTML, no images, no relative links), `CHANGELOG.md` format, and whether `marketplace.json` matches `npm run build`.

## Test filesystem isolation

Vitest creates one temporary suite root before starting workers and points `HOME`, `PI_CODING_AGENT_DIR`, XDG directories, npm and Git config paths, Vite's cache, and `TMPDIR` inside it. Clean exit deletes the root; send `SIGINT` (not `SIGTERM`) if aborting a run so cleanup executes.

Worker setup installs a Node filesystem tripwire that fails tests on any write outside the suite root or read of the real home directory outside the checkout and allowed `node_modules` (even if application code catches the error).

- Use `tmpdir()` for ordinary test fixtures, and `TAVERN_TEST_FIXTURES` for project fixtures that must sit outside the scope engine's scratch roots.
- Keep Git, shell, sandbox, and SQLite fixtures inside the suite root because the tripwire polices Node FS APIs, not native child processes or `better-sqlite3` syscalls.
- Real `sandbox-exec` probes run on macOS under `/private/tmp` and clean up after themselves. Optional private scope replay (`test/scope/effect-containment.test.ts`) stays skipped unless `TAVERN_SCOPE_REPLAY` points to a scrubbed fixture file.

## Steer replay

Manual two-goal live replay printed by `bb tavern steer-test` and paired with `test/server/steer.test.ts`:

```sh
node node_modules/vitest/vitest.mjs run test/server/steer.test.ts
```

To run the live check, start a Keeper manually with two harmless, private goals named **Index rebuild** and **Proxy retry**. Record both initial plan versions, then send these ten messages in order while the party works:

| # | Message | Expected read-as | Expected plan change |
| --- | --- | --- | --- |
| 1 | `Index: stage first` | steer, Index | Index only |
| 2 | `What is waiting?` | question | Neither |
| 3 | `Look up lunch menus` | aside | Neither |
| 4 | `Proxy: retry only once` | steer, Proxy | Proxy only |
| 5 | `Which model checks it?` | question | Neither |
| 6 | `Index: keep the rollback` | steer, Index | Index only |
| 7 | `Check the weather` | aside | Neither |
| 8 | `Proxy: stop the extra rollout` | steer, Proxy | Proxy only |
| 9 | `What is the ETA?` | question | Neither |
| 10 | `Index: test staging again` | steer, Index | Index only |

Verify that every reply is concise with the right routing tag, only steer messages create a new plan version (and only for the named quest), and any aside helper thread has no board-quest or waypoint link.
