# SDK request audit

Core gaps and current mitigations are tracked in [Requests for bb](host-asks.md).

Tavern makes 69 backend SDK call sites across 24 methods. The shared test host now validates those requests before a fixture handler runs, including handlers replaced with assignment, `vi.spyOn`, or a replacement namespace. A source inventory test fails when a new SDK method or an unreviewed SDK alias appears.

This audit found one production request violation: a normal spawn used `input: []`. bb rejects that request with HTTP 400. A spawn now carries the actual brief as its first text entry. Scope admission holds that same core-owned input before the provider starts when approval is required. It does not send a second initial brief.

Accepted spawn input increments the brief version once. Only an explicit pending brief is retried. Later instructions use the durable rebrief sender, retain their slot on failure, reconcile uncertain acknowledgements, and preserve bounded retry and blocker behavior.

## Evidence

Checked on 2026-11-14 against the installed SDK declarations at `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts` and the installed core bundle:

```text
/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/start-server.js
```

The bundle retains these source names and constraints:

| Core source or bundle location | Verified behavior |
| --- | --- |
| `packages/domain/src/plugin-id.ts`, line 14120 | Plugin ids match `^[a-z0-9][a-z0-9-]*$`. |
| `packages/domain/src/plugin-metadata.ts`, lines 19180–19235 | Metadata is a JSON object, bounded to 256 KiB of encoded JSON. |
| Prompt input schema, lines 13440–13469 | Text entries require a string; mentions and agent-only visibility have defined shapes. An empty text string is not the same as an empty input array. |
| Create-thread request, lines 25200–25285 | Required project and environment; a normal, non-fork input array must have an entry. Origin and plugin metadata attribution are checked. There is no create-only/defer-start flag. |
| Send request, lines 25332–25358 | Nonempty input array, a supported send mode, and a nonnegative integer `sendAt` when supplied. |
| Metadata mutation, lines 25562–25581 | Duplicate removals and overlap between `set` and `remove` are rejected. |
| List and event queries, lines 25661–25775 | SDK thread-list booleans/numbers become HTTP query strings. Event cursors and limits use digit strings; event pages cannot exceed 100. |
| SDK adapters, lines 204912–205605 | Spawn accepts prompt or input, never both. Send and spawn forward typed input. Event filters become a comma-separated query. |
| `src/services/plugins/plugin-api.ts`, lines 206470–206515 | Plugin-scoped SDK calls stamp origin, default metadata namespaces to the calling plugin, and retain explicitly requested metadata namespaces. Plugin RPC uses a caller-attributed SDK. |
| `src/services/threads/thread-storage.ts`, lines 67453–67468 | Storage location requires an attached environment. An environment-less thread returns HTTP 409, not a usable storage directory. |
| Environment-provider query, lines 24360–24372; SDK declarations, lines 17778–17794 | `environments.listProviders` accepts optional project and host filters; a host requires a project. |
| `src/services/threads/thread-environment-placement.ts`, lines 106562–106582 | Legacy managed-worktree placement selects the official `git-worktree` provider with an existing machine and branch inputs. |
| Bundled `environment-git-worktree/dist/server.js`, `worktreeInputsSchema` and `createManagedWorktree` | New worktrees use `{branch:{kind:"named",name}}` or `{branch:{kind:"default"}}`. The provider uses its trusted project checkout, owns provisioning, and allocates a per-attempt path. |

## Production call inventory

Paths below are relative to the Tavern plugin. Counts are call sites, not runtime request counts. `server.ts` was checked too; it registers SDK-backed services but contains no direct SDK call.

