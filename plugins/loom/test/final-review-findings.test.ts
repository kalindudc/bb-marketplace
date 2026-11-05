// Regressions for the review of Loom 0.33.0's final review: each describe names its finding.
import { beforeEach, describe, expect, it } from "vitest";
import { maintainFinalReviews, setAutoMerge } from "../src/auto-merge";
import type { ThreadRow } from "../src/db/store";
import { BRIEF_MAX, FINAL_BOUND, FINAL_ENDED, finalBadge, finalState, finalVerdict } from "../src/final-review";
import type { HostOutput } from "../src/host-contract";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import type { SpawnArgs } from "../src/ports";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { blockTicket, specOf, type EngineCtx } from "../src/workers";
import { makeCtx, reachApproved, seedProject, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: EngineHarness & { db: ReturnType<typeof makeCtx>["db"] };
beforeEach(() => {
  h = makeCtx();
});

const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
const posts = () => h.store.posts(ticket().id);
const dataOf = (outcome: string) => posts().filter((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome === outcome).map((post) => ({ post, data: JSON.parse(post.data_json) as Record<string, any> }));
const merges = () => h.host.callsTo("prMerge");
const spawns = () => (h.bb.callsTo("spawnThread") as Array<[SpawnArgs]>).map(([args]) => args).filter((args) => args.metadata.role === "final-review");
const reviewer = () => h.bb.threads.get(String(JSON.parse(h.store.ticketEvents(ticket().id, [FINAL_BOUND]).at(-1)!.data_json).thread))!;
const poll = async (ctx: EngineCtx = h.ctx, ms = 5 * 60_000) => {
  h.clock.advance(ms);
  await pollPullRequests(ctx, ctx.store.projectBySlug("csv")!);
};
const TEXT = { title: "Add order rows", body: "## Why\nSupport wants CSV exports.", commit_message: "Add the order row mapper" };
const FINAL = (final: Doc = {}) => ({ forge: { kind: "gh", auto_merge: { method: "squash", final_review: final } } });

async function openPr(merge: Doc): Promise<ThreadRow> {
  await seedProject(h, (doc) => void (doc.merge = { strategy: "pr", draft: false, ...merge }));
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, TEXT);
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
  return worker;
}
const approved = (review = "APPROVED") => h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: false, review: review as "APPROVED" });
const verdict = (v: "pass" | "fail", reason = "") => finalVerdict(h.ctx, reviewer().id, { verdict: v, reason });
const files = (...paths: string[]) => paths.map((path) => ({ path, status: "modified" as const, additions: 1, deletions: 1, binary: false, blob: null }));
const listing = (paths: string[], truncated = false): HostOutput<"changedFiles"> => ({ outcome: "ok", base: "b", head: "h", files: files(...paths), truncated });
/** Loom pushes a new head whose tree differs from the approved commit's, as a catch-up with the base does. */
function catchUp(sha: string): void {
  h.host.trees.set(sha, `tree-${sha}`);
  h.host.remoteBranches.set(ticket().pr_branch!, sha);
  h.host.feedback.set(URL, { ...h.host.feedback.get(URL), head: sha });
  h.store.updateTicket(ticket().id, { pushed_sha: sha, pr_checked_at: null });
}

