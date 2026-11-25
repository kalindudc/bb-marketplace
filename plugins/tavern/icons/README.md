# Tavern icons

Tavern's own marks: the plugin icon, a small set of glyphs for its UI and its tool timeline rows, and the source that draws the crests. Preview them at 14, 16, 20, 28 and 96 px in gruve light, gruve dark and gruvbox dark.

## How they are drawn

- A 24 by 24 grid, `currentColor`, a 1.9-unit stroke, square caps and mitred joins, so they sit beside bb's own icons and the kit's `Glyph` at 13 to 16 px.
- Each glyph is one stroke-only path, and every one is also in the `PATHS` table in `src/ui/kit/glyphs.tsx` under the same name, so `<Glyph name="ask" />` draws it. Keep the two copies equal when you edit one.
- Each glyph's ink box (`getBBox()` over its path) is centred on (12, 12) within 0.5 units, because the kit centres the text beside an icon on the icon box's middle. Check the box by rendering the SVG and measuring the path.
- Colour comes from where the glyph is used: the text colour, `--success` for verified, `--tavern-bad` for rejected, never a colour of its own.

## The plugin icon

| File | Use |
|---|---|
| `tavern.svg` | The plugin icon and the nav rail entry (`bb.branding.icon` and `experimental_icons.tavern` in `package.json`). A tavern sign: a wall bracket, a board on two chains, a Keeper's shield on the board. bb paints it as a mask in the theme colour, so it is one silhouette with a 1.8 stroke, matching the rail's weight at 16 px. |

## Glyphs

| File | Name | Use |
|---|---|---|
| `board-quest.svg` | board-quest | A board quest: a goal a Keeper holds, pinned on the board. Board quest chips, the quest board, `tavern_quest` rows. |
| `journal.svg` | journal | A thread's own checklist. The "Journal · 2 of 7" control, the Journal tab, `journal` tool rows. |
| `quest-map.svg` | quest-map | The plan to greenlight (a folded map). The quest map card, `tavern_plan` rows. |
| `ask.svg` | ask | A question that waits on the user. The asks pill ("3 need you"), the needs-you queue, `tavern_ask` rows. |
| `decided.svg` | decided | Decided for you: a reversible call the Keeper made (a signpost). The "3 decided" control, `tavern_decide` rows. |
| `party.svg` | party | The party: members staffed on a board quest (two shields). The party picture's heading, `tavern_hire` rows. |
| `ledger.svg` | ledger | The Keeper's lead state. The "Ledger (lead state)" control and tab, `tavern_status` rows. |
| `report.svg` | report | A member's report to its Keeper. Report cards and digests, `tavern_report` rows. |
| `standing.svg` | standing | Permanent work. The loop badge on a permanent member's mark in the plan card. |
| `wax-seal.svg` | wax-seal | The greenlight under 28 px: a plain round seal with two ribbon tails and the Keeper's shield, so it can never read as a settings cog. The "Form the party" seal button and the "Sealed 12:58" stamp. |
| `wax-seal-large.svg` | wax-seal-large | The greenlight from 28 px up: the scalloped wax seal with the shield. The quest map card's seal mark and the Tavern page. |
| `tick.svg` | tick | A Keeper update: the tick loop's one message per minute (a pulse). `[Tavern tick]` rows and the held-while-you-typed note. |
| `side-quest.svg` | side-quest | A side quest: a short errand off the main road. The side-quest lane, `::tavern-errand` cards, errand hires. |
| `verified.svg` | verified | A Warden verified an entry (a tick in the Warden's lozenge). Journal entries and map waypoints in the verified state, verify rows. |
| `rejected.svg` | rejected | A Warden rejected an entry (a cross in the lozenge). Rejected entries and waypoints, reject rows. |

The kit's own glyphs stay as they are. Where a new glyph is close to a kit one, use the new one for the Tavern idea and the kit one for the plain action: `journal` for the journal and `list` for a generic list, `ledger` for the ledger and `book` for docs, `ask` for an ask and `bell` for a notification, `quest-map` for the plan and `route` for a path between two things. The kit's `seal` (a starburst) stays for any non-greenlight use; the greenlight uses `wax-seal` or `wax-seal-large`.

## Crests

The crests are not files here. `source/crests.mjs` generates `src/shared/heraldry.ts`, which every surface draws from: class silhouettes, charges, the hue colours and three precomputed paths per crest (an inlay, the hue with the charge cut out, and a keyline), in a bold cut under 24 px and a standard cut from 24 px. Two charges are drawn so they can never pass for buttons: the fess is dancetty (a zigzag band), and the cross is pattée (arms that flare and run sharp to the rim). A plain band or cross in a roundel reads as a minus or plus button. Edit the geometry in `source/crests.mjs`, then regenerate from `plugins/tavern`:

```sh
mkdir -p /tmp/paper && npm i --prefix /tmp/paper paper@0.12   # paper.js does the booleans; not a plugin dependency
PAPER=/tmp/paper/node_modules/paper node icons/source/crests.mjs src/shared/heraldry.ts
npx tsc -p . --noEmit
```
