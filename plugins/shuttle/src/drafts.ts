// AI review drafts: a review thread hands Shuttle its findings, and the user chooses what to post.
import { AdapterError } from "./adapters/adapter";
import type { Finding, PostFinding, ReviewDraft, Severity, Verdict } from "./contract";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { DraftRow, PrRow } from "./db/store";
import { parseKey } from "./keys";
import { fetchPr, lookup, requirePr, shortKey } from "./prs";

export interface DraftInput {
  summary: string;
  verdict: Verdict;
  findings: Array<{ severity: Severity; path: string; line?: number | null; body: string }>;
}

export function draftView(ctx: Ctx, row: DraftRow): ReviewDraft {
  const review = row.review_id !== null ? ctx.store.reviewsOf(row.pr_id).find((r) => r.id === row.review_id) ?? null : null;
  return {
    id: row.id,
    threadId: row.thread_id,
    threadTitle: ctx.store.threadTitle(row.thread_id) ?? "Review thread",
    preset: review?.preset ?? null,
    trigger: review?.trigger ?? null,
    head: row.head,
    at: row.created_at,
    summary: row.summary,
    verdict: row.verdict,
    findings: JSON.parse(row.findings) as Finding[],
  };
}

/** Called by the review thread's shuttle_review_draft tool. */
export async function saveDraft(ctx: Ctx, threadId: string, query: string, input: DraftInput): Promise<{ pr: PrRow; draft: DraftRow }> {
  const pr = await lookup(ctx, query);
  if (pr.mine === 1) throw new ShuttleError(`${shortKey(ctx, pr)} is the user's own PR; drafts are for reviewing other people's`);
  const review = [...ctx.store.reviewsOf(pr.id)].reverse().find((r) => r.thread_id === threadId) ?? null;
  const latest = ctx.store.lastReview(pr.id);
  // A slower, older review must not replace the draft of the one that came after it.
  if (latest && latest.thread_id !== threadId) {
    throw new ShuttleError(`a newer review of ${shortKey(ctx, pr)} runs in \u201c${ctx.store.threadTitle(latest.thread_id) ?? latest.thread_id}\u201d; this thread's draft is out of date`);
  }
  const findings: Finding[] = input.findings.map((f, index) => ({ id: `f${index + 1}`, severity: f.severity, path: f.path, line: f.line ?? null, body: f.body }));
  const draft = ctx.store.addDraft({
    pr_id: pr.id,
    thread_id: threadId,
    review_id: review?.id ?? null,
    head: review?.head ?? pr.head,
    summary: input.summary,
    verdict: input.verdict,
    findings: JSON.stringify(findings),
  });
  ctx.store.setSnooze(pr.id, null, null);
  ctx.store.addEvent("draft", `\u201c${ctx.store.threadTitle(threadId) ?? threadId}\u201d drafted a review of ${shortKey(ctx, pr)}: ${findings.length} finding${findings.length === 1 ? "" : "s"}, nothing posted.`, pr.id, threadId);
  ctx.port.publish();
  return { pr, draft };
}

function refused(ctx: Ctx, pr: PrRow, error: unknown): never {
  if (error instanceof AdapterError) throw new ShuttleError(`${ctx.server(pr.server)?.name ?? pr.server} refused: ${error.message}`);
  throw error;
}

export async function readBack(ctx: Ctx, pr: PrRow): Promise<void> {
  const ref = parseKey(pr.key);
  if (ref) await fetchPr(ctx, ref).catch((error: unknown) => ctx.port.log("warn", `read back ${pr.key}: ${errText(error)}`));
}

export interface SubmitInput {
  verdict: Verdict;
  body: string;
  findings: PostFinding[];
  draftId?: number;
  staleOk?: boolean;
}

const VERDICT_TEXT: Record<Verdict, string> = { comment: "commented on", approve: "approved", changes: "requested changes on" };

