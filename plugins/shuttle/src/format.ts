// Plain-text views for agent tools and the CLI.
import type { EventView, PrView } from "./contract";

const REVIEW_TEXT = { approved: "approved", changes: "changes requested", required: "review required", none: "no review decision" } as const;

export function prLine(pr: PrView): string {
  const bits = [pr.state, `checks ${pr.checks}`, REVIEW_TEXT[pr.review]];
  if (pr.watch) bits.push(`watching (${pr.watch === "act" ? "forward and act" : "forward"})`);
  if (pr.pendingItems) bits.push(`${pr.pendingItems} unsent item${pr.pendingItems === 1 ? "" : "s"}`);
  if (pr.links.length) bits.push(`${pr.links.length} thread${pr.links.length === 1 ? "" : "s"}`);
  if (pr.needs) bits.push(`needs you: ${pr.needs}`);
  return `${pr.key}  ${bits.join(", ")}\n  ${pr.title} (by ${pr.author})\n  ${pr.url}`;
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
