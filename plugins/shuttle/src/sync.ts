// One sync of a server: who the user is there, every list it supports, and a refresh of the
// linked and watched PRs no list covered. Then the auto reviews the new requests call for.
import { LIST_OPERATIONS, type ListOperation, type ServerConfig } from "./config";
import type { Reason } from "./contract";
import { errText, type Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { linkFor } from "./keys";
import type { PrSummary } from "./model";
import { startReview } from "./reviews";
import { shortKey } from "./prs";

const DAY = 86_400_000;
const REFRESH_CAP = 30;

const REASON_OF: Record<ListOperation, Reason> = { authored: "authored", review_requested: "requested", team_requested: "team", mentioned: "mentioned" };

export interface SyncResult {
  server: string;
  ok: boolean;
  listed: number;
  errors: string[];
}

export async function syncServer(ctx: Ctx, server: ServerConfig, signal?: AbortSignal): Promise<SyncResult> {
  const started = ctx.now();
  const adapter = ctx.adapter(server.id);
  const supported = new Set(adapter.operations());
  const before = ctx.store.server(server.id);
  const errors: string[] = [];
  let login: string | null = before?.login ?? null;
  try {
    login = await adapter.whoami(signal);
  } catch (error) {
    errors.push(errText(error));
  }
  const seen = new Set<number>();
  let listed = 0;
  if (errors.length === 0) {
    for (const operation of LIST_OPERATIONS) {
      if (!supported.has(operation)) continue;
      try {
        const lists =
          operation === "authored"
            ? [
                await adapter.list(operation, { state: "open" }, signal),
                await adapter.list(operation, { state: "closed", since: new Date(ctx.now() - ctx.settings().doneDays * DAY).toISOString().slice(0, 10) }, signal),
              ]
            : [await adapter.list(operation, {}, signal)];
        const rows: PrSummary[] = lists.flatMap((list) => list.rows);
        const complete = lists.every((list) => list.complete);
        const reasonRows = ctx.store.tx(() =>
          rows.map((summary) => {
            const pr = ctx.store.upsertPr(server.id, summary, summary.url ?? linkFor(server, summary.repo, summary.number), operation === "authored");
            seen.add(pr.id);
            return { prId: pr.id, teams: summary.teams };
          }),
        );
        // Closed PRs keep `authored` so Done can list them; the other reasons only describe open PRs.
        ctx.store.replaceReasons(server.id, REASON_OF[operation], reasonRows, complete);
        listed += rows.length;
      } catch (error) {
        errors.push(errText(error));
      }
    }
    await refreshTracked(ctx, server, seen, errors, signal);
  }
  const now = ctx.now();
  const ok = errors.length === 0;
  ctx.store.saveServer({
    id: server.id,
    ok: ok ? 1 : 0,
    login,
    error: ok ? null : errors.join("; ").slice(0, 2000),
    last_ok_at: ok ? now : (before?.last_ok_at ?? null),
    last_sync_at: now,
    duration_ms: now - started,
    // The first good sync is the baseline: requests already waiting then never start auto reviews.
    baseline_at: before?.baseline_at ?? (ok ? now : null),
  });
  if (!ok && before?.ok !== 0) ctx.store.addEvent("sync_failed", `${server.name} sync failed: ${errors[0]}. Its PRs show the last good data.`);
  if (ok && before?.ok === 0) ctx.store.addEvent("sync_ok", `${server.name} syncs again.`);
  ctx.port.publish();
  return { server: server.id, ok, listed, errors };
}

/** Linked and watched open PRs that no list covered this round, such as someone else's PR you watch. */
async function refreshTracked(ctx: Ctx, server: ServerConfig, seen: Set<number>, errors: string[], signal?: AbortSignal): Promise<void> {
  const tracked = ctx.store
    .allPrs()
    .filter((pr) => pr.server === server.id && !seen.has(pr.id) && (pr.state === "open" || pr.state === "draft"))
    .filter((pr) => ctx.store.watch(pr.id) !== null || ctx.store.linksOf(pr.id).length > 0)
    .sort((a, b) => a.fetched_at - b.fetched_at)
    .slice(0, REFRESH_CAP);
  const adapter = ctx.adapter(server.id);
  for (const pr of tracked) {
    try {
      const summary = await adapter.view(pr.repo, pr.number, signal);
      ctx.store.upsertPr(server.id, { ...summary, repo: pr.repo }, summary.url ?? pr.url, false);
    } catch (error) {
      errors.push(`${shortKey(ctx, pr)}: ${errText(error)}`);
    }
  }
}

export function globMatch(glob: string, value: string): boolean {
  const re = new RegExp(`^${glob.trim().replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "iu");
  return re.test(value);
}

const TRIGGER_REASON = { requested: "requested", team: "team", mentioned: "mentioned" } as const;

/** PRs that newly asked for the user's review since the server's baseline and have no review for this head. */
export function autoReviewCandidates(ctx: Ctx, serverId: string): PrRow[] {
  const config = ctx.config().autoReview;
  const baseline = ctx.store.server(serverId)?.baseline_at;
  if (!baseline) return [];
  const ids = new Set<number>();
  for (const trigger of config.when) {
    for (const row of ctx.store.reasonRows(TRIGGER_REASON[trigger])) if (row.server === serverId && row.since > baseline) ids.add(row.pr_id);
  }
  const out: PrRow[] = [];
  for (const id of ids) {
    const pr = ctx.store.prById(id);
    if (!pr || pr.mine) continue;
    if (pr.state !== "open" && !(pr.state === "draft" && config.drafts)) continue;
    if (config.repos.length && !config.repos.some((glob) => globMatch(glob, pr.repo))) continue;
    const reviews = ctx.store.reviewsOf(pr.id);
    // A review of an unknown head counts for that unknown head too, so a server without heads is reviewed once.
    if (reviews.some((r) => r.head === pr.head)) continue;
    if (config.rerun === "never" && reviews.some((r) => r.trigger === "auto")) continue;
    if (ctx.store.kv(`auto_failed:${pr.id}:${pr.head ?? ""}`)) continue;
    out.push(pr);
  }
  return out;
}

export async function runAutoReviews(ctx: Ctx, serverId: string): Promise<number> {
  const config = ctx.config().autoReview;
  if (!config.enabled || ctx.settings().pauseAutomations) return 0;
  let started = 0;
  for (const pr of autoReviewCandidates(ctx, serverId)) {
    if (ctx.store.autoReviewsSince(ctx.now() - DAY) >= config.maxPerDay) {
      const day = new Date(ctx.now()).toISOString().slice(0, 10);
      if (ctx.store.kv("auto_capped") !== day) {
        ctx.store.setKv("auto_capped", day);
        ctx.store.addEvent("auto_capped", `Auto review reached its limit of ${config.maxPerDay} a day; the rest wait in Requested of me.`);
      }
      break;
    }
    try {
      await startReview(ctx, { key: pr.key }, "auto");
      started++;
    } catch (error) {
      ctx.store.setKv(`auto_failed:${pr.id}:${pr.head ?? ""}`, String(ctx.now()));
      ctx.store.addEvent("auto_failed", `Auto review of ${shortKey(ctx, pr)} could not start: ${errText(error)}`, pr.id);
    }
  }
  return started;
}
