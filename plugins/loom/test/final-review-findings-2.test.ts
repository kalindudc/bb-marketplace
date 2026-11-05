// Regressions for the second review of Loom 0.33.0's final review: each describe names its finding.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maintainFinalReviews, setAutoMerge } from "../src/auto-merge";
import { Store, type ThreadRow } from "../src/db/store";
import { FINAL_BOUND, FINAL_CLOSED, FINAL_STARTED, finalState, finalVerdict } from "../src/final-review";
import type { HostOutput } from "../src/host-contract";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { SpawnRefusedError, type SpawnArgs } from "../src/ports";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { specOf, type EngineCtx } from "../src/workers";
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
const approved = () => h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: false, review: "APPROVED" });
const verdict = (v: "pass" | "fail", reason = "", fixable?: boolean) => finalVerdict(h.ctx, reviewer().id, { verdict: v, reason, ...(fixable === undefined ? {} : { fixable }) });
/** Wraps one host method: `fn` gets the real call and decides what the caller sees. */
function around(method: string, fn: (input: any, real: () => Promise<unknown>) => Promise<unknown>): void {
  const real = h.host.call.bind(h.host);
  h.host.call = (async (hostId: string, m: string, input: unknown) => (m === method ? fn(input, () => real(hostId, m as never, input as never)) : real(hostId, m as never, input as never))) as typeof h.host.call;
}

describe("finding 1: the reviewer never starts in the checkout", () => {
  it("holds with a post when bb refuses the scratch directory, and spawns nothing in the checkout", async () => {
    await openPr(FINAL());
    approved();
    h.bb.spawnError = (args) => (args.metadata.role === "final-review" ? new SpawnRefusedError(400, "bb refused the workspace path") : null);
    await poll();
    expect(spawns().map((args) => args.workspace!.path).filter((path) => path === "/repo")).toEqual([]);
    const held = dataOf("final_review_held");
    expect(held).toHaveLength(1);
    expect(held[0]!.data.reason).toBe("scratch");
    expect(held[0]!.post.body).toContain("never runs it in the repo's checkout");
    await poll();
    expect(spawns().length).toBeLessThanOrEqual(2);
    expect(merges()).toEqual([]);
  });
});

describe("finding 3: a scratch directory is never lost", () => {
  it("records the run, with its scratch key, before it makes the directory", async () => {
    await openPr(FINAL());
    approved();
    let recorded: unknown = "not called";
    around("finalScratch", async (input, real) => {
      if (input.action === "create") recorded = h.store.ticketEvents(ticket().id, [FINAL_STARTED]).map((event) => JSON.parse(event.data_json).scratch);
      return real();
    });
    await poll();
    expect(recorded).toEqual([expect.stringMatching(/^loom-[0-9a-f]{24}$/)]);
  });

  it("does not record a run closed until its directory is removed, and tries again later", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    verdict("fail", "Broken", false);
    let fails = 1;
    around("finalScratch", async (input, real) => {
      if (input.action === "remove" && fails > 0) {
        fails -= 1;
        throw new Error("EBUSY: resource busy or locked");
      }
      return real();
    });
    await poll(h.ctx, 0);
    expect(h.store.ticketEvents(ticket().id, [FINAL_CLOSED])).toEqual([]);
    expect(h.host.scratch.size).toBe(1);
    h.clock.advance(5 * 60_000);
    await maintainFinalReviews(h.ctx);
    expect(h.store.ticketEvents(ticket().id, [FINAL_CLOSED])).toHaveLength(1);
    expect(h.host.scratch.size).toBe(0);
  });

  it("sweeps Loom's scratch directories that no outstanding run owns, and keeps the one that does", async () => {
    await openPr(FINAL({ timeout_minutes: 60 }));
    approved();
    await poll();
    h.host.scratch.set("loom-orphan", []);
    const owned = [...h.host.scratch.keys()].find((key) => key !== "loom-orphan")!;
    await maintainFinalReviews(h.ctx);
    h.clock.advance(31 * 60_000);
    approved();
    await maintainFinalReviews(h.ctx);
    expect([...h.host.scratch.keys()]).toEqual([owned]);
  });
});

describe("finding 4: a pass made just before a pause or an off still has its thread stopped", () => {
  const stops: Array<[string, () => void]> = [
    ["the project pauses", () => void h.store.setProjectState(project().id, "paused", "human")],
    ["auto-merge is turned off", () => void setAutoMerge(h.store, project(), "off", null)],
  ];
  it.each(stops)("stops and archives the reviewer when %s after its pass, and keeps the pass", async (_name, stop) => {
    await openPr(FINAL());
    approved();
    await poll();
    reviewer().status = "active";
    verdict("pass");
    stop();
    h.clock.advance(60 * 60_000);
    await maintainFinalReviews(h.ctx);
    expect(h.bb.callsTo("stop").map(([id]) => id)).toContain(reviewer().id);
    expect(reviewer().archivedAt).not.toBeNull();
    expect(h.host.scratch.size).toBe(0);
    expect(finalState(h.store, ticket().id, ticket().pushed_sha).passRun).not.toBeNull();
  });
});

describe("finding 5: a superseded run records nothing against its replacement", () => {
  it("does not hold the new head when a push lands during the stale run's fingerprint read", async () => {
    await openPr(FINAL());
    approved();
    // An incomplete brief: the pull request's listing fails.
    h.host.listings.set("origin/main..sq1", { outcome: "missing", message: "fatal: bad object" });
    await poll();
    expect(finalState(h.store, ticket().id, "sq1").open!.incomplete.length).toBeGreaterThan(0);
    verdict("pass");
    around("checkoutPrint", async (_input, real) => {
      h.store.updateTicket(ticket().id, { pushed_sha: "sq-new" });
      h.host.feedback.set(URL, { head: "sq-new" });
      return real();
    });
    await poll(h.ctx, 0);
    expect(finalState(h.store, ticket().id, "sq-new").held).toBeNull();
    expect(dataOf("final_review_held")).toEqual([]);
    await poll();
    expect(spawns()).toHaveLength(2);
  });
});

describe("upkeep tracks only outstanding runs", () => {
  it("reads no ticket history once every run is closed, and none at all for a project that never had one", async () => {
    await openPr(FINAL());
    approved();
    await poll();
    verdict("pass");
    await poll(h.ctx, 0);
    expect(merges()).toHaveLength(1);
    const fresh = new Store(h.db, h.clock.now);
    const spy = vi.spyOn(fresh, "ticketEvents");
    await maintainFinalReviews({ ...h.ctx, store: fresh }, project().id);
    await maintainFinalReviews({ ...h.ctx, store: fresh }, project().id);
    expect(spy).not.toHaveBeenCalled();
  });
});

export type { HostOutput };
