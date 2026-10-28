// Keeping open pull requests fresh with their base branch, on a repo that sets refresh_behind. Loom counts on the
// project's checkout how many commits of the remote base each open pull request's pushed commit lacks, fetching the base
// at most every FETCH_EVERY_MS per repo, and the merge queue merges the base into a pull request that lacks that many,
// or that the forge says conflicts, as it brings a stacked one up to date. A stacked pull request takes the base through
// its parent's refresh and the restack that follows.
import { repoCheckout } from "./checkouts";
import type { ProjectRow, Store, TicketRow } from "./db/store";
import { BEHIND_MAX, type HostOutput } from "./host-contract";
import { metaOf, type PrMeta } from "./pr-meta";
import { gitNetwork, isMultiRepo, repoSettings } from "./repos";
import type { Spec } from "./spec";
import type { EngineCtx } from "./workers";

export const FETCH_EVERY_MS = 30 * 60_000;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why an open pull request is due a refresh: the commits of its base it lacks, when at least refresh_behind, and whether the forge says it conflicts; and the base tip to merge, as Loom last fetched it. */
export interface Refresh {
  behind: number | null;
  conflict: boolean;
  tip: string;
}

/**
 * Whether an open pull request on a repo that sets refresh_behind must take its base now, by what the commit Loom pushed
 * to it has. Not while it is stacked on another ticket's branch, nor while work goes back to its worker; nor before Loom
 * counted the commit it pushed last, since the refresh merges the base tip that count fetched, so every fetch of the base
 * keeps to FETCH_EVERY_MS; nor once that commit has every commit of the tip, whatever the forge says, since merging the
 * tip again changes nothing. A conflict counts only when the forge read it after Loom's last push.
 */
export function refreshDue(spec: Spec, ticket: TicketRow): Refresh | null {
  if (spec.merge.strategy !== "pr" || ticket.state !== "pr_open" || ticket.pushed_sha === null || ticket.pr_url === null || ticket.handback_json !== null) return null;
  const settings = repoSettings(spec, ticket.repo);
  if (settings.refreshBehind === null) return null;
  const meta = metaOf(ticket);
  if ((meta?.base ?? ticket.pr_base ?? settings.base) !== settings.base) return null;
  const behind = meta?.behind;
  if (behind === undefined || behind.sha !== ticket.pushed_sha || behind.commits === 0) return null;
  const lacks = behind.commits >= settings.refreshBehind ? behind.commits : null;
  const conflict = meta!.mergeable === false && meta!.at >= (ticket.pushed_at ?? 0);
  return lacks === null && !conflict ? null : { behind: lacks, conflict, tip: behind.tip };
}

/**
 * What Loom posts once a refresh is pushed: "CSV-4's branch lacked 12,374 commits of origin/main, so Loom merged origin/main
 * into it, ran its checks and pushed abc123." `checked` is false when the ticket's work had the base already, so nothing
 * was merged into it and no checks ran.
 */
export function refreshedText(key: string, refresh: Refresh, target: string, took: string, sha: string, checked = true): string {
  const lacked = refresh.behind === null ? null : `${key}'s branch lacked ${refresh.behind.toLocaleString("en-US")} ${refresh.behind === 1 ? "commit" : "commits"} of ${target}`;
  const why = lacked === null ? `${key}'s pull request conflicted with ${target}` : refresh.conflict ? `${lacked} and its pull request conflicted with it` : lacked;
  if (!checked) return `${why}; the ticket's work had ${took} already, so Loom pushed ${sha.slice(0, 12)}, which takes it, with no checks to run.`;
  return `${why}, so Loom merged ${took} into it, ran its checks and pushed ${sha.slice(0, 12)}.`;
}

/** The meta once Loom merged the base into the branch: the forge's word that it conflicts is out of date until its next read. */
export function refreshedMeta(ticket: TicketRow): Partial<TicketRow> {
  const meta = metaOf(ticket);
  return meta === null || meta.mergeable !== false ? {} : { pr_meta_json: JSON.stringify({ ...meta, mergeable: null } satisfies PrMeta) };
}

