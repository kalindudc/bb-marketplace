Use your own slash-command prompts from `~/.agents/commands` in any bb thread, whichever agent runs it.

## What you get

- Type `!` in a composer to open a Commands menu listing every `.md` file in `~/.agents/commands`, with its description and argument hint. The list is read fresh from disk as you type, so a new or edited file shows up straight away.
- Pick a command, type its arguments after it, and send. The plugin attaches the command's instructions to your message for the agent, and you see only the pill and your arguments in the thread.
- Type `/name arguments` as plain text and it works too. Codex and Claude Code agents are told which commands exist and to run `/name` from the folder. pi expands `/name` itself when `~/.pi/agent/prompts` links to `~/.agents/commands`, so the plugin adds nothing to pi threads in that case.

## The command files

Each command is one Markdown file in pi's prompt template format. The file name is the command name, `description` and `argument-hint` come from the frontmatter, and the body can use `$ARGUMENTS`, `$1` and `${@:2}` for the arguments:

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness}.
```

To keep pi on the same files, make its prompts folder a link: `ln -s ../../.agents/commands ~/.pi/agent/prompts`.

## Limits

- bb's `/` menu is fed by skills and the agent's own command folders, and plugins cannot add to it, so the menu uses `!`.
- A `!` command attaches its text when you send, before bb knows the message, so the placeholders are not filled in. The agent is told that the rest of your message is the arguments and how `$ARGUMENTS`, `$1` and `${@:N}` map onto it.
- Typed `/name` has been tested in pi and codex threads. The `!` menu does not depend on the agent, because bb attaches the command text itself.
- The menu reads the folder on the machine that runs the bb server. Typed `/name` commands are read by the agent on the thread's own machine.
- Only top-level `.md` files with names made of letters, digits, `.`, `_` and `-` are listed, like pi.
