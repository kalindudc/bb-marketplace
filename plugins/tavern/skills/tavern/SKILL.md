---
name: tavern
description: Tune Tavern global settings with bb tavern settings get, set and import, only when the user asks. Class models, reasoning and motion may be tuned from any thread; machine rules and other guardrails may be changed only from a plain thread or Tavern’s Settings page.
---

# Tavern

## Stop all

Anyone, including a Keeper or member, may run `bb tavern stop-all`, including again while stopped. It sends bb a stop for every known live Keeper and member without gating on a status read, and holds new ticks, briefs, hires, spawns and pending releases and archives across restarts. It changes no quest state and releases no party member or machine. Read the stored state and last receipt with `bb tavern stop-all status`. A timeout is still stopping, not failed; later thread observations update the receipt without a polling timer.

Person-only messages pass. A message queued together with Tavern's own work waits until you resume. bb's Send now bypasses the dispatch hook and may send the held automated work with the message; it is NOT a way to send only your message while preserving the brake.

Resume is intended for the user on the common room. There is no CLI resume command. Plugin callers and any exposed agent or CLI markers are refused and the available surface is recorded. bb groups the page, CLI and agents as client callers with no thread id or origin, so Tavern can't prove a person pressed Resume. The receipt and common room state that limit. NEVER use a generic RPC call, shell or another send or spawn path to bypass the brake.

The stop scope is Keeper and member turns. Already-running hidden tale-renderer companions and character voice checks are outside that scope and can finish; new renderer and voice-check spawns are held. A placed hire stopped before spawning may free its unstarted reservation; no member or machine exists to release. See `docs/stop-all.md` for the receipt and caller limits.

Pause every Keeper is a separate setting on the common room and Settings page: it pauses new Keeper work while running turns finish.
## Draft pull requests

Smiths use `tavern_draft_pr` to keep the quest’s pull request record current. When the hire brief says pull requests open from home, commit the work and pass `title`, `body` and optional `base`; Tavern carries only the committed tree, pushes the member’s own branch and opens a draft. It never marks ready or merges. Read the result for excluded uncommitted files and the pushed commit.

When pull requests open on the member’s machine, open a draft with your own tools as your scope allows, then call `tavern_draft_pr` with `url`, `title` and optional `base`. This records it without pushing. Pass `forge` as `gh` or an enabled forge profile ID when known; omit it to record unknown. Reuse the same PR for the same head. Releasing the Smith hands open PR ownership to its Keeper without closing it.

The user configures profiles in Where work runs under `machines.forges`. These are guardrails; Tavern-managed threads MUST NOT change them. See `../../docs/forges.md` for the command contract.

## Tune settings

Tavern-managed threads (including archived Keepers and members) may preview guardrails but cannot apply them; change those on Tavern’s Settings page or ask from a plain thread.

Change settings ONLY when the user asks. Preview first, show the user the preview, then use `--apply`.

1. Read effective settings with `bb tavern settings get` or `bb tavern settings get classes`.
2. Preview a patch with `bb tavern settings set classes.smith.model=model-id tavern.ambientMotion=lively tavern.repeatSeconds=20`. Keys use camelCase dotted paths. Values are JSON (objects, arrays, numbers, booleans or null) or unquoted strings.
3. Add `--apply` to write the patch. Untouched keys remain unchanged. Every agent apply records the calling thread in Settings history and can be undone there.
4. For a complete replacement, preview `bb tavern settings import --toml "<TOML>"`, then add `--apply`. Import resets omitted explicit settings and pins to defaults.
5. Export with `bb tavern settings export`. Agent file exports and backup restores with data remain user-only.

Agents may preview and apply global settings while "Agents may change settings" is on (the default). When locked, previews remain available; ask the user to enable it before applying; NEVER try to bypass the lock. Settings changes do not grant consent for asks, Return, production work or other guarded actions.
