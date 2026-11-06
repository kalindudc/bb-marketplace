// The review gate: an outside review that runs on a draft before Loom publishes it. review_start runs once for each push
// that changed the ticket's own work, review_read is polled for that commit, findings come back to the worker as a fix
// round, and a failed or timed-out gate holds the publish without pausing the project.
import { beforeEach, describe, expect, it } from "vitest";
import { specOf } from "../src/ctx";
import { readBehind } from "../src/fresh";
import type { HostOutput } from "../src/host-contract";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { GATE_DONE, GATE_STARTED } from "../src/publish";
import { boardCards } from "../src/rpc";
import { parseSpec } from "../src/spec";
import { approve, settleReviews, spawnReviewers } from "../src/review";
import { settleChecks, submit } from "../src/checks";
import { checkOutHead, makeCtx, reachApproved, seedProject, specToml, ticketOf, type Doc, type EngineHarness } from "./helpers";
import type { ThreadRow } from "../src/db/store";

type Read = Extract<HostOutput<"prReviewRead">, { outcome: "ok" }>;
const URL = "https://github.com/acme/shop/pull/1";
const GATE = { review_start: "review-bot start", review_read: "review-bot read" };
const finding = (id: string, title: string): Read["findings"][number] => ({ id, title, body: `${title}, because the rows can be empty.`, path: "src/model/rows.ts", line: 12, severity: "medium" });

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
const card = () => boardCards(h.store.tickets(project().id), h.store.threadsForProject(project().id), spec(), h.store, h.clock.now()).find((each) => each.key === "CSV-1")!;
const starts = () => h.host.callsTo("prReviewStart");
const reads = () => h.host.callsTo("prReviewRead");
const readies = () => h.host.callsTo("prReady");
const events = (kind: string) => h.store.ticketEvents(ticket().id, [kind]).map((event) => JSON.parse(event.data_json) as Record<string, unknown>);
const posts = (outcome: string) => h.store.posts(ticket().id).filter((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome === outcome);
const poll = async (minutes = 5) => {
  h.clock.advance(minutes * 60_000);
  await pollPullRequests(h.ctx, project());
};
const queue = async () => {
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
};
const gateSays = (read: Partial<Read>) => void (h.host.gateRead = { outcome: "ok", state: "done", findings: [], ...read });
const passing = () => h.host.feedback.set(URL, { head: ticket().pushed_sha!, checks: [{ key: "check:build", name: "build", state: "passed", url: null, started: null, startedAt: null, completedAt: null, progress: null, steps: null }] });

async function openPr(edit: (doc: Doc) => void = () => undefined): Promise<ThreadRow> {
  await seedProject(h, (doc) => {
    doc.merge = { strategy: "pr", publish: {}, refresh_behind: 5000, forge: { kind: "gh", ...GATE, reviewers: [{ users: ["dana"] }] } };
    edit(doc);
  });
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { title: "Add order rows", body: "Adds the rows.", commit_message: "Add the order rows" });
  await queue();
  expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL });
  return worker;
}

/** The worker fixes what the round sent, the checks and a reviewer pass it, and Loom pushes it. */
async function fix(worker: ThreadRow): Promise<void> {
  const worktree = h.host.worktree(`/wt/${worker.environment_id}`);
  worktree.dirty = true;
  worktree.changed = ["src/model/rows.ts"];
  submit(h.ctx, worker.thread_id!, "Guarded the empty rows.");
  await settleChecks(h.ctx);
  await spawnReviewers(h.ctx, project(), spec());
  const reviewer = h.store.threads({ ticketId: ticket().id, role: "reviewer" }).at(-1)!;
  checkOutHead(h, reviewer);
  await approve(h.ctx, reviewer.thread_id!, "The fix holds.");
  await settleReviews(h.ctx);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, { commit_message: "Guard the empty rows" });
  await queue();
  expect(ticket().state).toBe("pr_open");
}

describe("the review gate in the spec", () => {
  it("takes review_start and review_read together, with review_rounds, and warns that it runs only with merge.publish", () => {
    const parsed = parseSpec(specToml((doc) => (doc.merge = { strategy: "pr", publish: {}, forge: { kind: "gh", ...GATE, review_rounds: 2 } })));
    expect(parsed.errors).toEqual([]);
    expect(parseSpec(specToml((doc) => (doc.merge = { strategy: "pr", forge: { kind: "gh", review_start: "x" } }))).errors).toEqual([expect.stringContaining("merge.forge.review_read: is required with review_start")]);
    expect(parseSpec(specToml((doc) => (doc.merge = { strategy: "pr", forge: { kind: "gh", ...GATE } }))).warnings).toEqual([expect.stringContaining("merge.forge.review_start: the review gate runs only on drafts Loom publishes, and this spec has no merge.publish")]);
  });
});

