# Tavern documentation

Start with the [README](../README.md) for installation and a first quest, or browse the guides below by role.

## Using Tavern

| Guide | What it covers |
| --- | --- |
| [Glossary](glossary.md) | One-stop definitions for every Tavern term. |
| [Quests, party and characters](quests-and-party.md) | Starting and steering quests, verbatim wording, lifecycle controls (Hold, Reopen, Stop, Cellar), spend and review budgets, delegation, Keeper refresh and chains, classes, characters, and service records. |
| [Scopes and guardrails](scopes.md) | Class presets, Enforce/Watch/Off modes, consequential shell acts, send guard, cluster writes, macOS Git sandbox, `~/.agents/tavern/scopes.yml`, and guard CLI. |
| [Machines and snapshots](machines-snapshots.md) | Machine placement rules, per-class model overrides, read-only snapshot capture, submission binding, preservation, and private Git refs. |
| [Draft pull requests from home](forges.md) | Forge profiles (`machines.forges`), `tavern_draft_pr`, command environment contract, setup preflight, and PR ownership. |
| [Closing time](closing-time.md) | Away windows, end states, temporary stop lists, guarded vs watched work, wakes, and reopening digests. |
| [Stop all](stop-all.md) | Emergency Stop all brake, Pause every Keeper, stop confirmations, Resume, and caller provenance. |
| [Backups](backups.md) | Saving, inspecting, exporting, previewing, and restoring private backups, retention, exit codes, and daily automation. |
| [Settings and CLI](settings-and-cli.md) | Settings sections, guided setup proposals, tuning, Insights, and the complete `bb tavern` CLI reference. |

## Reference for contributors

| Reference | What it covers |
| --- | --- |
| [Build and architecture](BUILD.md) | Plugin architecture, source layout, core invariants, and development workflow. |
| [Testing](testing.md) | Vitest filesystem isolation, fixture rules, and local verification commands. |
| [Steer replay](steer-test.md) | Two-goal live steer replay script referenced by `bb tavern steer-test`. |
| [Keeper mechanics reference](keeper-reference.md) | Detailed ask, scope, tick, closure, archive, backup, and CLI mechanics referenced by the Keeper skill. |
| [Settings and Insights backend](settings-backend.md) | Settings schema, precedence, TOML/dotfiles, deterministic tuning, Insights coverage, and public RPCs. |
| [SDK contracts](sdk-contracts.md) | Audited backend bb SDK call inventory, strict fake test host, and RPC JSON boundaries. |
| [Requests for bb](host-asks.md) | Open upstream bb host capabilities Tavern tracks and its current mitigations. |
