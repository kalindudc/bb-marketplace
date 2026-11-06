// Asking people to review each pull request Loom opens, on a repo whose forge sets reviewers: a stable random sample of a
// team, or of fixed logins, once per pull request and once the forge says it is not a draft. The pick is seeded by the pull
// request's URL, so a retry or a restart picks the same people; the author and bots are never picked or counted, and those
// already asked or reviewing from a rule's pool count toward its count. Each request is recorded before it is sent: a
// command forge's request that may have gone out (a lost answer, a timeout, a restart) is never sent again, and a definite
// failure is tried again at most REVIEW_TRIES times in all.
import { createHash } from "node:crypto";
import type { EventRow, ProjectRow, TicketRow } from "./db/store";
import { hostCallTransient } from "./forge-waits";
import { forgeBroke } from "./retry";
import { githubPull, type HostOutput } from "./host-contract";
import { andList } from "./prompts";
import { repoCheckout, type RepoCheckout } from "./checkouts";
import { repoSettings } from "./repos";
import type { ForgeSpec, ReviewerRuleSpec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { specOf, type EngineCtx } from "./ctx";
import { mergePostNow } from "./posts";

export const REVIEWERS_REQUESTED = "ticket.reviewers_requested";
export const REVIEWERS_ASKING = "ticket.reviewers_asking";
export const REVIEWERS_FAILED = "ticket.reviewers_failed";
/** The forge gate held the request, so nothing went out: it is asked again later, and uses no try. */
export const REVIEWERS_HELD = "ticket.reviewers_held";
/** Tries of a pull request's review request, counting each definite failure, before Loom gives up and says so. */
export const REVIEW_TRIES = 3;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a read of the pull request already tells: whether it is a draft, who opened it and who reviewed it. */
export interface ReviewRead {
  draft: boolean | null;
  author: string | null;
  reviewed: readonly string[];
}

const isBot = (login: string) => login.endsWith("[bot]");
const rank = (url: string, login: string) => createHash("sha256").update(`${url}\n${login.toLowerCase()}`).digest("hex");

/**
 * The logins a rule picks for the pull request at `url`. `exclude`, the author, is never picked and never counts. Those of
 * `pool` already asked or reviewing count first; then the rest, less `taken` (picked by an earlier rule), in the order of a
 * hash of the URL and the login, which does not depend on how the pool is listed.
 */
export function pickReviewers(url: string, pool: ReadonlyArray<{ login: string; bot: boolean }>, count: number, a: { exclude: ReadonlySet<string>; already: ReadonlySet<string>; taken?: ReadonlySet<string> }): { kept: string[]; picked: string[]; short: number } {
  const people = [...new Map(pool.filter((member) => !member.bot && !isBot(member.login) && !a.exclude.has(member.login.toLowerCase())).map((member) => [member.login.toLowerCase(), member.login])).values()];
  const kept = people.filter((login) => a.already.has(login.toLowerCase())).slice(0, count);
  const open = people.filter((login) => !a.already.has(login.toLowerCase()) && !a.taken?.has(login.toLowerCase())).sort((x, y) => (rank(url, x) < rank(url, y) ? -1 : 1));
  const need = Math.max(0, count - kept.length);
  const picked = open.slice(0, need);
  return { kept, picked, short: need - picked.length };
}

const ruleText = (rule: ReviewerRuleSpec) => (rule.count === undefined ? andList(rule.users) : `${rule.count} of ${andList(rule.users)}`);

/** A rule a version stored before team rules were retired may hold: a team and a count, and no users. */
type StoredRule = ReviewerRuleSpec | { team: string; count?: number; users?: undefined };

/** Why Loom asks no one from a stored team rule, and what the spec writes instead. */
export const teamRuleGone = (rule: { team: string; count?: number }) =>
  `${rule.team}, a team: Loom no longer reads team rules, so it asked no one from it. List the logins of the people to ask in this rule's users instead${rule.count === undefined ? "" : `, with count = ${rule.count}`}.`;

/**
 * A failed call: `thrown` when the call got no answer from the project's machine, rather than the forge's own failure;
 * `held` when nothing is counted, because the forge gate held the call or the forge's broken answer paused the project.
 */
type Failure = { message: string; transient: boolean; thrown: boolean; held?: boolean };
const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "transient" in value && !("outcome" in value);
const data = (event: EventRow) => JSON.parse(event.data_json) as { url?: string; reviewers?: string[] };

/** This pull request's review request as its events tell it: done, sent with no answer recorded, and failed how many times. */
function requestState(ctx: EngineCtx, ticketId: number, url: string): { done: boolean; sent: string[] | null; failures: number } {
  let sent: string[] | null = null;
  let failures = 0;
  for (const event of ctx.store.ticketEvents(ticketId, [REVIEWERS_REQUESTED, REVIEWERS_ASKING, REVIEWERS_FAILED, REVIEWERS_HELD])) {
    if (data(event).url !== url) continue;
    if (event.kind === REVIEWERS_REQUESTED) return { done: true, sent: null, failures };
    if (event.kind === REVIEWERS_ASKING) sent = data(event).reviewers ?? [];
    else if (event.kind === REVIEWERS_HELD) sent = null;
    else {
      sent = null;
      failures += 1;
    }
  }
  return { done: false, sent, failures };
}

/** Whether the ticket is still where a review request may go out for `url`: pr_open on it, in a running project, not done. */
function stillAsking(ctx: EngineCtx, projectId: number, ticketId: number, url: string): TicketRow | null {
  const ticket = ctx.store.ticket(ticketId);
  if (ctx.store.project(projectId)?.state !== "running" || ticket?.state !== "pr_open" || ticket.pr_url !== url) return null;
  return requestState(ctx, ticketId, url).done ? null : ticket;
}

/**
 * After a read of an open pull request, asks the reviewers its repo's rules pick, once per pull request. It waits for a read
 * that says the pull request is not a draft: a draft, and a forge that does not say, wait.
 */
export async function requestReviewers(ctx: EngineCtx, project: ProjectRow, ticketId: number, read: ReviewRead): Promise<void> {
  const { store } = ctx;
  const first = store.ticket(ticketId);
  const current = store.project(project.id);
  if (first === null || current?.state !== "running" || first.state !== "pr_open" || first.pr_url === null || read.draft !== false) return;
  const spec = specOf(store, current);
  const { forge } = repoSettings(spec, first.repo);
  const rules = forge.reviewers;
  if (rules === undefined || forge.kind === "none") return;
  const url = first.pr_url;
  const known = requestState(ctx, first.id, url);
  if (known.done) return;
  const done = (ticket: TicketRow, body: string, more: { requested: string[]; failed: Array<{ login: string | null; message: string }>; unknown?: string[] }, outcome = "reviewers_requested") => {
    store.event(ticket.project_id, ticket.id, REVIEWERS_REQUESTED, LOOM_ACTOR, { url, ...more });
    mergePostNow(ctx.store, ticket, body, { outcome, url, ...more });
  };
  // A command forge's request that went out and has no answer recorded may have asked them: Loom never sends it again.
  if (known.sent !== null && forge.kind === "command") {
    done(first, `Loom sent the request to review ${url} to ${andList(known.sent)}, and has no record of its answer (the machine restarted, or the answer was lost), so it cannot tell whether they were asked, and does not ask again. Check the pull request, and ask them yourself if they were not.`, { requested: [], failed: [], unknown: known.sent }, "reviewers_unknown");
    return;
  }
  const failed = (ticket: TicketRow, message: string) => {
    const failures = requestState(ctx, ticket.id, url).failures + 1;
    store.event(ticket.project_id, ticket.id, REVIEWERS_FAILED, LOOM_ACTOR, { url, message });
    if (failures >= REVIEW_TRIES) done(ticket, `Loom tried ${REVIEW_TRIES} times to ask for reviews of ${url} and gave up: ${message}`, { requested: [], failed: [{ login: null, message }] });
    else if (failures === 1) mergePostNow(ctx.store, ticket, `Loom could not ask for reviews of ${url} yet: ${message}. It tries again at the next read of the pull request, ${REVIEW_TRIES} times in all.`, { outcome: "reviewers_failed", url, message });
    else store.changed(ticket.project_id);
  };
  let checkout: RepoCheckout;
  try {
    checkout = await repoCheckout(ctx, current, spec, first.repo);
  } catch (error) {
    ctx.bb.log("warn", `Asking for reviews of ${first.key}'s pull request waits: ${errText(error)}`);
    return;
  }
  const call = async <T extends { outcome: string }>(fn: () => Promise<T>): Promise<T | Failure> => {
    try {
      const answer = await fn();
      if (answer.outcome === "held") return { message: (answer as unknown as { message: string }).message, transient: true, thrown: false, held: true };
      return answer.outcome === "unavailable" ? { message: (answer as unknown as { message: string }).message, transient: (answer as { transient?: unknown }).transient !== undefined, thrown: false } : answer;
    } catch (error) {
      if (forgeBroke(ctx, project.id, `Asking for reviews of ${url}`, error)) return { message: errText(error), transient: false, thrown: true, held: true };
      return { message: errText(error), transient: hostCallTransient(error) !== null, thrown: true };
    }
  };

  let author = read.author;
  let already = new Set(read.reviewed.map((login) => login.toLowerCase()));
  if (forge.kind === "gh") {
    const state = await call(() => ctx.host.call(checkout.hostId, "prReviewState", { repo: checkout.path, url }));
    const ticket = stillAsking(ctx, project.id, first.id, url);
    if (ticket === null) return;
    if (isFailure(state) && state.held === true) return;
    if (isFailure(state)) return failed(ticket, `Loom could not read who reviews it: ${state.message}`);
    const answer = state as Extract<HostOutput<"prReviewState">, { outcome: "ok" }>;
    author = answer.author ?? author;
    already = new Set([...already, ...answer.requested.map((login) => login.toLowerCase()), ...answer.reviewed.map((login) => login.toLowerCase())]);
  }
  const exclude = new Set(author === null ? [] : [author.toLowerCase()]);
  const picks: Array<{ rule: ReviewerRuleSpec; kept: string[]; picked: string[]; short: number; problem: string | null }> = [];
  const taken = new Set<string>();
  for (const rule of rules as readonly StoredRule[]) {
    if (rule.users === undefined) {
      picks.push({ rule: { users: [] }, kept: [], picked: [], short: 0, problem: teamRuleGone(rule) });
      continue;
    }
    const pool = rule.users.map((login) => ({ login, bot: false }));
    const pick = pickReviewers(url, pool, rule.count ?? pool.length, { exclude, already, taken });
    for (const login of pick.picked) taken.add(login.toLowerCase());
    picks.push({ rule, ...pick, problem: null });
  }
  const ticket = stillAsking(ctx, project.id, first.id, url);
  if (ticket === null) return;
  const chosen = picks.flatMap((pick) => pick.picked);
  const problems = picks.flatMap((pick) => (pick.problem === null ? [] : [{ login: null, message: pick.problem }]));
  const lines = (requested: ReadonlySet<string>) =>
    picks.map(({ rule, kept, picked, short, problem }) => {
      if (problem !== null) return `- ${problem}`;
      const asked = picked.filter((login) => requested.has(login));
      const parts = [
        ...(asked.length > 0 ? [`asked ${andList(asked)}`] : []),
        ...(picked.length > asked.length ? [`picked ${andList(picked.filter((login) => !requested.has(login)))}, who ${picked.length - asked.length === 1 ? "was" : "were"} not asked`] : []),
        ...(kept.length > 0 ? [`${andList(kept)} ${kept.length === 1 ? "was" : "were"} already asked or reviewing`] : []),
        ...(short > 0 ? [`${short} short: no one else in it can be asked`] : []),
      ];
      return `- ${ruleText(rule)}: ${parts.length === 0 ? "no one to ask" : parts.join("; ")}.`;
    });
  if (chosen.length === 0) return done(ticket, `Loom asked no one new to review ${url}:\n\n${lines(new Set()).join("\n")}`, { requested: [], failed: problems });
  // The spec allows at most 20 (spec.ts's REVIEWERS_MAX), so this is all of them; recorded in the same synchronous stretch as the send.
  store.event(ticket.project_id, ticket.id, REVIEWERS_ASKING, LOOM_ACTOR, { url, reviewers: chosen });
  const asked = await call(() => ctx.host.call(checkout.hostId, "prRequestReview", { repo: checkout.path, url, reviewers: chosen, ...(forge.kind === "command" ? { forge: { kind: "command" as const, request_reviews: forge.request_reviews! } } : {}) }));
  const after = ctx.store.ticket(ticket.id) ?? ticket;
  // A request the gate held sent nothing, so it is asked again later; one the forge answered with broken output paused the project and may have gone out.
  if (isFailure(asked) && asked.held === true) {
    if (!asked.thrown) store.event(ticket.project_id, ticket.id, REVIEWERS_HELD, LOOM_ACTOR, { url, message: asked.message });
    return;
  }
  // A command that exits non-zero asked no one, by its contract; a call that got no answer may have run it.
  const lost = isFailure(asked) && asked.thrown && asked.transient && forge.kind === "command";
  if (lost || (!isFailure(asked) && asked.outcome === "unknown")) {
    const message = isFailure(asked) ? asked.message : (asked as { message: string }).message;
    return done(after, `Loom asked ${andList(chosen)} to review ${url} through request_reviews, but cannot tell whether it worked: ${message}\n\nIt does not run the command again. Check the pull request, and ask them yourself if they were not asked.\n\n${lines(new Set()).join("\n")}`, { requested: [], failed: problems, unknown: chosen }, "reviewers_unknown");
  }
  // gh reads who is already asked before it asks, so a failed or lost request is tried again safely, at most REVIEW_TRIES times.
  if (isFailure(asked)) return failed(after, `Loom could not ask ${andList(chosen)}: ${asked.message}`);
  const answer = asked as Extract<HostOutput<"prRequestReview">, { outcome: "ok" }>;
  const requested = new Set(answer.requested);
  const misses = answer.failed.map((miss) => `Loom could not ask ${miss.login}: ${miss.message}`);
  const head = answer.requested.length > 0 ? `Asked ${andList(answer.requested)} to review ${url}, as the repo's reviewer rules pick:` : `Loom asked no one to review ${url}: the forge refused every request.`;
  done(after, [head, "", ...lines(requested), ...(misses.length === 0 ? [] : ["", ...misses])].join("\n"), { requested: answer.requested, failed: [...problems, ...answer.failed] });
}

