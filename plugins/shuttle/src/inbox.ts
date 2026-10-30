// The Inbox's read and its writes: snoozes, dismissals, seen state and the rules that keep PRs out.
import type { InboxRule, InboxRuleKind, InboxView, PrView } from "./contract";
import { NotFoundError, ShuttleError, type Ctx } from "./ctx";
import type { InboxRuleRow, PrRow } from "./db/store";
import { ruleMatches } from "./next";
import { requirePr, shortKey } from "./prs";
import { inboxCandidates, inboxOf, toView } from "./views";

const DAY_MS = 86_400_000;
const MAX_SNOOZE_MS = 60 * DAY_MS;
/** The kinds of event that are automation acting for the user; the Automation log lists these among every other kind. */
const AUTOMATION_KINDS = ["forwarded", "review_done", "auto_agent", "outcome", "draft", "auto_failed", "forward_failed"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isLive = (view: PrView) => view.state === "open" || view.state === "draft";

/** In this machine's time zone, which is the user's. */
function timeText(ms: number): string {
  const at = new Date(ms);
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}, ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** Every key must name a PR Shuttle has, or nothing changes. */
function requireAll(ctx: Ctx, keys: readonly string[]): PrRow[] {
  const rows = keys.map((key) => requirePr(ctx, key));
  return rows.filter((row, index) => rows.findIndex((other) => other.id === row.id) === index);
}

function viewsOf(ctx: Ctx, rows: readonly PrRow[]): PrView[] {
  const rules = ctx.store.inboxRules();
  return rows.map((row) => toView(ctx, ctx.store.prById(row.id)!, rules));
}

function ruleSubject(ctx: Ctx, rule: Pick<InboxRuleRow, "kind" | "server" | "value">): string {
  const server = ctx.server(rule.server)?.name ?? rule.server;
  switch (rule.kind) {
    case "author":
      return `PRs by @${rule.value} on ${server}`;
    case "repo":
      return `PRs from ${rule.value} on ${server}`;
    case "mention":
      return `Mentions in ${rule.value} on ${server}`;
  }
}

export function snooze(ctx: Ctx, keys: readonly string[], until: number | "update" | null): PrView[] {
  const now = ctx.now();
  if (typeof until === "number") {
    if (until <= now) throw new ShuttleError("Pick a snooze time in the future.");
    if (until > now + MAX_SNOOZE_MS) throw new ShuttleError("A snooze can last at most 60 days.");
  }
  const rows = requireAll(ctx, keys);
  ctx.store.tx(() => {
    for (const pr of rows) {
      if (until === null) {
        ctx.store.setSnooze(pr.id, null, null);
        continue;
      }
      ctx.store.setSnooze(pr.id, now, until === "update" ? null : until);
      ctx.store.addEvent("snoozed", until === "update" ? `Snoozed ${shortKey(ctx, pr)} until it changes.` : `Snoozed ${shortKey(ctx, pr)} until ${timeText(until)}.`, pr.id);
    }
  });
  ctx.port.publish();
  return viewsOf(ctx, rows);
}

export function dismiss(ctx: Ctx, keys: readonly string[], on: boolean): PrView[] {
  const rows = requireAll(ctx, keys);
  ctx.store.tx(() => {
    for (const pr of rows) {
      if (on) {
        ctx.store.setInboxDismissed([pr.id], ctx.now());
        ctx.store.setSnooze(pr.id, null, null);
        ctx.store.addEvent("dismissed", `Dismissed ${shortKey(ctx, pr)} from the Inbox.`, pr.id);
      } else if (pr.inbox_dismissed_at !== null) {
        ctx.store.setInboxDismissed([pr.id], null);
        ctx.store.addEvent("restored", `${shortKey(ctx, pr)} is back in the Inbox.`, pr.id);
      }
    }
  });
  ctx.port.publish();
  return viewsOf(ctx, rows);
}

export function markSeen(ctx: Ctx, keys: readonly string[]): void {
  const rows = requireAll(ctx, keys);
  ctx.store.setSeenAt(rows.map((row) => row.id), ctx.now());
  ctx.port.publish();
}

function ruleView(ctx: Ctx, rule: InboxRuleRow, candidates: ReturnType<typeof inboxCandidates>): InboxRule {
  const keeps = candidates
    .filter(({ view, wanted }) => wanted && !view.snoozed && view.dismissed === null && ruleMatches(rule, { ...view, reasons: view.reasons.map((r) => r.reason) }))
    .map(({ view }) => view.key);
  return { id: rule.id, kind: rule.kind, server: rule.server, serverName: ctx.server(rule.server)?.name ?? rule.server, value: rule.value, createdAt: rule.created_at, keeps };
}

export function addRule(ctx: Ctx, input: { kind: InboxRuleKind; server: string; value: string }): { rule: InboxRule; created: boolean } {
  if (!ctx.server(input.server)) throw new ShuttleError(`no server called ${input.server}`);
  const value = input.value.trim();
  if (!value) throw new ShuttleError("Name an author or a repo for the rule.");
  const row = ctx.store.addInboxRule(input.kind, input.server, value);
  if (row.created) {
    const unless = row.kind === "mention" ? " unless you are asked to review" : "";
    ctx.store.addEvent("inbox_rule", `${ruleSubject(ctx, row)} stay out of the Inbox${unless}.`);
    ctx.port.publish();
  }
  return { rule: ruleView(ctx, row, inboxCandidates(ctx)), created: row.created };
}

export function removeRule(ctx: Ctx, id: number): void {
  const rule = ctx.store.inboxRule(id);
  if (!rule || !ctx.store.removeInboxRule(id)) throw new NotFoundError(`no Inbox rule ${id}`);
  ctx.store.addEvent("inbox_rule", `${ruleSubject(ctx, rule)} can come to the Inbox again.`);
  ctx.port.publish();
}

export function inbox(ctx: Ctx): InboxView {
  const candidates = inboxCandidates(ctx);
  const views = candidates.map((entry) => entry.view);
  const now = ctx.now();
  const days = ctx.settings().inboxRequestDays;
  const olderRequests = views.filter(
    (v) => v.next.kind === "not_reviewed" && !v.bot && !v.quiet && v.reasons.some((r) => r.reason === "requested" || r.reason === "mentioned") && (v.requestedAt === null || now - v.requestedAt >= days * DAY_MS),
  ).length;
  const back = (view: PrView) => view.snoozedUntil ?? Number.POSITIVE_INFINITY;
  const snoozed = views
    .filter((v) => isLive(v) && v.snoozed && v.dismissed === null)
    .sort((a, b) => back(a) - back(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const dismissed = views.filter((v) => isLive(v) && v.dismissed !== null).sort((a, b) => b.dismissed!.at - a.dismissed!.at);
  return {
    prs: inboxOf(views),
    snoozed,
    dismissed,
    rules: ctx.store.inboxRules().map((rule) => ruleView(ctx, rule, candidates)),
    olderRequests,
    handled: ctx.store.countEvents(AUTOMATION_KINDS, now - DAY_MS),
  };
}
