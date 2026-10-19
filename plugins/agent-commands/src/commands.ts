import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Command {
  name: string;
  description: string;
  argumentHint: string | null;
  body: string;
}

// Mention item ids may not contain ":" because bb namespaces them as "<provider>:<id>".
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INSTRUCTIONS_LIMIT = 4096;
const DESCRIPTION_LIMIT = 120;

export function commandsDir(home: string): string {
  return join(home, ".agents", "commands");
}

// Follows pi's prompt-template rules: frontmatter is optional, the description
// falls back to the first non-empty body line, and arguments use $ARGUMENTS, $1, ${@:N}.
export function parseCommand(name: string, raw: string): Command {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const fields = new Map<string, string>();
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], unquote(field[2].trim()));
  }
  const body = (match ? raw.slice(match[0].length) : raw).trim();
  const firstLine = body.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  return {
    name,
    description: fields.get("description") || truncate(firstLine, 60),
    argumentHint: fields.get("argument-hint") || null,
    body,
  };
}

export function listCommands(dir: string): Command[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.endsWith(".md") && COMMAND_NAME.test(entry.slice(0, -3)))
    .filter((entry) => statSync(join(dir, entry)).isFile())
    .sort()
    .map((entry) => parseCommand(entry.slice(0, -3), readFileSync(join(dir, entry), "utf8")));
}

export function readCommand(dir: string, name: string): Command {
  if (!COMMAND_NAME.test(name)) throw new Error(`"${name}" is not a command name`);
  const path = join(dir, `${name}.md`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`The command "${name}" no longer exists: ${path} is missing`);
    }
    throw error;
  }
  return parseCommand(name, raw);
}

export function searchCommands(commands: readonly Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...commands];
  const rank = (command: Command): number => {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (command.description.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return commands
    .map((command) => ({ command, rank: rank(command) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.command.name.localeCompare(b.command.name))
    .map((entry) => entry.command);
}

export function commandSubtitle(command: Command): string {
  const description = truncate(command.description, DESCRIPTION_LIMIT);
  return command.argumentHint ? `${command.argumentHint} · ${description}` : description;
}

// The agent sees this beside the user's message; bb cannot substitute the
// placeholders because a mention resolves without the message text.
export function commandContext(command: Command): string {
  return [
    `The user ran the command "${command.name}" from ~/.agents/commands/${command.name}.md. Follow its instructions below.`,
    "Its arguments are the rest of the user's message: read $ARGUMENTS and $@ as all of them, $1, $2 and so on as single words split like a shell would, and ${@:N} as the words from position N on.",
    "",
    `<command name="${command.name}">`,
    command.body,
    "</command>",
  ].join("\n");
}

export function fallbackInstructions(commands: readonly Command[]): string | null {
  if (commands.length === 0) return null;
  const header = [
    "Slash commands from ~/.agents/commands: when a user message starts with /<name> and <name> is listed below, read ~/.agents/commands/<name>.md and follow it.",
    "The rest of the message is its arguments: $ARGUMENTS and $@ mean all of them, $1, $2 and so on single words split like a shell would, and ${@:N} the words from position N on.",
  ].join("\n");
  const lines: string[] = [];
  let length = header.length;
  for (const [index, command] of commands.entries()) {
    const line = `- /${command.name}: ${truncate(command.description, DESCRIPTION_LIMIT)}`;
    const rest = commands.length - index;
    const overflow = `- …and ${rest} more in ~/.agents/commands`;
    if (length + line.length + 1 + overflow.length + 1 > INSTRUCTIONS_LIMIT) {
      lines.push(overflow);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return [header, ...lines].join("\n");
}

// pi expands /name itself when its prompt folder is this commands folder.
export function piExpandsCommands(home: string): boolean {
  try {
    return realpathSync(join(home, ".pi", "agent", "prompts")) === realpathSync(commandsDir(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
