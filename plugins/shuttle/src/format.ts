// Plain-text views for agent tools and the CLI.
import type { EventView, PrView } from "./contract";

const REVIEW_TEXT = { approved: "approved", changes: "changes requested", required: "review required", none: "no review decision" } as const;

const MODE_TEXT = { fix: "fixes new feedback", notify: "is told about new feedback", off: "is off" } as const;

export function prLine(pr: PrView): string {
  const bits = [pr.state, `checks ${pr.checks}`, REVIEW_TEXT[pr.review]];
  if (pr.agent) bits.push(`agent ${pr.agent.threadId} ${MODE_TEXT[pr.agent.mode]}${pr.agent.status === "archived" ? " (archived)" : ""}`);
  if (pr.tracked) bits.push("tracked");
  if (pr.pendingItems) bits.push(`${pr.pendingItems} unsent item${pr.pendingItems === 1 ? "" : "s"}`);
  if (pr.links.length) bits.push(`${pr.links.length} thread${pr.links.length === 1 ? "" : "s"}`);
  const next = `${pr.next.inbox ? "in the Inbox: " : "next: "}${pr.next.label}. ${pr.next.why}`;
  return `${pr.key}  ${bits.join(", ")}\n  ${pr.title} (by ${pr.author})\n  ${next}\n  ${pr.url}`;
}

export function prDetail(pr: PrView, events: EventView[] = []): string {
  const lines = [prLine(pr)];
  if (pr.head) lines.push(`  head ${pr.head.slice(0, 12)}${pr.headRef ? ` (${pr.headRef})` : ""}${pr.base ? ` into ${pr.base}` : ""}`);
  if (pr.reasons.length) lines.push(`  listed because: ${pr.reasons.map((r) => r.reason + (r.teams.length ? ` ${r.teams.join(", ")}` : "")).join("; ")}`);
  for (const link of pr.links) lines.push(`  thread ${link.threadId} (${link.role}${link.archived ? ", archived" : ""}): ${link.title}`);
  if (pr.lastReview) lines.push(`  last review: ${pr.lastReview.state}, ${pr.lastReview.preset} (${pr.lastReview.trigger}) in ${pr.lastReview.threadId}`);
  if (pr.stale) lines.push("  the server's last sync failed, so this may be out of date");
  for (const event of events.slice(0, 10)) lines.push(`  ${new Date(event.at).toISOString().slice(0, 16)}Z ${event.text}`);
  return lines.join("\n");
}

export function prList(prs: PrView[], empty: string): string {
  return prs.length ? prs.map(prLine).join("\n\n") : empty;
}
