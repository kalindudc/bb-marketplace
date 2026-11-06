import { beforeEach, describe, expect, it } from "vitest";
import { setAutoMerge } from "../src/auto-merge";
import { Store, type ThreadRow } from "../src/db/store";
import { FINAL_BOUND, FINAL_STARTED, finalBadge, finalBrief, finalState, finalVerdict, FINAL_TRIES } from "../src/final-review";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { mergeOrderOf } from "../src/merge-order";
import { computeMetrics } from "../src/metrics";
import type { SpawnArgs } from "../src/ports";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { parseSpec, specHash } from "../src/spec";
import { specOf, type EngineCtx } from "../src/ctx";
import { makeCtx, reachApproved, seedProject, specToml, ticketOf, type Doc, type EngineHarness } from "./helpers";

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
const FINAL = (final: Doc = {}, more: Doc = {}) => ({ forge: { kind: "gh", auto_merge: { mode: "auto", method: "squash", final_review: final, ...more } } });

async function openPr(merge: Doc, edit?: (doc: Doc) => void): Promise<ThreadRow> {
  await seedProject(h, (doc) => {
    doc.merge = { strategy: "pr", draft: false, ...merge };
    edit?.(doc);
  });
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, TEXT);
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
  expect(ticket().state).toBe("pr_open");
  return worker;
}
const approved = () => h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: false, review: "APPROVED" });
/** The final reviewer's thread calls its tool, as the agent would. */
const verdict = (v: "pass" | "fail", reason = "", fixable?: boolean) => finalVerdict(h.ctx, reviewer().id, { verdict: v, reason, ...(fixable === undefined ? {} : { fixable }) });
/** Loom pushes a new commit to the open pull request, as a catch-up does. */
const push = (sha: string) => {
  h.host.remoteBranches.set(ticket().pr_branch!, sha);
  h.host.feedback.set(URL, { ...h.host.feedback.get(URL), head: sha });
  h.store.updateTicket(ticket().id, { pushed_sha: sha, pr_checked_at: null });
};

describe("final review in the spec", () => {
  it("hashes specs without it as before, auto_merge ones included, and takes an empty table or its keys", () => {
    const plain = parseSpec(specToml((doc) => void (doc.merge = { strategy: "pr", forge: { kind: "gh", auto_merge: { method: "squash" } } })));
    expect(plain.spec!.merge.forge!.auto_merge).toEqual({ method: "squash" });
    // The 0.32.0 hashes, pinned in auto-merge.test.ts, still hold; and a spec that adds final_review hashes differently.
    const withFinal = parseSpec(specToml((doc) => void (doc.merge = { strategy: "pr", ...FINAL() })));
    expect(specHash(plain.spec!)).not.toBe(specHash(withFinal.spec!));
    for (const final of [{}, { model: "small", reasoning: "minimal", timeout_minutes: 5 }, { provider: "codex" }]) {
      const parsed = parseSpec(specToml((doc) => void (doc.merge = { strategy: "pr", ...FINAL(final) })));
      expect(parsed.errors, JSON.stringify(final)).toEqual([]);
      expect(parsed.spec!.merge.forge!.auto_merge!.final_review).toEqual(final);
    }
    const bad = parseSpec(specToml((doc) => void (doc.merge = { strategy: "pr", ...FINAL({ timeout_minutes: 0, effort: "x" }) }))).errors.join("\n");
    expect(bad).toContain("final_review.timeout_minutes");
    expect(bad).toContain('unknown key "effort"');
  });
});

