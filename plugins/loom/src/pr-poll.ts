// Following open pull requests: read each one through its forge in batches, every POLL_MS and longer after failures,
// and settle what a read says: merged, closed, feedback for a fix round, or a wait on the forge.
import { repoCheckout, type RepoCheckout } from "./checkouts";
import type { ProjectRow, TicketRow } from "./db/store";
import { plural } from "./format";
import { POLL_MS, backedOffUntil, backoffText, forgeHostOf, networkWaitLong, networkWaitLongText, networkWaitText, nextBackoff, nextNetworkBackoff, nextPollAt } from "./forge-waits";
import { classify, classifyAnswer, classifyForgeRead, transientOf, type Failure, type Transient } from "./failures";
import { followDraft } from "./drafts";
import { publishRule } from "./publish";
import { followGate } from "./review-gate";
import { andList } from "./prompts";
import { followFeedback, syncPrText } from "./pull-requests";
import { PR_BATCH_MAX, githubPull, type HostInput, type HostOutput as HostOutputOf } from "./host-contract";
import { readMeta } from "./pr-meta";
import { autoMergeOf, followsFeedback, gitNetwork, prSettings, repoSettings, type RepoSettings } from "./repos";
import { followAutoMerge, type MergeRead } from "./auto-merge";
import { requestReviewers } from "./review-requests";
import { forgetClosedReads, noteAnswer, readGoesOut } from "./pr-sync";
import type { ForgeSpec, Spec } from "./spec";
import { type PrMeta, writeSub } from "./sub-state";
import { endRetry, stepFailed } from "./retry";
import { specOf, type EngineCtx } from "./ctx";
import { complete, endFinishedThreads, errText } from "./merge-common";
import { blockMergedElsewhere, closedPullRequest } from "./pr-closed";
import { loomPost } from "./posts";

/** A poll's closed read: closedPullRequest, with a failed read of the remote settled as any failed read is. */
async function settleClosed(ctx: EngineCtx, ticket: TicketRow, target: string | null): Promise<void> {
  const project = ctx.store.project(ticket.project_id)!;
  try {
    await closedPullRequest(ctx, project, ticket, target);
  } catch (error) {
    noteAnswer(ctx, ticket.id, `Reading the pull request of ${ticket.key} stopped: ${errText(error)}`);
    await readFailed(ctx, ticket, classify(error));
  }
}

/**
 * A read of the ticket's pull request failed in a way the ticket waits out, blocks for, or the project pauses for (retry.ts).
 * `polled` is the ticket as the read went out; an answer about a pull request or attempt the ticket has left is dropped.
 */
async function readFailed(ctx: EngineCtx, polled: TicketRow, failure: Failure): Promise<void> {
  const current = ctx.store.ticket(polled.id);
  if (current === null || !samePullRequest(polled, current)) return ctx.bb.log("warn", `Reading the pull request of ${polled.key} failed after the ticket left that pull request: ${failure.reason}`);
  await stepFailed(ctx, current, "read", failure, { what: `Reading the pull request of ${polled.key}`, floorMs: POLL_MS, ...(current.pr_url === null ? {} : { pr: current.pr_url }) });
}

/** Whether the ticket is still on the pull request and attempt it was read for. */
const samePullRequest = (polled: TicketRow, current: TicketRow): boolean =>
  current.state === "pr_open" && current.pr_url === polled.pr_url && current.attempt === polled.attempt && current.pushed_sha === polled.pushed_sha;

const stateForge = (forge: ForgeSpec): HostInput<"prState">["forge"] => (forge.kind === "command" ? { kind: "command", state: forge.state! } : { kind: "gh" });

type Feedback = Extract<HostOutputOf<"prFeedback">, { outcome: "ok" }>;

/**
 * One read of a pull request: its state, the PrMeta fields Loom stores (null for the push-only forge, which has no pull
 * request), and its feedback when Loom follows it; or why it failed, with `transient` for a forge failure worth waiting out.
 */
type PrRead =
  | { outcome: "ok"; state: "OPEN" | "MERGED" | "CLOSED"; meta: Pick<PrMeta, "draft" | "review" | "base" | "mergeable"> | null; feedback: Feedback | null; text?: PrTextRead; queue?: MergeRead["queue"] }
  | { outcome: "unavailable"; message: string; transient?: "server" | "rate_limit" | "network"; retryAfterMs?: number };

