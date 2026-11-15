---
name: tavern
description: Tune Tavern global settings with bb tavern settings get, set and import, only when the user asks. Class models, reasoning and motion may be tuned from any thread; machine rules and other guardrails may be changed only from a plain thread or Tavern’s Settings page.
---

# Tavern

## Tune settings

Tavern-managed threads (including archived Keepers and members) may preview guardrails but cannot apply them; change those on Tavern’s Settings page or ask from a plain thread.

Change settings ONLY when the user asks. Preview first, show the user the preview, then use `--apply`.

1. Read effective settings with `bb tavern settings get` or `bb tavern settings get classes`.
2. Preview a patch with `bb tavern settings set classes.smith.model=model-id tavern.ambientMotion=lively tavern.repeatSeconds=20`. Keys use camelCase dotted paths. Values are JSON (objects, arrays, numbers, booleans or null) or unquoted strings.
3. Add `--apply` to write the patch. Untouched keys remain unchanged. Every agent apply records the calling thread in Settings history and can be undone there.
4. For a complete replacement, preview `bb tavern settings import --toml "<TOML>"`, then add `--apply`. Import resets omitted explicit settings and pins to defaults.
5. Export with `bb tavern settings export`. Agent file exports and backup restores with data remain user-only.

Agents may preview and apply global settings while "Agents may change settings" is on (the default). When locked, previews remain available; ask the user to enable it before applying; NEVER try to bypass the lock. Settings changes do not grant consent for asks, Return, production work or other guarded actions.
