# Glossary

Tavern defines each concept once here. Other pages link back to these terms instead of re-explaining them.

## Roles and classes

A **class** defines a thread's job, tools, and guardrails. A **character** supplies a name, pixel-art avatar, crest, and short presentation lines—never permissions or expertise.

### Keeper
The lead agent thread for one or more goals. A Keeper scouts, proposes a [quest map](#quest-map), hires and briefs party members, tracks your decisions, and returns the final [tale](#tale). Keepers delegate rather than building directly.

### Ranger
A read-only scout hired to answer bounded questions with evidence before or during a quest.

### Smith
A builder hired to deliver a scoped [waypoint](#waypoint) in an isolated worktree or dedicated machine.

### Warden
A separate checker hired to inspect a maker's deliverable and evidence, then verify or reject its linked [journal](#journal) entries. Tavern prefers a different model family from the maker and labels same-family fallbacks explicitly.

### Wanderer
A general-purpose agent for a bounded errand or side quest. A Wanderer you start directly has no Tavern scope file; a Wanderer hired by a Keeper runs under the open scope preset with protected roots and consequential shell checks.

## Work and lifecycle

### Quest
A goal tracked on Tavern's board by a Keeper. A quest moves through recorded phases (`scout`, `greenlight`, `build`, `closing`, `done`, `stopping`, `stopped`, plus user `held`). A **side quest** or **errand** is bounded work run by a Wanderer outside the full map-and-check flow.

### Quest map
The Keeper's proposed plan: what "done" means, a critical path of [waypoints](#waypoint), who acts on each, how each is checked, an optional spend budget, and up to three open questions. Explicit approval (**greenlight**) is the default before planned building starts.

### Waypoint
One checkable deliverable on a quest map. Each waypoint specifies its check method: Warden verification, Keeper check, outside gate, or report-only.

### Journal
A thread's personal checklist, available in every bb thread via the Journal segment above the composer and the `journal` tool. Separate from board quests: linked entries require evidence and can be verified or rejected only by their assigned Warden.

### Needs you
The unified attention queue across the Common room, composer widget, Ledger, and homepage quest rows. It gathers open asks, checker handoff holds, proposed standing rules awaiting confirmation, and Keeper hand-backs.

### Tale
The saved record of a returned quest: the Keeper's final delivery, verified results, figures, open pull requests, credits, and what remains for you. Stopped quests never become tales.

### Cellar
Tavern's archive for returned or stopped quests. Sending a quest to the cellar archives its party threads (and the Keeper when it holds no other active work) while keeping its history and character service records intact. Deleted quests can also be restored from the cellar.

## Controls and infrastructure

### Scopes
Per-thread guardrails (`readonly`, `checker`, `worktree`, `open`) controlling tools, file writes, shell commands, consequential acts, sends as you, and cluster writes. Configured via Settings (`Enforce`, `Watch`, `Off`) and `~/.agents/tavern/scopes.yml`. See [Scopes and guardrails](scopes.md).

### Closing time
An away window you open when stepping away. For each quest you choose **Drafts-ready** (allow guarded private work under a temporary stop list) or **Pause** (interrupt and hold members). Returning produces a digest of what happened while closed. See [Closing time](closing-time.md).

### Stop all
An emergency brake that stops every known live Keeper and member turn and holds new ticks, briefs, hires, spawns, and cleanup across restarts until you press **Resume** on the Common room. See [Stop all](stop-all.md).

### Machine rule
A rule in **Settings → Where work runs** that places newly hired working members on their own new machines via bb's environment and machine providers, optionally overriding class models and pull-request targets. See [Machines and snapshots](machines-snapshots.md).

### Forge profile
A named GitHub (`gh`) or custom shell-command profile under `machines.forges` that lets Tavern push a placed Smith's branch and open or manage draft pull requests from your home machine. See [Draft pull requests from home](forges.md).

### Keeper refresh (succession)
Moving a Keeper's active charge, quests, and open asks onto a fresh Keeper thread when context grows long, while keeping the old transcript linked for reference.

### Keeper chain
A hierarchy where a Keeper hires another Keeper as a **lead** for a greenlit waypoint. The lead holds one party seat, opens a linked child quest, and shares chain depth, total member, and parent spend limits.