/** The title and description a read gave; null when it gave neither, as a state command or a host from before Loom read them. */
type PrTextRead = { title: string | null; body: string | null } | null;
const textRead = (read: { title?: string | null; body?: string | null }): PrTextRead => (read.title === undefined && read.body === undefined ? null : { title: read.title ?? null, body: read.body ?? null });

/** The due GitHub pull requests of one repository, with the checkout gh runs in; `forgeHost` keys the host's backoff. */
interface Batch {
  checkout: RepoCheckout;
  host: string;
  forgeHost: string;
  owner: string;
  name: string;
  tickets: Array<{ id: number; number: number }>;
  /** Read each one's merge queue state too: the repo merges through GitHub's merge queue (auto_merge.method = "queue"). */
  queue: boolean;
}

/**
 * Reads every open pull request whose next read is due, every 5 minutes unless it waits longer: merged completes the
 * ticket, closed blocks it, and so does one merged into a branch other than its repo's base. GitHub's are read PR_BATCH_MAX
 * at a time in one call per repository; a command forge's and the push-only forge's one at a time. Each due ticket gets
 * one read, never repeated in the same poll. A network failure or a rate limit stops every read to that forge host, in
 * this poll and every project's, for a while (forge-waits.ts); a command forge's host is its pull request URL's. Any other
 * failure is settled on each ticket it read by retry.ts: it waits, blocks that ticket, or pauses the project for a
 * failure of the whole project. A pull request the human synced (pr-sync.ts) is due now, whatever its own wait says.
 */
export async function pollPullRequests(ctx: EngineCtx, project: ProjectRow): Promise<void> {
  const { store } = ctx;
  const spec = specOf(store, project);
  const forgeOf = (ticket: TicketRow) => repoSettings(spec, ticket.repo).forge;
  const reads = forgetClosedReads(ctx, project.id);
  const due = store.tickets(project.id, ["pr_open"]).filter((ticket) => (ticket.pr_url !== null || forgeOf(ticket).kind === "none") && (ticket.pr_checked_at === null || ctx.now() >= nextPollAt(ticket)! || reads.asked.has(ticket.id)));
  if (due.length === 0) return;
  const synced = due.some((ticket) => reads.asked.has(ticket.id));
  try {
    await readDue(ctx, project, spec, due);
  } finally {
    for (const ticket of due) reads.out.delete(ticket.id);
    // A read that found nothing new writes no event, so the page that asked for it is told here.
    if (synced) store.changed(project.id);
  }
}

/** The read is going out: the ticket is not due again until its next wait, and a sync of it is answered by this read. */
function markRead(ctx: EngineCtx, ticketId: number): void {
  ctx.store.updateTicket(ticketId, { pr_checked_at: ctx.now() });
  readGoesOut(ctx, ticketId);
}

