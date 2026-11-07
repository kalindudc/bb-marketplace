// Forge failures on paths the forge gate does not see the end of: a review request after a fix push, and a review gate
// start the forge refused for a while.
import { tmpdir } from "node:os";
import { beforeEach, expect, it } from "vitest";
import { settleChecks, submit } from "../src/checks";
import { specOf } from "../src/ctx";
import type { ThreadRow } from "../src/db/store";
import { prReviewStart } from "../src/host/ops";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { followGate } from "../src/review-gate";
import { checkOutHead, makeCtx, reachApproved, seedProject, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});
const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};

async function open(edit: (doc: Doc) => void = () => undefined): Promise<ThreadRow> {
  await seedProject(h, (doc) => {
    doc.merge = { strategy: "pr", publish: {}, forge: { kind: "gh", review_start: "review-bot start", review_read: "review-bot read" } };
    edit(doc);
  });
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { title: "Add rows", body: "Adds rows.", commit_message: "Add rows" });
  await queue();
  expect(ticket().state).toBe("pr_open");
  return worker;
}

async function approveCodeFix(worker: ThreadRow): Promise<void> {
  const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
  worktree.dirty = true;
  worktree.changed = ["src/model/rows.ts"];
  submit(h.ctx, worker.thread_id!, "Guarded rows.");
  await settleChecks(h.ctx);
  await spawnReviewers(h.ctx, project(), spec());
  const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
  checkOutHead(h, reviewer);
  await approve(h.ctx, reviewer.thread_id!, "The fix holds.");
  await settleReviews(h.ctx);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { commit_message: "Guard rows" });
  await queue();
}

const review = { key: "review:alice:1", kind: "review" as const, author: "alice", bot: false, body: "Guard the rows.", url: null, state: "changes_requested", path: null, line: null };

it("pauses the project with the fix when asking for reviews again after a fix push gets a broken answer, and keeps the push", async () => {
  const worker = await open();
  h.host.feedback.set(URL, { items: [review] });
  await poll();
  expect(ticket().state).toBe("working");
  h.host.scripted.prRequestReview = [{ outcome: "unavailable", message: "The forge command must print a JSON object on its last line" }];
  await approveCodeFix(worker);
  expect(h.host.callsTo("prRequestReview")).toHaveLength(1);
  expect(project()).toMatchObject({ state: "paused", system_reason: expect.stringMatching(/must print a JSON object.*Fix the forge command/su) });
  expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 1 });
  expect(ticket().pushed_sha).not.toBe("sq1");
});

it("keeps an ordinary failure to ask for reviews again on the ticket, and never asks again", async () => {
  const worker = await open();
  h.host.feedback.set(URL, { items: [review] });
  await poll();
  h.host.scripted.prRequestReview = [{ outcome: "unavailable", message: "HTTP 422: alice cannot review" }];
  await approveCodeFix(worker);
  await poll();
  expect(project().state).toBe("running");
  expect(ticket().state).toBe("pr_open");
  expect(h.host.callsTo("prRequestReview")).toHaveLength(1);
});

it("waits on the forge host's backoff after a review_start server failure that named no delay, and starts again only after it", async () => {
  await open();
  const start = await prReviewStart({ repo: tmpdir(), url: URL, sha: ticket().pushed_sha!, head: "work", base: "main", command: "printf 'HTTP 503 Service Unavailable\\n'; exit 1" });
  expect(start).toMatchObject({ outcome: "failed", transient: "server" });
  h.host.scripted.prReviewStart = [start];
  await followGate(h.ctx, project(), ticket().id);
  const backoff = h.ctx.forgeBackoffs.get("github.com")!;
  expect(backoff).toMatchObject({ until: expect.any(Number) });
  expect(backoff.until).toBeGreaterThan(h.clock.t);
  // A read that works does not end the start's wait early.
  await h.ctx.host.call("host_1", "prReviewRead", { repo: "/repo", url: URL, sha: ticket().pushed_sha!, command: "read" });
  await followGate(h.ctx, project(), ticket().id);
  expect(h.host.callsTo("prReviewStart")).toHaveLength(1);
  h.clock.advance(backoff.until - h.clock.t);
  await followGate(h.ctx, project(), ticket().id);
  expect(h.host.callsTo("prReviewStart")).toHaveLength(2);
});
