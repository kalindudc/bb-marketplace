// A forge call the forge gate held sent nothing, so nothing counts it as attempted: a merge it held is asked for again,
// a review request it held uses no try. A forge's broken answer pauses the project with the fix on every forge path.
import { expect, it } from "vitest";
import { attemptState, followAutoMerge } from "../src/auto-merge";
import { specOf } from "../src/ctx";
import { followDraft } from "../src/drafts";
import { runMergeQueue, settleMerges } from "../src/merge";
import { requestReviewers } from "../src/review-requests";
import { makeCtx, reachApproved, seedProject, ticketOf, type EngineHarness } from "./helpers";

type Forge = Record<string, unknown>;
const MINUTE = 60_000;

async function opened(forge: Forge, more: Record<string, unknown> = {}): Promise<EngineHarness> {
  const h = makeCtx();
  await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", draft: false, forge, ...more }));
  await reachApproved(h);
  const project = h.store.projectBySlug("csv")!;
  await runMergeQueue(h.ctx, project, specOf(h.store, project));
  await settleMerges(h.ctx);
  const ticket = ticketOf(h, "CSV-1");
  h.host.prMeta.set(ticket.pr_url!, { ...h.host.prMeta.get(ticket.pr_url!), draft: false, review: "APPROVED" });
  h.clock.advance(5 * MINUTE);
  return h;
}
const project = (h: EngineHarness) => h.store.projectBySlug("csv")!;
const ticket = (h: EngineHarness) => ticketOf(h, "CSV-1");
const backOff = (h: EngineHarness) => h.ctx.forgeBackoffs.set("github.com", { until: h.clock.t + MINUTE, delayMs: MINUTE, message: "HTTP 429" });
const read = (h: EngineHarness) => ({ head: ticket(h).pushed_sha, author: "alice", text: null, items: [] });
/** What a poll stored for a ready pull request, and the gate taught its forge host by a batch read. */
async function ready(h: EngineHarness): Promise<void> {
  const t = ticket(h);
  await h.ctx.host.call("host_1", "prBatch", { repo: "/repo", host: "github.com", owner: "acme", name: "shop", numbers: [1], feedback: true });
  h.store.updateTicket(t.id, { pr_meta_json: JSON.stringify({ at: h.clock.t, state: "OPEN", draft: false, review: "APPROVED", base: "main", mergeable: true }), pr_status_json: JSON.stringify({ at: h.clock.t, head: t.pushed_sha, passed: 1, failed: 0, pending: 0 }) });
}

it.each([
  ["a comment merge", { kind: "gh", auto_merge: { mode: "auto", method: "comment", comment: "/merge" } }],
  ["a squash merge", { kind: "gh", auto_merge: { mode: "auto", method: "squash" } }],
])("asks for %s again once the backoff that held it ends, and counts no attempt for the held one", async (_name, forge) => {
  const h = await opened(forge);
  await ready(h);
  backOff(h);
  await followAutoMerge(h.ctx, project(h), ticket(h).id, read(h));
  expect(h.host.callsTo("prMerge")).toHaveLength(0);
  expect(attemptState(h.store, ticket(h).id)).toMatchObject({ used: 0, open: null });
  h.clock.advance(MINUTE);
  await followAutoMerge(h.ctx, project(h), ticket(h).id, read(h));
  expect(h.host.callsTo("prMerge")).toHaveLength(1);
});

it("uses no review-request try for a request the gate held, and asks once the backoff ends", async () => {
  const h = await opened({ kind: "command", open: "o", state: "s", feedback: "f", request_reviews: "ask", reviewers: [{ users: ["bob"] }] });
  backOff(h);
  for (let i = 0; i < 3; i++) await requestReviewers(h.ctx, project(h), ticket(h).id, { draft: false, author: "alice", reviewed: [] });
  expect(h.host.callsTo("prRequestReview")).toHaveLength(0);
  h.clock.advance(MINUTE);
  await requestReviewers(h.ctx, project(h), ticket(h).id, { draft: false, author: "alice", reviewed: [] });
  expect(h.host.callsTo("prRequestReview")).toHaveLength(1);
});

it("pauses the project with the fix when the forge's merge answer breaks the host contract", async () => {
  const h = await opened({ kind: "gh", auto_merge: { mode: "auto", method: "squash" } });
  await ready(h);
  h.host.errors.prMerge = Object.assign(new Error("bad forge output"), { code: "invalid_output" });
  await followAutoMerge(h.ctx, project(h), ticket(h).id, read(h));
  expect(project(h)).toMatchObject({ state: "paused", system_reason: expect.stringMatching(/bad forge output\. Fix the forge command in the spec/u) });
  expect(ticket(h).state).toBe("pr_open");
});

it("pauses the project with the fix when marking a draft ready gets a broken answer, and marks it at a later read once it runs", async () => {
  const h = makeCtx();
  await seedProject(h, (doc) => (doc.merge = { strategy: "pr", describe: "loom", draft: true, forge: { kind: "gh" } }));
  await reachApproved(h);
  h.host.errors.prReady = Object.assign(new Error("bad forge output"), { code: "invalid_output" });
  await runMergeQueue(h.ctx, project(h), specOf(h.store, project(h)));
  await settleMerges(h.ctx);
  expect(project(h)).toMatchObject({ state: "paused", system_reason: expect.stringMatching(/bad forge output\. Fix the forge command in the spec/u) });
  expect(h.store.posts(ticket(h).id).some((post) => post.body.includes("could not mark"))).toBe(false);

  h.host.errors.prReady = null;
  h.store.setProjectState(project(h).id, "running", "human");
  expect(await followDraft(h.ctx, project(h), ticket(h).id, true, "main")).toBe(true);
});

it("pauses the project with the fix when asking for reviews gets a broken answer", async () => {
  const h = await opened({ kind: "command", open: "o", state: "s", feedback: "f", request_reviews: "ask", reviewers: [{ users: ["bob"] }] });
  h.host.errors.prRequestReview = Object.assign(new Error("bad forge output"), { code: "invalid_output" });
  await requestReviewers(h.ctx, project(h), ticket(h).id, { draft: false, author: "alice", reviewed: [] });
  expect(project(h)).toMatchObject({ state: "paused", system_reason: expect.stringMatching(/bad forge output\. Fix the forge command in the spec/u) });
});