async function readDue(ctx: EngineCtx, project: ProjectRow, spec: Spec, due: TicketRow[]): Promise<void> {
  const { store } = ctx;
  const forgeOf = (ticket: TicketRow) => repoSettings(spec, ticket.repo).forge;
  const follows = prSettings(spec).maxFixRounds > 0;
  // Each repo's checkout is read once per poll; each pull request of a repo without one waits, as for any failed read.
  const checkouts = new Map<string | null, RepoCheckout | Failure>();
  const checkoutOfRepo = async (name: string | null): Promise<RepoCheckout | Failure> => {
    const cached = checkouts.get(name);
    if (cached !== undefined) return cached;
    const checkout = await repoCheckout(ctx, project, spec, name).catch((error: unknown) => classify(error));
    checkouts.set(name, checkout);
    return checkout;
  };
  const batches = new Map<string, Batch>();
  for (const seen of due) {
    const ticket = store.ticket(seen.id);
    if (ticket?.state !== "pr_open") continue;
    const forge = forgeOf(ticket);
    if (ticket.pr_url === null && forge.kind !== "none") continue;
    // Left due, so it is read in the first poll after the backoff ends.
    const host = forge.kind === "none" ? null : forgeHostOf(ticket.pr_url);
    if (backedOffUntil(ctx.forgeBackoffs, host, ctx.now()) !== null) continue;
    const checkout = await checkoutOfRepo(ticket.repo);
    if (!("hostId" in checkout)) {
      markRead(ctx, ticket.id);
      noteAnswer(ctx, ticket.id, checkout.reason);
      await readFailed(ctx, ticket, checkout);
      continue;
    }
    if (forge.kind === "gh") {
      const pull = githubPull(ticket.pr_url!);
      if (pull === null) {
        const message = `${ticket.key}'s pull request ${ticket.pr_url} is not a GitHub pull request URL, so gh cannot read it.`;
        markRead(ctx, ticket.id);
        noteAnswer(ctx, ticket.id, message);
        await readFailed(ctx, ticket, { kind: "lasting", scope: "ticket", reason: message, known: true });
        continue;
      }
      const key = `${host}/${pull.owner}/${pull.name}`;
      const batch = batches.get(key) ?? batches.set(key, { checkout, host: pull.host, forgeHost: host!, owner: pull.owner, name: pull.name, tickets: [], queue: false }).get(key)!;
      batch.tickets.push({ id: ticket.id, number: pull.number });
      batch.queue ||= autoMergeOf(forge)?.method === "queue";
      continue;
    }
    markRead(ctx, ticket.id);
    let read: PrRead;
    try {
      read = await readOne(ctx, checkout, ticket, forge, follows);
    } catch (error) {
      noteAnswer(ctx, ticket.id, `Reading the pull request of ${ticket.key} stopped: ${errText(error)}`);
      await readFailed(ctx, ticket, classifyForgeRead(error));
      continue;
    }
    await settleRead(ctx, project, checkout.settings, ticket, read, host);
  }
  for (const batch of batches.values()) {
    for (let start = 0; start < batch.tickets.length; start += PR_BATCH_MAX) {
      // A rate limit or network failure in an earlier chunk, or another repository's, leaves the rest due for the first poll after the backoff ends.
      if (backedOffUntil(ctx.forgeBackoffs, batch.forgeHost, ctx.now()) !== null) break;
      await readBatch(ctx, project, spec, batch, batch.tickets.slice(start, start + PR_BATCH_MAX), follows);
    }
  }
  await endFinishedThreads(ctx, project.id);
}

/** A read the forge host rate-limited: no read goes to that host, from any project, until the backoff ends. */
function backOff(ctx: EngineCtx, ticket: TicketRow, host: string, failure: { message: string; retryAfterMs?: number }, forge = "GitHub"): void {
  const now = ctx.now();
  const backoff = nextBackoff(ctx.forgeBackoffs.get(host), { now, message: failure.message, retryAfterMs: failure.retryAfterMs });
  ctx.forgeBackoffs.set(host, backoff);
  loomPost(ctx.store, ticket, { kind: "system", body: backoffText(host, backoff, now, forge), data: { rateLimited: true, host, until: backoff.until } });
  ctx.bb.log("warn", `${host} rate-limited Loom's pull request reads, so none goes there until ${new Date(backoff.until).toISOString()}: ${failure.message}`);
}

/**
 * A read that never reached the forge host, such as one whose name did not resolve. That is the machine, not the pull
 * request, so the whole host waits: no read goes there, from any project, for 5, 10, 20, then 30 minutes, and one failed
 * call is one failure however many pull requests it asked for. The ticket whose read starts the streak gets its one post,
 * and the ticket whose read fails after an hour of failures with no read there working in between gets one more.
 */
function waitOutNetworkError(ctx: EngineCtx, ticket: TicketRow, host: string, message: string): void {
  const now = ctx.now();
  const backoff = nextNetworkBackoff(ctx.forgeBackoffs.get(host), { now, message });
  ctx.forgeBackoffs.set(host, backoff);
  const { failures, since } = backoff.network;
  if (failures === 1) {
    loomPost(ctx.store, ticket, { kind: "system", body: networkWaitText(host, backoff), data: { networkFailed: true, host, until: backoff.until } });
    ctx.store.changed(ticket.project_id);
  }
  ctx.bb.log("warn", `Reading pull requests on ${host} failed ${plural(failures, "time")} in a row with a network error, so none goes there until ${new Date(backoff.until).toISOString()}: ${message}`);
  if (networkWaitLong(backoff, now)) {
    ctx.forgeBackoffs.set(host, { ...backoff, noted: true });
    loomPost(ctx.store, ticket, { kind: "system", body: networkWaitLongText(host, backoff, now), data: { networkFailed: true, host, until: backoff.until, since } });
    ctx.store.changed(ticket.project_id);
  }
}