/** The PR as its server has it now: a draft is compared with this head, not with the last sync's. */
async function currentHead(ctx: Ctx, pr: PrRow): Promise<PrRow> {
  const ref = parseKey(pr.key);
  if (!ref) return pr;
  try {
    return await fetchPr(ctx, ref);
  } catch (error) {
    throw new ShuttleError(`Could not check ${shortKey(ctx, pr)}'s current head on ${ctx.server(pr.server)?.name ?? pr.server}, so the draft was not posted: ${errText(error)}`);
  }
}

export async function submitReview(ctx: Ctx, key: string, input: SubmitInput): Promise<{ pr: PrRow; placed: number; inBody: number }> {
  let pr = requirePr(ctx, key);
  if (pr.mine === 1 && input.verdict !== "comment") throw new ShuttleError("You can't approve or request changes on your own PR");
  if (!input.body.trim() && !input.findings.length) throw new ShuttleError(input.verdict === "comment" ? "Write something, or pick findings to post" : "Nothing to post");
  const draft = input.draftId !== undefined ? ctx.store.draftById(input.draftId) : null;
  if (input.draftId !== undefined && (!draft || draft.pr_id !== pr.id)) throw new ShuttleError("That draft is not this PR's");
  if (draft && draft.state !== "draft") throw new ShuttleError(`That draft was already ${draft.state}`);
  if (draft) pr = await currentHead(ctx, pr);
  // A draft that does not say which head it read counts as read on an older one.
  const stale = draft !== null && (draft.head === null || pr.head === null || draft.head !== pr.head);
  const read = draft?.head ? ` at ${draft.head.slice(0, 7)}` : "";
  if (stale && input.verdict === "approve") throw new ShuttleError(`${shortKey(ctx, pr)} may have new commits since the review read it${read}; review it again before you approve`);
  if (stale && !input.staleOk) throw new ShuttleError(`${shortKey(ctx, pr)} may have new commits since the review read it${read}; confirm to post its comments on the lines it read`);
  const adapter = ctx.adapter(pr.server);
  if (!adapter.operations().includes("review")) throw new ShuttleError(`${ctx.server(pr.server)?.name ?? pr.server} has no review command, so Shuttle can't post reviews there`);
  let posted: { placed: number; inBody: number };
  try {
    posted = await adapter.review(pr.repo, pr.number, { verdict: input.verdict, body: input.body, head: draft ? draft.head : pr.head, comments: input.findings });
  } catch (error) {
    refused(ctx, pr, error);
  }
  if (draft) ctx.store.setDraftState(draft.id, "posted", input.findings.length);
  // What you reviewed is what the draft read, so new commits after it still bring the PR back.
  ctx.store.addMyReview({ pr_id: pr.id, verdict: input.verdict, head: draft?.head ?? pr.head, findings: input.findings.length });
  ctx.store.setSnooze(pr.id, null, null);
  const comments = input.findings.length ? ` with ${input.findings.length} comment${input.findings.length === 1 ? "" : "s"}` : "";
  ctx.store.addEvent("reviewed", `You ${VERDICT_TEXT[input.verdict]} ${shortKey(ctx, pr)}${comments}.`, pr.id);
  await readBack(ctx, pr);
  ctx.port.publish();
  return { pr: ctx.store.prById(pr.id)!, ...posted };
}

export function setDraftState(ctx: Ctx, key: string, draftId: number, state: "discarded" | "draft"): PrRow {
  const pr = requirePr(ctx, key);
  const draft = ctx.store.draftById(draftId);
  if (!draft || draft.pr_id !== pr.id) throw new ShuttleError("That draft is not this PR's");
  if (draft.state === "posted") throw new ShuttleError("That draft was already posted");
  ctx.store.tx(() => {
    if (state === "draft") {
      const live = ctx.store.liveDraft(pr.id);
      if (live && live.id !== draft.id) ctx.store.setDraftState(live.id, "discarded");
    }
    ctx.store.setDraftState(draft.id, state);
  });
  ctx.port.publish();
  return pr;
}
