# Changelog

Notable changes to Pi AI Services, newest first. Releases are tagged `pi-services/vX.Y.Z` in this repository.

## 0.3.0 (2026-10-20)

### Added

- A Regenerate title with pi item in every thread's actions menu, in the menu's Organize group, so the action is reachable from the menu as well as from the thread header button. When pi fails, the item shows a toast with pi's error message instead of failing silently.

### Changed

- The thread header button is hidden when bb reports a compact viewport, that is on a phone, where the header has no room for plugin buttons. The thread actions menu, which a phone opens as a drawer, carries the action there instead.

## 0.2.0 (2026-10-18)

### Added

- The Model setting is a dropdown instead of a text field, filled from `pi --list-models` when the settings section opens, with a (pi default) entry at the top and each model shown as provider / model. The list comes from your own pi install, so it only offers models that install can actually run.

### Changed

- Settings appear once, in a single section under Settings → Installed plugins → Pi AI Services. Before, a declarative settings form and the plugin's own section rendered the same two knobs twice.
- Settings are stored in the plugin's own storage rather than bb's declarative settings store, and the settings section loads them through a new `getSettings` call. Saving publishes the stored values on the `pi-services/settings` channel.
- Regenerate title now gives pi 15 seconds instead of 4.5, and the prompt carries the last five prompts from the thread, up to 600 characters each, next to the current title. A title now comes from what you asked in the conversation rather than from the old title alone.
- The title prompt asks pi for the title text alone: no quotes, punctuation, markdown or explanation, and no echo of the instructions, so what reaches the thread title is the title rather than a sentence about it.

### Fixed

- The Pi executable setting accepts flags, for example `pi -ne`. The value is split into a command and its leading arguments before spawning, so a wrapper command with flags starts instead of failing; the status check and the model list use the same split.

### Compatibility

- Nothing migrates the values saved by the earlier version, so set the Pi executable and Model again after upgrading. With nothing stored, the plugin starts from `pi` and pi's default model.

## 0.1.0 (2026-10-18)

### Added

- A bb AI service named Pi CLI for thread titles and commit messages. It runs `pi --print --no-session --no-tools` on the machine that runs the bb server, adds `--model` when a model is set, and uses your pi credentials and defaults, so no bb account or separate API key is needed. Choose it under Settings → AI services, or run `bb settings ai-services set thread-title pi` and `bb settings ai-services set commit-message pi`.
- Pi executable and Model settings under Settings → Installed plugins → Pi AI Services, also editable with `bb plugin config pi-services`.
- A Regenerate title with pi button in the thread header that asks pi for a fresh title, up to 8 words with no quotes or trailing punctuation, and renames the current thread.
- A status check for the service: it runs the configured executable with `--version` and reports that the pi CLI is not runnable on the bb server machine when that fails, so the service's status under Settings → AI services shows why it cannot be used.

### Compatibility

- Requires bb 0.46 or newer and plugin SDK 0.6.49, as declared in the plugin's `engines`. The pi CLI must be installed and signed in on the machine that runs the bb server.
- Text only: voice transcription is not provided. Each call starts a fresh pi process with its tools off, so every title or commit message pays pi's startup cost.