/**
 * What a pull request whose fix round is ready looks like now: one GitHub read of it, or a command forge's feedback command,
 * which can name its base, else its state command, which cannot. Its draft flag, review, base and mergeability are kept like a poll's.
 */
export async function fixRoundState(ctx: EngineCtx, checkout: RepoCheckout, url: string): Promise<{ outcome: "ok"; state: "OPEN" | "MERGED" | "CLOSED"; meta: Pick<PrMeta, "draft" | "review" | "base" | "mergeable"> } | ({ outcome: "unavailable"; message: string } & Partial<Transient>)> {
  const { hostId, path: repo, settings } = checkout;
  const { forge } = settings;
  const pull = forge.kind === "gh" ? githubPull(url) : null;
  if (pull !== null) {
    const answer = await ctx.host.call(hostId, "prBatch", { repo, host: pull.host, owner: pull.owner, name: pull.name, numbers: [pull.number], feedback: false });
    if (answer.outcome === "unavailable") return answer;
    const read = answer.pulls.find((each) => each.number === pull.number);
    if (read === undefined) {
      const miss = answer.missing[0];
      return { outcome: "unavailable", message: miss?.message ?? `gh found no pull request at ${url}.`, ...(miss === undefined ? {} : transientOf(miss)) };
    }
    return { outcome: "ok", state: read.state, meta: { draft: read.draft, review: read.review, base: read.base, mergeable: read.mergeable ?? null } };
  }
  if (forge.kind === "command" && forge.feedback !== undefined) {
    const read = await ctx.host.call(hostId, "prFeedback", { repo, url, forge: { kind: "command", feedback: forge.feedback } });
    if (read.outcome === "unavailable") return read;
    return { outcome: "ok", state: read.state, meta: { draft: read.draft ?? null, review: read.review ?? null, base: read.base ?? null, mergeable: read.mergeable ?? null } };
  }
  const state = await ctx.host.call(hostId, "prState", { repo, url, forge: stateForge(forge) });
  return state.outcome === "ok" ? { outcome: "ok", state: state.state, meta: { draft: null, review: null, base: null, mergeable: null } } : state;
}

/** A command forge's pull request through its feedback or state command, or the push-only forge's pushed commit. */
async function readOne(ctx: EngineCtx, checkout: RepoCheckout, ticket: TicketRow, forge: ForgeSpec, follows: boolean): Promise<PrRead> {
  const { hostId, path: repo, settings } = checkout;
  if (forge.kind === "none") {
    // The push-only forge has no pull request to ask: the ticket is done once the remote base contains the commit Loom pushed.
    const landed = await ctx.host.call(hostId, "landedOn", { repo, remote: settings.remote, base: settings.base, sha: ticket.pushed_sha ?? ticket.head_sha!, ...gitNetwork(settings) });
    return landed.outcome === "ok" ? { outcome: "ok", state: landed.landed ? "MERGED" : "OPEN", meta: null, feedback: null } : landed;
  }
  if (follows && followsFeedback(forge)) {
    const read = await ctx.host.call(hostId, "prFeedback", { repo, url: ticket.pr_url!, forge: forge.kind === "command" ? { kind: "command", feedback: forge.feedback! } : { kind: "gh" } });
    if (read.outcome !== "ok") return read;
    return { outcome: "ok", state: read.state, meta: { draft: read.draft ?? null, review: read.review ?? null, base: read.base ?? null, mergeable: read.mergeable ?? null }, feedback: read, text: textRead(read) };
  }
  // The state command prints one word, so it tells nothing else about the pull request.
  const state = await ctx.host.call(hostId, "prState", { repo, url: ticket.pr_url!, forge: stateForge(forge) });
  return state.outcome === "ok" ? { outcome: "ok", state: state.state, meta: { draft: null, review: null, base: null }, feedback: null } : state;
}

