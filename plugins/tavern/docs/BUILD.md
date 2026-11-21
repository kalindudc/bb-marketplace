# Tavern: build plan and ownership

Read this first, then the design documents. Four builders work in parallel in ONE shared checkout, so file ownership is strict. The coordinator (the thread that briefed you) integrates, installs into bb and runs the live tests.

## What Tavern is

A bb plugin for orchestration that stays loose. The user hands a thin goal to a **Keeper** thread in an ordinary bb thread with bb's own composer. The Keeper:

1. scouts with Rangers;
2. proposes a **quest map** (the plan: done-when, critical path of waypoints with who acts and lead times, at most three questions, the party);
3. waits for the user's greenlight ("Form the party") only for staffing, while still doing everything reversible itself;
4. hires a party of agents (Smiths build, a Warden checks);
5. keeps them on course while the user steers, interrupts and drops asides at any time.

Every thread, typed or not, gets a **journal** (Tavern supersedes the pi-quests plugin). Agents have characters (name, crest, voice), but personality only shows at thresholds and never changes the work.

Design sources from the original build, not part of this checkout:

- `design/brief.md`: the jobs, the lifecycle, the vocabulary (§ on Tavern words) and the decisions, including "Decisions after mock v2" and "How those land". It is the product spec; where it conflicts with `architecture.md`, the brief wins.
- `design/architecture.md`: SDK mapping, the loop (mailbox, tick, re-anchor, routing), data and tools. Its "orchestrator", "goal", "scout", "builder" and "checker" are now Keeper, board quest, Ranger, Smith and Warden.
- `design/mock/index.html` (open in a browser) and `design/mock/src/*.js|css`: the approved v2 mock. `design/why.md` maps each surface to its production component name and slot. UI must match the mock's layout and feel. Two v3 changes are not in the mock (see "Decided after the mock").
- `research/bb-sdk.md`, `research/bb-049-surfaces.md`, `research/quests-inventory.md`, `research/bb-prior-art.md`: SDK facts with code citations. bb is 0.49.0, which matches `@get-bb/plugin-sdk` 0.6.132 (installed in `node_modules`; types in `node_modules/@get-bb/plugin-sdk/bundled-types/`, or `/tmp/sdk/package/bundled-types/`). The `bb-plugin-authoring` skill (`~/.bb/runtime/global-skills/*/skills/bb-plugin-authoring/`) has references. Flare (`plugins/flare`) and Loom (`plugins/loom`) in this repo are good working examples.

## Decided after the mock (not drawn in it)

- **Widget row, not the composer.** Tavern draws nothing in bb's composer action row except ONE small crest toggle button. Its bar is a composer banner (`app.composer.customize({ id, scopes: ["thread"], banners: [{ id, chrome: "bare", component }] })`), like Flare's. It stacks with Flare's banner, and returns `null` when hidden so the space is freed. Hide with a small control inside the row or a command shortcut. Bring it back with the crest button in composer `actions`, which shows a dot with the count of open asks while hidden. On compact layout, where actions do not render, use a `plusMenu` row "Show Tavern". The hidden flag is per thread (`setHidden` RPC; the server keeps it in its database).
- **The widget row in every thread**, typed or not, shows journal progress ("3 of 7 · doing: add the retry"). In a Keeper thread it also carries the board quests, the asks pill (expands in place, with full consent details for sends-as-you), "Decided for you" count, and status (listening, busy, holding). In a member thread it shows class, board quest, waypoint and Keeper. When a thread has no journal and no Tavern role, the row renders nothing.
- **Row crests are native:** `experimental_setThreadRowStatus` with icons registered through `app.experimental_icons.register` (the pi-minions mechanism: a content script hands the setter to an `experimental_appOverlay` that reads `experimental_useSidebarThreads()`). One mark per row and no text. bb hides it while a thread is working, failed-unread or waiting for input; that is accepted.
- **Journal supersedes pi-quests.** The tool is named `journal` and keeps pi-quests' action names working (add, split, add_step, list, toggle, update, delete, clear, reorder, reparent, undo, redo, rules, skill), plus start, done, block, reopen, verify, reject, note, link, get. The user disables pi-quests when installing Tavern. Tavern imports old pi-quests logs on first touch and never deletes them. See `research/quests-inventory.md` §6 for the full keep and improve lists; implement them.
- **Greenlight is explicit, but the Keeper is independent:** staffing waits for the user; everything reversible proceeds (Rangers, briefs, private drafts, asking outside owners for lead times); reversible questions the Keeper decides itself are recorded as "Decided for you" with Undo. Only consequential steps wait: merge, deploy, production writes, sending as the user, anything other people see.
- Names: plugin `Tavern`, lead class `Keeper`. Classes: Keeper (lead), Ranger (scout), Smith (builder), Warden (checker), Wanderer (general). Themed words always sit beside their plain words in the UI, for example "Quest map (greenlight)".

