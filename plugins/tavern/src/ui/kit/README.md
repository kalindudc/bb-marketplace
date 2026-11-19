# Tavern design system

This is the source of truth for how every Tavern surface looks and behaves: the thread widget row, the side-panel tabs, chat cards, read-as tags, the Tavern page and the crests. Import parts from `src/ui/kit` (`index.ts`). `tavern.css` holds the tokens and primitives, and `components.css` holds the thread surfaces. When this file and a surface disagree, the surface is the defect. The design lead (Gerald) has the final call on visual decisions.

## Art direction: a warm tavern at work

Warm, assured, alive. Tavern is a working room, not a theme park. The thread stays as readable as any bb thread; the richness lives in a few places: crests, the party picture, the quest map and its wax seal, and the two moments (the party forms, and the tale is told). Day is gruve light. Night is the two dark themes, where a faint lantern glow warms the board, the map and the two moments, and nothing else.

Bad news, asks, blockers, evidence and numbers are always plain: no voice, no glow, no motion.

## Reference screenshots

All are taken with bb's own stylesheet and the plugin CSS in the fixture harness. They live in `/Users/me/.bb/thread-storage/thr_kyhzwgqhx4/design/system/`.

| Screenshot | Shows |
|---|---|
| [1-widget-keeper-asks-light.jpg](/Users/me/.bb/thread-storage/thr_kyhzwgqhx4/design/system/1-widget-keeper-asks-light.jpg) | The Keeper's widget row stacked under Flare, with an ask expanded in place (full sends-as-you consent) |
| [2-quest-log-gruvbox.jpg](/Users/me/.bb/thread-storage/thr_kyhzwgqhx4/design/system/2-quest-log-gruvbox.jpg) | Journal tab: compact rows, one entry expanded, and the member widget row |
| [3-ledger-dark.jpg](/Users/me/.bb/thread-storage/thr_kyhzwgqhx4/design/system/3-ledger-dark.jpg) | Ledger tab: board quests, party picture, Decided for you with Undo, asks; chat cards and the read-as tag |
| [4-quest-map-card-light.jpg](/Users/me/.bb/thread-storage/thr_kyhzwgqhx4/design/system/4-quest-map-card-light.jpg) | The quest map card (greenlight): route, waypoint shapes, questions, party, the seal button, on one screen |
| [5-chat-cards-gruvbox.jpg](/Users/me/.bb/thread-storage/thr_kyhzwgqhx4/design/system/5-chat-cards-gruvbox.jpg) | The tale (credits) card: the finished map, each member with verified wins, what is still yours; the ask pointer and the widget row |
| [6-member-row-390-gruvbox.jpg](/Users/me/.bb/thread-storage/thr_kyhzwgqhx4/design/system/6-member-row-390-gruvbox.jpg) | The member widget row and a report card at 390 px, with 44 px targets |
| [7-scope-ask-dark.jpg](/Users/me/.bb/thread-storage/thr_kyhzwgqhx4/design/system/7-scope-ask-dark.jpg) | A scope ask expanded: the member, each widening in words with its rule id, where it applies, why, and radio choices |

## Layout and spacing

- The font is bb's (`--font-sans`, the user's monospace) and code uses `--font-mono`. Corners use `var(--radius)`, which is square in the user's themes. Never set a font family or a radius of your own.
- Spacing steps are 2, 4, 6, 8, 12, 16 and 24 px. Inside a row use 4 to 6; between rows and inside cards use 6 to 8; between cards and sections use 12 to 16; use 24 only around page sections.
- Density follows bb: a widget row is one line, 34 px tall on desktop and 44 px on touch. Card padding is 8 to 12 px. List rows are 28 to 32 px on desktop.
- Surfaces size by their container, not the window: use container queries (`container-type: inline-size`), because the same part renders in a 1,000 px thread and in a 320 px side panel. Check every surface at 1400, 720 and 390 px wide.
- Nothing scrolls sideways. Long text truncates with an ellipsis and carries a `title`; URLs and ids truncate, sentences wrap.

## Type

| Size | Use |
|---|---|
| 11 px | The floor. Meta lines, plain anchors (`.anc`), section labels (`.lbl`: 700 weight, upper case, 0.04em tracking, muted) |
| 12 px | Row and card body text, buttons |
| 13 px | Card titles, widget-row labels, chat-card headlines |
| 14 px | Tab headings (with their plain anchor at 11 px) |
| 16 px | Form inputs on touch only, so phones do not zoom |

Use two weights: 400 and 600 for text, and 700 only for section labels and names. Never go below 11 px, not even for a badge.

## Colour

Use bb tokens only. Mix new colours from them with `color-mix(in oklab, …)` under a `--tavern-*` name in `tavern.css`, and never write a hex value in a component.

