// PR rows as the UI, the tools and the CLI see them, and which area each one belongs in.
import type { AgentView, Area, CheckCounts, MyReview, PrView } from "./contract";
import type { Ctx } from "./ctx";
import type { LinkRow, PrRow } from "./db/store";
import { actionsOf, parseLabels, parseReviewers } from "./edit";
import { agentActive, feedbackSignature, INBOX_ORDER, nextStep, stillHandled } from "./next";
import { globMatch } from "./sync";

const DAY = 86_400_000;
const QUIET_MS = 30 * DAY;
/** Reasons first seen this soon after the first sync were already waiting at install. */
const BASELINE_SLACK_MS = 5 * 60_000;

const isLive = (pr: PrRow) => pr.state === "open" || pr.state === "draft";

export function agentMode(watch: "act" | "forward" | null): AgentView["mode"] {
  return watch === "act" ? "fix" : watch === "forward" ? "notify" : "off";
}

export function agentOf(ctx: Ctx, pr: PrRow, owner: LinkRow | null = ctx.store.ownerLink(pr.id)): AgentView | null {
  if (!owner) return null;
  const watch = ctx.store.watch(pr.id);
  const status: AgentView["status"] = owner.archived === 1 ? "archived" : owner.waiting === 1 ? "waiting" : owner.status === null ? "unknown" : ["active", "starting", "pending"].includes(owner.status) ? "working" : "idle";
  const sent = ctx.store.events({ prId: pr.id, threadId: owner.thread_id, kinds: ["forwarded"], limit: 1 })[0];
  return {
    threadId: owner.thread_id,
    title: owner.title ?? "Thread",
    mode: agentMode(watch?.mode ?? null),
    status,
    auto: owner.auto === 1,
    lastSent: sent ? { at: sent.at, text: sent.text } : null,
  };
}

export function isBot(ctx: Ctx, pr: PrRow): boolean {
  return pr.author_bot === 1 || ctx.settings().botAuthors.some((glob) => globMatch(glob, pr.author));
}

/** Team slugs without @ or org, so GitHub's @Shopify/edge-infrastructure and Delta's @edge-infrastructure match. */
export function normalizeTeam(team: string): string {
  return team.replace(/^@/u, "").split("/").pop()!.toLowerCase();
}

function myReviewOf(ctx: Ctx, pr: PrRow): MyReview | null {
  const server = pr.my_review ? (JSON.parse(pr.my_review) as MyReview) : null;
  const local = ctx.store.latestMyReview(pr.id);
  const fromShuttle: MyReview | null = local ? { verdict: local.verdict as MyReview["verdict"], at: local.at, head: local.head } : null;
  if (!server) return fromShuttle;
  if (!fromShuttle) return server;
  return (server.at ?? 0) >= (fromShuttle.at ?? 0) ? server : fromShuttle;
}

function requestedAtOf(ctx: Ctx, pr: PrRow, reasons: Array<{ reason: string; since: number }>): number | null {
  const asking = reasons.filter((r) => r.reason === "requested" || r.reason === "team" || r.reason === "mentioned");
  if (!asking.length) return null;
  if (pr.requested_at !== null) return pr.requested_at;
  const baseline = ctx.store.server(pr.server)?.baseline_at ?? null;
  const since = Math.min(...asking.map((r) => r.since));
  // Shuttle saw it after its first sync, so when it saw it is when it was asked.
  if (baseline !== null && since > baseline + BASELINE_SLACK_MS) return since;
  return null;
}

