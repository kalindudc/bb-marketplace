// Changing the user's own PRs on their server: draft state, open or closed, labels and reviewers.
import { AdapterError } from "./adapters/adapter";
import type { ChangeOperation } from "./config";
import type { Label, PrAction, PrChange, Reviewer } from "./contract";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { parseKey } from "./keys";
import { fetchPr, requirePr, shortKey } from "./prs";

const OPERATION: Record<PrAction, ChangeOperation> = { ready: "ready", draft: "draft", close: "close", reopen: "reopen", labels: "edit_labels", reviewers: "edit_reviewers" };

function byState(pr: PrRow): PrAction[] {
  if (pr.state === "draft") return ["ready", "close", "labels", "reviewers"];
  if (pr.state === "open") return ["draft", "close", "labels", "reviewers"];
  if (pr.state === "closed") return ["reopen", "labels"];
  return [];
}

/** The changes the user can make to this PR now: only on their own PRs, and only those its server has commands for. */
export function actionsOf(ctx: Ctx, pr: PrRow): PrAction[] {
  if (pr.mine !== 1) return [];
  const candidates = byState(pr);
  if (!candidates.length) return [];
  let operations: Set<string>;
  try {
    operations = new Set(ctx.adapter(pr.server).operations());
  } catch {
    return [];
  }
  return candidates.filter((action) => operations.has(OPERATION[action]));
}

export const parseLabels = (json: string | null): Label[] | null => (json === null ? null : (JSON.parse(json) as Label[]));
export const parseReviewers = (json: string | null): Reviewer[] | null => (json === null ? null : (JSON.parse(json) as Reviewer[]));

