// Insights: how your PRs and reviews flow, from what Shuttle stores. Numbers it only started
// keeping in 0.3 (requests, phases, deliveries, snapshots) say so through collectingSince.
import type { Finding, InsightsView, PrView } from "./contract";
import type { Ctx } from "./ctx";
import { agentActive } from "./next";
import { globMatch } from "./sync";
import { allViews } from "./views";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
export const INSIGHTS_SINCE = "insights_since";
const SLOW_MS = 2 * DAY;
/** Shares of open time mean little until Shuttle has seen this much of it, summed over your PRs. */
const PHASE_MIN_MS = 3 * DAY;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const days = (ms: number) => Math.round(ms / DAY);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Monday of the week, as YYYY-MM-DD, in UTC. */
export function weekOf(ms: number): string {
  const date = new Date(ms);
  const back = (date.getUTCDay() + 6) % 7;
  return dayOf(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - back));
}

/** The day's open-request counts, kept once a day for the trend. */
export function snapshotCounts(views: PrView[]): Record<string, number> {
  const open = views.filter((v) => !v.mine && (v.state === "open" || v.state === "draft") && v.reasons.some((r) => r.reason === "requested" || r.reason === "team"));
  return { total: open.length, bots: open.filter((v) => v.bot).length, quiet: open.filter((v) => v.quiet && !v.bot).length };
}

