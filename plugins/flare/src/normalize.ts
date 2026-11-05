import { DEFAULT_KIND, isKind, type Kind } from "./kinds";

export const TITLE_MAX = 120;
export const BODY_MAX = 4000;

export interface FlareDraft {
  kind: Kind;
  title: string;
  body: string;
  urgent: boolean;
}

export interface FlareFields {
  title?: unknown;
  body?: unknown;
  kind?: unknown;
  notify?: unknown;
}

export type Normalized = { ok: true; draft: FlareDraft; notes: string[] } | { ok: false; reason: string };

const ALIASES = new Map<string, Kind>(Object.entries({
  find: "finding",
  found: "finding",
  note: "finding",
  info: "finding",
  insight: "finding",
  update: "progress",
  status: "progress",
  milestone: "progress",
  step: "progress",
  choice: "decision",
  decided: "decision",
  tradeoff: "decision",
  blocked: "blocker",
  block: "blocker",
  issue: "blocker",
  problem: "blocker",
  error: "blocker",
  warning: "blocker",
  done: "summary",
  complete: "summary",
  recap: "summary",
  result: "summary",
} satisfies Record<string, Kind>));

// Models sometimes send a number as the title or "true" for a boolean, so scalars are read as text.
const text = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\u0000/g, "") : typeof value === "number" || typeof value === "boolean" ? String(value) : "";

export const truthy = (value: unknown): boolean => value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");

function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = value.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

function kindOf(value: unknown, notes: string[]): Kind {
  const raw = text(value).trim().toLowerCase();
  if (raw === "") return DEFAULT_KIND;
  if (isKind(raw)) return raw;
  const alias = ALIASES.get(raw) ?? ALIASES.get(raw.replace(/s$/, ""));
  if (alias !== undefined) return alias;
  notes.push(`"${cut(raw, 24)}" is not a kind, so it went as a ${DEFAULT_KIND}.`);
  return DEFAULT_KIND;
}

// A heading, list or quote marker in front of a body's first line would read as noise in a title.
const stripMarker = (line: string): string => line.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, "").trim();
const firstLine = (body: string): string => body.split("\n").map(stripMarker).find((line) => line !== "") ?? "";

/**
 * Turns whatever the agent or the CLI sent into a flare, or says why nothing was sent. It never throws: a flare
 * must not fail the agent's turn, so a long title is cut and an unknown kind falls back, each with a note.
 */
export function normalizeFlare(fields: FlareFields): Normalized {
  const notes: string[] = [];
  let body = text(fields.body).replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  let title = text(fields.title).replace(/\s+/g, " ").trim();

  if (title === "") {
    const line = firstLine(body);
    if (line === "") {
      return { ok: false, reason: "Nothing was sent: a flare needs a title. Carry on, and send it again with a title if it still matters." };
    }
    title = line.replace(/\s+/g, " ");
    body = body.slice(body.indexOf(line) + line.length).replace(/^\s+/, "");
  }
  if (title.length > TITLE_MAX) {
    title = cut(title, TITLE_MAX);
    notes.push(`The title was cut to ${TITLE_MAX} characters; detail belongs in the body.`);
  }
  if (body.length > BODY_MAX) {
    body = cut(body, BODY_MAX);
    notes.push(`The body was cut to ${BODY_MAX} characters.`);
  }

  return { ok: true, draft: { kind: kindOf(fields.kind, notes), title, body, urgent: truthy(fields.notify) }, notes };
}