describe("a review gate on a draft", () => {
  it("starts once for the commit Loom pushed, holds the publish while it runs, and sends its findings to the worker as a fix round", async () => {
    const worker = await openPr();
    passing();
    await poll();
    const sha = ticket().pushed_sha!;
    expect(starts()).toEqual([{ repo: "/repo", url: URL, sha, head: ticket().pr_branch, base: "main", command: "review-bot start" }]);
    expect(events(GATE_STARTED)).toEqual([{ url: URL, sha, own: sha, round: 0 }]);
    expect(reads()).toEqual([]);
    expect(card().publishWait).toBe(`its review gate is still running on ${sha.slice(0, 12)}`);
    await poll();
    expect(reads().at(-1)).toEqual({ repo: "/repo", url: URL, sha, command: "review-bot read" });
    expect(readies()).toEqual([]);

    gateSays({ findings: [finding("f1", "Guard empty rows")] });
    await poll();
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
    const message = h.bb.sent(worker.thread_id!).at(-1)!;
    expect(message).toContain("Finding from the review gate (medium) on src/model/rows.ts:12: Guard empty rows");
    expect(message).toContain("there is no thread to reply to");
    expect(events(GATE_DONE)).toEqual([{ url: URL, sha, own: sha, state: "done", findings: [{ id: "f1", title: "Guard empty rows", severity: "medium" }], sent: 1 }]);
    expect(starts()).toHaveLength(1);
    expect(readies()).toEqual([]);

    await fix(worker);
    gateSays({ findings: [] });
    passing();
    await poll();
    expect(starts()).toHaveLength(2);
    expect(starts().at(-1)!.sha).toBe(ticket().pushed_sha);
    await poll();
    expect(readies()).toHaveLength(1);
    expect(h.host.callsTo("prRequestReview")).toHaveLength(1);
  });

  it("does not start again for a refresh that only brought in the base's commits, and its clean result still stands", async () => {
    await openPr();
    gateSays({ findings: [] });
    await poll();
    await poll();
    expect(starts()).toHaveLength(1);
    // A draft whose checks still run: a refresh happens before it is published.
    h.host.feedback.set(URL, { head: ticket().pushed_sha!, checks: [{ key: "check:build", name: "build", state: "pending", url: null, started: null, startedAt: null, completedAt: null, progress: null, steps: null }] });
    await poll();
    h.host.remoteBase = "base001";
    h.host.behind.set(ticket().pushed_sha!, 9_000);
    await readBehind(h.ctx, project(), spec());
    await queue();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 0, pushed_sha: "sq2" });
    passing();
    await poll();
    expect(starts()).toHaveLength(1);
    expect(readies()).toHaveLength(1);
  });

  it("holds the publish when the gate fails, and says so once, without pausing the project", async () => {
    await openPr();
    passing();
    gateSays({ state: "failed", findings: [], message: "The review bot could not check out the branch." });
    await poll();
    await poll();
    await poll();
    expect(readies()).toEqual([]);
    expect(project().state).toBe("running");
    expect(posts("gate_failed")).toHaveLength(1);
    expect(posts("gate_failed")[0]!.body).toContain("The review bot could not check out the branch.");
    expect(card().publishWait).toContain("its review gate failed");
  });

  it("holds the publish when the gate does not finish in time", async () => {
    await openPr();
    passing();
    await poll();
    await poll(95);
    expect(posts("gate_failed")).toHaveLength(1);
    expect(posts("gate_failed")[0]!.body).toContain("did not finish within 90 minutes");
    expect(project().state).toBe("running");
    expect(readies()).toEqual([]);
  });

  it("stops sending findings after review_rounds gate rounds, and holds the publish for the human", async () => {
    const worker = await openPr((doc) => (doc.merge.forge.review_rounds = 1));
    gateSays({ findings: [finding("f1", "Guard empty rows")] });
    await poll();
    await poll();
    expect(ticket().state).toBe("working");
    await fix(worker);
    gateSays({ findings: [finding("f2", "Name the column")] });
    await poll();
    await poll();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 1 });
    expect(posts("gate_capped")).toHaveLength(1);
    expect(card().publishWait).toContain("its review gate still has findings after 1 round");
  });

  it("keeps the draft while a finding it sent stays on the next head, and sends it again as a counted fix round", async () => {
    const worker = await openPr();
    passing();
    gateSays({ findings: [finding("f1", "Guard empty rows")] });
    await poll();
    await poll();
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 1 });
    await fix(worker);
    passing();
    await poll();
    await poll();
    expect(readies()).toEqual([]);
    expect(ticket()).toMatchObject({ state: "working", pr_rounds: 2 });
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("Finding from the review gate (medium) on src/model/rows.ts:12: Guard empty rows");
    expect(events(GATE_DONE).map((event) => event.sent)).toEqual([1, 1]);
  });

  it("is clean only when the gate lists no finding for the head", async () => {
    await openPr();
    passing();
    gateSays({ findings: [finding("f1", "Guard empty rows"), finding("f1", "Guard empty rows")] });
    await poll();
    await poll();
    // The same finding twice in one answer is sent once.
    expect(JSON.parse(h.store.posts(ticket().id).filter((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome === "pr_feedback").at(-1)!.data_json).items).toHaveLength(1);
  });

  it("holds with one post when a finding survives the last gate round the cap allows", async () => {
    const worker = await openPr((doc) => (doc.merge.forge.review_rounds = 1));
    passing();
    gateSays({ findings: [finding("f1", "Guard empty rows")] });
    await poll();
    await poll();
    await fix(worker);
    passing();
    await poll();
    await poll();
    await poll();
    expect(ticket()).toMatchObject({ state: "pr_open", pr_rounds: 1 });
    expect(readies()).toEqual([]);
    expect(posts("gate_capped")).toHaveLength(1);
    expect(posts("gate_capped")[0]!.body).toContain("Guard empty rows");
    expect(card().publishWait).toContain("its review gate still has findings after 1 round");
  });

  it("runs a start once even when its answer is lost", async () => {
    await openPr();
    h.host.lost.prReviewStart = [new Error("socket hang up")];
    await poll();
    await poll();
    expect(starts()).toHaveLength(1);
  });

  it("does not run without merge.publish", async () => {
    await openPr((doc) => void delete doc.merge.publish);
    await poll();
    expect(starts()).toEqual([]);
  });
});
