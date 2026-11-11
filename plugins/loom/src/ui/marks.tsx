// A ticket's state as one mark, the same in the list, the maps, the pane and the exact list. Each state has its own
// shape as well as its tone, so the marks read apart without colour; queued is a plain ring, never the dashed outline
// the maps keep for stubs.
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { TicketState } from "../states";

export type Tone = "att" | "bad" | "ok" | "on" | "mut";

const MARKS: Record<TicketState, { icon: string; tone: Tone }> = {
  blocked: { icon: "AlertCircle", tone: "att" },
  queued: { icon: "Circle", tone: "mut" },
  working: { icon: "Loading", tone: "on" },
  checking: { icon: "Clock", tone: "on" },
  review: { icon: "Eye", tone: "on" },
  approved: { icon: "Check", tone: "ok" },
  merging: { icon: "GitMerge", tone: "ok" },
  pr_open: { icon: "GitPullRequest", tone: "ok" },
  done: { icon: "CircleCheck", tone: "ok" },
  cancelled: { icon: "Unavailable", tone: "mut" },
};

export const TONE_TEXT: Record<Tone, string> = {
  att: "text-[var(--attention)]",
  bad: "text-[var(--loom-bad)]",
  ok: "text-[var(--loom-ok)]",
  on: "text-[var(--loom-link)]",
  mut: "text-[var(--loom-muted)]",
};

/** Every icon a mark can draw, for the map's export to copy bb's own glyphs. */
export const MARK_ICONS: readonly string[] = [...new Set([...Object.values(MARKS).map((mark) => mark.icon), "CircleX", "GitPullRequestDraft"])];

export function markOf(state: TicketState, failed = false, draft = false): { icon: string; tone: Tone } {
  if (failed) return { icon: "CircleX", tone: "bad" };
  if (draft && state === "pr_open") return { icon: "GitPullRequestDraft", tone: "ok" };
  return MARKS[state];
}

export function StateMark({ state, failed = false, draft = false, className = "size-3.5" }: { state: TicketState; failed?: boolean; draft?: boolean; className?: string }) {
  const mark = markOf(state, failed, draft);
  return <Icon name={mark.icon} fallback="Circle" aria-hidden className={`shrink-0 ${TONE_TEXT[mark.tone]} ${className}`} />;
}
