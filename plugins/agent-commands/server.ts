import { homedir } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  commandContext,
  commandSubtitle,
  commandsDir,
  fallbackInstructions,
  listCommands,
  piExpandsCommands,
  readCommand,
  searchCommands,
} from "./src/commands";

const MAX_RESULTS = 50;

export default function agentCommands(bb: BbPluginApi): void {
  // Read on the machine that runs the bb server, so commands on an enrolled remote machine are not listed.
  const home = homedir();
  const dir = commandsDir(home);

  bb.ui.registerMentionProvider({
    id: "commands",
    label: "Commands",
    triggers: ["!"],
    search: ({ query }) =>
      searchCommands(listCommands(dir), query)
        .slice(0, MAX_RESULTS)
        .map((command) => ({ id: command.name, title: command.name, subtitle: commandSubtitle(command) })),
    resolve: (name) => ({ context: commandContext(readCommand(dir, name)) }),
  });

  bb.agents.configure((context) => {
    const skipped = context.provider.id === "pi" && piExpandsCommands(home);
    const instructions = skipped ? null : fallbackInstructions(listCommands(dir));
    return { tools: [], skills: [], ...(instructions === null ? {} : { instructions }) };
  });
}
