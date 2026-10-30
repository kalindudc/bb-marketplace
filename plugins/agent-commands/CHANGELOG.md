# Changelog

Notable changes to Agent Commands, newest first. Releases are tagged `agent-commands/vX.Y.Z` in this repository.

## 0.1.0 (2026-10-19)

### Added

- A `!` menu in every composer. Typing `!` opens a Commands menu that lists the `.md` files in `~/.agents/commands` with each command's description and argument hint. The folder is read on every keystroke, so a new or edited file shows up without reloading the plugin.
- Picking a command and sending. The plugin reads the file again at send time and attaches its instructions as agent-only context, so the thread shows only the command pill and the arguments you typed.
- Search in the menu. A command whose name starts with what you typed comes first, then one whose name contains it, then one whose description contains it, with at most 50 results. An empty query lists the whole folder.
- Typed `/name arguments` in Codex and Claude Code threads. Those agents are told which commands exist and to read `~/.agents/commands/<name>.md` for a message that starts with `/name`, because they do not know the folder.
- Command files in pi's prompt-template format. Frontmatter is optional; `description` and `argument-hint` are read from it, the description falls back to the first non-empty body line cut to 60 characters, and the body can use `$ARGUMENTS`, `$1` and `${@:N}`.
- A missing command blocks the send. If a file is deleted after you picked it, the send fails with an error that names the missing path instead of sending the message without the instructions.

### Compatibility

- The menu uses `!`, not `/`. bb builds its `/` menu from its own commands, skills and command folders that only provider plugins can declare, and a plugin cannot add entries to it.
- pi threads get no extra instructions while `~/.pi/agent/prompts` resolves to `~/.agents/commands`, because pi expands `/name` itself. A symlink such as `ln -s ../../.agents/commands ~/.pi/agent/prompts` points pi at the same files.
- The command list added to other agents stops before bb's 4096-character instruction limit and ends with a line saying how many commands were left out, so a large folder does not push the cap.
- Only top-level `.md` files are listed, and a name must start with a letter or digit and use only letters, digits, `.`, `_` and `-`; a name with `:` is refused because bb namespaces mention ids as `<provider>:<id>`.
- The menu reads `~/.agents/commands` on the machine that runs the bb server, so commands on an enrolled remote machine are not listed there. A typed `/name` is read by the agent on the thread's own machine.
- The command's text is attached when you send, before bb knows the message, so its placeholders are not filled in. The agent is told that the rest of your message is the arguments and how they map onto `$ARGUMENTS`, `$1` and `${@:N}`.