describe("the final review before a merge", () => {
  it("runs once every other hold cleared, in the project's checkout with no worktree or machine, at low reasoning", async () => {
    await openPr(FINAL());
    await poll();
    expect(spawns()).toEqual([]);
    approved();
    await poll();
    expect(spawns()).toHaveLength(1);
    const args = spawns()[0]!;
    expect(args.workspace!.path).toMatch(/^\/data\/final-review\/loom-[0-9a-f]{24}$/);
    expect(args).toMatchObject({ hostId: "host_1", reasoningLevel: "low", providerId: "codex", model: "gpt", title: "CSV-1 · final review" });
    expect(args.environment).toBeUndefined();
    expect(args.detail).toContain("Nothing: the head has the exact tree Loom's reviewers approved");
    expect(args.detail).toContain("check the text only");
    expect(args.detail).toContain("WHEN an order is mapped THE SYSTEM SHALL return one row");
    expect(merges()).toEqual([]);
  });

  it("never merges without a pass for the current head, and merges right after one", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    await poll();
    expect(merges()).toEqual([]);
    verdict("pass");
    expect(ticket().pr_checked_at).toBeNull();
    await poll(h.ctx, 0);
    expect(merges()).toEqual([expect.objectContaining({ sha: ticket().pushed_sha })]);
    expect(spawns()).toHaveLength(1);
    expect(reviewer().archivedAt).not.toBeNull();
  });

  it("checks the head again after the review and right before it asks to merge", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    verdict("pass");
    const real = h.bb.projectCheckout.bind(h.bb);
    let lookups = 0;
    h.bb.projectCheckout = async (id: string, host: string) => {
      lookups += 1;
      // The second lookup is the merge's own, after the read: Loom pushes a new commit meanwhile.
      if (lookups === 2) h.store.updateTicket(ticket().id, { pushed_sha: "sq-new" });
      return real(id, host);
    };
    await poll(h.ctx, 0);
    expect(lookups).toBeGreaterThanOrEqual(2);
    expect(merges()).toEqual([]);
  });

  it("never merges a new head on the pass of the one before it", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    verdict("pass");
    push("sq-new");
    await poll(h.ctx, 0);
    expect(merges()).toEqual([]);
    // The push came before Loom counted the pass, so it never counts; and the new head has none.
    expect(finalState(h.store, ticket().id, "sq1").passRun).not.toBeNull();
    expect(finalState(h.store, ticket().id, "sq1").passed).toBeNull();
    expect(finalState(h.store, ticket().id, "sq-new").passed).toBeNull();
  });

  it("starts a new review for the new head after a pass for the old one", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    verdict("pass");
    push("sq-new");
    h.host.trees.set("sq-new", "tree-new");
    await poll();
    expect(merges()).toEqual([]);
    expect(spawns()).toHaveLength(2);
    expect(spawns()[1]!.detail).toContain("From the approved commit");
    verdict("pass");
    await poll(h.ctx, 0);
    expect(merges()).toEqual([expect.objectContaining({ sha: "sq-new" })]);
  });

  it("after a restart neither runs a second review for the head nor merges without its verdict", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    const restarted: EngineCtx = { ...h.ctx, store: new Store(h.db, h.clock.now) };
    await poll(restarted);
    expect(spawns()).toHaveLength(1);
    expect(merges()).toEqual([]);
    finalVerdict(restarted, reviewer().id, { verdict: "pass", reason: "" });
    await poll(restarted, 0);
    expect(merges()).toHaveLength(1);
  });

  it("after a restart between recording a run and its spawn, finds the thread by its token, or ends the run and tries again", async () => {
    await openPr(FINAL());
    approved();
    h.store.event(project().id, ticket().id, FINAL_STARTED, "loom", { sha: ticket().pushed_sha, url: URL, token: "tok-lost" });
    const restarted: EngineCtx = { ...h.ctx, store: new Store(h.db, h.clock.now) };
    await poll(restarted);
    expect(spawns()).toEqual([]);
    expect(h.bb.callsTo("findSpawnedThread")).toEqual([["tok-lost"]]);
    expect(dataOf("final_review_unfinished")[0]!.post.body).toContain("Loom restarted before the reviewer started");
    await poll(restarted);
    expect(spawns()).toHaveLength(1);
    expect(merges()).toEqual([]);
  });

  const stops: Array<[string, () => void]> = [
    ["the human pauses the project", () => h.store.setProjectState(project().id, "paused", "human")],
    ["the human turns auto-merge off", () => void setAutoMerge(h.store, project(), "off", null)],
    ["the human turns it off for the ticket", () => void setAutoMerge(h.store, project(), "off", ticket())],
  ];
  it.each(stops)("does not merge when %s during the review", async (_name, stop) => {
    await openPr(FINAL());
    approved();
    await poll();
    stop();
    verdict("pass");
    await poll(h.ctx, 0);
    await poll();
    expect(merges()).toEqual([]);
  });

  it("does not start a review when the human pauses while Loom reads the delta", async () => {
    await openPr(FINAL());
    approved();
    const real = h.host.call.bind(h.host);
    h.host.call = (async (hostId: string, method: string, input: unknown) => {
      if (method === "changedFiles") h.store.setProjectState(project().id, "paused", "human");
      return real(hostId, method as never, input as never);
    }) as typeof h.host.call;
    await poll();
    expect(spawns()).toEqual([]);
    expect(h.store.ticketEvents(ticket().id, [FINAL_STARTED])).toEqual([]);
  });

  it("does not merge after a timeout; it tries again later, and holds after its tries are used up", async () => {
    await openPr(FINAL({ timeout_minutes: 2 }));
    approved();
    await poll();
    // Each run times out at the next read; the next one waits 5, then 10 minutes.
    for (let reads = 0; reads < 12; reads += 1) {
      await poll();
      expect(merges()).toEqual([]);
    }
    expect(spawns()).toHaveLength(FINAL_TRIES);
    expect(dataOf("final_review_unfinished").every(({ data }) => data.why === "timeout")).toBe(true);
    const held = dataOf("final_review_held");
    expect(held).toHaveLength(1);
    expect(held[0]!.post.body).toContain("bb loom auto-merge csv retry --ticket CSV-1");
    expect(merges()).toEqual([]);
    expect(finalBadge(h.store, spec(), ticket())).toMatchObject({ state: "held" });
    expect(setAutoMerge(h.store, project(), "retry", ticket())).toContain("final review again");
    await poll();
    expect(spawns()).toHaveLength(FINAL_TRIES + 1);
  });

  it("does not merge when the reviewer fails to start; it tries again after the wait", async () => {
    await openPr(FINAL());
    approved();
    h.bb.spawnError = (args) => (args.metadata.role === "final-review" ? new Error("no such provider") : null);
    await poll();
    expect(dataOf("final_review_unfinished")[0]!.post.body).toContain("bb could not start the reviewer: no such provider");
    h.bb.spawnError = null;
    expect(spawns()).toHaveLength(1);
    await poll();
    expect(spawns()).toHaveLength(2);
    expect(merges()).toEqual([]);
  });

  it("nudges a reviewer that ends its turn without a verdict once, then ends the run", async () => {
    await openPr(FINAL({ timeout_minutes: 30 }));
    approved();
    await poll();
    reviewer().status = "idle";
    await poll();
    expect(h.bb.sent(reviewer().id).at(-1)).toContain("Call loom_final_review now");
    await poll();
    expect(dataOf("final_review_unfinished")[0]!.data.why).toBe("idle");
    expect(merges()).toEqual([]);
  });

  it("turns a failure the worker can fix into a fix round with the reviewer's reason, counted like other feedback", async () => {
    const worker = await openPr(FINAL());
    approved();
    await poll();
    verdict("fail", "The merge of main dropped the header row the second criterion needs.", true);
    await poll(h.ctx, 0);
    expect(ticket().state).toBe("working");
    expect(h.bb.sent(worker.thread_id!).at(-1)).toContain("dropped the header row");
    expect(merges()).toEqual([]);
    const round = posts().map((post) => JSON.parse(post.data_json) as Record<string, any>).find((data) => data.outcome === "pr_feedback")!;
    expect(round.counted).toBe(1);
  });

  it("blocks the ticket on a failure the worker cannot fix", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    verdict("fail", "The description promises a migration this change does not have; a person must decide.", false);
    await poll(h.ctx, 0);
    expect(ticket().state).toBe("blocked");
    expect(ticket().blocked_reason).toContain("promises a migration");
    expect(merges()).toEqual([]);
  });

  it("refuses a verdict for a head the pull request no longer has", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    push("sq-new");
    expect(() => verdict("pass")).toThrow("The pull request changed since this review started");
    expect(finalState(h.store, ticket().id, "sq1").passed).toBeNull();
  });

  it("shows on the Merge order tab and in the metrics", async () => {
    await openPr(FINAL());
    approved();
    expect(finalBadge(h.store, spec(), ticket())).toEqual({ state: "waiting", reason: null });
    await poll();
    expect(finalBadge(h.store, spec(), ticket())).toEqual({ state: "running", reason: null });
    const tickets = h.store.tickets(project().id);
    const badges = new Map(tickets.map((each) => [each.key, finalBadge(h.store, spec(), each)] as const));
    expect(mergeOrderOf(spec(), tickets, badges)!.entries.find((entry) => entry.key === "CSV-1")!.finalReview).toEqual({ state: "running", reason: null });
    verdict("fail", "Broken", true);
    const metrics = computeMetrics({ tickets: h.store.tickets(project().id), events: h.store.projectEvents(project().id), posts: [], threads: [], reviews: [], now: h.clock.now() });
    expect(metrics.finalReviews).toEqual({ runs: 1, passed: 0, failed: 1, unfinished: 0, tokens: 0 });
  });
});

