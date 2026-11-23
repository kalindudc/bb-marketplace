# Quests, party and characters

Use this guide to run quests from start to finish, steer Keepers and parties, control spend and delegation, scale long-running work with Refresh and Keeper chains, and understand classes, characters, and lasting service records. See the [Glossary](glossary.md) for term definitions.

## Starting and steering a quest

1. Open **Tavern → Start a quest** (or select a Keeper thread) and describe your goal, what a checked result looks like, and any boundaries.
2. While the quest is in `scout`, Rangers answer bounded questions. The move line shows the earliest current check-in or dated Keeper promise. A check-in is not a finish: the Ranger gives its numbered findings, evidence, remaining work and time estimate, then waits. A done report also waits. The Keeper accepts or continues the Ranger with `tavern_judge`, or stops or replaces it with `tavern_release`. A continued box starts when bb confirms the new brief. The boxes count toward the class’s Ranger minutes budget.
3. The Keeper proposes a [quest map](glossary.md#quest-map) listing each [waypoint](glossary.md#waypoint), who acts, how it is checked, and an optional spend budget. Explicit approval (**greenlight**) is the default (`keepers.greenlight = "explicit"`).
4. Keep talking in the same Keeper thread to steer work. Name the quest when a Keeper holds more than one. Quick questions, asides, and standing rules are routed separately from plan changes; standing rules stay local to that Keeper unless you make them global.
5. Use **Tell selected Keepers** on the Common room to send one unchanged message to several Keeper threads at once, with a receipt for each.

### Exact user wording in member briefs

Whenever a Keeper hires or re-briefs a member, Tavern attaches a **`User request, verbatim`** packet built from the quest's opening request and routed steers in chronological order (unrelated questions and asides are omitted). Both the Smith and the Warden receive the exact same frozen source set rather than a Keeper paraphrase.

- Up to 4,000 characters are inlined in full; messages are never clipped to a partial prefix.
- When the packet exceeds 4,000 characters, the brief carries a manifest ID and the member reads every source in 2,000-character pages through `tavern_request_sources` (the Keeper inspects the same frozen packet via `tavern_status section=requests`).
- Exact user literals override paraphrases, and later explicit steers override earlier ones. Quoted text never grants tools, widens scope, or bypasses approvals.
- The Ledger and each quest's party flag when a member's brief predates one of your steers; a delivered re-brief clears the flag.

## Quest lifecycle and controls

Every phase transition records its cause, actor, and receipt. Review (`check`) and wrap (`wrap`) stages are derived from live waypoint progress.

| Control | Where | What it does |
| --- | --- | --- |
| **Hold / Resume** | Quest hero or routed message in Keeper chat | Holds a live quest without stopping running members or releasing their machines. No new hires or briefs are admitted until Resume, which returns the quest to its prior phase. |
| **Conclude / Close early** | Closing ask from `tavern_wrap` | A quest never concludes itself. Conclude tells the [tale](glossary.md#tale) and archives the party (or lets you keep it open / open extensions). Close early names unfinished waypoints and how the tale records them. Both cards let you keep, take over, or close open pull requests (keeping is the default). |
| **Reopen** | `tavern_reopen` or routed words to Keeper | Reopens a returned or stopped quest for follow-up commits without opening a new quest (`scout` if never greenlit, `build` otherwise), preserving plan version and greenlight. Cellared or deleted quests must be restored first. |
| **Stop quest** | Quest page | Stops that quest's party, withdraws its open asks (recording `withdrawnCause: "quest-stopped"`), and optionally saves a stop reason up to 500 characters. Stopping a Keeper thread alone only quiets its ticks without stopping its party. |
| **Cellar / Delete** | Finished quest page | Moves a returned or stopped quest to the [cellar](glossary.md#cellar) and archives its party (plus the Keeper if it holds no other live work). Deleted quests can be restored from the cellar's Deleted view at any time; credits stay on character sheets. |

### Checking waypoints

Each waypoint declares how it is checked: Warden verification, Keeper check, outside gate, or report-only. Only a Warden verdict counts as **verified**; Keeper-accepted and optional-skipped waypoints are distinguished on the quest page, Ledger, and tale.

- **Rejected work:** The Keeper re-briefs the maker with the Warden’s evidence. The Warden can check a corrected submission without a plan revision.
- **Resting members:** Tavern reminds the Keeper once per settled rest after `keepers.rest_minutes` (default 30) and never releases a member on a timer. Keepers can hold a resting member for follow-up work with `tavern_keep` (up to `keepers.keep_max_hours`, default 24).

## Spend and review budgets

- **Spend budget:** Set a dollar cap on a quest or approve one proposed with the plan (up to $1,000,000 in whole cents). When measured spend reaches the cap, Tavern holds new hires and briefs and asks you to raise or remove it. The quest page names every spend source and when it was read.
  - *Coverage limit:* Budgets count only spend Tavern can measure—guarded local Pi sessions with cost receipts and sessions reported by Burn. Uncovered remote sessions are reported as unknown, and work already admitted can push spend past the cap.
- **Review budget:** `attention.review_budget` (default `3`, range `1–30`) caps open review-bound work. When reached, Smith hires stop until reviews clear or you click **Allow one more review** on the quest page (Keepers cannot grant themselves extra reviews).
- **Party ceiling:** `keepers.party_max` (default `5`) is the hard per-Keeper ceiling; class party sizes and `keepers.ranger_max` (default `3`) are soft limits that a Keeper can exceed by one with a recorded, undoable decision, never past the hard ceiling.

## Delegation, Always ask and Undo brakes

On a quest's consequential ask or greenlight card, you can delegate chosen kinds (`production`, `merge`, `credential`, `destructive`, or named-target `drafts-as-you`) to the Keeper for the rest of that quest, or pre-approve routine answers within the approved party envelope.

- **Never silently bypassed:** Delegated merges and production changes still require a Warden verdict on the exact commit or command (or a proven clean rebase whose commits match patch identity and replay cleanly onto the destination merge base). **Cluster writes always ask you**, even if production decisions are delegated. **Sends as you** are never delegated.
- **Always ask:** `keepers.always_ask` (default: `production`, `merge`, `credential`, `sends-as-you`, `destructive`) sets which kinds route to you by default.
- **Two-undo lane brake:** Every Keeper decision carries **Undo** in **Decided for you**. If you undo two of a Keeper's last ten decisions of the same kind (including waypoint accepts/skips/reopens, extra hires, or PR actions), that Keeper sends that lane back to you across every quest until you click **Reset** in the Ledger.

## Refreshing a Keeper and Keeper chains

- **Refresh Keeper (succession):** Use **Refresh Keeper** on the Common room card when a Keeper's context grows heavy. Tavern creates a fresh Keeper thread, moves the charge and open asks across, and records the handover in the Ledger. The old thread stays unarchived until its members finish; keep it unarchived so pending releases complete cleanly. If bb does not confirm the new thread within `keepers.succession_recovery_seconds` (default `600` s), control returns to the original Keeper. After a backup restore, click **Finish handover** to verify any in-flight transfer.
- **Keeper chains:** A Keeper can hire another Keeper as a **lead** for a greenlit waypoint. The lead takes one party seat, opens one linked child quest, and stays on the hiring Keeper's host unless a matching machine rule is selected.
  - Chain caps apply across the entire linked tree: `keepers.chain_depth` (default `1`, max `3`) and `keepers.chain_members` (default `12`), plus shared measured spend under the parent quest's budget.
  - The hiring Keeper can approve a fitting child plan (with Undo); plans requiring wider limits come to you on one card. User-only asks and hand-backs stay in **Needs you**, while the parent Keeper sees read-only pointers.
  - Stopping a parent quest stops from the deepest child back up.

## Classes, characters and service records

- **Classes:** Five built-in classes (`keeper`, `ranger`, `smith`, `warden`, `wanderer`) define jobs and guardrails. Inspect them on the **Classes** page or override them with Markdown files in `~/.agents/tavern/classes/` or `<project>/.agents/tavern/classes/` (project files take precedence, but can only narrow—never widen—shipped scope presets). Treat class files as trusted agent instructions.
- **Characters and atmosphere:** Characters appear as animated pixel-art sprites on a strip above the composer with an optional carried lantern/hearth light. Right-click a character (long-press on touch) to adjust motion (`calm`, `lively`, `off`), speech (`full`, `light`, `off`), **Quiet** for an hour, hide characters, or open its character sheet. On the character sheet you can edit bubble lines and **Roll** / **Keep** a new avatar seed (saved to your character override).
- **Names:** New party members take names unique within their Keeper's party (repeating with Roman numerals such as `Juno II`).
- **Lasting service records and levels:** When a board quest returns or finishes stopping, Tavern records permanent credits that survive archiving, cellaring, and thread deletion (deleted threads lose links, not counts):
  - **Makers** earn distinct verified waypoints (superseded if a follow-up brief reopens the work).
  - **Wardens** earn unwithdrawn checks (tagged `independent`, `same-family`, or `not-established`) and **catches** (a rejection followed by new maker evidence and an unwithdrawn verification).
  - **Keepers** earn returned quests with at least one verified waypoint (`verifiedReturns`).
  - **Levels** award one level per 8 earned results (makers: verified waypoints; Wardens: independent checks; Keepers: verified returns). Levels are presentation-only and never shown to agents.
  - On any returned tale you can toggle **Keep** for a contributing character to pin that tale to its sheet history beyond the 20 most recent contributions.