const uniq = <T>(values: readonly T[], keyOf: (value: T) => string): T[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const k = keyOf(value);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

function normalize(change: PrChange): PrChange {
  if (change.kind === "labels") return { kind: "labels", add: uniq(change.add, (l) => l), remove: uniq(change.remove, (l) => l).filter((l) => !change.add.includes(l)) };
  if (change.kind === "reviewers") {
    const id = (r: { login: string; team: boolean }) => `${r.team ? "team" : "user"}:${r.login}`;
    const add = uniq(change.add, id);
    return { kind: "reviewers", add, remove: uniq(change.remove, id).filter((r) => !add.some((a) => id(a) === id(r))) };
  }
  return change;
}

function describe(change: PrChange, name: string): string {
  const list = (values: string[]) => values.map((v) => `\u201c${v}\u201d`).join(", ");
  switch (change.kind) {
    case "ready":
      return `Marked ${name} ready for review.`;
    case "draft":
      return `Turned ${name} back into a draft.`;
    case "close":
      return `Closed ${name}.`;
    case "reopen":
      return `Reopened ${name}.`;
    case "labels":
      return [change.add.length ? `Added ${list(change.add)} to ${name}.` : "", change.remove.length ? `Removed ${list(change.remove)} from ${name}.` : ""].filter(Boolean).join(" ");
    case "reviewers": {
      const who = (refs: typeof change.add) => list(refs.map((r) => (r.team ? `@${r.login}` : r.login)));
      return [change.add.length ? `Asked ${who(change.add)} to review ${name}.` : "", change.remove.length ? `Withdrew the review request to ${who(change.remove)} on ${name}.` : ""].filter(Boolean).join(" ");
    }
  }
}

/** What the server will show after the change, so the PR reads right even when the read-back fails. */
function patchFor(pr: PrRow, change: PrChange, now: number): Parameters<Ctx["store"]["patchPr"]>[1] {
  switch (change.kind) {
    case "ready":
      return { state: "open", updated_at: now };
    case "draft":
      return { state: "draft", updated_at: now };
    case "close":
      return { state: "closed", updated_at: now };
    case "reopen":
      return { state: "open", updated_at: now };
    case "labels": {
      const labels = (parseLabels(pr.labels) ?? []).filter((l) => !change.remove.includes(l.name));
      for (const name of change.add) if (!labels.some((l) => l.name === name)) labels.push({ name, color: null });
      return { labels: JSON.stringify(labels), updated_at: now };
    }
    case "reviewers": {
      const same = (a: { login: string; team: boolean }, b: { login: string; team: boolean }) => a.login === b.login && a.team === b.team;
      const reviewers = (parseReviewers(pr.reviewers) ?? []).filter((r) => !change.add.some((a) => same(a, r)) && !(r.state === "requested" && change.remove.some((x) => same(x, r))));
      return { reviewers: JSON.stringify([...change.add.map((r) => ({ login: r.login, team: r.team, state: "requested" as const })), ...reviewers]), updated_at: now };
    }
  }
}

const ACTION: Record<PrChange["kind"], PrAction> = { ready: "ready", draft: "draft", close: "close", reopen: "reopen", labels: "labels", reviewers: "reviewers" };

export async function editPr(ctx: Ctx, key: string, raw: PrChange): Promise<PrRow> {
  const pr = requirePr(ctx, key);
  const name = shortKey(ctx, pr);
  const server = ctx.server(pr.server);
  if (pr.mine !== 1) throw new ShuttleError(`${name} is not one of your PRs; Shuttle only changes your own`);
  const change = normalize(raw);
  if ((change.kind === "labels" || change.kind === "reviewers") && !change.add.length && !change.remove.length) throw new ShuttleError("nothing to change");
  const action = ACTION[change.kind];
  if (!actionsOf(ctx, pr).includes(action)) {
    const fits = byState(pr).includes(action);
    throw new ShuttleError(fits ? `${server?.name ?? pr.server} has no ${OPERATION[action]} command, so Shuttle can't do that there` : `${name} is ${pr.state}, so it can't be changed that way`);
  }
  try {
    await ctx.adapter(pr.server).change(pr.repo, pr.number, change);
  } catch (error) {
    if (error instanceof AdapterError) throw new ShuttleError(`${server?.name ?? pr.server} refused the change: ${error.message}`);
    throw error;
  }
  ctx.store.patchPr(pr.id, patchFor(pr, change, ctx.now()));
  ctx.store.addEvent("edit", describe(change, name), pr.id);
  const ref = parseKey(key);
  if (ref) await fetchPr(ctx, ref).catch((error: unknown) => ctx.port.log("warn", `read back ${key}: ${errText(error)}`));
  ctx.port.publish();
  return ctx.store.prByKey(key)!;
}

/** Labels and reviewers to offer: what the server says, plus what Shuttle has seen on the repo's PRs and the user's teams. */
export async function editOptions(ctx: Ctx, key: string): Promise<{ labels: Array<Label & { description: string | null }>; people: string[]; teams: string[] }> {
  const pr = requirePr(ctx, key);
  if (pr.mine !== 1) throw new ShuttleError(`${shortKey(ctx, pr)} is not one of your PRs`);
  const adapter = ctx.adapter(pr.server);
  let fromServer = { labels: [] as Array<Label & { description: string | null }>, people: [] as string[] };
  if (adapter.operations().includes("edit_options")) {
    try {
      fromServer = await adapter.editOptions(pr.repo, pr.number);
    } catch (error) {
      throw new ShuttleError(`${ctx.server(pr.server)?.name ?? pr.server} could not list labels and reviewers: ${errText(error)}`);
    }
  }
  const siblings = ctx.store.allPrs().filter((other) => other.server === pr.server);
  const sameRepo = siblings.filter((other) => other.repo === pr.repo);
  const seenLabels = sameRepo.flatMap((other) => parseLabels(other.labels) ?? []).map((l) => ({ ...l, description: null }));
  const seenReviewers = sameRepo.flatMap((other) => parseReviewers(other.reviewers) ?? []);
  const myTeams = siblings.flatMap((other) => ctx.store.reasons(other.id)).filter((r) => r.reason === "team").flatMap((r) => JSON.parse(r.teams) as string[]).map((t) => t.replace(/^@/u, ""));
  const me = ctx.store.server(pr.server)?.login;
  return {
    labels: uniq([...fromServer.labels, ...seenLabels], (l) => l.name).sort((a, b) => a.name.localeCompare(b.name)),
    people: uniq([...fromServer.people, ...seenReviewers.filter((r) => !r.team).map((r) => r.login)], (p) => p).filter((p) => p !== pr.author && p !== me),
    teams: uniq([...myTeams, ...seenReviewers.filter((r) => r.team).map((r) => r.login)], (t) => t),
  };
}
