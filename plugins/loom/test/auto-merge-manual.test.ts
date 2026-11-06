// auto_merge.mode: "manual", the default, waits for the human to confirm each pushed commit's merge, in the panel, the
// CLI or through the planner; "auto" is how auto-merge worked before, asking once the pull request is ready.
import { beforeEach, describe, expect, it } from "vitest";
import { confirmMerge, mergeConfirmOf, requestMerge, setAutoMerge } from "../src/auto-merge";
import type { ThreadRow } from "../src/db/store";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { autoMergeOf, repoSettings } from "../src/repos";
import { boardCards } from "../src/rpc";
import { parseSpec, specHash } from "../src/spec";
import { HUMAN_ACTOR } from "../src/states";
import { specOf } from "../src/workers";
import { makeEngine, reachApproved, seedProject, specToml, ticketOf, type Doc, type EngineHarness } from "./helpers";

let h: ReturnType<typeof makeEngine>;
beforeEach(() => {
  h = makeEngine();
});

const URL = "https://github.com/acme/shop/pull/1";
const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h as EngineHarness, "CSV-1");
const posts = () => h.store.posts(ticket().id);
const dataOf = (outcome: string) => posts().filter((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome === outcome);
const merges = () => h.host.callsTo("prMerge");
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const approved = (more: Record<string, unknown> = {}) => h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: false, review: "APPROVED", ...more });
const TEXT = { title: "Add order rows", body: "## Why\nSupport wants CSV exports.", commit_message: "Add the order row mapper" };
/** The pull request and commit the human sees now. */
const seen = () => ({ prUrl: ticket().pr_url!, sha: ticket().pushed_sha! });
const card = () => boardCards(h.store.tickets(project().id), h.store.threadsForProject(project().id), spec(), h.store).find((each) => each.key === "CSV-1")!;

async function openPr(autoMerge: Doc): Promise<ThreadRow> {
  await seedProject(h, (doc) => void (doc.merge = { strategy: "pr", draft: false, forge: { kind: "gh", auto_merge: autoMerge } }));
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, TEXT);
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
  expect(ticket().state).toBe("pr_open");
  return worker;
}

describe("auto_merge.mode in the spec", () => {
  it("is manual when unset, and a spec without it hashes as before", () => {
    const plain = parseSpec(specToml((doc) => void (doc.merge = { strategy: "pr", forge: { kind: "gh", auto_merge: { method: "squash" } } })));
    expect(plain.errors).toEqual([]);
    expect(plain.spec!.merge.forge!.auto_merge).toEqual({ method: "squash" });
    expect(autoMergeOf(plain.spec!.merge.forge!)!.mode).toBe("manual");
    const auto = parseSpec(specToml((doc) => void (doc.merge = { strategy: "pr", forge: { kind: "gh", auto_merge: { method: "squash", mode: "auto" } } })));
    expect(autoMergeOf(auto.spec!.merge.forge!)!.mode).toBe("auto");
    expect(specHash(auto.spec!)).not.toBe(specHash(plain.spec!));
    expect(parseSpec(specToml((doc) => void (doc.merge = { strategy: "pr", forge: { kind: "gh", auto_merge: { method: "squash", mode: "sometimes" } } }))).errors.join("\n")).toContain("auto_merge.mode");
  });
});

