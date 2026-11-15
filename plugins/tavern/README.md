# Tavern

Hand a goal to a lead agent and keep the decisions. Tavern gives that lead a
plan, a team and a recorded ledger, so you can steer the work from one thread
instead of carrying messages between agents.

The lead is called a Keeper. It hires scouts, proposes a quest map for your
approval, then sends builders and a checker to the work. You see what needs
you, read their reports and follow the result back to its evidence. Every
thread also gets a journal: a checklist separate from the team's board quests.

This is draft release documentation. Tavern has not been published to this
marketplace yet; the commands below apply after its first release. See
[Current limits](#current-limits) before trying it.

## Install

```sh
bb marketplace add git:github.com/kalindudc/bb-marketplace@main
bb plugin install tavern@kalindudc
```

Tavern needs bb 0.49 or newer and providers that offer the models configured
for its classes. Open Classes to inspect them, and change provider, model or
reasoning overrides in Settings before starting. Git and bb's git-worktree
environment provider are needed for isolated coding worktrees.

If you use the old pi-quests plugin, disable it before enabling Tavern: both
claim the legacy `quest` tool name. Tavern imports old checklists when it
first reads them after taking ownership. Restart existing agent sessions to
pick up the new `journal` tool schema.

## Start with one small goal

1. Open Tavern from bb's left navigation and choose Start a quest. Send your
   goal in the Keeper thread it prepares. Include what a checked result looks
   like and anything the team must not do.
2. Let its Rangers scout. Read the proposed quest map, the party and any
   questions. Approve the plan when it is right; explicit approval is the
   default before the planned building work starts.
3. Continue in the same Keeper thread. Name the quest when you steer one of
   several goals. Questions, quick asides and standing rules are recorded
   separately from changes to the plan. A rule stays with that Keeper unless
   you explicitly make it global.
4. Answer asks on the page or in the thread. Open a member's report in the
   side panel when you want the evidence, not another status message.
5. Read the returned tale: what changed, who made and checked it, what was
   verified and what is still yours to do. Returning a quest does not commit,
   push or merge the work for you.

Scouting and coordination use model turns too. A plan awaiting approval does
not mean no usage has occurred.

## Who does what

A class defines the job and its allowed work. A character supplies a name,
crest and a few short presentation lines; it does not add expertise or
permissions.

| Class | Job |
| --- | --- |
| Keeper | Leads the work, records your decisions and delegates rather than building. |
| Ranger | Answers bounded scouting questions with evidence. |
| Smith | Builds a scoped deliverable. |
| Warden | Checks the maker's claims in a separate context and verifies or rejects linked journal entries. |
| Wanderer | Handles a bounded task or side quest. |

A separate checker thread is not automatically an independent model-family
check. Tavern labels a same-family fallback rather than calling it
independent. Levels count verified wins for presentation only; agents never
see them.

## Follow the work

The common room brings together asks, quests, side quests and solos. A quest
page shows its map, whose move comes next, party, rules, decisions, Notebook
and event history. The connection map shows how Keepers, quests and people
relate. Returned work has a tale with credits and verified results; stopped
work remains distinct from a successful return.

The Journal segment above the composer opens the thread's checklist. Agents
can add steps, attach evidence, mark blockers and undo grouped changes.
Linked work needs evidence, and only its assigned Warden can verify or reject
it. Keepers' board-quest entries mirror the quest phase, not an agent's tick.
Journal reminders do not start agent turns.

Character sheets let you edit the presentation fields and preview short
lines. Their work-shaping lens stays read-only. Classes can be inspected on
the page and overridden with Markdown files in `~/.agents/tavern/classes/`
or a project's `.agents/tavern/classes/`; project files take precedence.
Treat those files as trusted agent instructions, not harmless appearance
settings.

## Keep control of usage and scope

Tavern's agents are ordinary bb threads using your providers. There is no
hard dollar cap. The default party ceiling is five, with a review budget of
three. Keep the first quest small and watch provider usage. If Burn is
installed, Insights also shows its recorded costs; that section is hidden
when Burn is absent.

Stop quiets a Keeper's automatic updates; it does not cancel the working
party. A user message or accepted action can wake it again. Use Stop quest
when you mean to stop that quest's party. Tavern's global pause holds its
automatic ticks while leaving asks answerable.

Scoped work prefers Pi's pre-execution guard. Check its state with
`bb tavern guard status`. Other providers require an explicit detection-only
exception: violations can be noticed, but are not prevented by that watcher.
No preset or guard grants permission for a production change, merge,
deployment, deletion or message sent as you. Those still need your explicit
consent; production commands also need immediate confirmation.

## Settings, backups and the terminal

Settings controls pacing, providers, presentation, notifications and
retention. Automatic pacing tuning is off by default. You can enable
suggestions, pin values and inspect or undo recorded changes. Memory limits
are not tuned down.

```sh
bb tavern status
bb tavern quests
bb tavern settings export > tavern-settings.toml
bb tavern backup save --with-data --json
bb tavern backup list --json
```

Settings imports and backup restores offer previews. Save with data writes a
private, server-local backup; restoring records requires an empty Tavern
database. User-authored notes can be private. A Tavern bundle is not a backup
of bb's thread transcripts, project files or credentials, and it does not
transfer live machine-allocation authority.

See [Settings and Insights](docs/settings-backend.md) for TOML, audited
changes and tuning, and [Backups](docs/backups.md) for restore, retention and
automation recipes.

## Current limits

These limits describe the last reviewed installed checkpoint. The new
[Closing time backend](docs/closing-time.md) has source tests, but still needs
the combined build and live check before these installed-version limits change.

- Closing time and its away controls are previews, not an enforced away mode.
  While closed currently shows recent activity, not a recorded away window.
- Classes has a read-only page, not a class editor. Character voice editing
  works, but its preview is not an automatic behavioral voice check; that
  check is not implemented.
- The connection map can label an archived Keeper as listening. The common
  room distinguishes archived threads correctly.
- Machine placement is still under development. Leave its rules empty for
  the existing execution behavior.
- The next live reliability run is still pending. Unit tests and saved tales
  are not proof of recovery after a real provider compaction or repeated
  interruptions.