describe("the brief", () => {
  it("shows the pull request's own files that changed since approval, not what the base merge brought", () => {
    const ticketRow = { key: "CSV-1", title: "Order rows", pr_url: URL, pushed_sha: "sq2", acceptance_json: JSON.stringify(["WHEN x THE SYSTEM SHALL y"]) } as Parameters<typeof finalBrief>[0]["ticket"];
    const brief = finalBrief({
      ticket: ticketRow,
      approvedAt: 0,
      delta: { approved: "c1", same: false, certain: true, prFiles: [{ path: "src/a.ts", additions: 3, deletions: 1 }], own: ["src/a.ts"], patches: [{ path: "src/a.ts", patch: "-old\n+new", truncated: false }], baseOnly: 412, problem: null },
      text: { title: "Add order rows", body: "Adds rows." },
      approvedText: { title: "Add order rows", body: "Adds rows." },
      items: [{ key: "comment:1", kind: "comment", author: "alice", body: "Please keep the header.", url: null }],
    }).text;
    expect(brief).toContain("412 other files changed only because the base was merged in");
    expect(brief).toContain("### src/a.ts");
    expect(brief).toContain("Unchanged since the reviewers approved it.");
    expect(brief).toContain("- comment by alice: Please keep the header.");
    expect(brief).not.toContain("check the text only");
  });
});