| Role | Token | Rule |
|---|---|---|
| Text | `--foreground`, `--tavern-muted` | Muted text is a mix toward the foreground so it keeps 4.5:1 on cards; on a tint, darken it again (see the "your move" override in `components.css`) |
| Surfaces | `--card` (raised), `--tavern-recessed` (wells, quotes), `--background` | Cards are one step above the page; there is no extra shadow in light themes |
| Lines | `--tavern-line` (seams), `--border` (controls) | A border means a control; see below |
| Your move | `--tavern-you` (`--attention`), `--tavern-you-fill` | Only for what waits on the user: asks, "your move" waypoints, the seal |
| Status | `--success` (done, verified), `--tavern-blocked` (blocked), `--tavern-bad` (rejected, failed) | Only for status, always with a word or a mark beside it. In dark themes `--tavern-bad` is bb's destructive text mixed 70% toward the foreground, because bb's own is 3.4:1 on gruvbox dark's card. Never put `--tavern-bad` text on a `--tavern-bad` tint (3.9:1 in gruvbox dark); text on a tint uses the foreground. |
| Characters | `--tavern-teal`, `-plum`, `-violet`, `-blue`, `-rose`, `-ink` (via `HUE_CSS`) | Only for identity (crests, a member's tick on the map). Never use a status colour for identity, or a character hue for status |
| Seal and lantern | `--tavern-wax`, `--tavern-lantern` | Wax colours the seal, glyphs and fills, never words: as text it is 4.3:1 on gruvbox dark's card. A design that needs wax-coloured words asks for a text token first. The lantern is the night glow (see "Lantern glow"). |
| Primary | `--primary` | One primary button per card at most |

Every surface passes WCAG AA in gruve light, gruve dark and gruvbox dark. Check all three; gruvbox dark is the one that fails first on tints.

## Depth

Tavern is layered, not flat: a recessed board, raised cards, notices pinned on top, and overlays above everything. bb's themes set their own shadows to none, so Tavern draws its own from the tokens in `tavern.css`. Use the tokens, never your own shadow.

| Level | Use | Surface | Shadow token |
|---|---|---|---|
| Recessed | The quest board, party lanes, map backgrounds, wells and quotes | `--tavern-elev-recessed-bg` | `--tavern-elev-recessed-shadow` (inset) |
| Base | The page and the thread | bb's `--background` | none |
| Raised | Cards: chat cards, Decided for you, an expanded journal entry, the page's cards | `--tavern-elev-raised-bg` (`--card`) | `--tavern-elev-raised-shadow` |
| Nested | A card on a card: the tale's member cards and callouts, any card inside a raised card. Add `.nested` | `--tavern-elev-nested-bg`: by day `--card` 20% with white, by night `--card` 80% with black | none; the line is `--tavern-line-nested` |
| Pinned | Notices on the board, the one card that needs the user now | `--card` | `--tavern-elev-pinned-shadow` |
| Overlay | Menus, popovers, sheets and dialogs | `--tavern-elev-overlay-bg` (`--popover`) | `--tavern-elev-overlay-shadow` |

- Light themes shade with the foreground (9, 16 and 24% through `--tavern-shade-1` to `-3`). Dark themes shade with black (30, 45 and 58%) and add a 1 px top highlight (`--tavern-highlight`, the foreground at 7%), because no theme colour is darker than the background. Shadow tokens are the only place a colour outside the theme is allowed.
- Utility classes: `.elev-recessed`, `.elev-raised`, `.elev-pinned` and `.elev-overlay`. The kit already applies them to `.party`, `.decided`, `.tcard`, an open journal entry, `.tavern-menu` and the class picker.
- Keep a 1 px `--tavern-line` border on every level, so edges hold in the light theme where shadows are faint. Never stack two raised levels: a card inside a card is Nested.

Nested is set by measurement over a lit parent, in gruve light, gruve dark and gruvbox dark. The nested card has its own surface and a firmer line, and no shadow (the day glow washes a shadow out). By day it is a near-white sheet and by night a darker panel. The glow darkens its parent by day and lightens it by night, so it only ever widens the difference.

| | Gruve light | Gruve dark | Gruvbox dark |
|---|---|---|---|
| Surface against the parent, ΔE2000 off the glow, then at its peak | 3.5, 12.6 | 4.2, 11.9 | 5.5, 14.5 |
| `--tavern-line-nested` against the parent, off the glow, then at its peak | 3.3:1, 2.7:1 (foreground 56%) | 3.5:1, 2.8:1 (48%) | 3.1:1, 2.3:1 (48%) |
| Text on it: body, muted, the lowest of bad, blocked, wax and primary | 11.6, 7.7, 6.5:1 | 13.6, 7.9, 6.7:1 | 10.8, 7.8, 5.5:1 |

The minimum is a surface difference of ΔE 3.5 off the glow. The line holds 3:1 where the surface difference is smallest, off the glow. At the peak the surface (ΔE 11 or more) carries the edge; a line holding 3:1 there too would need foreground at 62%, which boxes the card in.
- Depth never carries meaning on its own. An ask is still marked with `--tavern-you` and words; a blocker still has its rule and its word.

### Lantern glow

The radial light is Tavern's signature warmth, and it marks what matters now. Use it on at most one or two places per surface: the thing that needs the user or the work in progress, never history, lists or finished items. In the Ledger that is the "Needs you" card, or the first active quest when nothing needs you.

Use it only on main cards: the quest board, each Keeper's notice, the quest map card, the tale, the party-forms card, a quest page's header card and a character sheet's header. Add `.glow`, or use `--tavern-glow` in a `radial-gradient(90% 60% at 30% 0%, var(--tavern-glow), transparent 70%)` on a `::before` layer behind the content.

By day the glow is the inverse of the night lantern. A light card is already the lightest thing on screen, so a light glow can't show; by day the glow darkens and warms the card, an ember on paper, where at night it lightens it. Brightness change is what the eye catches first: the night glow lifts its card's luminance by 70 to 85%, while the first day tint changed it by 4% and could not be seen. Light themes darken every accent to pass as text, so the day glow has its own tint: the theme's attention hue at a mid lightness and high chroma (`--tavern-glow-tint`, `oklch(from var(--attention) 0.68 0.14 h)`). Strengths are set by measurement: the peak's colour difference (ΔE2000) and luminance change against the plain card, with all text over the peak at 4.5:1 or more.

| Where | Day (light themes) | Night (dark themes) |
|---|---|---|
| Main cards and the board (`--tavern-glow`) | the tint at 22%: ΔE 10 to 13, luminance -19% | `--tavern-lantern`, `--attention` at 13%: ΔE 8.6 to 10.8, luminance +72 to +84% |
| Chat cards (`--tavern-glow-chat`) | the tint at 10%: ΔE 4.9 to 6.8, luminance -10% | `--attention` at 5%: ΔE 3.3 to 5.1, luminance +25 to +28% |
| Wide surfaces: the map (`--tavern-glow-wide`) | the tint at 12%: ΔE 5.7 on the board, muted text 5.9:1 | `--tavern-lantern`, the same as main cards |

Strength follows area as well as the peak. On the map the lit ellipse covers most of a card that can fill the screen, three to six times the lit area of a Keeper's notice (about 740,000 px² in the harness and 1.5 million in a full live map, against 260,000), and by day the main-card peak there reads as a tinted page, not as a light. Wide surfaces use `--tavern-glow-wide`: set it as `--tavern-glow` on the card, and the glow layer stays unchanged.

Anything that sits on a lit surface is opaque. A transparent node lets the light through, so it looks lit, which is the opposite of what "returned" or "outside" means. Quiet items lie flat at Base (`--background`, no shadow), not see-through.

Day can't go darker: at the peak, wax and primary text are at 4.6 to 4.7:1 in gruve light. A change to either side needs the same measurement in gruve light, bb's default light and both dark themes.

Never glow on asks, blockers, failures, evidence, list rows or the thread widget row. Use at most one glowing card in a viewport column, plus the board.

Each card's glow sits a little differently, so a page of cards does not look stamped from one mould. Pass `style={glowVars(seed)}` on the card, with a seed that is stable for that card (for example `map:<quest id>` or `notice:<keeper thread id>`). The helper picks the origin between 30 and 70% across and 0 and 20% down, and the size within about 10% of the default, from a hash of the seed. It never changes between renders, it is the same in every theme, and it never animates. Without the style, the glow falls back to the default placement.

### Board, notices and tacks

- The board is a recessed surface with grain: `background: var(--tavern-grain), var(--tavern-elev-recessed-bg)` and the recessed inset shadow, with the lantern glow from the top centre in dark themes.
- A notice is a pinned card on the board: `--card`, a 1 px line, `--tavern-elev-pinned-shadow`, and one wax tack (`<span class="tack" aria-hidden="true" />`) centred on its top edge. Notices sit square; never rotate them, because the text must stay readable.
- A notice that needs the user keeps the tack and adds the `--tavern-you` left rule. It never glows brighter or moves.

## Patterns

- **Card** (`.tcard`): 1 px `--tavern-line` border on `--card`. The header is one line: glyph, title at 13 px, plain anchor, then meta and the single action on the right (`TimeAgo`, a status tag, "Open the ledger ›"). Body text is 12 px. The foot holds the actions, primary first. A 3 px left rule marks a card that needs the user (`--tavern-you`), a blocker or a failure, and nothing else.
- **Widget row** (`.twidget`): one line at Flare's weight, stacked with other plugins' banners above bb's composer. Identity sits on the left, then the board quests, counts and links, and × to hide at the far right. It expands in place under the row (asks, Decided for you, the brief); it never grows a second permanent line.
- **List row** (Journal, ledger lists): status mark, short id, a one-line description that truncates, and counts with nouns. Quick controls take no room until the row is hovered or focused, so the description uses the full width and truncates only while they show; the row's height never changes. Focusing any control in the row shows them, so keyboard reach is unchanged, and on touch the open entry carries them. Rows start collapsed; clicking or pressing Enter expands the full detail in place.
- **Buttons**: `.btn` (30 px), `.btn.sm` (24 px), `.btn.pri` (primary fill), `IconButton` (24 px, 44 px on touch, always with a tooltip), and `.lnk-btn.act` for a text link that ends in `OpensMark` or `ExpandsMark`.
- **Buttons are for actions; references are links.** A bordered button is for something you do: answer, open a thread, stop, undo, confirm. A reference inside a sentence (a quest name in an event, a member in a summary) is a quiet inline link: no border, no box, the sentence's own font, underlined or in the accent on hover and focus.
- **Repeated context collapses.** Do not repeat the same reference on every row. Group rows under one heading (events grouped by board quest), or show the name once per run of rows about the same thing.
- **At most two bordered controls in a row.** When a whole row opens a detail, make the row itself the target with a quiet › at the end, and keep at most one or two real buttons (Undo, Answer) on it.
- **A control inside a clickable row has its own hover, never the row's.** While Tale, Cellar or any other inner control is hovered or focused, the row stays unlit, and the control lights as its own box: an inset 1 px edge in `--tavern-muted` (5.2:1 or more against the row in every theme) over `--tavern-inner-hover`, a fill a step above the row's `--tavern-hover`, with a pointer cursor. The inset edge moves nothing. A tag or count inside the row that is not a control (the Keeper row's "2 decided") is part of the row: a click on it opens what the row opens, and the row's tooltip says what it means.
- **Text menu triggers are targets** (`OverflowMenu` with a text trigger, `.menu-trigger`): at least 24 px tall, and 44 px on touch and at 560 px and below, with no page class needed. Whether one also looks like a button is the surface's call.
- **Filters are one segmented control**, never a row of separate boxed buttons. Markup: `div.segc[role=group][aria-label]` holding `button.seg[aria-pressed]`, each with an optional `span.num` count. The group has one `--tavern-line` border on the raised elevation, with 1 px inset dividers between segments. It wraps at narrow widths. The current segment is `--surface-selected`, bold, with a 2 px inset `--primary` underline, so the choice shows by shape as well as fill and still reads in grayscale. Its count turns `--foreground`. Segments are 26 px tall (44 px on touch and at 560 px and below), with 9 px side padding, 12 px labels and 11 px counts. More than four options go into a "More" menu (`.seg-more`), which sits outside the group as a quiet link.
- **Clamped text** (`Clamp`): long text shows one or two lines and expands in place. It becomes a control (with `ExpandsMark` and `aria-expanded`) only when the clamp actually cuts it or folds extra detail behind it. Text that fits stays plain, so a short line never looks like a button. Member summaries in the party picture, decisions, steers, promises and facts all use it.
- **Party picture** (`PartyPicture`): each member is placed by its state (`memberPlace`: working is on the road, done or stopped is resting, anything else is at the table), never by the stored `place`, which drifted on old rows. Three zones side by side, which stack when the party is narrower than 480 px. Zone headings keep the count on their first line, and the plain anchor wraps under the name. Do not add size containment (`container-type`) to the party or its zones: it makes their content count for nothing, and the party collapses inside a parent that sizes to its content. A part with a class bb's stylesheet also uses (`.table`) must set its own `display`.
- **Headline numbers and charts** (`Kpi`, `Chart`, `QuietNotice`, `CheckIndependence`, `ruleScopeLabel`, `useWidenRule`, `formatValue`): metrics are history, so they sit on raised cards with no glow. `Kpi` shows an 11 px label, a 20 px bold value (in `--tavern-blocked` when `warn`) and an optional delta against the previous period. The delta tint (success or destructive, as on status tags) says better or worse, the arrow says up or down, and a hidden word says it to screen readers. `Chart` takes one Insights series (`points` of `{ x, y | null }` and a unit word). Bars write the value at the end of each bar; a trend labels its first, last, lowest and highest values and breaks the line at a missing day. Draw SVG at its measured width (1:1 with the viewBox), never scaled to fit, so its 11 px labels stay 11 px at every width; the audit cannot see scaled text. Series take `--chart-1`, falling back to `--primary`, and never a status colour. Format units only through `formatValue` (ratio as %, s as s, min or h, bytes as KB, tokens as 6.2M tokens, usd; count and level stay plain numbers), or pass `format`.
- **Rule scope** (`RULE_SCOPE`, `ruleScopeLabel`, `useWidenRule`): say who a standing rule reaches in plain words: "This Keeper", "This quest: Vault cutover", "This project", "All Keepers". A rule reaches its Keeper and that Keeper's party. A rule row is its scope line (with its actions on the right), then the rule in full, never cut. A narrow rule offers one quiet action, "Apply to all Keepers ⌄", which expands an inline confirm saying exactly who it will reach; Apply calls `widenRule` with scope `global`, and one receipt follows ("Now applies to all Keepers"). Never a modal. Already global and turned-off rules offer nothing. The chat's read-as receipt shows the same scope after the rule chip ("· this Keeper"), with the same widen action; its confirm takes its own line under the receipt.
- **Characters**: the composer uses `PartyStrip` from `src/ui/engine`. It paints a 24 by 28 pixel actor at twice its size on a single 64 px canvas. A named button follows the sprite, so hover notices and click hops work without putting controls or text on the canvas. The class crest stays in the widget row. The kit's `TavernCharacter` remains available for an in-place character without a strip.
- **Same-family Warden** (`CheckIndependence`, `SAME_FAMILY`): when a Warden's model comes from the builder's family, show the exact words "same-family check (not independent)" wherever that member appears: under its name in the party picture, and on its quest in the Ledger (the compact party shows crests only). Use a warning tint, because it is a caveat on trust, not a failure. Show nothing when the field is absent or "independent".
- **Quiet Keeper** (`QuietNotice`): a Keeper the user stopped stays quiet until resumed. It says "Quiet since you stopped it, 03:12" in the viewer's local time (with the date when it is not today), with a Resume button that calls `resumeKeeper`. Resume clears the Stop and has the Keeper re-anchor; it does not change Closing time. It is a neutral state: a recessed line with the pause glyph, no left rule and no glow, and the Keeper's status dot goes hollow. In the widget row (`compact`) it takes the place of the board-quest chips, since a quiet Keeper moves no quest, and on narrow rows it outranks the Ledger link. After Resume it hides itself and leaves one receipt ("Resumed"), and it returns only if a later Stop is newer.
- **Keeper memory** (`KeptInMind`, `KeeperNoteRows`, `GateRows`): read-only rows on a shared grid (subgrid), so the text, the meta and the quest tag line up across rows. The text comes first, then the meta (due time, "overdue", "on a condition", "until 17:00", or the age), then the quest tag. Promises sort by due time, with overdue first and conditions last; facts are quoted word for word, newest first. Each list shows three rows, then "Show all N" in place. Outside gates sit inside their quest card, one line each: the gate glyph, who was asked, and the waypoint, with "answered" or "asked 18m ago"; the channel and the answer go on a second line. Hand-backs ("waiting on you") go under Needs you, which counts by kind ("3 asks · 1 rule · 1 hand-back") so its number never reads as more asks than the widget shows.
- **Board quest and Keeper rows** (`QuestRow`, `KeeperRow`, `keeperStatus`, `questMove`): one row per board quest or Keeper, each its own size container (`.qrow`, `.krow`), so the same row works in the room's rail, a 720 list and a phone. A live quest row is two lines: the name, which opens the quest page and is the whole row's target, then the phase strip, "Build 2 of 7" and whose move it is. A returned or stopped quest is one line with "Tale ›" (returned only) and "Cellar" to archive it. A Keeper row is the crest, the name, the thread title as a second label in the same weight, and "started 14:23" (or "started 13 Nov") so two Keepers on the same task tell apart; the whole row opens the thread and ends in its ›, after the state ("Wren · holding ›"). Every word of state comes from `keeperStatus` and `questMove`, so the board, rows and menus never disagree. A Keeper's states are idle, busy, holding while you type, quiet and thread archived; the server's "listening" reads as "idle", because people didn't know what listening meant. Each state word explains itself on hover wherever `StateMark` draws it, from `KEEPER_STATE_HINT` (idle: "Between turns. It takes your next message, or its party's next report."). The work mark (`st-work`, also busy) is a closed ring with its right half filled, a still "in progress" mark; an open arc read as a spinner that had frozen, so no state mark is ever an open arc. Below 420 px the Keeper row is two lines: the crest, the name and the short state word ("holding"), then the thread title, muted, and "started …". The title truncates first. Nothing that tells two Keepers apart, and no state word, is ever dropped. An archived Keeper's thread is never "holding".
  - Whose move (`questMove`): a reported waypoint waits on its check, never its maker. It names the Warden checking it ("checking …", work tone), or the Keeper, who has to find one ("find a checker for …"). An active checker-handoff hold comes first: "You · 1 hold".
  - Verified counts (`verifiedOf`, `verifiedWords`): every "verified" label counts verified waypoints only, with the skipped ones named beside them: "1 of 2 verified · 1 skipped". When all were skipped it reads "1 skipped" for one and "all 3 skipped" for more. The words carry a no-break space before each "·". Progress ("on the path", `pathProgress`) is a different measure, where a skipped waypoint counts as out of the way.
- **Loading** (`QueryState`, `Skeleton`, the `Sk*` parts in `skeleton.tsx`): content still loading shows a static skeleton shaped like the real layout, never "Loading…" and never an empty flash. Pass `skeleton` to `QueryState`: it holds the skeleton's space from the first frame and shows it at `SKELETON_DELAY_MS` (150 ms), so a fast load shows nothing and a slow one moves nothing when it lands. The region is `aria-busy` with one hidden status, "Loading the ledger"; the shapes are `aria-hidden`, hold no DOM text and take no focus. Build a surface's skeleton inside its real container from the parts. Kit parts use the real components' own classes, lines take the line height of the text they stand in for, and crests and glyphs are SVGs, so the swap moves nothing (measured at 0 px for every fixed-height part). Lists draw the count this device last saw (`useSkeletonCount`, 0 to 8, else 2). A refetch keeps the data on screen, with at most a still "refreshing" word beside a heading. An error replaces the skeleton with the problem and Retry; an empty result shows its empty state. Colour: `--tavern-skel` (foreground 9%, decoration) fills, and `--tavern-skel-edge` (foreground 60%) outlines, carrying 3:1 on every surface (3.41:1 or more, measured). Nothing in a skeleton moves.
- **Decision rows** (`DecidedForYou`): the title is the row, at the body size (13 px). Closed, it takes two lines before it is cut, with the whole title and the reason in its tooltip. Open, the whole title wraps above the reason. The time sits under the title, and Undo and OK sit top right, so the title is never squeezed beside them. Targets are 24 px, 44 on touch.
- **Long lists fold** with "Show all N" in place: a quiet `.lnk-btn.act` with `ExpandsMark` and `aria-expanded` under the first rows, then "Show fewer". `DecidedForYou`'s `limit` does this. Never a separate page for a list the user is already reading.
- **Agent text** (descriptions, titles, reasons, report lines, paths) carries `data-content`. The kit gives `[data-content]` `overflow-wrap: anywhere`, so a worktree path or a 60-character identifier wraps inside its card instead of spilling, and audits can tell the agent's words from the interface's. Ids inside it never reach a person: pass the text through `readable()` (or `ReportView`, `readableEvidence`) with names from `summaryNames` (one member, with `reports` for report ids), `questNames` (text about a whole quest, such as the tale) or `memberReportNames`. Report ids read "Vex’s report", or "Vex’s report for Check the duration" when Vex filed more than one, from the one builder `reportLabels`. An id nobody can name reads "another thread", "another quest", "a waypoint" or "a report"; ids inside a path stay, because they are part of the path.
- **Tags and pills**: a status tag (`StatusPill`, `.tag`) or a route chip is a tint with no border, because it is a fact, not a control. Choices are real radio inputs in `.opts` and `.opt` rows, never checkboxes, never fake boxes.
- **Times**: `TimeAgo` for recent events ("4m ago", with the full time in the tooltip), and `clockTime` for event logs ("from your steer, 14:05"). Never print a raw epoch age; if a time is unknown, say "unknown".

### Journal tally and ribbon (`Tally`, `Ribbon`)

The journal panel's Notebook direction, which the user picked after an independent review. It is being built; until it lands, these rules are the spec.

The journal is the agent's working notebook. Two marks make it Tavern's and carry data: the tally counts what is done, the ribbon says where the agent's pen is now. Neither replaces words: the tally always sits beside "N of M", and the ribbon's row says ", now" to screen readers.

**Tally** (`Tally`, journal header only). One chalk stroke per done entry, in gates of five (four uprights and a slash across them), the way a tavern chalks a tab. A tally counts only what is done (the user's call): open, doing, blocked and rejected entries draw no mark, and their counts stay words. Marks for unfinished work read as smudges, and a mark that is half a stroke says nothing a word does not say better.

- Done strokes are `--foreground`, 2 px wide. A stroke for an entry a Warden verified is `--tavern-wax` and 2.75 px wide, drawn first (`verified`), so proven work reads apart from ticked work by weight as well as colour; the label adds ", 5 verified by a Warden". Strokes are with at least 4 px between uprights and 6 px between gates (4 px when space is short). Never squeeze them closer: past that they read as a barcode. With nothing done, no strokes draw and the words stand alone.
- Above 40 done entries, whole gates fold into one count mark at the left: a small gate glyph and "+N" in 11 px foreground at weight 600, and the remainder (fewer than five) draws as strokes. For example, 47 done draws "+45" and 2 strokes.
- It sits on the header's second line, left, with "17 of 24" after it (the number is 13 px bold, "of 24" muted), then plain counts while they are above 0: "1 blocked" in `--tavern-blocked` and "1 rejected" in `--tavern-bad`, 12 px. The line wraps rather than squeeze the strokes, and is wrapped in `role="img"` with the full label: "Tally: 17 of 24 done, 1 blocked, 1 rejected". The SVG itself is `aria-hidden`.
- The current entry's mark is the ribbon and the now line, never a stroke.
- The Done fold may repeat a small tally (10 px tall, the same rules) after "Done · N". Nowhere else: the context-row segment keeps its bar, because a tally beside Shuttle's and git's segments would be a second progress language in bb's row.
- Motion: only the journal's cues below. The numbers never animate.

**Ribbon** (`Ribbon`, journal list only). A bookmark ribbon hangs from the top edge of the current entry's row into the margin: 7 px wide, `--primary`, a notched end 6 px below the row, `aria-hidden`.

- The current entry is the server's `progress.current`, never a copy of it worked out in the UI: the doing entry; else the first ready entry that has no open steps; else the first ready entry; else the first open one. Ready means open, not blocked, and every `after` entry closed. In the coordinator's journal this is step 37, not its parent 97. Exactly one row carries the ribbon, or none when everything is done.
- The row also gets a tint (`--primary` 8% over the background) and its description turns weight 600. The description button's accessible name ends in ", doing now" when the entry is doing and ", next" otherwise.
- No glow on the row: the lantern never lights a list row. List order is kept, so in a long journal the current row can sit far below the fold (1,072 px down in the 100-entry journal on a phone). The now line in the header always shows it.

**Now line** (journal header, third line). One button: a small ribbon mark, "Doing" or "Next" (11 px, bold, upper case), the entry's id and its description on one line (600, ellipsis, full text in the tooltip). It has the ribbon's tint (`--primary` 8%) and no glow. It is 26 px tall on the laptop and 44 px on phones. Activating it shows the entry in the list (switching the filter to All if the entry is hidden), scrolls it to the centre and moves focus to its description. Accessible name: "Doing: <description>. Show it in the list". It is absent when everything is done. It starts 65 px below the panel top on the laptop and 83 px on a phone.

**The notebook list** around them:

- A margin rule, 1 px, `--primary` at 32%, runs through the centre of every checkbox, a parent's, a step's and the done-steps fold's alike (the row's 14 px gutter plus half the hit size: 26 px on the laptop, 36 px on phones). Steps indent by their text, 22 px, not by their box. Empty boxes are filled with `--tavern-paper`, so the rule passes behind them. The rule is drawn as its own element (a background gradient makes contrast unmeasurable). It is decoration and carries no meaning.
- Done steps fold under their parent into one row, "✓ N done steps ›", that expands in place; open steps stay visible.
- Rows are 28 px on the laptop and 44 px at 560 px and below or on touch. On phones a row hides its quick controls; the open entry carries them.
- The open entry has at most one bordered button, chosen by state: Start for to do or rejected, Done for doing, Unblock for blocked, none for done, verified or a board mirror. Block… and Add a note are quiet links (Reopen for done); everything else is in "…". The Add a step field keeps its own small Add step button.
- Rejected and blocked reasons: in full in the open entry, under a 3 px left rule in `--tavern-bad` or `--tavern-blocked` with the word ("Rejected by Vex (Warden) · 12h ago"); on one line under the row in the Stuck list. Main-list rows stay one line. Never on a red tint.
- Filters: All, Open, and "Stuck N" only while N is above 0; More holds Done, Verified, Rejected and Added by you. The header menu holds "Clear done · N" (with the receipt "Cleared N done · Undo" in place) and History; Undo and Redo stay icon buttons.

- Keyboard: expanding an entry keeps focus on its description. A menu moves focus to its first item; Up, Down, Home and End move within it; Escape or Tab closes it and returns focus to its trigger. Escape cancels an open form or edit and returns focus to what opened it.
- Delete confirms on a line under the row: "Delete with 3 steps?", then a Delete button in `--tavern-bad` and Cancel. Focus goes to Cancel. On phones the row hides its quick controls, so the confirm cannot sit in the row.
- Edit description replaces the row with the field, Save and Cancel (the caret goes to the end; Escape cancels). Step of… is a labelled select in the open entry, for entries without steps. In a panel 400 px or narrower (a container query on the notebook), Save and Cancel wrap under the full-width field.
- The open entry lists its last four changes in full, not action words.
- On phones every small button (`btn sm`, including Add) is at least 44 by 44 px.

**Journal paper** (goal 11, the user's ask). The page stays behind the entries and never sits under text, so the contrast audit can measure every entry.

- `--tavern-paper` is the list's background: bb's `--warning` at 3% over `--background`, warm in every theme (wax is aqua in gruvbox dark). Every text on it, hover and the current row included, measures 4.95:1 or better (`design/alive/paper.md`). Inside the list, every fill that used `--background` uses `--tavern-paper`.
- Rule lines are the row dividers themselves, in `--tavern-paper-rule`, on the rows' existing rhythm. A stitched spine (`--tavern-paper-spine`) runs at the panel's left edge, outside the rows; it gives way to the ribbon at 320 px. In dark themes, lantern light (`--tavern-paper-lantern`, the quiet chat glow) sits in the header's lower padding and below the add field, never behind an entry row. All CSS: no images, filters or blur.
- No grain, no glow on a row, no levels, no streaks and nothing time-based.

**Journal motion** (`useJournalCues`, the user's ask). Four one-shot cues on the panel's own surface, `journal:<thread>`, with one slot (`JOURNAL_SLOTS`):

| Cue | When | Form |
|---|---|---|
| Tally stroke | an entry turns done | the new stroke is drawn: it scales along its line from its top, at a constant width, and fades in over the first third, 180 ms (`mo-chalk`) |
| Gate slash | a fifth done entry closes a gate | the same, from the slash's lower end (`mo-slash`) |
| Ribbon | the current entry changes | slides to it when the move is `MAX_TRAVEL_PX` (160 px) or less, otherwise fades in and rises 8 px where it lands, 300 ms |
| Seal | a Warden verifies an entry | its wax mark settles once, 260 ms (`mo-verified`) |

- A cue follows a change between two journal results seen by this panel, keyed on entry ids. Every result up to the end of the panel's first fetch only records: the first one, the skeleton's swap, and a cached journal with the refetch that follows it when the panel reopens (pass the query's `isFetching`). An id the earlier result didn't have never cues, so an Undo of "Clear done" draws its strokes still. The Done fold, filters, the clock and other threads' activity are not journal results.
- One stroke per result: the last, when several finish together; none when it folded into "+N".
- The user's own change plays as the answer to their click and takes no slot. An agent's or a Warden's change is automatic: the stroke, the ribbon and the seal share the one slot (when an agent finishes one entry and starts the next in one result, the stroke plays and the ribbon lands still), and they hold while a blocked or rejected entry is on screen or while the user types (the typing hold, under Stop conditions). The stuck-row hold is decided when a cue is due, with one read of the stuck rows' boxes against what the panel shows, so a row drawn by a filter, a fold or the same result counts; no observer, no timer.
- The hook calls the coordinator directly rather than through `useTavernMotion`, so window focus and visibility never re-render the journal.
- Under reduced motion every mark is simply there.

Measured (mock, 100 entries, 30 open; panel 855 px tall, phone 755): open entries on the first screen 11 on a 360 phone (the now line costs one row), 25 at 440 and 600 (today's panel shows 3, 14 and 14). The current entry's now line starts at 83 px on the phone and 65 px on the laptop. Audit and overflow check: 180 of 192 runs clean on every rail (three themes; 320, 360, 440 and 600; 16 states). The other 12 are the 100-entry journal scrolled to its end, where the check flags rows passing under the opaque sticky header; a hit test shows nothing shows through it.

## Interaction rules

These rules keep Tavern's controls predictable. Every new surface follows them; a review that finds a break files it as a defect.

### What looks clickable is clickable, and nothing else does

- A control has a pointer cursor, a hover fill (`--state-hover`), the shared focus ring, and a tooltip plus an accessible name that say what it does.
- A control that opens something elsewhere (a thread, a tab, a page) ends with `OpensMark` (›). A control that expands something in place ends with `ExpandsMark` (▾, which turns up while open) and sets `aria-expanded`.
- Plain facts (this thread's own identity, a status dot, a waypoint label you cannot follow) have no border, no box, no hover and no chevron. Never draw a box around text that does nothing.
- Counts always carry their noun: "3 need you", "2 of 7 done", "0 reports". A bare number in a box is never allowed.
- What needs you is asks plus checker-handoff holds to release (`heldQuests`, `activeHold`). A hold opens where asks open, reads "Checker handoff", never moves, and makes the quest your move ("You · 1 hold"). A hold the Keeper also asked about counts once, as that ask. Its receipt is the server's release, in `releaseWords`.
- In the widget row, icon-only controls are limited to the hide control (×) and the journal list icon; both have tooltips.

### The same thing does the same thing everywhere

| Element | Always does |
|---|---|
| Crest and name of another thread | Opens that thread › |
| A board quest's name or chip | Opens its quest page in the Tavern page › |
| Journal progress ("Journal · 2 of 7") | Opens the Journal tab › |
| An ask count ("3 need you") | Expands the asks in place ▾ (in the thread) or scrolls to the queue (on the page) |
| "Decided for you" count | Expands the list with Undo in place ▾ |
| "Ledger (lead state)" | Opens the Ledger tab › |
| "Brief" | Expands the member brief in place ▾ |
| × in the widget row | Hides Tavern in this thread; the crest in the composer brings it back |

The current thread's own crest and name are a label, not a link.

### Consequential answers

An answer that sends as the user, merges, touches production, deletes or widens a member's scope shows the sender, the recipient, the full draft or change, what happens next and a way to defer, before the confirm button is enabled. A scope ask lists every widening in plain words with its rule id (`wideningWords`), and approval is disabled when the grant details are missing. Scheduling a production step is never the same choice as permission to run it. Answering in one place clears the ask everywhere and leaves one receipt.

### Starting a thread as a class

The server resolves a class's provider, model, reasoning and permission for the project (`classExecution`), and the new-thread composer shows it in its class banner (`thread/class-start.tsx`, `ClassBanner`).

- The class's settings are applied once per draft, whether the class came from a pill, the picker, the page or the default class in settings. A later picker change is the person's choice and is never undone.
- A model or reasoning that differs from the class's never blocks a send. The banner says so in one sentence, "Running on X; the Smith class says Y", with one action, Use class settings.
- A start the server will refuse warns before send, with the server's own words (`classStartRefusal`): a provider that can't carry the class's guard, or a wider permission.
- A default class that can't start never falls back silently. Before send the banner says "Starts as a plain thread: the default class Smith can't start here (reason)" with a Settings link. After start, the thread's widget row shows the server's note (`decor.classNotice`), even when the row is hidden.
- With a default class set, "Start as a plain thread" sends this one message as a plain thread (`classId: "none"`) on the pickers as shown.
- Use class settings in a started thread switches only model and reasoning, because bb can't change a thread's provider or permission after start. Its receipt names what bb applied ("Now on Claude Opus 5.5 · high reasoning.").
- When a call fails, the banner says the settings couldn't be read. It never claims the class can't start.

### Optical centring

Text beside an icon is centred on the icon by its cap height, not its line box. In the user's monospace font, capitals and digits sit about 1 px above the middle of the line box, which looks broken next to a centred icon. The kit fixes it with `text-box: trim-both cap alphabetic` on text that sits directly beside an icon in a control or a one-line row (see `tavern.css`), with `overflow: clip visible` so descenders still show on truncated labels.

- Wrap any text next to an icon in its own element (`<Glyph/><span>Label</span>`, never `<Glyph/>Label`), because the trim cannot reach a bare text node in a flex row.
- Glyphs and crests centre their ink on the 24-unit grid (at most 0.5 units off). Check new rows by measuring the icon's `getBBox()` centre against the text's cap centre; the difference must be under 0.5 px.

### Sizes and keyboard

- Text is at least 11 px. Desktop targets are at least 24 px; touch and 560 px and below use 44 px.
- Every control works with the keyboard: menus take arrow keys, Escape closes and returns focus to the trigger, and dialogs and sheets keep focus inside until they close.

## Motion

Ambient motion has three settings modes. Calm preserves the budgets below and the hearth's jittered replay. Lively repeats hearth flicker, road steps and the busy widget pulse at the configured interval (3 to 60 seconds, default 20), while their work condition holds. Those repeats bypass rest, slots and motion windows without consuming one-shot budgets. Off keeps the hearth still and disables ambient repeats; other one-shot cues keep their existing rules. The stored hearth-flicker switch remains compatible: false maps to Off.

Every mode respects reduced motion, a hidden page, typing through two seconds after the last keystroke, and asks, blockers or failures in view. Lively timers stop on unmount or when their condition ends. They never trigger React state updates.

Cues mark a real Tavern change, then return to a rest pose. The hearth's replay while work runs is a separate short flicker that yields to everything and has its own off switch. The evidence and measurements are in the motion design notes (`design/motion/why.md`).

### Character engine

- One animation-frame scheduler serves every world in the document. It advances physics in fixed 60 Hz steps and draws pixel art about 12 times a second. If combined update and draw time averages more than 2 ms across 120 frames, physics drops to 30 Hz, then to 15 Hz if the next window still runs over budget. Read the rolling average and worst times, frame and world counts, budget level and running state in `window.__tavernEngine` while a world is mounted.
- Motion Off and reduced motion draw a still pose and stop scheduling. A hidden tab or an off-screen world does not advance. Calm idles in place and plays one-shot mood cues. Lively travels only when the actor is idle or at work, within the composer's own width.
- Typing and a held widget row stop travel but leave a quiet idle. A held row shows no cues or speech. Mood cues go through the motion coordinator, so its budgets and holds can refuse them. Hover and click are user cues; they bypass the automatic budgets but respect a held row and still modes. The light anchor is reserved for later worlds; the engine does not light the page.
- Art implements `CharacterArt` independently of the clock and physics. The composer currently adapts the kit's existing sprites. Other worlds can register with the same scheduler and supply their own update and draw functions.

### Every cue goes through the coordinator

- Start motion with `useTavernMotion(surface).cue(el, kind, { key, ms, className | run, ... })`, from `motion.ts`, never with a bare class or `element.animate()`. The coordinator registers every animation, CSS or JavaScript, so the budgets, the stop conditions and reduced motion reach all of them.
- `key` is the thing's identity (a quest id, a member thread id), not the DOM node, so a re-render or a remount doesn't replay a cue.
- Start cues on an observed change (`useChangeCue`), never on mount. The one exception is a surface's arrival burst, and the 30 s rest keeps a remount from replaying it.
- The coordinator lives for one frontend generation. Tavern's `tavern-motion` content script activates it on mount, so its listeners are up before any surface renders, and its disposer ends it when bb replaces or deactivates the bundle (mounts are counted, so it ends only when the last one goes): running cues finish, every document and window listener goes, and it refuses cues and stays uninstalled until the next mount.
- For "why didn't it move": `window.__tavernMotion` returns a frozen copy of the coordinator's state on each read (`now`, `paused`, `reduced`, `composing`, `typingHoldUntil`, the held surfaces, the running cues with their time left, and the last 200 refusals with their reason and time). It is built on read, with no timer, and nothing done to it changes the coordinator. It exposes surfaces and cue keys, which are thread and entry ids (`journal:<thread>`, `tally:<thread>:<entry>`), and no content.
- A yielding cue (`yields: true`, only the hearth replay today) gives way to everything. It skips its turn, never queueing, while any other cue runs on its surface, while an ask, blocker or failure is on screen (`STUCK_IN_VIEW`: `[data-ask]`, `[data-stuck]`, `.t-bad` and any `[role=alert]`, so a refused action counts too), or when less than `YIELD_HEADROOM_MS` (2 s) of the window would be left after it. It counts toward the window only when it decides whether it plays itself, never when another cue is checked, so it can't be the reason another cue is refused. Its `restMs` replaces the 30 s rest for it alone. A surface that shows a failure or a blocker outside an ask marks it `data-stuck`.
- Every hearth cue (lighting, arrival, flare, out and the replay) counts toward the window only when it decides whether it plays itself (`ownWindow`, which `yields` implies), and never when another cue is checked. So a member who sets out as the hearth lights always plays its road step. A hearth cue still counts everyone's motion for itself, so it is the one that gives way when the window is full.
- Pass `onDone` when a cue carries a state change (a row removed, a hearth gone out). It runs when the cue ends, is settled or is refused, so the state always lands.
- The two moments use `useMoment`. They play once per device: the first time the card is active here, kept in `remember.ts`. A key or a pointer inside the card finishes the moment and still does its own job.

### Budgets (constants exported by `motion.ts`)

| Constant | Value | What it limits |
|---|---|---|
| `BURST_MAX_MS` | 5000 | Any one burst: the busy dot 3.2 s, the hearth's flicker 3.6 s, a road step 2.8 s |
| `PAGE_SLOTS` | 3 | Ambient bursts at once on a page view |
| `THREAD_SLOTS` | 1 | Ambient bursts at once in a thread (the busy dot) |
| `THREAD_SLOTS_HELD` | 0 | The same while the widget row is held: an ask is in the row |
| `JOURNAL_SLOTS` | 1 | Automatic cues at once in a journal panel, its own surface (`journal:<thread>`): an agent's stroke, the ribbon and the seal share it. None while a blocked or rejected entry is in view, or under the typing hold |
| `TYPING_HOLD_MS` | 2000 | Automatic cues on every surface after the last input in any text field (and while an IME composition is open): the typing hold. A guess, to tune |
| `ONE_SHOT_CUES` | 4 | Cues at once across every kind; the rest show only their still mark |
| `BURST_REST_MS` | 30000 | A target doesn't replay within this. A guess, to tune |
| `MOTION_PER_WINDOW_MS` per `WINDOW_MS` | 5000 per 30000 | 5 s for cues in any 30 s, overlapping cues counted once. A guess, to tune |
| `OWN_PER_WINDOW_MS` | 3600 | The hearth's own motion on top, at most 3.6 s per window; worst case 8.6 s, and the hearth only starts when the total has room. The party's steps carry the news; the hearth is ambient |
| `YIELD_HEADROOM_MS` | 2000 | A yielding cue plays only if this much of its surface's window is still free after it |
| `HEARTH_REPLAY_MS`, `HEARTH_REPLAY_MIN_MS` to `HEARTH_REPLAY_MAX_MS` (`hearth.tsx`) | 1500; 18000 to 26000 | The replay's one cycle, and its gap, drawn afresh each time. A guess, to tune |
| `MAX_TRAVEL_PX` | 160 | A move travels only this far and across no row; otherwise it fades and rises 8 px where it lands |

The budgets apply to automatic motion. The user's own actions (`auto: false`) and the two moments (`moment: true`) are registered, so they pause, settle and obey reduced motion, but they are never refused.

### Timing

- Tokens: `--tavern-ease` for entrances, `--tavern-ease-move` for moves between places, `--tavern-dur-cue` (300 ms), `--tavern-dur-move` (450 ms) and `--tavern-dur-moment` (1200 ms, the cap for the two moments, stagger included, at five members).
- Hover and expand take 110 to 150 ms; an arrival takes 600 ms at most.
- Ambient motion is opacity, or a shift of 2 px at most, on cycles of 1.6 s or slower. Scale and rotation belong only to the two moments. Journal tally strokes and gate slashes may scale along their own line from their start point (non-scaling-stroke), 180 ms, once per cue. Scale stays reserved for the two moments everywhere else.
- Change cues have no stagger; the two moments stagger by 100 ms.
- Animate only `transform` and `opacity`. `test/ui/kit/motion-css.test.ts` checks every stylesheet under `src/ui`: no `infinite`, no other animated property, and no opacity in the hearth's flicker or flare.

### Never animate

- Asks of any kind: cards, chips, counts, pointers and rows whose move is yours. The coordinator refuses anything inside `[data-ask]`.
- Blockers, failures (a failed member or quest row), evidence and numbers.
- A notice that needs the user, including its tack.
- The lantern glow, ever.
- Text being read: chat, the Ledger, journal entries, briefs.
- The composer, and the widget row while it is held.
- bb's own surfaces, and anything tied to scrolling.
- Skeletons: they are static, appear after 150 ms, and swap to content with no animation.

### Stop conditions

These cover cues already running, not only new ones.

1. The page is hidden (`document.hidden`): every registered animation pauses with its time held, and new cues are refused as "paused". On return they resume; nothing replays. A window that is visible but not focused keeps its cues, because watching from another app is still watching; the budgets, the rests and the typing hold still cap them.
2. The widget row becomes held (an ask is in it): its running cues finish at once, and none start.
3. The typing hold, one rule for every surface (the page, the widget rows, the journal): an automatic cue holds for 2 s (`TYPING_HOLD_MS`) after the last input in any text field (input, keydown of a printing key, or composition update), and for the whole time an IME composition is open. Focus doesn't count. A draft doesn't count either: bb focuses the composer, with any draft it restored, whenever a thread opens, and a focused field on the page (a rule editor, the Stop reason) is often only being read. A held cue is drawn still, never queued and played later. A cue already playing finishes; the hold only stops new ones. The one exception, deliberate and not a bug: the first keystroke cuts the widget rows' running cues at once, because they sit beside the composer (the busy dot pulses for 3.2 s) and nothing moves there while the user types. The cut cancels the animation, so the row lands on its rest state, never on the cue's end frame. The user's own changes and the two moments are unaffected. A field that loses focus ends its composition, so a lost `compositionend` can't hold cues for good. The listeners are passive and touch no React state, so typing re-renders nothing.
4. Every burst ends within `BURST_MAX_MS`, and the rest and window budgets stop bursts from chaining into continuous motion.
5. Reduced motion: under `prefers-reduced-motion: reduce` (all bb reads) or `html[data-motion="reduced"]` (the kit's test hook), `tavern.css` turns every animation and transition off, and the coordinator finishes anything running and refuses new cues. Every state keeps its still mark and word.

### The parts

- **Busy dot:** pulses twice (3.2 s) when its Keeper turns busy or the row comes into view busy, then holds solid.
- **Road crest:** a member who sets out moves onto the road, then takes one 2 px step.
- **`Hearth`:** the tavern's state in one glyph, 24 to 40 px, always with its words from `hearthWords`. It is lit while the tavern is at work: a Keeper busy, or a member on the road (`onRoad`, from `onTheRoad(room)`, the same count as the status line's "on the road"). The words name only what is at work, with no total: "Lit · 1 Keeper busy · 2 on the road", "Lit · 2 on the road", "Lit · 1 Keeper busy", and otherwise "Banked · nobody at work". "Not lit · no active Keeper" shows when every Keeper is archived and nobody is on the road, and "Not lit yet · no Keeper" on the first night. Archived Keepers never count as busy, since the rows flag them. At closing time the words stay "Out": "Out · closed until 08:00", then "Out · was due back at 08:00" once the Back at time has passed, or "Out · closed" with no end time. The clock is local 24-hour time with the day when it isn't today ("Mon 08:00"), from `awayClock`, which the status line shares. Nothing shows until the room carries its closing-time status. It lives inside a heading or a scene, never as its own card and never beside an ask count. Its flames move and never dim, so they keep 3:1 on every surface. With `replay` (the "Hearth flicker while work runs" setting, `room.hearthFlicker`, on by default), a lit hearth on a visible page replays one 1.5 s cycle of the same 1.5 px flicker at a gap drawn from 18 to 26 s, so it never ticks like a clock; arrival and becoming lit keep their two 1.6 s cycles. It is a yielding cue, so it also waits out typing, a hidden page and reduced motion, and the first turn within 30 s of lighting skips. It stops at once when the hearth banks, and a replay re-renders nothing. With `settingsHref`, its words then end "Flickers while work runs · Settings ›" on hover or focus (always where there is no hover), linking to the setting: with reduced motion, that is the off switch WCAG 2.2.2 asks for, one step from the thing that moves.
- **`ArrivalMark`:** the primary mark and the word "new" on what changed since the last look (`useLookedSince`), faded in once.
- **The two moments:** the party forming (the seal stamps and the party is dealt, 1,000 ms at five members; the party card's deal, 800 ms) and the tale being told (the credits on the tale page, retimed with Zack in step 3).

## Words

- Themed words keep their plain anchor through `Vocabulary`, `vocab()` or `.anc`: "Quest map (greenlight)", "Smith (builder)", "Ledger (lead state)". Use `VOCABULARY` for every themed word instead of typing it.
- "Board quest" means a goal pinned on the board. "Journal" means one thread's own checklist. Never use "quest" alone where both could fit.
- When space runs out, drop the whole anchor before truncating the name, and truncate task text before either. Never cut an anchor mid-word. `MemberChip` does this by itself: its anchor wraps onto a hidden second line when it does not fit.
- Character voice appears only in voice slots: a member's sign-off line on a report, row labels, the two moments and empty states. With Character voice off in Settings, no character line is drawn anywhere and the history is kept: every voice slot checks `voiceShown(registry)` (`ReportView` and the thread's `ReportCard` take it as `voice`), which is false while the registry is unknown, so a turned-off line never flashes in. Asks, blockers, findings, evidence and numbers stay plain. Health-sounding voice is suppressed while any owned quest is degraded.
- Agents never see levels or loot; those are for the user.
- The cellar is the archive's name wherever the user reads it: `<Vocabulary word="cellar" />` gives "Cellar (archived)". A returned or stopped quest is not done until the user sends it to the cellar, which is their acceptance, so returned quests stay in view until then. Take every cellar string from `CELLAR`: `send` "Send to the cellar (archive)", `sendAllReturned`, `restore` "Bring up", `link(n)` "Cellar (archived) · N" (add `OpensMark` for the ›), `sent(n)` "2 sent to the cellar" (add the Undo button beside it) and `autoSetting`. Code, tables and RPCs keep "archive".
- Plurals: use `<Vocabulary word="errand" plural />` or `vocab("board", true)` for themed plurals, and `plural(n, "thread")` for counts ("1 thread", "2 threads"). Never write "1 threads".
- Names: a live member's name is `member.displayName ?? character.name` ("Lark II" when a party repeats a name). `memberIdentity` already applies it, so read the name from it and never from the registry directly. The one exception is a level line: a level belongs to the character, so `reachedInParty` names it with the character's own name and says each crossing once, however many members share the character.

## Crests and glyphs

- The shape is the class: shield for the Keeper, pennant for the Ranger, tower for the Smith, lozenge for the Warden, roundel for the Wanderer; `square` is spare for custom classes. The inner charge is the character, and the hue comes from `HUE_CSS`. Shapes and charges are defined in `src/shared/heraldry.ts` (Keela owns it). Identity must read from shape and charge alone, because the dark themes collapse the six hues to about three families.
- Sizes: 14 px in sidebar rows (bb's row status, from registered SVG icons), 16 px for the composer toggle, 18 px in the widget row, chips and cards, and 24 px and up on the Tavern page and character sheets. Below 24 px the `CREST_PATHS_SMALL` drawing is used.
- Glyphs (`Glyph`) are drawn on a 24-unit grid with a 1.9-unit stroke in `currentColor`, shown at 13 to 16 px. They sit at the same optical weight as bb's own icons next to them in the composer and the side panel.

### Levels and notches (`level.ts`, `Crest level`)

- **One rule for every class:** a level per 8 earned results (`RESULTS_PER_LEVEL`), each class counting the work it is trusted for (`earnedCount`):
  - makers (Rangers, Smiths, Wanderers): waypoints a Warden verified;
  - Wardens: independent checks, whatever the verdict, so a level never rewards passing work; same-family checks never count;
  - Keepers: quests brought back with at least one verified waypoint (`keeper.verifiedReturns`), so a quest whose optional waypoints were all skipped earns nothing.
- Read a level with `levelFor(registry, characterId, classId)`, never by counting on a surface; the counts come from the lasting service record, which archiving threads doesn't erase.
- **Words** (`levelOf(...).words`): "Level 2 · 7 more independent checks for level 3." Each number is said once: the line names what is still needed, in its unit ("verified waypoints", "independent checks", "quests with verified work"), and the record keeps the counts. With nothing earned there is no level: no level line and a plain crest, and the sheet says `noLevelWords` ("No independent checks yet"). `LEVEL_BASIS` says where a maker's or a Warden's levels come from, once beside the line; a Keeper has none, as its unit says it.
- **Notches:** a crest of 24 px or more cuts one V-shaped notch per level past the first, at most 5 (`MAX_NOTCHES`), so level 1 is the plain crest and every notch was earned. They're grouped on the shape's plainest edge: the top of the shield, square and pennant, the left side of the tower (its top is crenellated and its base keyline too thin to carry a cut), the upper-left edge of the lozenge and the top of the roundel. Each cut is 1.5 units wide and 2.6 deep (2.6 px on a 24 px crest), and the gap between cuts is as wide as a cut, so five read as five marks, never a saw edge or a crown; five fit on every edge, so a cut is never dropped. The cut is a mask, so it shows the surface behind in any theme, and its two sides carry the keyline (a stroke clipped to the field inside the ring), so a notch reads as carved on a light field too, never as a gap in the outline. Below 24 px, and in the sidebar's registered icons, crests stay plain.
- A notched crest's name adds the level ("Juno, Smith, level 3"). Where the words don't fit beside it (chat cards), they go in the control's tooltip.
- Levels are for the user only: agents never see them.

## Using the kit

Build new surfaces from the kit's exports before writing new markup: `Vocabulary`, `MemberChip`, `PartyPicture`, `Clamp`, `KeptInMind`, `KeeperNoteRows`, `GateRows`, `Kpi`, `Chart`, `DecidedForYou`, `StatusMark`, `StatusPill`, `PhaseStrip`, `EvidenceList`, `TimeAgo`, `QueryState`, `Crest`, `TavernCharacter`, `Glyph`, `IconButton`, `OverflowMenu`, `OpensMark`, `ExpandsMark`, `AskCard`, `QuestMap` and `Button`. Keep their exports stable; the Tavern page imports them. Page-only parts may use their own `tv-*` classes, but they take every value from the tokens above.

Selectors start at `.tavern`. A part's root carries `tavern` and its own class on the same element, so write `.tavern.ask, .tavern .ask` when the part can be a root.

Text that reads the clock gets its time from a hook in the part that shows it, never from `Date.now()` during render, because memoized parts render again only when their props change. Use `useToday()` for words that change with the date ("23:50" today, "Nov 14 23:50" after), which re-renders once at midnight and on return to the tab. Use `useNow()` or `TimeAgo` for ages ("3m ago"), which tick every minute. `localTime`, `keeperStartedLabel` and `guardRecordWords` require that time as an argument.

## No modals

Tavern never covers what the user is deciding about. There are no modal dialogs, no centred or absolutely placed forms, and no scrims.

- Forms and decisions open in bb's side panel beside the content, the way Shuttle does: register an `experimental_tab` and open it with `experimental_panel.openTab({ tab, params })`. Tavern's Re-route, Make this a rule, Journal and Ledger work this way. On phones bb shows the panel as a sheet, so the tab repeats what the decision is about at its top (Re-route quotes the message, a rule starts from the message text, an ask shows its question), and it offers "Back to chat".
- A one-line confirm (Delete, Stop, Undo) expands in place, beside the control that asked for it, with the consequence in words and a way back. Never use `window.confirm`.
- Allowed overlays are menus and pickers anchored to their trigger, as bb draws its own (the model picker, the class picker, overflow menus). They list choices; they never hold a form, and Escape closes them and returns focus to the trigger.

## Ledger and other state panels

Lead with what is true now and fold the past. The order is: what needs the user (asks, rules to confirm, hand-backs), the active work with its next step and outside gates, what the Keeper keeps in mind (promises and facts), Decided for you, the user's standing instructions, finished work in one line each, and then history in folded sections with counts (answered asks, all decisions, read-as routes, rules turned off, archived quests). Finished work collapses to one line ("Returned · verified 2 of 2 ›"). Long text (decisions, steers) is clamped to one or two lines and expands in place. Text you act on is never cut: a rule beside Confirm or Turn on wraps in full under its label, with the buttons on the label's line. On a narrow Ledger, one-line rows move their meta under the title rather than squeezing it, and fold anchors wrap onto their own line rather than breaking the label. The Ledger is its own size container (`tavern-ledger`), so these layouts are the same in the side panel and the phone sheet.

- Decided for you is an attention list, not history. "OK ✓" on a row and "Mark all seen" in its header take decisions out of it everywhere (the Ledger, the common room, the widget's "N decided") without undoing them; a quest sent to the cellar takes its decisions out by itself. Every decision stays in "All decisions" and on its quest page. Use `DecidedForYou` with `total` (the server's uncapped `decidedCount`) and `useDecisionSeen`; the kit owns the in-place receipt "Marked N seen · Undo". "Mark all seen" sends the ids on screen, or the scope's `all` through the snapshot watermark when the list is clipped, so a decision that arrives after render stays unseen.
- History lists that can grow page with "Show more · N of M" at the end, newest first; never a cap without a way to the rest.
- Panels remember where you were, per device: scroll, folds, filters and the open item come back when the panel reopens. Mark each fold `<details data-fold="name">` and call `useRememberedView(rootRef, key, ready)`; keep other view state in `useRemembered(key, initial, accept)`. Keys name the surface and the thread (`ledger:<threadId>:view`); `accept` rejects stale values, which fall back to the default. An explicit link to a place always wins over the remembered one.

## Panels

bb's side-panel tabs are fixed-height boxes with `overflow: hidden`, so every tab root (`.journal`, `.ledger`, `.rtab`, and any new one) is its own scroll container: `height: 100%; min-height: 0; overflow-y: auto`. Never give a tab `min-height: 100%`, because it then grows past the panel and cannot scroll. Sticky headers stick inside that container.

## Checking a surface

1. Look at it with bb's real stylesheet: the fixture harness in `/Users/me/.bb/thread-storage/thr_kyhzwgqhx4/design/prod/harness/` loads bb's app CSS and the plugin CSS, with the three themes and the widths.
2. Run `~/.agents/skills/ux-design/scripts/audit-page.js` with the root set to each top-level `.tavern` element, in all three themes at 1400, 720 and 390 px, with a `minTarget` of 44 at 560 px and below. Contrast, small text, small targets, unnamed controls, text spill and sideways overflow must all be zero.
3. Run the overflow check, [`overflow-check.js`](/Users/me/.bb/thread-storage/thr_kyhzwgqhx4/design/system/overflow-check.js), in the same themes and widths. It lists text drawn past its card (spill), boxes that clip letters without an ellipsis (clipped) and text cut vertically (cut). All three must be zero. Intended truncation with an ellipsis is not counted.
4. Check optical centring on new rows: each icon's ink centre and the text's cap centre must be within 0.5 px.
5. Take screenshots of what you changed, look at them yourself, and send them for review.