describe("a manual merge", () => {
  it("waits for the human's confirmation once the pull request is ready, saying so once, and merges after it", async () => {
    await openPr({ method: "squash" });
    expect(autoMergeOf(repoSettings(spec(), null).forge)!.mode).toBe("manual");
    expect(card().mergeConfirm).toMatchObject({ ready: false, confirmed: false });
    approved();
    await poll();
    await poll();
    expect(merges()).toEqual([]);
    expect(dataOf("auto_merge_confirm")).toHaveLength(1);
    expect(dataOf("auto_merge_confirm")[0]!.body).toContain("auto_merge.mode is manual, so Loom waits for you to confirm the merge");
    expect(mergeConfirmOf(h.store, spec(), ticket(), h.clock.now())).toMatchObject({ ready: true, confirmed: false });
    expect(card().mergeConfirm).toMatchObject({ ready: true, confirmed: false });

    expect(h.engine.confirmMerge("CSV-1", seen())).toBe(`Confirmed CSV-1's merge at ${ticket().pushed_sha!.slice(0, 12)}: Loom asks to merge its pull request at its next read.`);
    expect(card().mergeConfirm).toMatchObject({ ready: false, confirmed: true });
    await poll();
    expect(merges()).toEqual([expect.objectContaining({ url: URL, sha: ticket().pushed_sha, attempt: 1 })]);
    h.host.prStates.set(URL, "MERGED");
    await pollPullRequests(h.ctx, project());
    expect(ticket().state).toBe("done");
  });

  // The human's ask: no Confirm merge until the pull request is ready, and the one thing it waits for instead.
  it("offers no confirmation until the pull request is ready, says what it waits for, and refuses one sent early", async () => {
    await openPr({ method: "squash" });
    expect(card().mergeConfirm).toMatchObject({ ready: false, confirmed: false, waiting: "checks not read" });
    expect(() => h.engine.confirmMerge("CSV-1", seen())).toThrow("CSV-1's pull request is not ready to merge yet: checks not read. Confirm it once it is.");
    expect(h.store.ticketEvents(ticket().id, ["ticket.merge_confirmed"])).toEqual([]);
    h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: true, review: "APPROVED" });
    await poll();
    approved({ draft: true });
    h.store.updateTicket(ticket().id, { pr_meta_json: JSON.stringify({ at: 0, draft: true, review: "APPROVED", base: "main" }) });
    expect(card().mergeConfirm).toMatchObject({ ready: false, waiting: "being marked ready for review" });
    approved();
    await poll();
    expect(card().mergeConfirm).toMatchObject({ ready: true, waiting: null });
    h.engine.confirmMerge("CSV-1", seen());
    await poll();
    expect(merges()).toHaveLength(1);
  });

  it("records a planner's request early, shown as waiting until the pull request is ready", async () => {
    await openPr({ method: "squash" });
    requestMerge(h.store, project(), ticket(), "thr_plan", { sha: ticket().pushed_sha!, note: "Merge once it is approved." });
    expect(card().mergeConfirm).toMatchObject({ ready: false, waiting: "checks not read", requested: { note: "Merge once it is approved." } });
    approved();
    await poll();
    expect(card().mergeConfirm).toMatchObject({ ready: true, requested: { note: "Merge once it is approved." } });
  });

  it("needs a new confirmation for a new push", async () => {
    await openPr({ method: "squash" });
    approved();
    await poll();
    h.engine.confirmMerge("CSV-1", seen());
    h.store.updateTicket(ticket().id, { pushed_sha: "f".repeat(40) });
    h.host.feedback.set(URL, { head: "f".repeat(40) });
    await poll();
    expect(merges()).toEqual([]);
    expect(mergeConfirmOf(h.store, spec(), ticket(), h.clock.now())).toMatchObject({ ready: true, confirmed: false });
  });

  it('merges by itself with mode = "auto", as before', async () => {
    await openPr({ method: "squash", mode: "auto" });
    expect(card().mergeConfirm).toBeNull();
    approved();
    await poll();
    expect(merges()).toHaveLength(1);
    expect(() => h.engine.confirmMerge("CSV-1", seen())).toThrow('sets auto_merge.mode = "auto", so Loom merges its pull request by itself');
  });

  it("refuses a confirmation where Loom would not merge: auto-merge off, no auto_merge, or no open pull request", async () => {
    await openPr({ method: "squash" });
    setAutoMerge(h.store, project(), "off", ticket());
    expect(card().mergeConfirm).toBeNull();
    expect(() => confirmMerge(h.store, project(), ticket(), seen(), h.clock.now())).toThrow("Auto-merge is off for CSV-1");
    setAutoMerge(h.store, project(), "on", ticket());
    h.store.updateTicket(ticket().id, { state: "approved" });
    expect(() => confirmMerge(h.store, project(), ticket(), seen(), h.clock.now())).toThrow("CSV-1 is approved with no open pull request");

    h = makeEngine();
    await seedProject(h, (doc) => void (doc.merge = { strategy: "pr", forge: { kind: "gh" } }));
    expect(() => confirmMerge(h.store, project(), ticket(), seen(), h.clock.now())).toThrow("sets no auto_merge");
  });

  it("records the human as who confirmed, and says so when the commit is already confirmed", async () => {
    await openPr({ method: "squash" });
    approved();
    await poll();
    h.engine.confirmMerge("CSV-1", seen());
    expect(h.store.ticketEvents(ticket().id, ["ticket.merge_confirmed"])).toEqual([expect.objectContaining({ actor: HUMAN_ACTOR })]);
    expect(h.engine.confirmMerge("CSV-1", seen())).toBe(`CSV-1's merge at ${ticket().pushed_sha!.slice(0, 12)} is already confirmed.`);
    expect(h.store.ticketEvents(ticket().id, ["ticket.merge_confirmed"])).toHaveLength(1);
  });
});

// Tony's review: a confirmation sent for one head, replayed after the head moved, confirmed and merged the new head.
describe("a confirmation is for the exact pull request and commit the human saw", () => {
  const NEW = "b".repeat(40);
  const moveHead = () => {
    h.store.updateTicket(ticket().id, { pushed_sha: NEW });
    h.host.feedback.set(URL, { head: NEW });
  };

  it("refuses a confirmation for a head that has moved since, as a replayed request, and merges nothing", async () => {
    await openPr({ method: "squash" });
    approved();
    await poll();
    const before = seen();
    moveHead();
    expect(() => h.engine.confirmMerge("CSV-1", before)).toThrow(`CSV-1's pull request moved since you saw it: you confirmed ${before.sha.slice(0, 12)}, and Loom has pushed ${NEW.slice(0, 12)} since`);
    await poll();
    expect(merges()).toEqual([]);
    expect(h.store.ticketEvents(ticket().id, ["ticket.merge_confirmed"])).toEqual([]);

    h.engine.confirmMerge("CSV-1", seen());
    await poll();
    expect(merges()).toEqual([expect.objectContaining({ sha: NEW })]);
  });

  it("refuses a confirmation for another pull request", async () => {
    await openPr({ method: "squash" });
    expect(() => h.engine.confirmMerge("CSV-1", { prUrl: "https://github.com/acme/shop/pull/9", sha: ticket().pushed_sha! })).toThrow("CSV-1's pull request moved since you saw it");
    expect(h.store.ticketEvents(ticket().id, ["ticket.merge_confirmed"])).toEqual([]);
  });

  it("lets no confirmation but the human's authorize a merge", async () => {
    await openPr({ method: "squash" });
    h.store.event(project().id, ticket().id, "ticket.merge_confirmed", "thr_plan", { url: URL, sha: ticket().pushed_sha });
    approved();
    await poll();
    expect(merges()).toEqual([]);
    expect(mergeConfirmOf(h.store, spec(), ticket(), h.clock.now())).toMatchObject({ ready: true, confirmed: false });
  });
});
