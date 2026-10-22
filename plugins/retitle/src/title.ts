export interface Mention {
  start: number;
  end: number;
  resource: { kind: string };
}

export interface InputPart {
  type: string;
  text?: string;
  visibility?: string;
  mentions?: readonly Mention[];
}

export interface TitleSource {
  task: string;
  commands: string[];
}

const MAX_TASK_LENGTH = 4000;
const MAX_TITLE_WIDTH = 48;

// Mirrors bb's own title prompt, so a retitled thread reads like the others.
const PROMPT_HEAD = [
  "You create concise titles for coding tasks.",
  "Reply with only the title: short, clear, sentence case, in the same language as the task. Keep it under about 40 characters; for scripts that do not separate words with spaces, that is roughly 20 characters. Summarize the task in your own words instead of copying its text. No quotes, no trailing punctuation, no explanation.",
  "",
  "Consider the user's intent when titling to make it useful. For instance, if they detail specific tools to use to solve a problem, it is the problem that should be the title, not the tools that should be used.",
  "",
].join("\n");

/**
 * The text the user typed. bb's own titler also reads agent-only parts, such as
 * the command body a `!plan` mention attaches, so those are dropped here, and
 * command mentions are cut out of the text and named separately.
 */
export function titleSource(input: readonly InputPart[]): TitleSource | null {
  const commands: string[] = [];
  const texts: string[] = [];
  for (const part of input) {
    if (part.type !== "text" || part.visibility === "agent-only" || !part.text) continue;
    let text = part.text;
    const cuts = (part.mentions ?? [])
      .filter((mention) => mention.resource.kind === "plugin" || mention.resource.kind === "command")
      .sort((a, b) => b.start - a.start);
    for (const cut of cuts) {
      const token = text.slice(cut.start, cut.end).trim();
      if (token && !commands.includes(token)) commands.unshift(token);
      text = text.slice(0, cut.start) + " " + text.slice(cut.end);
    }
    texts.push(text);
  }
  const task = texts.join(" ").replace(/\s+/gu, " ").trim().slice(0, MAX_TASK_LENGTH);
  if (task === "" && commands.length === 0) return null;
  return { task, commands };
}

export function titlePrompt(source: TitleSource): string {
  const commands =
    source.commands.length === 0
      ? ""
      : `The prompt invokes these commands or skills: ${source.commands.join(", ")}. They name how the work is carried out, so title the work they are applied to. When the prompt names nothing else, title what the invoked command itself does.\n\n`;
  return `${PROMPT_HEAD}\n${commands}Task:\n${source.task || source.commands.join(" ")}`;
}

export function cleanTitle(reply: string): string | null {
  const line = reply
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "");
  if (line === undefined) return null;
  const title = line
    .replace(/^title:\s*/iu, "")
    .replace(/^["'`*]+|["'`*]+$/gu, "")
    .replace(/[.!?:;,]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (title === "") return null;
  if (title.length <= MAX_TITLE_WIDTH) return title;
  const cut = title.slice(0, MAX_TITLE_WIDTH + 1);
  const space = cut.lastIndexOf(" ");
  return (space > MAX_TITLE_WIDTH / 2 ? cut.slice(0, space) : cut.slice(0, MAX_TITLE_WIDTH)).trim();
}