export function insights(ctx: Ctx, range: InsightsView["range"]): InsightsView {
  const now = ctx.now();
  const from = now - RANGE_DAYS[range] * DAY;
  const views = allViews(ctx);
  const rows = ctx.store.allPrs();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const mine = views.filter((v) => v.mine);
  const others = views.filter((v) => !v.mine);

  const merged = mine.filter((v) => v.state === "merged" && (v.closedAt ?? 0) >= from);
  const opened = mine.filter((v) => (v.createdAt ?? 0) >= from);
  const timeToMerge = median(merged.flatMap((v) => (v.createdAt !== null && v.closedAt !== null ? [v.closedAt - v.createdAt] : [])));
  const firstReviewWait = median(
    mine.flatMap((v) => {
      const row = byKey.get(v.key);
      return row?.first_review_at != null && v.createdAt !== null && v.createdAt >= from ? [row.first_review_at - v.createdAt] : [];
    }),
  );
  const since = Number(ctx.store.kv(INSIGHTS_SINCE) ?? now);
  const reviewResponse = median(
    others.flatMap((v) => {
      const row = byKey.get(v.key);
      const asked = row?.requested_at ?? v.requestedAt;
      return v.myReview?.at != null && v.myReview.at >= from && asked != null && v.myReview.at > asked ? [v.myReview.at - asked] : [];
    }),
  );

  const mineIds = mine.flatMap((v) => {
    const row = byKey.get(v.key);
    return row ? [row.id] : [];
  });
  const shares = { draft: 0, waiting: 0, fixing: 0, approved: 0 };
  for (const phase of ctx.store.phases(mineIds)) {
    const start = Math.max(phase.start_at, from);
    const end = phase.end_at ?? now;
    if (end > start && phase.phase in shares) shares[phase.phase as keyof typeof shares] += end - start;
  }
  const phaseTotal = Object.values(shares).reduce((a, b) => a + b, 0);
  const phases = phaseTotal >= PHASE_MIN_MS ? { draft: shares.draft / phaseTotal, waiting: shares.waiting / phaseTotal, fixing: shares.fixing / phaseTotal, approved: shares.approved / phaseTotal } : null;

  const mineSet = new Set(mineIds);
  const sent = ctx.store.sentSince(from).filter((s) => mineSet.has(s.pr_id));
  const sentAt = new Map(sent.map((s) => [`${s.pr_id}:${s.item_id}`, s.at]));
  const outcomes = ctx.store.outcomesSince(from).filter((o) => sentAt.has(`${o.pr_id}:${o.item_id}`));
  const count = (kind: string) => outcomes.filter((o) => o.outcome === kind).length;
  const you = ctx.store.events({ kinds: ["handled"], limit: 500 }).filter((e) => e.at >= from).length;
  const fixed = count("fixed");
  const replied = count("replied");
  const declined = count("declined");
  const feedback = {
    total: sent.length,
    fixed,
    replied,
    declined,
    you,
    open: Math.max(0, sent.length - fixed - replied - declined),
    agentMedianMs: median(outcomes.filter((o) => o.outcome === "fixed").map((o) => o.at - sentAt.get(`${o.pr_id}:${o.item_id}`)!)),
  };

  const weeks: string[] = [];
  for (let at = from; at <= now + WEEK; at += WEEK) if (!weeks.includes(weekOf(Math.min(at, now)))) weeks.push(weekOf(Math.min(at, now)));
  const bucket = new Map(weeks.map((week) => [week, { week, asked: 0, team: 0, reviewed: 0 }]));
  // Each episode of a request counts once: the server's requested_at belongs to the one still open,
  // and an earlier one counts from when Shuttle first saw it.
  for (const request of ctx.store.requests(0)) {
    if (request.reason !== "team" && request.reason !== "requested") continue;
    const serverAt = request.gone_at === null ? byId.get(request.pr_id)?.requested_at ?? null : null;
    const at = serverAt ?? (request.first_seen > since ? request.first_seen : null);
    if (at === null || at < from) continue;
    const row = bucket.get(weekOf(at));
    if (!row) continue;
    if (request.reason === "team") row.team++;
    else row.asked++;
  }
  for (const view of others) {
    if (view.myReview?.at == null || view.myReview.at < from) continue;
    const row = bucket.get(weekOf(view.myReview.at));
    if (row) row.reviewed++;
  }

  const openRequests = ctx.store.snapshots(dayOf(from)).map((s) => ({ day: s.day, total: s.counts.total ?? 0, bots: s.counts.bots ?? 0, quiet: s.counts.quiet ?? 0 }));

  const runs = ctx.store.reviewsSince(from);
  const drafts = ctx.store.draftsSince(from);
  const presetOf = new Map(runs.map((r) => [r.id, r.preset]));
  const presets = new Map<string, { preset: string; drafts: number; posted: number; drafted: number; kept: number }>();
  const entry = (preset: string) => presets.get(preset) ?? presets.set(preset, { preset, drafts: 0, posted: 0, drafted: 0, kept: 0 }).get(preset)!;
  for (const run of runs) entry(run.preset);
  for (const draft of drafts) {
    const row = entry((draft.review_id !== null ? presetOf.get(draft.review_id) : undefined) ?? "Other threads");
    row.drafts++;
    if (draft.state === "posted") {
      row.posted++;
      row.drafted += (JSON.parse(draft.findings) as Finding[]).length;
      row.kept += draft.posted_findings ?? 0;
    }
  }
  const ai = [...presets.values()].map((p) => ({ preset: p.preset, drafts: p.drafts, posted: p.posted, kept: p.drafted ? p.kept / p.drafted : null }));

  const reviewerStats = new Map<string, { login: string; bot: boolean; reviews: number; waits: number[] }>();
  const bots = ctx.settings().botAuthors;
  for (const view of mine) {
    if ((view.updatedAt ?? 0) < from) continue;
    for (const reviewer of view.reviewers ?? []) {
      if (reviewer.team || reviewer.state === "requested") continue;
      const stat = reviewerStats.get(reviewer.login) ?? { login: reviewer.login, bot: reviewer.bot === true || /\[bot\]$/iu.test(reviewer.login) || bots.some((g) => globMatch(g, reviewer.login)), reviews: 0, waits: [] };
      stat.reviews++;
      if (reviewer.at != null && view.createdAt !== null && reviewer.at > view.createdAt) stat.waits.push(reviewer.at - view.createdAt);
      reviewerStats.set(reviewer.login, stat);
    }
  }
  // People first: the table answers who reviews you, and bots review everything.
  const reviewers = [...reviewerStats.values()].sort((a, b) => Number(a.bot) - Number(b.bot) || b.reviews - a.reviews).slice(0, 8).map((s) => ({ login: s.login, bot: s.bot, reviews: s.reviews, medianMs: median(s.waits) }));

  const ideas: InsightsView["ideas"] = [];
  const openMine = mine.filter((v) => v.state === "open" || v.state === "draft");
  const slow = openMine
    .filter((v) => v.state === "open" && v.review !== "approved" && v.review !== "changes" && v.createdAt !== null && now - v.createdAt > SLOW_MS)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  // Nudge the oldest one that asks someone by name: a nudge needs people to mention.
  const nudgeable = slow.find((v) => v.can.comment && (v.reviewers ?? []).some((r) => r.state === "requested" && !r.team));
  if (slow.length) {
    const list = slow.slice(0, 3).map((v) => `${v.repo.split("/").pop()}#${v.number} (${plural(days(now - v.createdAt!), "day")})`).join(", ");
    ideas.push({
      id: "slow-reviews",
      tone: "warn",
      title: phases && phases.waiting > 0.3 ? `Waiting for a first review is ${Math.round(phases.waiting * 100)}% of your PRs\u2019 open time.` : `${plural(slow.length, "open PR")} of yours ${slow.length === 1 ? "has" : "have"} waited 2 days or more for a review.`,
      detail: `The longest: ${list}.`,
      action: nudgeable ? { id: "nudge", label: `Nudge #${nudgeable.number}\u2019s reviewers`, key: nudgeable.key } : null,
    });
  }
  const noAgent = openMine.filter((v) => !agentActive(v.agent));
  if (noAgent.length) {
    const suggested = noAgent.filter((v) => v.suggestedAgent).length;
    const speed = feedback.agentMedianMs !== null ? ` Agents fixed feedback in a median ${Math.max(1, Math.round(feedback.agentMedianMs / 60_000))} minutes.` : "";
    ideas.push({
      id: "no-agent",
      tone: "info",
      title: `${noAgent.length} of your ${openMine.length} open PRs have no agent.`,
      detail: `Their reviews and failed checks wait until you see them.${speed}${suggested ? ` ${suggested} were opened by a bb thread that auto agent can pick.` : ""}`,
      action: ctx.settings().autoAgent ? null : { id: "auto_agent", label: "Turn on auto agent", key: null },
    });
  }
  const requested = others.filter((v) => (v.state === "open" || v.state === "draft") && v.reasons.some((r) => r.reason === "requested" || r.reason === "team"));
  const botRequests = requested.filter((v) => v.bot);
  if (botRequests.length) {
    const authors = [...new Set(botRequests.map((v) => v.author))].slice(0, 3).join(", ");
    ideas.push({ id: "bots", tone: "neutral", title: `${botRequests.length} of your ${requested.length} review requests come from bots.`, detail: `From ${authors}. Reviews hides them unless you show them.`, action: { id: "hide_bots", label: "Hide bots in Reviews", key: null } });
  }
  const quiet = requested.filter((v) => v.quiet && !v.bot);
  if (quiet.length) {
    ideas.push({ id: "quiet", tone: "neutral", title: `${quiet.length} requests have been quiet for 30 days or more.`, detail: "Nothing has changed on them in a month; most are likely abandoned.", action: { id: "show_quiet", label: "Show them", key: null } });
  }
  const posted = ai.filter((row) => row.kept !== null);
  const keptAll = posted.length ? posted.reduce((a, row) => a + row.kept!, 0) / posted.length : null;
  if (keptAll !== null && keptAll < 0.5) {
    ideas.push({ id: "kept", tone: "neutral", title: `You post ${Math.round(keptAll * 100)}% of AI findings.`, detail: "Telling the review preset what to leave out would shorten every draft.", action: { id: "edit_preset", label: "Edit the preset", key: null } });
  }

  return {
    range,
    collectingSince: since > from ? since : null,
    kpis: { merged: merged.length, opened: opened.length, timeToMerge, firstReviewWait, reviewResponse },
    phases,
    feedback,
    requests: [...bucket.values()],
    openRequests,
    ai,
    reviewers,
    ideas,
  };
}