/** Reads up to PR_BATCH_MAX of one repository's due GitHub pull requests in one call, then settles each ticket on its own. */
async function readBatch(ctx: EngineCtx, project: ProjectRow, spec: Spec, batch: Batch, chunk: Batch["tickets"], follows: boolean): Promise<void> {
  const { store } = ctx;
  // Each ticket as it is when the call goes out: settleRead compares the ticket with it once the answer is in.
  const polled = chunk.flatMap(({ id, number }) => {
    const ticket = store.ticket(id);
    return ticket?.state === "pr_open" ? [{ ticket, number }] : [];
  });
  if (polled.length === 0) return;
  for (const { ticket } of polled) markRead(ctx, ticket.id);
  const { checkout, host, owner, name } = batch;
  let answer: HostOutputOf<"prBatch">;
  try {
    answer = await ctx.host.call(checkout.hostId, "prBatch", { repo: checkout.path, host, owner, name, numbers: [...new Set(polled.map((each) => each.number))], feedback: follows, ...(batch.queue ? { queue: true } : {}) });
  } catch (error) {
    const what = polled.length === 1 ? `the pull request of ${polled[0]!.ticket.key}` : `the pull requests of ${andList(polled.map(({ ticket }) => ticket.key))}`;
    const message = `Reading ${what} stopped: ${errText(error)}`;
    const failure = classifyForgeRead(error);
    for (const { ticket } of polled) noteAnswer(ctx, ticket.id, message);
    for (const { ticket } of polled) await readFailed(ctx, ticket, failure);
    return;
  }
  if (answer.outcome === "unavailable") {
    // A rate limit or a network failure stops the whole host once; any other failure is settled on each ticket of the call.
    if (answer.transient === "rate_limit") backOff(ctx, polled[0]!.ticket, batch.forgeHost, answer);
    else if (answer.transient === "network") waitOutNetworkError(ctx, polled[0]!.ticket, batch.forgeHost, answer.message);
    else {
      const failure = classifyAnswer(answer);
      for (const { ticket } of polled) noteAnswer(ctx, ticket.id, answer.message);
      for (const { ticket } of polled) await readFailed(ctx, ticket, failure);
    }
    return;
  }
  // Answered ones first: a read that worked clears the host's backoff, so a rate limit in the same answer must come after it.
  const answered = (number: number) => answer.pulls.some((each) => each.number === number);
  const missOf = (number: number) => answer.missing.find((each) => each.number === number);
  const limited = polled.filter(({ number }) => missOf(number)?.transient === "rate_limit");
  const offline = polled.filter(({ number }) => missOf(number)?.transient === "network");
  for (const { ticket, number } of [...polled.filter((each) => answered(each.number)), ...polled.filter((each) => !answered(each.number))]) {
    if (limited.some((each) => each.ticket.id === ticket.id) || offline.some((each) => each.ticket.id === ticket.id)) continue;
    const pull = answer.pulls.find((each) => each.number === number);
    const read: PrRead =
      pull === undefined
        ? missedRead(ticket, missOf(number))
        : { outcome: "ok", state: pull.state, meta: { draft: pull.draft, review: pull.review, base: pull.base, mergeable: pull.mergeable ?? null }, feedback: pull.feedback, text: textRead(pull), ...(pull.queue === undefined ? {} : { queue: pull.queue }) };
    await settleRead(ctx, project, repoSettings(spec, ticket.repo), ticket, read, batch.forgeHost);
  }
  // However many pull requests of the one answer GitHub rate-limited, it is one limit: one backoff, one post, the longest wait it named.
  if (limited.length > 0) {
    const misses = limited.map(({ number }) => missOf(number)!);
    const waits = misses.flatMap((each) => (each.retryAfterMs === undefined ? [] : [each.retryAfterMs]));
    backOff(ctx, limited[0]!.ticket, batch.forgeHost, { message: misses[0]!.message, ...(waits.length === 0 ? {} : { retryAfterMs: Math.max(...waits) }) });
  } else if (offline.length > 0) {
    waitOutNetworkError(ctx, offline[0]!.ticket, batch.forgeHost, missOf(offline[0]!.number)!.message);
  }
}

