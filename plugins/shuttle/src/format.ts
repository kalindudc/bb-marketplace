// Plain-text views for agent tools and the CLI.
import type { BoardDetail, BoardSummary, EventView, PrView, ServerStatus } from "./contract";
import { failureAdvice, STEP_LABELS } from "./failures";

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

export function boardLine(board: BoardSummary): string {
  const counts = `${board.prCount} PR${board.prCount === 1 ? "" : "s"}, ${board.attention} need attention, ${board.ready} ready, ${board.merged} merged`;
  const lines = [`${board.id}  ${board.name}${board.archivedAt === null ? "" : " (archived)"}`, `  ${counts}`];
  if (board.description) lines.push(`  ${board.description}`);
  if (board.preview.length) lines.push(`  preview: ${board.preview.map((pr) => `${pr.key} — ${pr.title}`).join(" · ")}`);
  return lines.join("\n");
}

export function boardList(boards: BoardSummary[], empty: string): string {
  return boards.length ? boards.map(boardLine).join("\n\n") : empty;
}

export function boardDetailText(detail: BoardDetail, options: { prLimit?: number; activityLimit?: number } = {}): string {
  const prLimit = options.prLimit ?? 20;
  const activityLimit = options.activityLimit ?? 10;
  const lines = [boardLine(detail.board)];
  if (detail.prs.length) {
    lines.push("", ...detail.prs.slice(0, prLimit).map(prLine));
    if (detail.prs.length > prLimit) lines.push(`... ${detail.prs.length - prLimit} more PR${detail.prs.length - prLimit === 1 ? "" : "s"}`);
  } else {
    lines.push("", "No PRs are saved in this board.");
  }
  if (detail.activity.length) {
    lines.push("", "Activity:");
    for (const item of detail.activity.slice(0, activityLimit)) lines.push(`  ${new Date(item.at).toISOString().slice(0, 16)}Z ${item.text}${item.threadId ? ` (${item.threadId})` : ""}`);
    if (detail.activity.length > activityLimit) lines.push(`... ${detail.activity.length - activityLimit} more activity item${detail.activity.length - activityLimit === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

/** "11:38" in local time, with the day when it is not today. */
function hhmm(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toTimeString().slice(0, 5);
  return date.toDateString() === new Date(now).toDateString() ? time : `${date.toDateString().slice(4, 10)} ${time}`;
}

/** A server's status for `bb shuttle status`: one line when it is fine, and why it failed on the lines below when not. */
export function serverText(server: ServerStatus, now = Date.now()): string {
  const id = server.id.padEnd(7);
  if (!server.enabled) return `${id} off`;
  if (server.state === null) return `${id} not synced yet`;
  const synced = server.lastSyncAt === null ? "" : ` · synced ${hhmm(server.lastSyncAt, now)}`;
  // A server that failed before Shuttle kept each step has only its stored error.
  if (server.state !== "ok" && server.failure === null) return `${id} failing: ${server.error ?? "the last sync failed"}${synced}`;
  if (server.state === "ok" || server.failure === null) {
    const lastFailed = server.lastFailedAt !== null && now - server.lastFailedAt < 86_400_000 ? ` · last failed ${hhmm(server.lastFailedAt, now)}` : "";
    return `${id} ok as ${server.login}${synced}${lastFailed}`;
  }
  const { failure } = server;
  const head = server.state === "partial"
    ? `synced, except ${server.failedSteps.map((step) => STEP_LABELS[step]).join(", ")}`
    : `failing${server.failingSince === null ? "" : ` since ${hhmm(server.failingSince, now)}`}`;
  const pad = " ".repeat(8);
  const lines = [`${id} ${head}: ${failure.summary} (${failure.operation})`];
  if (failure.output !== null) lines.push(...failure.output.split("\n").slice(-4).map((line) => `${pad}| ${line}`));
  lines.push(`${pad}${server.lastOkAt === null ? "no good sync yet" : `last good sync ${hhmm(server.lastOkAt, now)}`}${server.failures > 1 ? ` · ${server.failures} syncs in a row` : ""}`);
  lines.push(`${pad}${failureAdvice(failure, server.nextSyncAt === null ? null : hhmm(Math.max(server.nextSyncAt, now), now))}`);
  return lines.join("\n");
}
