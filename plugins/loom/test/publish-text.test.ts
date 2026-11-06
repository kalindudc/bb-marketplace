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
import { approve, spawnReviewers, settleReviews } from "../src/review";
import { writeSub } from "../src/sub-state";
import { makeCtx, seedProject, reachApproved, ticketOf, type Doc, type EngineHarness } from "./helpers";

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

});
