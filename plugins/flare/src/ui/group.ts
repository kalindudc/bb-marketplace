import type { FeedDto, FlareDto, RunDto } from "../contract";
import { KIND_LABELS } from "../kinds";

export interface Section {
  key: string;
  /** Null for flares sent outside any turn this plugin saw, such as from a terminal between turns. */
  run: RunDto | null;
  /** Oldest first, so a turn reads in the order it happened. */
  flares: FlareDto[];
  latestAt: number;
}

const containing = (runs: readonly RunDto[], at: number): RunDto | undefined =>
  runs.find((run) => run.startedAt <= at && (run.endedAt ?? Number.POSITIVE_INFINITY) >= at);

/**
 * Groups a thread's flares by the turn they arrived in, oldest turn first, as a conversation reads. A child thread's
 * flare joins the parent's turn that was running when it arrived.
 */
export function groupFlares(feed: Pick<FeedDto, "flares" | "runs">): Section[] {
  const runs = new Map(feed.runs.map((run) => [run.id, run]));
  const sections = new Map<string, Section>();
  for (const flare of feed.flares) {
    const own = flare.fromChild === null && flare.runId !== null ? runs.get(flare.runId) : undefined;
    const run = own ?? containing(feed.runs, flare.createdAt) ?? null;
    const key = run?.id ?? "outside";
    const section = sections.get(key) ?? { key, run, flares: [], latestAt: 0 };
    section.flares.push(flare);
    section.latestAt = Math.max(section.latestAt, flare.createdAt);
    sections.set(key, section);
  }
  for (const section of sections.values()) section.flares.sort((a, b) => a.createdAt - b.createdAt);
  return [...sections.values()].sort((a, b) => (a.run?.startedAt ?? a.latestAt) - (b.run?.startedAt ?? b.latestAt));
}

export function clock(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function duration(from: number, to: number): string {
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export const OUTCOME_LABELS: Record<RunDto["outcome"], string> = {
  running: "Running",
  done: "Finished",
  failed: "Failed",
  unknown: "Ended",
};

export function sectionTitle(section: Section, now: number): string {
  if (section.run === null) return "Outside a turn";
  const { run } = section;
  return `Turn at ${clock(run.startedAt, now)} · ${duration(run.startedAt, run.endedAt ?? now)}`;
}

/** The whole feed as Markdown, for pasting into a document, a PR or another chat. */
export function feedMarkdown(sections: readonly Section[], now: number): string {
  const blocks = sections.map((section) => {
    const status = section.run === null ? "" : ` (${OUTCOME_LABELS[section.run.outcome].toLowerCase()})`;
    const lines = [`### ${sectionTitle(section, now)}${status}`];
    if (section.run?.prompt) lines.push("", `> ${section.run.prompt}`);
    for (const flare of section.flares) lines.push("", flareMarkdown(flare, now));
    return lines.join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

export function flareMarkdown(flare: FlareDto, now: number): string {
  const from = flare.fromChild === null ? "" : ` · from ${flare.fromChild.title ?? flare.fromChild.threadId}`;
  const head = `- **${KIND_LABELS[flare.kind]}** · ${flare.title} (${clock(flare.createdAt, now)}${from})`;
  if (flare.body === "") return head;
  return `${head}\n${flare.body
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n")}`;
}
