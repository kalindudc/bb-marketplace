// Where the publish gate meets the pull request's text: a gate finding fixed only by reviewed text gets a fresh gate run,
// and a draft is never published while the text its reviewers approved still waits to be set.
import { beforeEach, describe, expect, it } from "vitest";
import { submit, settleChecks } from "../src/checks";
import { specOf } from "../src/ctx";
import type { ThreadRow } from "../src/db/store";
import { followDraft } from "../src/drafts";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { applyPrText, askForPrTexts, handInPrText } from "../src/pull-requests";
import { repoSettings } from "../src/repos";
import { followGate } from "../src/review-gate";
import { publishWaits } from "../src/publish";
import { checkWaitOf } from "../src/check-wait";
import { approve, spawnReviewers, settleReviews } from "../src/review";
import { writeSub } from "../src/sub-state";
import { checkOutHead, makeCtx, seedProject, reachApproved, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness;
beforeEach(() => { h = makeCtx(); });
const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
async function queue() {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
}
async function poll() {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
}
async function open(edit: (doc: Doc) => void = () => undefined): Promise<ThreadRow> {
  await seedProject(h, doc => {
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
function passing() {
  h.host.feedback.set(URL, { head: ticket().pushed_sha!, checks: [{ key: "check:build", name: "build", state: "passed", url: null, started: null, startedAt: null, completedAt: null, progress: null, steps: null }] });
}

async function approveCodeFix(worker: ThreadRow): Promise<void> {
  const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
  worktree.dirty = true;
  worktree.changed = ["src/model/rows.ts"];
  submit(h.ctx, worker.thread_id!, "Guarded rows.", { body: "Adds rows and explains the empty export." });
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

describe("publishing and the pull request's text", () => {
  it("reruns the review gate when its finding was fixed only by reviewed PR text", async () => {
    const worker = await open();
    passing();
    h.host.gateRead = { outcome: "ok", state: "done", findings: [{ id: "description", title: "Explain the empty rows", body: "The description must name the fallback.", severity: "medium", path: null, line: null }] };
    await poll();
    await poll();
    expect(ticket().state).toBe("working");
    const pushes = h.host.callsTo("push").length;
    submit(h.ctx, worker.thread_id!, "Explained the fallback.", { body: "Adds rows. Empty rows produce an empty export." });
    await settleChecks(h.ctx);
    expect(ticket().state).toBe("review");
    await spawnReviewers(h.ctx, project(), spec());
    const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
    await approve(h.ctx, reviewer.thread_id!, "The description now explains the fallback.");
    await settleReviews(h.ctx);
    await queue();
    expect(ticket().state).toBe("pr_open");
    expect(h.host.callsTo("push")).toHaveLength(pushes);
    expect(h.host.callsTo("prEdit")).toHaveLength(1);
    h.host.gateRead = { outcome: "ok", state: "done", findings: [] };
    passing();
    await poll();
    await poll();
    expect(h.host.callsTo("prReviewStart")).toHaveLength(2);
    expect(h.host.callsTo("prReady")).toHaveLength(1);
  });

  it("does not publish before an approved text edit waiting after a server error is applied", async () => {
    await open(doc => { doc.merge.forge = { kind: "gh" }; });
    h.host.scripted.prEdit = [{ outcome: "unavailable", message: "HTTP 503", transient: "server" }];
    await applyPrText(h.ctx, spec(), ticket(), { hostId: "host", path: "/repo", bbProjectId: "proj_1", settings: repoSettings(spec(), null) }, { title: "Correct rows", body: "The corrected description." });
    expect(JSON.parse(ticket().pr_applied_json!).want.title).toBe("Correct rows");
    h.store.updateTicket(ticket().id, writeSub("pr_status_json", { at: h.clock.now(), head: ticket().pushed_sha!, passed: 1, failed: 0, pending: 0 }));
    await followDraft(h.ctx, project(), ticket().id, true, "main");
    expect(h.host.callsTo("prReady")).toHaveLength(0);
  });

  it("sets a waiting approved text in the same read before it publishes", async () => {
    await open((doc) => void (doc.merge.forge = { kind: "gh" }));
    h.host.scripted.prEdit = [{ outcome: "unavailable", message: "HTTP 503", transient: "server" }];
    await applyPrText(h.ctx, spec(), ticket(), { hostId: "host", path: "/repo", bbProjectId: "proj_1", settings: repoSettings(spec(), null) }, { title: "Correct rows", body: "The corrected description." });
    h.clock.advance(60 * 60_000);
    passing();
    await poll();
    const order = h.host.calls.map((call) => call.method).filter((method) => method === "prEdit" || method === "prReady");
    expect(order).toEqual(["prEdit", "prEdit", "prReady"]);
  });

  it("holds a draft whose approved text Loom could only post for the human to set, and says so", async () => {
    await open((doc) => void (doc.merge.forge = { kind: "command", open: "forge open", state: "forge state", feedback: "forge feedback", ready: "forge ready" }));
    await applyPrText(h.ctx, spec(), ticket(), { hostId: "host", path: "/repo", bbProjectId: "proj_1", settings: repoSettings(spec(), null) }, { title: "Correct rows", body: "The corrected description." });
    expect(JSON.parse(ticket().pr_applied_json!)).toMatchObject({ byHand: true });
    h.store.updateTicket(ticket().id, writeSub("pr_status_json", { at: h.clock.now(), head: ticket().pushed_sha!, passed: 1, failed: 0, pending: 0 }));
    await followDraft(h.ctx, project(), ticket().id, true, "main");
    expect(h.host.callsTo("prReady")).toEqual([]);
    expect(publishWaits(h.store, spec(), ticket(), h.clock.now(), checkWaitOf({}))).toEqual(["the title and description its reviewers approved wait for you to set them by hand; set them, then mark it ready on the forge"]);
  });

  describe("the review gate while approved text waits", () => {
    it("does not run the code fix gate on old text while its approved edit waits", async () => {
    const worker = await open();
    passing();
    h.host.gateRead = { outcome: "ok", state: "done", findings: [{ id: "rows", title: "Guard the rows", body: "Guard the rows and explain them.", severity: "medium", path: null, line: null }] };
    await poll();
    await poll();
    expect(ticket().state).toBe("working");
    h.host.scripted.prEdit = [{ outcome: "unavailable", message: "HTTP 503", transient: "server" }];
    await approveCodeFix(worker);
    expect(ticket().state).toBe("pr_open");
    expect(JSON.parse(ticket().pr_applied_json!).want).toBeDefined();
    expect(h.host.callsTo("prReviewStart")).toHaveLength(1);
    await followGate(h.ctx, project(), ticket().id);
    expect(h.host.callsTo("prReviewStart")).toHaveLength(1);
    // Once the edit lands, the gate starts once, for the code and the text together.
    h.clock.advance(60 * 60_000);
    await poll();
    expect(JSON.parse(ticket().pr_applied_json!).want).toBeUndefined();
    await poll();
    expect(h.host.callsTo("prReviewStart")).toHaveLength(2);
  });
    it("does not start the gate while approved text still waits to be applied", async () => {
    await open();
    h.host.scripted.prEdit = [{ outcome: "unavailable", message: "HTTP 503", transient: "server" }];
    await applyPrText(h.ctx, spec(), ticket(), { hostId: "host", path: "/repo", bbProjectId: "proj_1", settings: repoSettings(spec(), null) }, { title: "Correct rows", body: "The corrected description." });
    expect(JSON.parse(ticket().pr_applied_json!).want.title).toBe("Correct rows");
    await followGate(h.ctx, project(), ticket().id);
    expect(h.host.callsTo("prReviewStart")).toHaveLength(0);
  });

    it("does not start the gate while approved text requires a by-hand edit", async () => {
    await open(doc => { doc.merge.forge = { kind: "command", open: "forge open", state: "forge state", feedback: "forge feedback", ready: "forge ready", review_start: "review-bot start", review_read: "review-bot read" }; });
    await applyPrText(h.ctx, spec(), ticket(), { hostId: "host", path: "/repo", bbProjectId: "proj_1", settings: repoSettings(spec(), null) }, { title: "Correct rows", body: "The corrected description." });
    expect(JSON.parse(ticket().pr_applied_json!).byHand).toBe(true);
    await followGate(h.ctx, project(), ticket().id);
    expect(h.host.callsTo("prReviewStart")).toHaveLength(0);
  });

  });
});
