# Build and architecture

Reference for contributors working in `plugins/tavern`. Tavern is a self-contained TypeScript bb plugin with zero external provider or company-specific dependencies.

## Directory layout

```text
plugins/tavern/
├── server.ts            # Plugin server entrypoint (database, migrations, RPCs, tools, CLI, background loop)
├── host.ts              # Native host worker entrypoint (Git transport, forge commands, portable Pi guard)
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
│       ├── page/        # Common room, quest page, connection map, classes, insights, settings, Closing time
│       └── thread/      # Composer widget, journal segment, member brief, reports tab
└── test/                # Vitest unit, contract, RPC, scope, host, and UI tests
```

## Runtime architecture

- **No separate daemon:** `server.ts` runs on bb's main server thread and shares its SQLite WAL database (`data.db`). Keep work non-blocking: use async Git execution and cached/frozen store reads (`src/server/freeze-json.ts`).
- **One background loop:** A 5-second sweep handles ticks, stale checks, retries, and deferred cleanup; wake events also trigger the same gated tick path so reports and ask answers do not wait out the interval.
- **Native host worker (`host.ts`):** Bundled by `bb plugin build` as a self-contained Node 22 ESM artifact that executes Git transport, snapshot capture/carry, forge commands, and portable Pi guard preparation on the target host.
- **Strict shared contracts:** Every RPC surface is defined with Zod schemas in `src/shared/` (`contract.ts`, `settings.ts`, `away-rpc.ts`, `backup.ts`, `placement-rpc.ts`, `setup.ts`, `insights.ts`) and tested against strict lossless JSON serialization.

## Core invariants

- **Never edit shipped migrations.** bb validates shipped migration text verbatim (`SEED_QUEST_CHANGE_SEEN` has no trailing semicolon). Add new migrations instead.
- **Respect the Keeper instruction budget.** `test/server/keeper-instructions.test.ts` enforces a byte cap on the combined Keeper class prompt and skill. Trim before adding text; never raise the cap.
- **Never mutate cached store records in place.** Stores return frozen snapshots; a manual edit to `data.db` while bb runs requires a plugin reload.
- **Keep authority explicit.** User-only controls go through the shared authority table (`src/shared/authority.ts` / `src/server/authority.ts`). Never infer human attribution from unmarked client calls or bypass approval gates.
- **Keep Tavern provider- and company-agnostic.** Machine placement and model lists come from bb's catalog; never hardcode internal hosts, providers, or forge tools.
- **Respect the UI motion contract.** Follow the "Never animate" list in `src/ui/kit/README.md` (asks, counts, evidence, and reduced-motion views stay still).

## Build and local install

From `plugins/tavern`:

```sh
npm ci
node_modules/.bin/tsc -p . --noEmit
bb plugin build .
```

To reload a locally built install in bb:

```sh
bb plugin reload tavern
```

See [Testing](testing.md) for running the Vitest suite and marketplace root checks.
