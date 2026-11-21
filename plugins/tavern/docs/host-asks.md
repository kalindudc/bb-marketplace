# Requests for bb

These are core capabilities or fixes Tavern needs, not APIs Tavern already has. Tim maintains this list; additions go through Tim or the coordinator. Recording an ask here does not file an upstream issue or authorize a core change.

## 1. Preserve own JSON data properties during RPC normalization

- Ask: Build normalized JSON objects with safe own data properties, using `Object.fromEntries`, `Object.defineProperty` or an equivalent null-prototype construction. Do not assign an arbitrary key through a prototype setter.
- Why Tavern needs it: Provider inputs are opaque JSON. Losing a key changes the provider configuration; treating a data key as a prototype mutation is not a faithful JSON round trip.
- Evidence: The pinned SDK's `node_modules/@get-bb/plugin-sdk/dist/testing/index.js:2896–2950`, function `normalizeRpcJsonResult`, constructs `{}` and assigns `normalized[key]` at lines 2941–2944. The official-driver regression in `test/settings/placement-rpc.test.ts` reproduces an own `__proto__` key disappearing and becoming the returned object's prototype. This is a local framework test, not a live HTTP or remote-host observation; the global object prototype remains unchanged in the probe.
- Today's workaround: Reject `__proto__`, `constructor` and `prototype` at every depth of provider inputs, with a plain error naming the key and rule/input path. Settings, CLI and TOML all use that validation. There is no reserved-key escape or patched SDK.
- Raised by: Tim.

## 2. Distinguish human-driven clients from agents

- Ask: Expose a trusted caller identity that distinguishes a human-driven app or terminal action from an agent invocation. Carry that identity through RPC and CLI calls rather than relying on caller-supplied text or metadata. CLI and HTTP requests made inside a bb thread must carry its trusted thread id, including the `BB_THREAD_ID` execution context, so plugins can refuse thread callers. A request must not be able to omit or override its thread attribution.
- Why Tavern needs it: Machine allocation, routing and remote-guard consent belong to explicit user configuration. A label that includes both humans and agents cannot establish human approval.
- Evidence: `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:155–165` explicitly groups the app, CLI, agents and bb itself under `experimental_caller.kind = "client"`. `PluginCliContext` at lines 20554–20563 has optional thread/project context but no human principal.
- Today's workaround: Keep routing, consent and caps out of agent tools and tuning; refuse plugin-origin settings mutations and known agent-thread CLI mutations; audit explicit client changes. Tavern does not claim that client identity or an absent thread ID proves a human made the request.
- Shared limitation: Answering always-ask asks (including production, merge and credentials), Returning from Closing time and releasing a checker-handoff hold all use this client boundary. A shell-equipped agent can call the same CLI or HTTP route as the app and supply `via: page`. Tavern cannot prove that a human made that call. An ask answer or release still does not execute a production action.
- Hold-release mitigation: Keep hold control ids out of agent instructions, guards, ledgers, ticks, tool output and `tavern_status`. The Keeper can request a release ask by quest; the server binds its hold privately. The page and thread card retain the control id for their user controls. This reduces guidance towards the control; it is not caller authentication, and an agent with access to client RPCs can still query that UI data.
- Raised by: Ted and Tim; the coordinator extended this ask for checker-handoff releases.

## 3. Require an extension to load before a provider can run tools

- Ask: Provide a vetoable startup contract that requires a specified extension and scope revision to load before the provider can execute its first tool. Return session-bound startup proof, or a clear startup refusal.
- Why Tavern needs it: Installing a marked guard on a remote host does not prove the session loaded it. A model instruction or post-start watcher cannot prevent the first unguarded action.
- Evidence: The coordinator's `design/machines/design.md`, section 5, records the startup proof gap and accepted posture. The inspected SDK has no required-extension or pre-tool startup-attestation contract. Provider environment callbacks are failure-isolated contributions, not vetoable startup gates.
- Today's workaround: Prepare the marked guard where possible and label approved remote execution as detection-only. The user accepts that posture once per rule. Missing arming proof is not presented as prevention, and a loaded guard's real denial is never disabled to bypass it.
- Raised by: Frank.

## 4. Offer a core exclusive-machine lease

- Ask: Provide a machine lease or exclusivity capability with a trusted owner and lifetime, so core can prevent another thread or plugin from using a checkout promised to one member.
- Why Tavern needs it: Provider-owned dedicated checkouts need one-member ownership. Tavern can avoid sharing within its own allocations but cannot enforce that promise against other users or plugins.
- Evidence: The coordinator's `design/machines/design.md`, dedicated-machine and host sections, distinguishes a fresh per-member machine from a shared checkout. The inspected generic host/machine APIs do not advertise an exclusive lease; provider identity is not proof of exclusivity.
- Today's workaround: Allocate one new machine per rule-placed member and enforce Tavern-only ownership. Wardens receive their own placement and carried source. This does not claim core-enforced exclusivity or survival after an external archive, deletion or provider loss.
- Raised by: Frank.

