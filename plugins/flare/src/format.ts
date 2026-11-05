import { proseBody } from "./blocks";
import { KIND_LABELS } from "./kinds";
import type { FlareRow } from "./store";

export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const excerpt = (body: string, max: number): string => {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** Flares as plain text for an agent or a terminal, newest first. */
export function flaresText(rows: readonly FlareRow[], viewer: string, now: number, options: { bodies: "excerpt" | "full" }): string {
  if (rows.length === 0) return "No flares in this thread yet.\n";
  const head = rows.length === 1 ? "1 flare, newest first:" : `${rows.length} flares, newest first:`;
  const lines = rows.map((row) => {
    const from = row.threadId === viewer ? "" : ` [from ${row.threadTitle ?? row.threadId} ${row.threadId}]`;
    const line = `- ${ago(row.createdAt, now)} · ${KIND_LABELS[row.kind]}: ${row.title}${from} (${row.id})`;
    if (row.body === "") return line;
    const body = options.bodies === "full" ? row.body.split("\n").map((text) => `    ${text}`).join("\n") : `    ${excerpt(proseBody(row.body), 240)}`;
    return `${line}\n${body}`;
  });
  return `${head}\n${lines.join("\n")}\n`;
}