/** A pull request a batch answer left out: gone when GitHub says so, or a failure to wait out like a whole failed read. */
function missedRead(ticket: TicketRow, miss: Extract<HostOutputOf<"prBatch">, { outcome: "ok" }>["missing"][number] | undefined): PrRead {
  if (miss === undefined) return { outcome: "unavailable", message: `Reading the pull request of ${ticket.key} stopped: gh found no pull request at ${ticket.pr_url}.` };
  const { message, ...transient } = miss;
  return { outcome: "unavailable", message: `Reading the pull request of ${ticket.key} stopped: ${message}`, ...(transient.transient === undefined ? {} : { transient: transient.transient }), ...(transient.retryAfterMs === undefined ? {} : { retryAfterMs: transient.retryAfterMs }) };
}

/**
 * Acts on one read of the ticket's pull request: merged completes the ticket, unless it merged into a branch other than
 * the repo's base, closed blocks it, and open follows its feedback and keeps its text up to date (syncPrText). A
 * successful read stores the PrMeta first.
 */
async function settleRead(ctx: EngineCtx, project: ProjectRow, settings: RepoSettings, polled: TicketRow, read: PrRead, host: string | null): Promise<void> {
  const { store } = ctx;
  noteAnswer(ctx, polled.id, read.outcome === "ok" ? null : read.message);
  if (read.outcome === "unavailable") {
    const forge = settings.forge.kind === "gh" ? "GitHub" : (host ?? "the forge");
    if (read.transient === "rate_limit" && host !== null) backOff(ctx, polled, host, read, forge);
    else if (read.transient === "network" && host !== null) waitOutNetworkError(ctx, polled, host, read.message);
    // The push-only forge has no forge host to back off, so even its rate limit waits on the ticket.
    else await readFailed(ctx, polled, classifyAnswer(read));
    return;
  }
  if (host !== null) ctx.forgeBackoffs.delete(host);
  // The answer is about the pull request and attempt that were polled; the human may have blocked and requeued the ticket during the host call.
  const seen = store.ticket(polled.id);
  if (seen === null || !samePullRequest(polled, seen)) return;
  endRetry(ctx, polled.id, "read");
  if (read.meta !== null) store.updateTicket(seen.id, writeSub("pr_meta_json", readMeta(seen, { at: ctx.now(), ...read.meta, state: read.state })));
  const current = store.ticket(seen.id)!;
  const base = read.meta?.base ?? null;
  if (read.state === "MERGED" && settings.forge.kind === "none") {
    const target = `${settings.remote}/${settings.base}`;
    complete(ctx, current.id, { kind: "merge", body: `The branch landed on ${target}.`, data: { outcome: "branch_landed", pushed: target } });
  } else if (read.state === "MERGED" && base !== null && base !== settings.base) {
    await blockMergedElsewhere(ctx, current, settings, base);
  } else if (read.state === "MERGED") {
    complete(ctx, current.id, { kind: "merge", body: "The pull request was merged.", data: { outcome: "pr_merged", url: current.pr_url } });
  } else if (read.state === "CLOSED") {
    await settleClosed(ctx, current, base);
  } else {
    const reviewed = (read.feedback?.items ?? []).filter((item) => item.kind === "review").map((item) => item.author);
    // A pull request Loom publishes is judged on this read's checks, so it is published after its feedback is followed.
    const publishing = publishRule(specOf(store, project)) !== null;
    const undrafted = !publishing && (await followDraft(ctx, project, current.id, read.meta?.draft ?? null, read.meta?.base ?? null));
    await requestReviewers(ctx, project, current.id, { draft: undrafted ? false : (read.meta?.draft ?? null), author: read.feedback?.author || null, reviewed });
    if (read.feedback !== null) await followFeedback(ctx, store.project(project.id)!, store.ticket(current.id)!, read.feedback);
    if (publishing) await followGate(ctx, store.project(project.id)!, current.id);
    if (publishing && (await followDraft(ctx, project, current.id, read.meta?.draft ?? null, read.meta?.base ?? null))) {
      await requestReviewers(ctx, project, current.id, { draft: false, author: read.feedback?.author || null, reviewed });
    }
    await syncPrText(ctx, store.project(project.id)!, current.id, read.text ?? null);
    await followAutoMerge(ctx, project, current.id, { head: read.feedback?.head ?? null, author: read.feedback?.author || null, text: read.text ?? null, items: read.feedback?.items ?? null, ...(read.queue === undefined ? {} : { queue: read.queue }) });
  }
}