## 5. Report actual context-card visibility and pane identity

- Ask: Expose whether the thread context card is actually shown, together with a stable pane identity. A context-kind value should not imply a visible card when the card is hidden.
- Why Tavern needs it: The journal segment above the composer must remain visible when the card is hidden, without duplicating it when the card is shown. Two panes of the same thread may have different visibility.
- Evidence: `src/ui/thread/card-shown.ts:1–10` records that `experimental_useThreadContextKind()` reports `"card"` for a non-banner layout even while the card is hidden, and that the SDK exposes no pane ID.
- Today's workaround: Observe the card container's `hidden` attribute and track visibility by thread. If two card-layout panes show the same thread and only one reveals its card, the thread-keyed state can hide both journal segments. Unknown or unmounted cards leave the segment visible.
- Raised by: The user and Gaetano.

## 6. Make plugin settings descriptions meet normal-text contrast

- Ask: Make bb's shared plugin-settings section description style meet the Web Content Accessibility Guidelines (WCAG) AA minimum of 4.5:1 for normal text against the settings background. Check its opacity and theme combinations centrally, so plugins do not need to duplicate descriptions to make them readable.
- Why Tavern needs it: These descriptions explain what backups contain and how settings behave. The shared `text-subtle-foreground/75` style measures only 3.38:1 in the reviewed light theme. Every plugin uses that host style; this is not a Tavern-only colour choice.
- Evidence: Tony's coordinator review, `design/page-lead/backup-export-look.md:3,23–25`, measured live build `3addffca` in gruve light at widths 1400 and 390. In that evidence bundle, `shots/export/backup-1.jpg` and `backup-2.jpg` show the Backup section; `tools/out-backup.json` and `out-backup2.json` hold the raw measurements. The measurement is for that theme/build, not a claim that every theme has been measured.
- Today's workaround: Render each Tavern section description inside its body using the kit's muted text, with at least 4.5:1 contrast, and leave bb's description field empty. Zack owns the Tavern workaround; a host fix is still needed for other plugins.
- Raised by: Tony.

## 7. Keep page breadcrumbs clear of phone header actions

- Ask: Let bb's page breadcrumb steps shrink, truncating earlier steps first with an ellipsis and a title containing the full text. Keep the final step visible without covering the header actions.
- Why Tavern needs it: On a 390 px phone, the unshrinking Character sheets step occupies 275 px while the header actions start at 192 px. The last step shrinks to 0 px, and the earlier steps provide no tooltip. A shorter page label cannot fix that layout for every plugin.
- Evidence: Tony's coordinator measurements report the 390 px viewport and the 275 px, 192 px and 0 px values above. `design/page-lead/backup-export-look.md:15` records the Classes breadcrumb collision, and `design/page-lead/state.md:60` records the same issue on a quest page. These are the reviewed phone layouts, not measurements of every viewport.
- Today's workaround: Steve shortens what Tavern returns from usePageTitle below a 480 px window. This reduces collisions but cannot make bb's breadcrumb steps shrink or supply missing titles.
- Raised by: Tony.

## 8. Guarantee that hidden threads do not notify

- Ask: Make hidden threads ineligible for user-facing thread notifications, regardless of the default notification level. Provide a core guarantee so a background check cannot notify merely because a notification sender uses the normal default.
- Why Tavern needs it: Voice checks run in hidden threads and must stay quiet. Tavern must not depend on another plugin to mute each check, or race to change a notification setting after the turn starts.
- Evidence: A live probe ran a hidden thread with parent notifications off on 14 November 2026. The notification-level query returned "all (default)". The probe explicitly could not establish whether the push plugin skips hidden threads or whether a push was delivered. This is a default-level risk and a missing core guarantee, not an observed notification.
- Today's workaround: Request hidden visibility and turn parent notifications off, but do not treat those flags as a verified mute for every notification sender. The probes established no plugin-independent mute. Changing the level through the push-notifications plugin would add a dependency and is not Tavern's chosen solution.
- Raised by: Steve.

## 9. Deduplicate thread sends with a caller-supplied request id

