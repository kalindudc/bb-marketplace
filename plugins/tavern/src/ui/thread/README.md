# Thread UI integration

`registerThreadSurfaces(app)` registers the new-thread class picker and its preview banner, the single crest toggle, the bare Tavern widget banner, compact + menu entry, Keeper send-menu routes, message metadata/actions, seven directive cards, four thread tabs, the journal command and native row crests.

The shared kit is exported from `../kit/index.ts`. `QuestMap` takes `{ quest: BoardQuestSummary, mode: "plan" | "live" | "tale" }`. It draws dependencies in the gutters between full-title waypoint cards. When the dependency columns do not fit the available width, the same waypoints form a vertical trail. The plan card and Ledger can also show a compact route list. Lead times are descriptive because the contract contains free-form strings, not durations; no ETA is invented.

## Server expectations

- The mention provider is `classes`; the initial pill resolves the selected class id. Picker values map to the SDK's `providerId`, `model`, `reasoningLevel` and `permissionMode`.
- `decor`, `journal`, `ledger`, `routes`, `registry`, `crests` and `boardQuest` use the shared tagged RPC cache.
- The additive `reports` RPC reads explicit report ids or a member thread id, including errands outside a board quest. Builder B's handler is now present in `src/server/rpc.ts`.
- Ask answers use the original option id and the selected surface. No consequential option starts selected. A sends-as-you ask cannot be answered without its full draft and recipient. Closing the UI leaves the ask waiting; there is no invented defer RPC.
- The widget calls `typing` at most once per ten seconds when a Keeper draft changes. Hidden banners still observe the composer to preserve this hold.
- Message metadata has no text in SDK 0.6.132. It shares one bounded timeline read per Keeper and route revision, then matches through `messageKey`. Exact timestamps also match. Repeated identical messages whose timestamp cannot be matched are not guessed; Re-route lets the user select the occurrence. Reads stop after three history pages.
- Class and Keeper menu callbacks use the RPC client published by the app overlay. They recheck the role before sending. The menu is disabled until the banner has loaded its decoration.

## Verification boundary

`test/ui/thread` exercises fixtures and SDK registration behavior. `preview.tsx` is a browser-only fixture entry, not a plugin surface. A fixture browser cannot prove native host popup placement, provider-catalog reconciliation, cross-device answer races, keyboard shortcut conflicts or arbitration with Flare and other row-status plugins. The coordinator should verify these after installation.
