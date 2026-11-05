// A flare's body is shown in the Flares tab the way bb shows a reply, so it may carry blocks only some installed
// plugin can draw. Flare knows none of them: for the places that are not a reply (the banner, a notification, the note
// a parent agent gets, an agent reading flares back) it keeps the prose and names each block instead. Any fenced block
// with a language and any `::name{…}` line counts as a block, whoever draws it. Pure: the server and the app share it.

export type Segment =
  | { type: "prose"; text: string }
  | { type: "block"; language: string; text: string }
  | { type: "directive"; name: string; text: string };

const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`{]*)[^`]*$/;
const DIRECTIVE = /^ {0,3}::([a-z][a-z0-9-]*)\{[^}]*\}[ \t]*$/;

const closes = (line: string, fence: string): boolean =>
  new RegExp(`^ {0,3}\\${fence[0]}{${fence.length},}[ \\t]*$`).test(line);

/** The body as prose, blocks and directives, in order. A fence with no language, or an unclosed one, is prose. */
export function parseBody(body: string): Segment[] {
  const lines = body.split("\n");
  const segments: Segment[] = [];
  let prose: string[] = [];
  const flush = () => {
    const text = prose.join("\n").replace(/^\n+|\n+$/g, "");
    if (text.trim() !== "") segments.push({ type: "prose", text });
    prose = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const open = OPEN.exec(line);
    if (open !== null) {
      let close = index + 1;
      while (close < lines.length && !closes(lines[close]!, open[1]!)) close++;
      if (close >= lines.length) {
        prose.push(...lines.slice(index));
        break;
      }
      const language = open[2]!.toLowerCase();
      const text = lines.slice(index, close + 1).join("\n");
      if (language === "") {
        prose.push(text);
      } else {
        flush();
        segments.push({ type: "block", language, text });
      }
      index = close + 1;
      continue;
    }
    const directive = DIRECTIVE.exec(line);
    if (directive !== null) {
      flush();
      segments.push({ type: "directive", name: directive[1]!, text: line.trim() });
    } else {
      prose.push(line);
    }
    index++;
  }
  flush();
  return segments;
}

export const blockCount = (segments: readonly Segment[]): number => segments.filter((segment) => segment.type !== "prose").length;

const pointer = (segment: Exclude<Segment, { type: "prose" }>): string =>
  segment.type === "block" ? `_[A ${segment.language} block; see it in the Flares tab.]_` : `_[A ${segment.name} view; see it in the Flares tab.]_`;

/** The prose, with each block replaced by a line naming it: for a notification, an agent, or a quick preview. */
export function proseBody(body: string): string {
  return parseBody(body)
    .map((segment) => (segment.type === "prose" ? segment.text : pointer(segment)))
    .join("\n\n");
}

/** The prose alone, for the banner's preview, and how many blocks it left for the Flares tab. */
export function previewBody(body: string): { text: string; blocks: number } {
  const segments = parseBody(body);
  return {
    text: segments
      .filter((segment): segment is Extract<Segment, { type: "prose" }> => segment.type === "prose")
      .map((segment) => segment.text)
      .join("\n\n"),
    blocks: blockCount(segments),
  };
}

/** The first line a person would read, for a notification: no fence, table row or Markdown marker. */
export function leadLine(body: string): string | null {
  for (const segment of parseBody(body)) {
    if (segment.type !== "prose") continue;
    let fenced = false;
    for (const line of segment.text.split("\n")) {
      if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const text = line.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, "").trim();
      if (text === "" || text.startsWith("|")) continue;
      return text.replace(/[*_`]/g, "");
    }
  }
  return null;
}