export function toView(ctx: Ctx, pr: PrRow): PrView {
  const server = ctx.server(pr.server);
  const serverRow = ctx.store.server(pr.server);
  const watch = ctx.store.watch(pr.id);
  const last = ctx.store.lastReview(pr.id);
  const links = ctx.store.linksOf(pr.id);
  const owner = links.find((l) => l.role === "owner") ?? null;
  const agent = agentOf(ctx, pr, owner);
  const reasonRows = ctx.store.reasons(pr.id);
  const reasons = reasonRows.map((r) => ({ reason: r.reason, teams: JSON.parse(r.teams) as string[] }));
  const teams = [...new Set(reasons.filter((r) => r.reason === "team").flatMap((r) => r.teams).map(normalizeTeam))];
  const reviewers = parseReviewers(pr.reviewers);
  const checkCounts = pr.check_counts ? (JSON.parse(pr.check_counts) as CheckCounts) : null;
  const draft = pr.mine ? null : ctx.store.liveDraft(pr.id);
  const draftFindings = draft ? (JSON.parse(draft.findings) as unknown[]).length : 0;
  const myReview = pr.mine ? null : myReviewOf(ctx, pr);
  const requestedAt = requestedAtOf(ctx, pr, reasonRows);
  const actions = actionsOf(ctx, pr);
  let ops = new Set<string>();
  let cancelsAutoMerge = false;
  try {
    const adapter = ctx.adapter(pr.server);
    ops = new Set(adapter.operations());
    cancelsAutoMerge = typeof adapter.cancelAutoMerge === "function";
  } catch {
    // A server removed from the config: its PRs show, with nothing to do on them.
  }
  const lastReview = last
    ? { threadId: last.thread_id, title: ctx.store.threadTitle(last.thread_id) ?? "Review thread", state: last.state, preset: last.preset, trigger: last.trigger, head: last.head, at: last.created_at }
    : null;
  const live = isLive(pr);
  const can = {
    merge: pr.mine === 1 && pr.state === "open" && ops.has("merge"),
    comment: live && ops.has("comment"),
    review: pr.mine === 0 && pr.state === "open" && ops.has("review"),
    reply: live && ops.has("reply"),
    resolve: live && ops.has("resolve"),
  };
  const now = ctx.now();
  const snoozed = pr.dismissed_at !== null && (pr.updated_at ?? 0) <= pr.dismissed_at && (pr.snoozed_until === null || now < pr.snoozed_until);
  const handled = stillHandled(pr.handled_sig, feedbackSignature(reviewers, pr.checks, pr.head));
  const bot = isBot(ctx, pr);
  const suggested = pr.suggested_thread && !owner ? { threadId: pr.suggested_thread, title: ctx.store.threadTitle(pr.suggested_thread) ?? "Thread", why: pr.suggested_why ?? "" } : null;
  const settings = ctx.settings();
  const next = nextStep({
    now,
    mine: pr.mine === 1,
    state: pr.state,
    checks: pr.checks,
    checkCounts,
    review: pr.review,
    head: pr.head,
    author: pr.author,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    reviewers,
    agent,
    suggestedAgent: suggested,
    handled,
    autoMerge: pr.auto_merge === 1,
    snoozed,
    can: {
      merge: can.merge,
      comment: can.comment,
      ready: actions.includes("ready"),
      reopen: actions.includes("reopen"),
      cancelAutoMerge: cancelsAutoMerge,
      approve: can.review,
    },
    reasons: reasons.map((r) => r.reason),
    teams,
    tracked: pr.tracked === 1,
    bot,
    requestedAt,
    lastReview,
    lastReviewFinishedAt: last?.finished_at ?? null,
    lastReviewHandled: last ? ctx.store.hasDraftSince(pr.id, last.created_at) : false,
    draft: draft ? { findings: draftFindings, preset: last?.preset ?? null, auto: last?.trigger === "auto" } : null,
    myReview,
    additions: pr.additions,
    deletions: pr.deletions,
    files: pr.files,
    inboxRequests: settings.inboxRequests,
    inboxRequestDays: settings.inboxRequestDays,
  });
  return {
    key: pr.key,
    server: pr.server,
    serverName: server?.name ?? pr.server,
    repo: pr.repo,
    number: pr.number,
    sep: server?.sep ?? "#",
    url: pr.url,
    title: pr.title,
    author: pr.author,
    mine: pr.mine === 1,
    state: pr.state,
    checks: pr.checks,
    checkCounts,
    review: pr.review,
    head: pr.head,
    headRef: pr.head_ref,
    base: pr.base,
    additions: pr.additions,
    deletions: pr.deletions,
    files: pr.files,
    updatedAt: pr.updated_at,
    createdAt: pr.created_at,
    closedAt: pr.closed_at,
    reasons,
    teams,
    requestedAt,
    bot,
    quiet: (pr.updated_at ?? pr.fetched_at) < now - QUIET_MS,
    tracked: pr.tracked === 1,
    links: links.map((l) => ({ threadId: l.thread_id, title: l.title ?? "Thread", role: l.role, archived: l.archived === 1 })),
    agent,
    suggestedAgent: suggested,
    watch: watch?.mode ?? null,
    lastReview,
    myReview,
    draft: draft ? { id: draft.id, findings: draftFindings, at: draft.created_at } : null,
    next,
    snoozedUntil: snoozed ? (pr.snoozed_until ?? null) : null,
    handled,
    autoMerge: pr.auto_merge === 1,
    stale: serverRow?.ok === 0,
    pendingItems: watch ? ctx.store.pendingCount(pr.id) : 0,
    labels: parseLabels(pr.labels),
    reviewers,
    actions,
    can,
  };
}

export function inArea(view: PrView, area: Area, ctx: Ctx): boolean {
  const live = view.state === "open" || view.state === "draft";
  switch (area) {
    case "mine":
      return view.mine && live;
    case "done":
      return view.mine && !live && (view.closedAt ?? view.updatedAt ?? 0) >= ctx.now() - ctx.settings().doneDays * DAY;
    case "reviews":
      return !view.mine && live && (view.reasons.length > 0 || view.tracked || view.myReview !== null || view.draft !== null || view.lastReview !== null);
  }
}

export function enabledServerIds(ctx: Ctx): Set<string> {
  return new Set(ctx.config().servers.filter((s) => s.enabled).map((s) => s.id));
}

/** Every PR of the enabled servers, newest first, as views. */
export function allViews(ctx: Ctx): PrView[] {
  const enabled = enabledServerIds(ctx);
  return ctx.store
    .allPrs()
    .filter((pr) => enabled.has(pr.server))
    .map((pr) => toView(ctx, pr));
}

export function inboxOf(views: PrView[]): PrView[] {
  const rank = (view: PrView) => INBOX_ORDER.indexOf(view.next.kind);
  return views.filter((view) => view.next.inbox).sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export { agentActive };
