// PR rows as the UI, the tools and the CLI see them, and which list each one belongs in.
import type { PrView, Section } from "./contract";
import type { Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { actionsOf, parseLabels, parseReviewers } from "./edit";

const DAY = 86_400_000;
const isOpen = (pr: PrRow) => pr.state === "open" || pr.state === "draft";

export function needsOf(ctx: Ctx, pr: PrRow): string | null {
  if (!isOpen(pr)) return null;
  const dismissed = pr.dismissed_at ?? 0;
  const last = ctx.store.lastReview(pr.id);
  if (!pr.mine && last && last.state !== "running" && (last.finished_at ?? 0) > dismissed) {
    return last.state === "done" ? "The review finished: read it and choose what to post" : "The review thread failed";
  }
  if (!pr.mine) return null;
  const changed = (pr.updated_at ?? pr.fetched_at) > dismissed;
  if (pr.state === "open" && pr.review === "approved" && pr.checks === "passed" && changed) return "Approved and green: ready to merge";
  if (pr.review === "changes" && changed) {
    const watched = ctx.store.watch(pr.id) !== null && ctx.store.linksOf(pr.id).some((l) => l.role === "owner" && !l.archived);
    if (!watched) return "Changes requested, and no watching thread is acting on them";
  }
  return null;
}

export function toView(ctx: Ctx, pr: PrRow): PrView {
  const server = ctx.server(pr.server);
  const state = ctx.store.server(pr.server);
  const watch = ctx.store.watch(pr.id);
  const last = ctx.store.lastReview(pr.id);
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
    review: pr.review,
    head: pr.head,
    headRef: pr.head_ref,
    base: pr.base,
    additions: pr.additions,
    deletions: pr.deletions,
    files: pr.files,
    updatedAt: pr.updated_at,
    reasons: ctx.store.reasons(pr.id).map((r) => ({ reason: r.reason, teams: JSON.parse(r.teams) as string[] })),
    watch: watch?.mode ?? null,
    links: ctx.store.linksOf(pr.id).map((l) => ({ threadId: l.thread_id, title: l.title ?? "Thread", role: l.role, archived: l.archived === 1 })),
    lastReview: last
      ? { threadId: last.thread_id, title: ctx.store.threadTitle(last.thread_id) ?? "Review thread", state: last.state, preset: last.preset, trigger: last.trigger, head: last.head, at: last.created_at }
      : null,
    needs: needsOf(ctx, pr),
    stale: state?.ok === 0,
    pendingItems: watch ? ctx.store.pendingCount(pr.id) : 0,
    labels: parseLabels(pr.labels),
    reviewers: parseReviewers(pr.reviewers),
    actions: actionsOf(ctx, pr),
  };
}

export function inSection(view: PrView, section: Section, ctx: Ctx): boolean {
  const open = view.state === "open" || view.state === "draft";
  const has = (reason: string) => view.reasons.some((r) => r.reason === reason);
  switch (section) {
    case "needs":
      return view.needs !== null;
    case "requested":
      return open && has("requested");
    case "team":
      return open && has("team");
    case "mentioned":
      return open && has("mentioned");
    case "watching":
      return !view.mine && view.watch !== null;
    case "inflight":
      return view.mine && open;
    case "done":
      return view.mine && !open && (view.updatedAt ?? 0) >= ctx.now() - ctx.settings().doneDays * DAY;
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