describe("finding 1: the reviewer cannot change Loom's shared checkout unseen", () => {
  it("starts in an empty scratch directory of its own, not the repo's checkout", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    expect(spawns()[0]!.workspace!.path).not.toBe("/repo");
    expect(spawns()[0]!.workspace!.path).toMatch(/^\/data\/final-review\//);
    expect(h.host.callsTo("checkoutPrint")).toEqual([{ repo: "/repo" }]);
  });

  it("holds and posts when the checkout changed while the reviewer ran, and never resets it", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    h.host.prints.set("/repo", "print-after-reviewer-edits");
    verdict("pass");
    await poll(h.ctx, 0);
    await poll();
    expect(merges()).toEqual([]);
    const held = dataOf("final_review_held");
    expect(held).toHaveLength(1);
    expect(held[0]!.data.reason).toBe("checkout");
    expect(held[0]!.post.body).toContain("the checkout /repo changed while it ran");
    expect(held[0]!.post.body).toContain("retry --ticket CSV-1");
    expect(h.host.callsTo("resetHard")).toEqual([]);
    expect(finalBadge(h.store, spec(), ticket())).toMatchObject({ state: "held" });
  });

  it("holds when Loom cannot read the checkout again", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    h.host.prints.set("/repo", new Error("fatal: index file corrupt"));
    verdict("pass");
    await poll(h.ctx, 0);
    expect(merges()).toEqual([]);
    expect(dataOf("final_review_held")[0]!.post.body).toContain("could not read the checkout /repo again: fatal: index file corrupt");
  });

  it("counts a pass only once the reviewer has really stopped, not while it is stopping", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    verdict("pass");
    h.bb.stopConfirms = false;
    await poll(h.ctx, 0);
    await poll();
    expect(merges()).toEqual([]);
    expect(reviewer().status).toBe("stopping");
    expect(h.host.callsTo("checkoutPrint")).toHaveLength(1);
    h.bb.stopConfirms = true;
    reviewer().status = "idle";
    await poll();
    expect(h.host.callsTo("checkoutPrint")).toHaveLength(2);
    expect(merges()).toHaveLength(1);
  });
});

describe("finding 2: a dropped approved change is never called base-only", () => {
  it("shows an approved file that a conflict resolution put back to the base, and says which files only the base brought", async () => {
    await openPr(FINAL());
    approved();
    catchUp("sq2");
    // At the approval the pull request changed a.ts and b.ts; the catch-up resolved a.ts to the base's version.
    h.host.listings.set("origin/main..c1", listing(["src/model/a.ts", "src/export/b.ts"]));
    h.host.listings.set("origin/main..sq2", listing(["src/export/b.ts"]));
    h.host.listings.set("c1..sq2", listing(["src/model/a.ts", "lib/base-1.ts", "lib/base-2.ts"]));
    await poll();
    const brief = spawns()[0]!.detail!;
    expect(brief).toContain("### src/model/a.ts");
    expect(brief).not.toContain("None of the pull request's own files changed");
    expect(brief).toContain("2 other files changed only because the base was merged in");
    expect(brief).not.toContain("THIS BRIEF IS INCOMPLETE");
  });

  it("counts every changed file as the pull request's own, and says so, when a listing fails", async () => {
    await openPr(FINAL());
    approved();
    catchUp("sq2");
    h.host.listings.set("origin/main..c1", { outcome: "missing", message: "fatal: bad object c1" });
    h.host.listings.set("origin/main..sq2", listing(["src/export/b.ts"]));
    h.host.listings.set("c1..sq2", listing(["src/model/a.ts", "lib/base-1.ts"]));
    await poll();
    const brief = spawns()[0]!.detail!;
    expect(brief).toContain("### src/model/a.ts");
    expect(brief).toContain("### lib/base-1.ts");
    expect(brief).not.toContain("changed only because the base was merged in");
    expect(brief).toContain("Loom could not establish which changes since the approval came only from the base");
  });
});

