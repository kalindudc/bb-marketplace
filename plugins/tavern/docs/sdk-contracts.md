# SDK contracts

Contributor reference for Tavern's audited bb SDK usage (`@get-bb/plugin-sdk` 0.6.132+) and strict test-host validation. Open upstream core gaps and mitigations live in [Requests for bb](host-asks.md).

## Audited SDK call inventory

`test/server/sdk-call-inventory.test.ts` parses every TypeScript file in `src/server/`, `src/scope/watch.ts`, and `server.ts` with the TypeScript compiler API and fails if:
- any production code calls an SDK method missing from `SDK_CONTRACTS` in `test/server/sdk-contract.ts`, or
- any code aliases `.sdk` without an explicit audit.

`SDK_CONTRACTS` currently covers **37 backend SDK methods**:

| Namespace | Audited methods |
| --- | --- |
| `threads` | `spawn`, `send`, `get`, `list`, `output`, `update`, `stop`, `delete`, `archive`, `unarchive`, `defaultExecutionOptions`, `storageLocation`, `getPluginMetadata`, `updatePluginMetadata` |
| `threads.*` | `queuedMessages.list`, `queuedMessages.delete`, `queuedMessages.update`, `queuedMessages.send`, `interactions.list`, `events.list` |
| `environments` | `get`, `list`, `listProviders` |
| `hosts` | `get`, `list`, `experimental_listProviders` |
| `projects` | `get`, `list`, `defaultExecutionOptions` |
| `providers` | `list`, `models` |
| `plugins` | `list`, `callRpc` |
| `files` | `mkdir`, `read`, `write` |
| `system` | `config` |

The shared test host wraps every SDK call and validates its arguments before fixture handlers run (including spies and replaced namespaces).

## Key bb SDK invariants enforced in Tavern

- **Non-empty spawn and send inputs:** `threads.spawn` (non-fork) and `threads.send` require a non-empty `input` array (never `input: []`) and accept either `prompt` or `input`, never both. Scope admission holds that first input before provider execution rather than sending a duplicate initial brief.
- **Send mode:** Tavern uses `queue-if-active` for tells and ticks, never `steer`, so running tools are not interrupted mid-call.
- **Stop confirmation:** `threads.stop` returns only `{ ok: true }`. Tavern reads thread status afterwards and treats `stopping` as unconfirmed rather than assuming idle.
- **Metadata is a mirror, never authority:** Clients and agents can write thread plugin metadata (capped at 256 KiB JSON). Tavern always reads role, scope, and authorization from its own SQLite database.
- **Tool and skill selection (`configure`):** Tavern's `configure` hook explicitly selects `journal` and `quest-management` for every thread (including untyped threads). The legacy `quest` tool stays registered but unselected so pre-existing sessions keep working while new threads see `journal`.
- **Storage location:** `threads.storageLocation` requires an attached environment (returns HTTP 409 otherwise).
- **Strict lossless RPC JSON:** Every registered RPC schema is validated with strict JSON round-tripping in `test/server/sdk-contract.test.ts` (no `undefined`, `NaN`, or prototype-polluting keys).

## Adding a new SDK call

1. Add the method's request validator to `SDK_CONTRACTS` in `test/server/sdk-contract.ts`, verified against `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`.
2. Add focused coverage in `test/server/sdk-contract.test.ts` and run `node node_modules/vitest/vitest.mjs run test/server/sdk-call-inventory.test.ts test/server/sdk-contract.test.ts`.
3. Update this table if you add or remove an audited method.