## Shared files (owned by the coordinator; do not edit, ask instead)

- `src/shared/schema.ts`: domain shapes (zod). `src/shared/contract.ts`: the RPC contract and invalidation tags. `src/shared/text.ts`, `src/shared/heraldry.ts`, `src/shared/define-contract.ts`.
- `src/ui/kit/crest.tsx`: the crest component. `src/ui/kit/mock-tavern.css.txt`: the mock's Tavern CSS, to port from.
- `src/server/ports.ts`, `src/server/migrations.ts`.
- `app.tsx`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `classes/*.md`, `characters/*.md`.

If you need a shared shape changed, make the smallest additive change you need in `schema.ts` or `contract.ts`, mark it with a one-line comment `// added by <your name>: why`, and say so in your report. Never remove or rename a shared field.

## Ownership

| Builder | Owns | Delivers |
|---|---|---|
| A: journal | `src/server/journal/**`, `skills/journal/**`, `test/journal/**` | The journal engine, store, `journal` tool, nudges, import of pi-quests logs, the `JournalPort` |
| B: Keeper backend | `server.ts`, `src/server/**` except `journal/`, `skills/tavern-keeper/**`, `test/server/**` | Registry, members, typed-thread binding, `configure`, the `tavern_*` tools, the tick loop, routing, asks, RPC handlers, CLI |
| C: thread UI | `src/ui/thread/**`, `src/ui/kit/**` (except `crest.tsx`), `icons/**`, `test/ui/thread/**` | Everything drawn inside threads: class picker, widget row and toggle, chat cards, read-as tags, ledger and journal tabs, row crests |
| D: Tavern page UI | `src/ui/page/**`, `test/ui/page/**` | The Tavern nav panel: common room, quest page with the live map, the map (connections), the tale, character sheets, classes, closing time; homepage section; settings section |

`src/server/migrations.ts` concatenates the frozen journal migration (imported as `JOURNAL_MIGRATIONS` from `src/server/journal/migrations.ts`) and `KEEPER_MIGRATIONS` from `src/server/keeper/migrations.ts`, followed by `APPENDED`. Tavern is installed live. Never edit either frozen module or existing appended statements; new SQL goes only at the end of `APPENDED`. The journal module retains its original `QUESTLOG_MIGRATIONS` export and `questlog_*` SQL names so installed data stays compatible.

## Interfaces between builders

`src/server/ports.ts` (shared, already written; A implements it, B consumes it). In outline:

```ts
export interface JournalPort {
  get(threadId: string): Journal;                       // also imports a pi-quests log on first touch
  progress(threadId: string): JournalProgress;
  edit(threadId: string, edit: JournalEdit, actor: Actor): { message: string };   // user edits from the UI
  /** Create or update the entry in a member's journal that stands for a waypoint. Returns the entry id. */
  linkWaypoint(memberThreadId: string, link: WaypointLink, description: string, owner: string, actor: Actor): string;
  /** Every entry linked to a board quest, across threads, for the waypoint roll-up. */
  linkedEntries(boardQuestId: string): JournalEntry[];
  /** Open entries as a few lines, for re-anchoring text. */
  openSummary(threadId: string, limit: number): string;
  /** Instructions block for configure (rules for the tool, plus a snapshot of open entries after a compaction). */
  instructions(threadId: string): string;
  /** Called by B's single message.dispatch hook: return a reject message for Tavern's own notes that would start a turn, else null. */
  dispatchCheck(ctx: MessageDispatchHookContext): string | null;
  onChange(listener: (threadId: string, entryIds: string[]) => void): () => void;
}
export interface JournalDeps {
  /** The caller's Tavern role, from B's members table (never from metadata). */
  roleOf(threadId: string): { classId: string; role: "keeper" | "member" | "solo"; waypointId: string | null; boardQuestId: string | null } | null;
  invalidate(tags: string[]): void;
}
// A exports from src/server/journal/index.ts:
export function registerJournal(bb: BbPluginApi, db: Database, deps: JournalDeps): JournalPort;
```