- Ask: Let `threads.send` accept an idempotency key or caller request id, and expose whether that request was accepted. Repeating a request with the same key must not start another turn, including after a plugin reload or a lost SDK response.
- Why Tavern needs it: A Keeper tick can time out while bb is accepting it. After a reload, an empty queue and empty accepted-input history cannot distinguish a send that never reached bb from one whose acceptance is still in flight. Retrying a new message risks duplicate work; never retrying silently starves the Keeper.
- Evidence: The pinned SDK's `bundled-types/bb-plugin-sdk.d.ts` defines `ThreadSendArgs` through `SendMessageRequest`. That request has no caller request id or idempotency key. `test/server/loop-scheduling.test.ts` reproduces reloads with accepted, never-arrived and late-arriving sends against the local fake host. These are local tests, not an observation of a live duplicate.
- Today's workaround: Persist the batch before sending, keep its tick id across uncertain delivery, reconcile queue and accepted-input history, and resend that same batch after two minutes without confirmation. Server admission rejects unmarked duplicates, repeated retry generations and terminal ids. A new marked retry may be admitted when the host never confirmed the earlier admission; Keeper instructions prohibit repeating a seen id. Each retry is logged and counted; two unresolved retries open a blocker whose Check again action immediately reconciles history and retries the same batch if necessary. This is a plugin-level safeguard, not a core exactly-once delivery guarantee.
- Raised by: Ken, with the coordinator's approval.


## 10. Let plugin RPC reads re-render only for the fields a component uses

- Ask: Make `experimental_useRpcQuery` subscribe only to the result fields a caller reads, for example by exposing `isFetching` and `isLoading` as getters so React Query's tracked properties apply, or let the caller choose with an option such as `notifyOnChangeProps`. A component that reads only `data` and `error` must not re-render when a background refetch starts.
- Why Tavern needs it: Every Keeper change refetches the room, and today each refetch renders every subscribed component twice: once when the fetch starts, once when the data arrives. The first render changes nothing on screen. At 20 Keepers in the room harness, a tick re-renders about 4,300 components over those 2 commits, and a tick with unchanged data costs as much as a changed one (130 to 146 ms against 135 to 174 ms in development React). This affects every plugin that uses the hook, not only Tavern.
- Evidence: In the pinned SDK (`@get-bb/plugin-sdk` 0.6.132), `ExperimentalRpcQueryOptions` (`bundled-types/bb-plugin-sdk-app.d.ts:23966-23972`) accepts only `contract`, `pluginId`, `method`, `input` and `enabled`, with no `select` or `notifyOnChangeProps`. The hook (`dist/internal/rpc-query-host.js:2388`) builds its result with `isFetching: query.isFetching` (line 2424) on every render, so React Query counts `isFetching` as read for every caller. Tavern never reads `isFetching`. A React devtools-hook count in the harness shows 2 commits per refetch, the first with all data props unchanged. Measured in development React through Steve's harness (`review/perf/hx-fibers.json`, `hx-tick.json` in thread storage), not in production.
- Today's workaround: Tavern is wrapping each page surface in `React.memo` (in progress). The page shell passes `room.data` and `registry.data`, which keep their identity through the fetch-start render and through unchanged refetches, so the memo skips both. Text computed from the clock (an ask's waiting time, Closing time words) moves to `useNow()`, so it still refreshes once a minute behind the memo. Small subscribers (sidebar, page title, badge) still render twice. This is a plugin-side workaround, not a fix in the hook.
- Raised by: Beena, with the coordinator's approval.

## 11. Give plugin Markdown explicit file routing

- Ask: Let the host Markdown component accept the thread or host identity for local file routing independently of a document root. A plugin page quoting a thread message should be able to open its absolute file links and thread-storage paths as chat does.
- Why Tavern needs it: A Keeper's tale quotes its final message on a plugin page. File destinations outside the Keeper's workspace root are inert there, even though they open in chat.
- Evidence: In the bb source, `apps/app/src/lib/plugin-sdk-app-impl.tsx` builds Markdown's message routing from `useThreadTimelineNavigation`. A plugin page has no timeline-local handler. `components/ui/markdown-message-link-routing.ts` installs local-file routing only when that handler exists. `components/ui/markdown-document-link-routing.ts` handles paths inside the document root, but paths outside it fall back to `messageRouting.localFile?.onOpenLink(link) ?? false`. Omitting the document prop therefore cannot restore the absent handler. The public `MarkdownProps` has no link-renderer override.
- Today's workaround: Preserve host Markdown for lists and tables, and show a deduplicated “Files in this delivery” list using the SDK's explicit host or thread-storage FileLink targets. Paths in next actions use FileLink inline. This does not make the original Markdown links active outside the document root.
- Raised by: Devin, with the coordinator's approval.
