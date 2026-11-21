---
name: tavern
description: Understand Tavern’s Keepers, quests and guardrails. Discover a setup, tune settings when the user asks, open draft pull requests as a Smith, or use Stop all.
---

# Tavern

A Keeper leads a quest. It turns the user's goal into a plan, works within the approved limits, hires other members, and brings decisions it cannot make back to the user. A class describes a member's role, tools and execution settings; a character is how that role appears and speaks. Rangers scout, Smiths make changes, and Wardens check work they did not make. A plain bb thread does not take a Tavern role.

A quest's waypoints describe what has to be done and how to check it. Keep reported, accepted and independently verified work distinct. The Journal holds a thread's checklist and evidence; the Ledger holds the Keeper's plan, party and decisions. Use the class instructions for the mechanics of each role.

An ask is a recorded decision for the user or a Keeper with the right delegation. A preference, a greenlight and a delegation grant different authority; none unlocks everything. Scopes constrain tools, paths and consequential actions. Watch only records what it detects. Do not treat a missing guard or a permissive scope as consent.

Machine rules match new work to a target and say what may be provisioned. A rule can choose a different provider, model and reasoning level for each class it places. A forge profile names the commands used for pull requests from home; otherwise a member opens and records the draft on its own machine. See [the settings reference](settings.md) for defaults, authority and the structured values.

Attention settings control the review budget, notifications and quiet hours. Closing time holds selected kinds of action for a window; it does not grant consent when the user returns. Stop all is the broader brake and holds the whole party's turns and new work without throwing away the quest.

## Setup

1. Use `bb tavern setup discover` to read bb’s current facts as JSON. It lists registered checkouts and the default branches bb knows, normalized project remotes, offered environment and machine providers, model catalogs, and the current Tavern settings revision and placement policy. Use `--project <id>` to narrow to a project or `--host <id>` to look at providers on a specific host. An unknown branch or a catalog error is not evidence of a default or of model availability.
2. Check what the SDK does not know on the intended source host. Use `git remote -v` to inspect the checkout’s actual fetch and push remotes. Use `command -v` for the forge CLI and `gh auth status` if it uses `gh`. Inspect the script paths on disk without running an unreviewed script. Keep project-specific preferences in the user's configuration, not in the base skill.
3. Use `bb tavern setup propose --toml "<PATCH>" --reasons '<JSON>'` once you know what to change. TOML contains only the settings to change. Reasons use camelCase dotted keys, for example `{"classes.smith.model":"Use the model you picked."}`. Each changed key needs one line. `machines.rules` and `machines.forges` are ordered arrays: if changing one, copy the unchanged rows into that array in the patch. Get them from `bb tavern settings export` (TOML), or read `placement` in discovery (camelCase JSON, not snake_case TOML). See the [reference examples](settings.md#setup-examples). A preset file is the same TOML patch passed to `--toml`, with reasons supplied separately. Do not use a full settings import: it resets omitted explicit values and pins.
4. For new or changed command profiles, use absolute executable paths without arguments for the open, state and close entries. The files must be outside agent checkouts and thread storage. Each script must support a read-only `--help`. Tavern reads paths and catalogs before showing the proposal; it never runs those scripts until Apply. A model for a machine that does not exist is marked not checked yet; it is checked when the first member starts there.
5. Put the returned `::tavern-setup{id="…"}` directive on its own line. Every setup proposal waits for the user's Apply, whatever its keys. The user can review or dismiss it from the thread or Settings. Never apply for the user. Apply is theirs to press: Tavern blocks agents it can recognise, but it can’t tell every agent’s call from their click. If a named setting changed or a check fails, fix the issue and propose again. Changes outside the patch stay as they are.

6. Ask the user to open Tavern Settings, Your attention, and press "Send a test alert". Have them check their device and choose "It arrived" or "It did not". Only the user should send and answer the test. Do not treat a successful send as proof that a device showed it.

## Stop all

Anyone, including a Keeper or member, may run `bb tavern stop-all`, including again while stopped. It sends bb a stop for every known live Keeper and member without gating on a status read, and holds new ticks, briefs, hires, spawns and pending releases and archives across restarts. It changes no quest state and releases no party member or machine. Read the stored state and last receipt with `bb tavern stop-all status`. A timeout is still stopping, not failed; later thread observations update the receipt without a polling timer.

Person-only messages pass. A message queued together with Tavern's own work waits until you resume. bb's Send now bypasses the dispatch hook and may send the held automated work with the message; it is NOT a way to send only your message while preserving the brake.

Resume is intended for the user on the common room. There is no CLI resume command. Plugin callers and any exposed agent or CLI markers are refused and the available surface is recorded. bb groups the page, CLI and agents as client callers with no thread id or origin, so Tavern can't prove a person pressed Resume. The receipt and common room state that limit. NEVER use a generic RPC call, shell or another send or spawn path to bypass the brake.

The stop scope is Keeper and member turns. Already-running hidden tale-renderer companions are outside that scope and can finish; new renderer spawns are held. A placed hire stopped before spawning may free its unstarted reservation; no member or machine exists to release. See `docs/stop-all.md` for the receipt and caller limits.

Pause every Keeper is a separate setting on the common room and Settings page: it pauses new Keeper work while running turns finish.

## Draft pull requests

Smiths use `tavern_draft_pr` to keep the quest’s pull request record current. When the hire brief says pull requests open from home, commit the work and pass `title`, `body` and optional `base`; Tavern carries only the committed tree, pushes the member’s own branch and opens a draft. It never marks ready or merges. Read the result for excluded uncommitted files and the pushed commit.

When pull requests open on the member’s machine, open a draft with your own tools as your scope allows, then call `tavern_draft_pr` with `url`, `title` and optional `base`. This records it without pushing. Pass `forge` as `gh` or an enabled forge profile ID when known; omit it to record unknown. Reuse the same PR for the same head. Releasing the Smith hands open PR ownership to its Keeper without closing it.

The user configures profiles in Where work runs under `machines.forges`, or applies a setup proposal. These are guardrails; Tavern-managed threads MUST NOT change them directly. See `../../docs/forges.md` for the command contract.

## Tune settings

Tavern-managed threads (including archived Keepers and members) may preview guardrails but cannot apply them; change those on Tavern’s Settings page or ask from a plain thread.

Change settings ONLY when the user asks. Preview first, show the user the preview, then use `--apply`.

1. Read effective settings with `bb tavern settings get` or `bb tavern settings get classes`.
2. Preview a patch with `bb tavern settings set classes.smith.model=model-id tavern.ambientMotion=lively tavern.repeatSeconds=20`. Keys use camelCase dotted paths. Values are JSON (objects, arrays, numbers, booleans or null) or unquoted strings.
3. Add `--apply` to write the patch. Untouched keys remain unchanged. Every agent apply records the calling thread in Settings history and can be undone there.
4. For a complete replacement, preview `bb tavern settings import --toml "<TOML>"`, then add `--apply`. Import resets omitted explicit settings and pins to defaults.
5. Export with `bb tavern settings export`. Agent file exports and backup restores with data remain user-only.

Agents may preview and apply global settings while "Agents may change settings" is on (the default). When locked, previews remain available; ask the user to enable it before applying; NEVER try to bypass the lock. Settings changes do not grant consent for asks, Return, production work or other guarded actions.