`registerJournal` registers the `journal` tool and its deprecated `quest` alias, starts its own event watchers (nudges) and returns the port. The `journal` skill is the canonical guide; `quest-management` is a small forwarding alias. New session configuration selects only the `journal` tool, while both skill names remain available. Existing sessions retain their `quest` descriptor and can call its shared handler. New notes use `[Journal]`; the dispatch guard also accepts old `[Quests]` notes. Database names, `quests.progress` and the `quests.log` legacy import keep their old spelling. B calls it from `server.ts`, includes `journal` and `journal` in every thread's `configure` selection, adds `port.instructions(threadId)` to every thread's instructions, and calls `port.dispatchCheck` first inside B's one `message.dispatch` handler (bb allows one handler per hook per plugin). Waypoint roll-up rules: entry `todo` maps to waypoint `todo`, `doing` to `doing`, `blocked` to `blocked`, `done` to `reported`, `verified` to `verified`, `rejected` to `rejected`; no linked entry yet means `planned`.

UI builders talk to the server only through `rpcContract` with `experimental_useRpcQuery` and `experimental_useRpcMutation` (see `plugins/flare/src/ui/banner.tsx`). Until B's handlers exist, build against fixtures that satisfy the zod schemas (parse them in a test so they stay valid), kept in your own folders.

UI registration: C exports `registerThreadSurfaces(app)` from `src/ui/thread/register.tsx`; D exports `registerPageSurfaces(app)` from `src/ui/page/register.tsx`. `app.tsx` calls both.

Message directives the Keeper writes on their own line in its replies (C renders them with `app.slots.messageDirective` or the SDK's equivalent; B's tool results tell the Keeper exactly which line to write):

| Directive | Card |
|---|---|
| `::tavern-questmap{quest="<id>" version="<n>"}` | Quest map card with the seal (greenlight answerable in place) |
| `::tavern-ask{id="<id>"}` | One-line pointer to the ask (the full ask lives in the widget row and the page) |
| `::tavern-reports{ids="<id>,<id>"}` | Report digest |
| `::tavern-ledger{quest="<id>" version="<n>"}` | Ledger change, "from your steer, 14:05" |
| `::tavern-party{quest="<id>"}` | The party forms (casting moment) |
| `::tavern-errand{member="<threadId>"}` | Side journal result |
| `::tavern-tale{quest="<id>"}` | The tale (wrap credits) |

## Builder B: Keeper backend, in detail