| SDK method | Sites | Consumers | Test-host checks |
| --- | ---: | --- | --- |
| `environments.get` | 5 | `server/environments`, `server/scopes`, `server/settings/cli`, `scope/watch` | Nonempty environment id. |
| `environments.listProviders` | 1 | `server/environments` | Optional nonempty project and host filters; host requires project. Production refuses missing or unavailable worktree providers before spawn. |
| `files.read` | 1 | `server/settings/cli` | Host id and path. |
| `files.write` | 1 | `server/settings/cli` | Host id, path, string content, supported encoding. |
| `plugins.callRpc` | 2 | `server/insights/burn`, `server/runtime` | Plugin id, method and JSON input. Current targets are Burn's `usage` and push notifications' `notifications.send`. |
| `plugins.list` | 2 | `server/insights/burn`, `server/journal/store` | Optional options and abort signal. |
| `projects.get` | 2 | `server/runtime`, `server/backup` | Nonempty project id. |
| `projects.list` | 1 | `server/backup` | Optional string `include`, boolean `includePersonal` and abort signal; unknown keys and invalid types are rejected. Backups include personal projects and resolve local source paths through `projects.get`. |
| `providers.list` | 1 | `server/execution` | Typed optional project/environment/host routing. |
| `providers.models` | 3 | `server/execution` | Provider id and typed optional routing; the additional Pi probe checks its advertised model before preferring its pre-exec guard. |
| `system.config` | 4 | `server/runtime`, `server/scopes`, `server/backup` | Optional options and abort signal; no required request body. |
| `threads.archive` | 2 | `server/runtime`, `server/tools/index` | Nonempty thread id. |
| `threads.defaultExecutionOptions` | 1 | `server/runtime` | Nonempty thread id; the production caller handles a null result. |
| `threads.events.list` | 10 | `server/journal/requests`, `server/runtime`, `server/tick`, `scope/watch` | Thread id, numeric-string cursors, order, maximum 100 entries, and the native event filters Tavern uses. |
| `threads.get` | 13 | `server/journal/requests`, `server/journal/store`, `server/runtime`, `server/scopes`, `server/settings/cli`, `server/tick`, `scope/watch` | Nonempty thread id. Observed environment attachment is retained for storage checks. |
| `threads.getPluginMetadata` | 2 | `server/hires`, `server/journal/store` | Thread id; optional, valid explicit namespace. Omission uses the plugin's namespace in real bb. |
| `threads.list` | 1 | `server/hires` | Typed filters, boolean archive/hidden flags, nonnegative integer limit/offset. |
| `threads.queuedMessages.delete` | 2 | `server/tick` | Thread id and queued-message id. Production additionally checks Tavern ownership before deletion. |
| `threads.queuedMessages.list` | 4 | `server/runtime`, `server/tick` | Nonempty thread id. Queue access does not require an attached environment. |
| `threads.send` | 3 | `server/journal/requests`, `server/runtime`, `server/tick` | Nonempty typed input, supported mode, valid optional execution and scheduling fields. |
| `threads.spawn` | 1 | `server/runtime` | Required project/environment, prompt/input exclusivity, nonempty normal input, environment union, execution fields, metadata size/JSON, submission data and the installed git-worktree provider input schema. |
| `threads.stop` | 4 | `server/runtime`, `scope/watch` | Nonempty thread id. |
| `threads.storageLocation` | 1 | `server/scopes` | Thread id; HTTP 409 for an observed thread whose environment is still absent, even if the storage fixture is replaced. |
| `threads.updatePluginMetadata` | 2 | `server/journal/store`, `server/runtime` | Thread id, optional explicit namespace, bounded JSON metadata, disjoint `set`/`remove`, no duplicate removals. |

The event filters currently used are `client/turn/requested`, `item/started`, `item/completed`, `system/thread/interrupted`, `thread/compacted`, `turn/started`, `turn/mainRun/updated` and `turn/completed`. Adding another filter requires updating the audited fixture surface.

## Smith worktree placement

Smiths on legacy, Worktree or Project checkout Git environments select the official `git-worktree` provider on the parent machine. The base is the checkout’s current branch, or the provider’s default branch when absent. Non-Git, unprovisioned, unsupported-provider and unavailable-provider parents are refused before spawn; the staffing reservation is returned. Other classes continue reusing their parent environment.

A read-only `bb environment providers --project "$PROJECT_ID" --machine "$HOST_ID" --json` check reported both `project-checkout` and `git-worktree` available for the live-test project. The strict-host regressions cover these selections, refusal paths and recovery. Actual provider provisioning remains an asynchronous BB operation and needs the next live check; Tavern does not create Git worktrees itself or bypass scope admission.

## Guarded provider and model selection

Scoped hires prefer Pi when its advertised catalog offers the configured model or its canonical alias. Unknown class models and unverifiable provider defaults refuse before spawn instead of silently using another model. Non-Pi scoped execution refuses by default; a user can approve one exact detection-only hire through a consequential scope ask. That approval binds the provider, model, effective scope, brief, plan and proposed character, and cannot be supplied through the generic ask tool or reused for another member. A definite unbound 4xx returns the approval; uncertain delivery retains its reservation.