describe("finding 3: a running reviewer is stopped once its pull request is not ready any more", () => {
  it("stops and archives the reviewer when approval becomes pending, and starts no new one while it is", async () => {
    await openPr(FINAL({ timeout_minutes: 2 }));
    approved();
    await poll();
    approved("REVIEW_REQUIRED");
    await poll(h.ctx, 60 * 60_000);
    await poll();
    expect(finalState(h.store, ticket().id, ticket().pushed_sha).open).toBeNull();
    expect(h.bb.callsTo("stop").map(([id]) => id)).toContain(reviewer().id);
    expect(reviewer().archivedAt).not.toBeNull();
    expect(spawns()).toHaveLength(1);
    approved();
    await poll();
    expect(spawns()).toHaveLength(2);
  });

  const stops: Array<[string, () => Promise<void> | void]> = [
    ["the project pauses", () => void h.store.setProjectState(project().id, "paused", "human")],
    ["auto-merge is turned off", () => void setAutoMerge(h.store, project(), "off", null)],
    ["the ticket blocks", () => blockTicket(h.ctx, ticket(), { reason: "Hold it", needs: "", actor: "human" })],
    ["the ticket is cancelled", () => void h.store.setTicketState(ticket().id, "cancelled", "human", {})],
  ];
  it.each(stops)("stops and archives the reviewer when %s, with no read of the pull request", async (_name, stop) => {
    await openPr(FINAL());
    approved();
    await poll();
    await stop();
    await maintainFinalReviews(h.ctx, project().id);
    const ended = h.store.ticketEvents(ticket().id, [FINAL_ENDED]).map((event) => JSON.parse(event.data_json) as { why: string });
    expect(ended.map((each) => each.why)).toEqual(["interrupted"]);
    expect(reviewer().archivedAt).not.toBeNull();
    await maintainFinalReviews(h.ctx, project().id);
    expect(spawns()).toHaveLength(1);
  });

  it("times a reviewer out at its deadline even while no read of the pull request happens", async () => {
    await openPr(FINAL({ timeout_minutes: 2 }));
    approved();
    await poll();
    h.clock.advance(3 * 60_000);
    await maintainFinalReviews(h.ctx, project().id);
    expect(h.store.ticketEvents(ticket().id, [FINAL_ENDED]).map((event) => (JSON.parse(event.data_json) as { why: string }).why)).toEqual(["timeout"]);
    expect(reviewer().archivedAt).not.toBeNull();
  });
});

describe("finding 4: a verdict after the run's deadline is refused", () => {
  it("refuses a late pass, records the timeout, and never merges on it", async () => {
    await openPr(FINAL({ timeout_minutes: 2 }));
    approved();
    await poll();
    h.clock.advance(10 * 60_000);
    expect(() => verdict("pass")).toThrow("ran out of time");
    await poll(h.ctx, 0);
    expect(merges()).toEqual([]);
    expect(finalState(h.store, ticket().id, ticket().pushed_sha).passRun).toBeNull();
    expect(dataOf("final_review_unfinished")[0]!.post.body).toContain("its verdict came after its deadline");
  });
});

describe("finding 5: the brief is bounded, and an incomplete one is no full sanity check", () => {
  it("caps a huge delta, names what it left out with exact counts, and holds its pass for the human's accept", async () => {
    await openPr(FINAL());
    approved();
    catchUp("sq2");
    const pr = Array.from({ length: 100 }, (_, index) => `src/pr/${index}.ts`);
    const base = Array.from({ length: 5000 }, (_, index) => `lib/base/${index}.ts`);
    h.host.listings.set("origin/main..sq2", listing(pr, true));
    h.host.listings.set("origin/main..c1", listing(pr));
    h.host.listings.set("c1..sq2", listing([...pr, ...base], true));
    await poll();
    const brief = spawns()[0]!.detail!;
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX);
    expect(brief.match(/^### /gm)!.length).toBeLessThanOrEqual(12);
    expect(brief).toContain("THIS BRIEF IS INCOMPLETE");
    expect(brief).toContain("5,088 changed files of the pull request's own are not shown in full");
    expect(brief).toContain("- and 5,058 more files");
    verdict("pass");
    await poll(h.ctx, 0);
    expect(merges()).toEqual([]);
    const held = dataOf("final_review_held");
    expect(held[0]!.data.reason).toBe("partial");
    expect(held[0]!.post.body).toContain("accept --ticket CSV-1");
    expect(setAutoMerge(h.store, project(), "accept", ticket())).toContain("Accepted CSV-1's final review");
    await poll();
    expect(merges()).toHaveLength(1);
  });
});