- **Registry** (`src/server/registry.ts`): load `classes/*.md` and `characters/*.md` shipped with the plugin, then `~/.agents/tavern/classes|characters/*.md`, then `<project>/.agents/tavern/classes|characters/*.md`; a later file with the same id overrides. Parse YAML frontmatter with `yaml` and validate with `classDefSchema` and `characterDefSchema`; record problems instead of throwing. Reload on file change or on each `registry` read with a short cache.
- **Typed threads.** The class picker inserts a Tavern plugin mention (`bb.ui.registerMentionProvider` with trigger `!`, items are startable classes) at the start of the first message, and send-menu rows submit with `composer.submit({ experimental_data: { classId } })`. B's `message.dispatch` hook binds the thread on its first dispatch: from `ctx.experimental_submission` when `pluginId` is Tavern's, or a Tavern mention in `ctx.input.blocks`. It picks a character (the class's list, preferring one not busy with this user right now), writes the members row, and returns `proceed` within milliseconds. The hook runs before the thread is provisioned, so `configure` sees the member. Spawned members are bound at spawn time. Also mirror `{ classId, characterId }` into the thread's plugin metadata for other readers, but never trust metadata for identity.
- **configure**: for every thread, `tools` include `journal`, `skills` include `journal`, `instructions` include the journal block. Find out from the SDK and the authoring references whether a registered tool is offered to a thread that `configure` does not select, and make sure untyped threads still get `journal`. For typed threads add: the class body; the character block (below); active standing rules (global, project, this Keeper, its board quests); for a Keeper, the ledger restatement (board quests, current plan version, critical path with the next link, open asks, recent decisions, the user's last steer); for a member, its brief, its board quest's done-when and its linked entries. Keep instructions under 32 KiB, newest and most important first. Tools: Keeper gets the `tavern_*` Keeper tools; hired members get `tavern_report`; Wardens also get verify and reject through the journal tool's role check.
- **Character block**: "Your name is <Name>. You may write one line in <Name>'s voice (at most 140 characters) only in the `voice` field of `tavern_report`, and at most one short line at the start of a greeting or a wrap. Everywhere else write plainly. Personality never changes what you do, how carefully you check, or what you report. Never use the voice for blockers, failures or bad news." The server drops `voice` on blocked and needs-decision reports.
- **Tools** (`src/server/tools/*.ts`, each re-checks the caller's role from the members table, returns at once, is idempotent where it can be, and returns bounded text):
  - `tavern_route {kind, boardQuestId?, summary}`: records how the latest unrouted user message was read. Steers and new quests must name or create a board quest; asides and questions must not.
  - `tavern_quest {title, short}`: opens a board quest in phase `scout`. Returns its id.
  - `tavern_hire {classId, brief, boardQuestId?, waypointId?, errand?, characterId?, title}`: spawns a member with `bb.sdk.threads.spawn`, parent = the Keeper thread, `parentNotifications: "off"`, provider, model, reasoning and permission from the class, a worktree environment for `environment: worktree` classes when the project supports it (else shared). Sends the brief as the first message. Enforces the class's `hires` list, the budget, and the greenlight: only Rangers and errand helpers before the greenlit version. Links the waypoint into the member's journal via the port.
  - `tavern_tell {memberThreadId, text}`: queues a message to a member (never a steer into a running tool).
  - `tavern_plan {boardQuestId, plan fields, fromSteer?}`: writes a new plan version, moves the phase to `greenlight` when not yet greenlit, opens or refreshes the greenlight ask, and tells the Keeper to write the `::tavern-questmap` line.
  - `tavern_ask {boardQuestId?, question, why, kind, options, meanwhile, holds, proceedInMinutes?, draft?}`: refuses `proceedInMinutes` for consequential kinds (production, sends-as-you, credential, greenlight). Returns at once.
  - `tavern_decide {boardQuestId?, text, why, reversible, source, sourceRef?}`.
  - `tavern_rule {scope, text}`: Keeper-proposed rules start inactive until the user confirms.
  - `tavern_status {boardQuestId?}`: the board (members, reports, asks, review queue), bounded.
  - `tavern_wrap {boardQuestId, outcome, left}`: opens Conclude if all waypoints are settled, or Close early with the remaining waypoints. The latter records their state when the user explicitly accepts the waivers. Only the user's answer archives the party threads and writes the tale. The card also records what to do with open pull requests.
  - `tavern_report {status, outcome, evidence, artifacts, confidence, voice}` for members: refused while the member's linked waypoint entry is done without evidence; writes a mailbox row; ends with "Report written. End your turn."
  - Register `presentation` labels for each tool so timeline rows read well.
- **The tick loop** (`bb.background.service`): folds new reports, answers, applied defaults, stale members, user-to-member messages and route corrections into ONE agent-only message per Keeper, at most once a minute and only when something changed, sent with `bb.sdk.threads.send({ mode: "queue" })` (check the exact send API). The text starts with `[Tavern tick]` and has three parts: facts; priorities restated (board quests, done-when, the next link, standing rules); what to do next. Hold the tick while the user typed in that Keeper's composer in the last 45 s (`typing` RPC), has a queued message, or sent one in the last 60 s; record "held N s while you typed". Ticks may start a turn (that is how the Keeper acts on reports), but never steer into a user's turn.
- **Re-anchor**: after a compaction, an interrupted turn or a failed turn, send a fresh restatement with the next tick (find the event that signals compaction per provider; at least treat `thread.failed` and a stopped turn). `configure` instructions carry the ledger on every session start.
- **Direct messages to members**: the dispatch hook notices `initiator: "user"` on a member thread and records "You told Juno: …" for the Keeper's next tick.
- **Stale members**: no report and no activity for 20 minutes is a strike; two strikes put "re-plan or replace" in the tick.
- **Asks**: `answerAsk` writes the answer, invalidates tags, and wakes the Keeper with a tick (immediately when idle). `proceedAt` defaults fire from the service as "applied default". A greenlight answer records `greenlitVersion`, moves the phase to `build`, and the tick says "Party approved: hire it now, critical path first".
- **Stop**: `stopBoardQuest` stops every member thread and records the event. No model involved.
- **Push**: blockers only, through the push-notifications plugin RPC if installed (see how Flare does it).
- **RPC handlers** for every method in `rpcContract`, invalidating tags on every write (find the server-side invalidate API Flare uses).
- **Reconcile at start**: rebuild member states from live threads when the plugin loads.
- **CLI** (`bb tavern …`): `status`, `quests`, `ask <id> <option>`, `steer-test` (prints the replay script below). Keep it small.
- **Skill** `skills/tavern-keeper/SKILL.md`: the Keeper's operating guide (how to route, plan, ask, brief, read ticks), loaded for Keepers.
- **Steer test** (`test/server/steer.test.ts` plus a replay script in `docs/steer-test.md`): a Keeper holding two board quests gets ten messages mixing redirects, quick questions and unrelated asides; with fake tools, check that routing writes only to the named board quest, asides touch none, and plan versions move only for steers.

## Builder A: journal, in detail

Implement `research/quests-inventory.md` §6 (keep list, improve list, Tavern integration, migration) against the port above. Points that matter most:

- SQLite tables for entries, changes and history in the shared database; caps (description 500, entries 200 per journal, evidence 30 per entry); ids never reused (a per-journal counter emitting two-digit hex through ff, then longer hex; imported hex and previously issued base36 ids stay reserved).
- Statuses todo, doing, blocked, done, verified, rejected. `done` on a linked entry needs at least one evidence item; on an unlinked entry, evidence is optional but the result text nudges for it. `toggle` keeps working for old prompts (open to done, done to todo). `verify` and `reject` only for a Warden whose `roleOf` matches the entry's board quest; `reject` sets the open status `rejected` with the reason; the owner can start or complete it again.
- Every change records actor and time. User edits from the UI reach the agent once, with descriptions, as in pi-quests ("You ticked [a3] "Add the retry" done").
- Undo and redo grouped per action (a batch add or split is one undo).
- Plan line after every change, as pi-quests does. `list` with filters (open, mine, blocked); `get` for one entry with evidence.
- Nudges: port pi-quests' note machinery (steered agent-only note during a running tool, never starting a turn; `[Journal]` prefix; the stale rule). Read `~/.bb/plugins/cache/git/github.com/kalindudc/quests/932d005cb1cdc60ee831df81a6858c1ca05f043d/` for the original code; reuse its logic, rewrite for the new store.
- Mirror progress `{done, total, current}` into thread plugin metadata in the shape minions reads today (`research/quests-inventory.md` §4: confirm the exact namespace and key minions reads, and keep it compatible).
- Import: on first touch, read the old pi-quests log from thread metadata (confirm how to read another plugin's metadata namespace; if the SDK forbids it, report that and import only what is readable), convert, keep ids, `createdBy: import`.
- Skill `skills/journal/SKILL.md`: carry pi-quests' skill text over, updated for statuses, evidence, links and the board-quest distinction ("a board quest is a goal a Keeper holds; your journal is your own checklist").
- Tests for every action, the caps, undo grouping, evidence gates, Warden gating, import, and the nudge decision logic.

## Builder C: thread UI, in detail

Match the mock (S1, S3, S4, S5, S12, S13, S14, S15, S16, S17) with the changes above. Components named in `design/why.md`.

- **Kit** (`src/ui/kit/`): Tavern CSS ported from `mock-tavern.css.txt` and the `.tavern` variables in `design/mock/src/style.css` (hues from bb theme tokens; it must work in every bb theme, light and dark), vocabulary helper (themed word plus plain anchor), status pills, evidence list, member chip (crest plus name plus class), time-ago, the registry hook. D will import from the kit; keep exports stable and tell the coordinator what you exported.
- **S1 class picker** in the new-thread composer: chip in `actions` (scope `new-thread`) opening a listbox popover of startable classes with keyboard support; picking inserts the Tavern mention pill at the start and calls `setSelection` with the class's provider, model, reasoning and permission. Fallback send-menu rows "Start as <Class>" that `submit({ experimental_data: { classId } })`. The mention provider itself is registered on the server (`bb.ui.registerMentionProvider`): coordinate with B through the coordinator; C draws the UI.
- **Widget row** (banner) and its crest toggle (`actions`, scope thread) plus `plusMenu` "Show Tavern" for compact layout, as decided above. Asks expand in place; sends-as-you show the recipient, the full draft and "sends as you"; answering clears every copy. "Decided for you" list with Undo. Calls `typing` (debounced, at most every 10 s) while the composer has text in a Keeper thread.
- **Send menu** rows in Keeper threads: "Send as an aside" and "Pin as a new quest" (submit with `experimental_data: { route: "aside" | "new-quest" }`; B records it as a routing hint).
- **Read-as tag** above the user's messages in Keeper threads (`experimental_messageMetadata`, placement above), from the `routes` query matched with `messageKey()`; a message action "Re-route…" and "Make this a rule".
- **Directive cards** listed in "Interfaces". The quest map card draws the live map (one route on a time axis, crests on owned waypoints, diamonds for the user's moves, gates for outside actors, parallel lanes when waypoints branch, fold after 8), "Decided for you", the questions with recommendations, the proposed party, and the seal button (answers the greenlight ask). The party card deals the crests (reduced motion respected).
- **Tabs** (thread context, `experimental_tab`): "Ledger" for Keeper threads (party picture, Decided for you, the ledger, the restatement it is anchored with), and "Journal (checklist)" for every thread (full journal with statuses, evidence, links, the actor timeline, filters, user edits, undo). Command "Open the journal" with shortcut ⌘⇧L, and send-menu "Add to journal (checklist)".
- **Member thread** decorations: class, board quest, waypoint, Keeper, brief, report cards.
- **Row crests**: register one icon per (class shape, character) pair, or per character per class, with inline SVG colours; content script plus app overlay as in pi-minions (`~/.bb/plugins/cache/git/github.com/kalindudc/minions/*/` `app.tsx` around lines 784 to 869).
- Accessibility: real buttons and listboxes, focus management, WCAG AA contrast in every theme, reduced motion, 390 px compact layout.

## Builder D: Tavern page UI, in detail

Match the mock (S2, S6, S7, S7b, S8, S9, S10, S11, S13) using C's kit (import from `src/ui/kit/`; if something you need is missing, write it in your own folder and tell the coordinator).

- `navPanel` "Tavern" with a sidebar (common room, the map, character sheets, classes), a badge with the count of open asks (`experimental_useBadge`), and sub-routes for quest pages and the tale. Never a chat on the page: "Open thread" goes to the real thread.
- Common room: needs-you queue (asks answerable in place, same consent rules as C), the quest board with one notice per Keeper and its party picture, side-quest lane, solos, review queue against budget, recent events.
- Quest page: phase strip, the live map (share the map component with C: C owns `src/ui/kit/quest-map.tsx`; until it lands, build against its props `({ quest: BoardQuestSummary, mode: "plan" | "live" | "tale" })`), board by whose move, history with steers and re-anchors marked, party, full ledger, Stop.
- The map (connections): Keepers, board quests, members, side quests, asks and outside owners, focus plus one hop, with a list beside it; the list leads below 1000 px.
- The tale: finished map with verified loot per waypoint, the roll with levels from verified wins only, what is left.
- Character sheets: crest at 96 px, class lens (read-only), voice (editable fields written to `~/.agents/tavern/characters/<id>.md` through a server RPC: ask the coordinator to add it to the contract), level from verified wins only, "agents never see levels".
- Classes: list and a read-only detail for now (editing in a later round).
- Closing time (away mode): the sheet and the "while the tavern was closed" digest. The server side is a later round; draw it from the contract fields that exist and leave the action disabled with a "coming soon" note if needed.
- `homepageSection`: class cards that start a typed thread, and quests on the board.
- `settingsSection`: link to classes and characters, and the pi-quests import status line.

## Conventions

- TypeScript strict, React 19, zod 4. No comments that narrate code; one-line comments only for why. No silent fallbacks.
- Tests with vitest (`npx vitest run <your test folder>`). Use the SDK testing helpers (`@get-bb/plugin-sdk/testing`, `createFakePluginHost`, `makePluginAgentConfigurationContext`) where they help.
- Typecheck with `npx tsc -p . --noEmit` and fix errors in YOUR files only; others are mid-change. Build check: `bb plugin build .` (from `plugins/tavern`) must succeed for your entry points once B's `server.ts` and C/D's register files exist; until then, do not stub other builders' files.
- Do not install, enable, disable or reload plugins in bb, do not send messages to real threads, and do not commit. The coordinator integrates and installs.
- When done, report: what you built (files), what you verified (commands and results), what you could not verify, shared-file changes, and open questions.