Pi has the pre-tool guard and watcher. Codex and Claude remain detection only, with the watcher and existing environment speed bumps. Installed hooks, shims, files and environment variables are not provider-independent enforcement. This round installs no new hooks or shims and makes no claim that they prevent absolute executable or environment-based bypasses. Capability selection is tested locally; provider startup and the real UI still need a coordinator-controlled live check.

## Checker binding and interrupted tools

A Warden checker receives its maker environment through `threads.get`; the backend checks `environments.get` and `system.config` before reading a server-local linked Git toplevel. The maker root is separate from the Warden environment. Only explicit command spans/shell fences and unambiguous bare check forms from the current plan become trusted `checks.commands`; prose and additions in the hire brief do not grant commands. Missing roots retain ordinary reads but fail closed for checks. The scope file, template, rebind, narrowing and cold recovery preserve that binding. `checker-hires.test.ts` exercises this through the strict host against real temporary linked worktrees, without running a provider.

The installed `PluginAgentToolContext.signal` contract (`bb-plugin-sdk.d.ts:20678–20690`) aborts on request cancellation, Stop, deletion and plugin disposal. Tavern refuses calls already aborted before execution. Started actions settle and report durable outcomes rather than claiming that Stop rolled back a send or a recorded decision. A failed action whose signal aborted explicitly says its outcome is unconfirmed and requests status inspection before retrying.

B1’s native events put both route-permission errors at sequence 124–125, 2,632 ms before manual Stop at sequence 128. The interrupted completion expired the old Luc fact; the resumed Keeper then attached its stale Luc summary to the newer Carry-on message. Interrupted turns now retain unrouted receipts while ending the old routing authority, so the two messages route separately. A normally completed subsequent turn still expires forgotten routes and records `route.missed`. These facts are regression-tested in `interrupted-tools.test.ts`; they do not assert that Stop itself caused the original errors.

## RPC JSON boundary

The shared host delegates registered RPC execution to the installed SDK’s official testing driver. It retains all registrations, validates input and output schemas, and applies the same strict JSON normalizer as bb (`dist/testing/index.js`, `normalizeRpcJsonResult` and `callRpc`). Undefined values, functions, symbol values/keys, bigint, cycles, class instances and non-finite numbers are refused rather than cleaned with `JSON.stringify`. The official host is disposed after each test; Tavern’s separate SDK request proxy remains in place.

`rpc-host.test.ts` pins 18 negative and registration/schema cases, including the original explicit optional-undefined shape. `rpc-json.test.ts` boots the real server entrypoint, uses the real journal and temporary SQLite/files, removes optional fields from stored records, and calls all 40 registered methods. Its case map is exhaustive at compile time and compared with the actual registration inventory at runtime. Every result must pass strict JSON validation and a lossless round trip. It covers healthy journals without a problem field, scoped members without guard posture, untyped threads, settings-file status, Insights and all backup operations. There is no standalone status RPC; status is an agent-tool/CLI surface and the settings-file action.

## Test boundary and remaining live checks

The fixture is a strict guard for Tavern’s SDK requests and its own RPC wire surface, not a complete bb emulator. It does not check every SDK response schema or simulate host connectivity, provider availability, actual worktree provisioning, queue scheduling, external RPC target implementations or hook ordering. Fake handlers still receive SDK arguments rather than a synthesized HTTP request. Promise timing is preserved, while failed calls and replacement handlers remain visible in the request log.

The storage 409 guard uses thread state observed through `threads.get` or `threads.spawn`. A fixture that calls storage without ever supplying a thread response has no known attachment state; it must seed or read that state to test pending provisioning.

Live verification remains necessary for first-provider-turn admission, pending environments, queued input resumption, and the installed Burn/push RPC implementations. The tests establish request validity and Tavern's boundary logic; they do not by themselves prove a live hire or a delivered notification.

Run the checks without rebuilding the plugin:

```sh
npx vitest run test/server/sdk-contract.test.ts test/server/sdk-call-inventory.test.ts test/server/rpc-host.test.ts test/server/rpc-json.test.ts test/settings/spawn-brief.test.ts test/settings/briefs.test.ts
npx tsc -p . --noEmit
```