// When Loom last fetched each repo's base, by project and repo, and whether the counts since worked. In memory: a restart fetches again at once.
const fetches = new WeakMap<Store, Map<string, { at: number; ok: boolean }>>();

/**
 * The tick's step on the pr strategy: for each repo that sets refresh_behind and has open pull requests, counts the
 * commits of its remote base that each one's pushed commit lacks and keeps the count in its PrMeta. The base is fetched
 * at most every FETCH_EVERY_MS per repo; in between, only a pull request pushed since its last count is counted again,
 * against the base as last fetched. A pull request no poll has read yet waits for its first read. A count that fails
 * is logged and tried again with the next fetch; only the refresh waits on it.
 */
export async function readBehind(ctx: EngineCtx, project: ProjectRow, spec: Spec): Promise<void> {
  if (spec.merge.strategy !== "pr") return;
  const { store } = ctx;
  const times = fetches.get(store) ?? fetches.set(store, new Map()).get(store)!;
  const names: Array<string | null> = isMultiRepo(spec) ? spec.repo!.map((repo) => repo.name) : [null];
  for (const name of names) {
    const settings = repoSettings(spec, name);
    if (settings.refreshBehind === null) continue;
    const open = store.tickets(project.id, ["pr_open"]).filter((ticket) => ticket.repo === name && ticket.pushed_sha !== null && ticket.pr_url !== null && ticket.pr_meta_json !== null);
    if (open.length === 0) continue;
    const key = `${project.id}:${name ?? ""}`;
    const last = times.get(key);
    const fetch = last === undefined || ctx.now() - last.at >= FETCH_EVERY_MS;
    if (!fetch && !last.ok) continue;
    const asked = fetch ? open : open.filter((ticket) => metaOf(ticket)!.behind?.sha !== ticket.pushed_sha);
    if (asked.length === 0) continue;
    const at = fetch ? ctx.now() : last.at;
    times.set(key, { at, ok: false });
    const shas = [...new Set(asked.map((ticket) => ticket.pushed_sha!))];
    try {
      const checkout = await repoCheckout(ctx, project, spec, name);
      for (let start = 0; start < shas.length; start += BEHIND_MAX) {
        const answer = await ctx.host.call(checkout.hostId, "behindBase", { repo: checkout.path, remote: settings.remote, base: settings.base, fetch: fetch && start === 0, shas: shas.slice(start, start + BEHIND_MAX), ...gitNetwork(settings) });
        if (answer.outcome === "unavailable") throw new Error(answer.message);
        keepCounts(ctx, project, asked, answer);
      }
      times.set(key, { at, ok: true });
    } catch (error) {
      const where = name === null ? "" : ` in the repo "${name}"`;
      ctx.bb.log("warn", `Could not count how far ${project.slug}'s open pull requests${where} are behind ${settings.remote}/${settings.base}: ${errText(error)}`);
    }
  }
}

function keepCounts(ctx: EngineCtx, project: ProjectRow, asked: readonly TicketRow[], answer: Extract<HostOutput<"behindBase">, { outcome: "ok" }>): void {
  const { store } = ctx;
  const counts = new Map(answer.behind.map((each) => [each.sha, each.commits]));
  store.tx(() => {
    for (const seen of asked) {
      const ticket = store.ticket(seen.id);
      const commits = counts.get(seen.pushed_sha!);
      const meta = ticket === null ? null : metaOf(ticket);
      if (ticket?.state !== "pr_open" || ticket.pushed_sha !== seen.pushed_sha || commits === undefined || meta === null) continue;
      const { behind: _old, ...rest } = meta;
      const next: PrMeta = commits === null ? rest : { ...rest, behind: { commits, sha: ticket.pushed_sha!, tip: answer.tip, at: ctx.now() } };
      store.updateTicket(ticket.id, { pr_meta_json: JSON.stringify(next) });
    }
  });
  store.changed(project.id);
}
