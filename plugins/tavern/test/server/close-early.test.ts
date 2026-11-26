// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { Ask } from "../../src/shared/schema";
import { waypointLabel } from "../../src/shared/waypoint";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { readTale } from "../../src/server/tale";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest, waypointEntry } from "./support";

const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

async function fixture({ settled = false, keeperCheck = false } = {}) {
  const f = setup(); dbs.push(f.k.store.db);
  registerTools(f.bb, f.runtime); registerRpc(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Watch the rollout", "Watch");
  const plan = planInput(q.id);
  f.k.plan("lead", { ...plan, waypoints: [
    { ...plan.waypoints[0]!, title: "Collect updates", check: settled ? "none" : keeperCheck ? "keeper" : "warden" },
    { ...plan.waypoints[0]!, id: "w2", title: "Check the next shift", check: "warden", optional: true },
  ] });
  f.k.answerAsk(f.k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
  f.k.bind("maker", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Collect updates",
    brief: { outcome: "Collect updates", mode: "make-it-work", outOfScope: "Deploying", doneWhen: "Updates read", context: [], questions: [], timeboxMinutes: null } });
  f.port.linkedEntries = () => [waypointEntry("maker", q.id)];
  if (settled) f.k.settle("lead", { boardQuestId: q.id, waypointId: "w2", as: "skipped", reason: "The watch was complete" });
  const propose = (extra: Record<string, unknown> = {}) => f.harness.behavior.invokeAgentTool("tavern_wrap", {
    boardQuestId: q.id, outcome: "The rollout has ended", left: "", next: [], reason: "The owner cancelled the next shift", ...extra,
  }, { threadId: "lead" });
  const pending = () => f.k.store.openAsks("lead", q.id).filter(a => a.kind === "conclude");
  const answer = (ask: Ask, optionId: string, pullRequestChoices?: { id: string; action: "keep" | "you" | "close" }[]) => f.harness.invokeRpc("answerAsk", { askId: ask.id, optionId, note: null, via: "page", ...(pullRequestChoices ? { pullRequestChoices } : {}) });
  return { ...f, q, propose, pending, answer };
}

it("opens one close-early card with the unsettled states, reason and verbatim user steer", async () => {
  const f = await fixture(); f.advance(1000);
  const words = "The owner called it off. Close the watch here.";
  f.k.receiveUser("lead", words);
  const route = f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Stop watching", notes: [] });
  await f.propose({ fromSteer: route.id });
  const [ask] = f.pending();
  expect(f.k.quest(f.q.id).phase).toBe("closing");
  expect(ask?.effect).toMatchObject({ type: "close-early", draft: { fromSteer: { text: words }, unsettled: [
    { waypointId: "w1", state: "reported", reason: "The owner cancelled the next shift" }, { waypointId: "w2", state: "planned" },
  ] } });
  expect(ask?.options.map(o => o.label)).toEqual(["Close early", "Keep open"]);
  expect(ask?.options[0]?.detail).toContain("w1 recorded as made, not verified; w2 recorded as not done");
});

it("applies one explicit close and makes the event log sufficient to explain the waivers", async () => {
  const f = await fixture(); await f.propose();
  const ask = f.pending()[0]!;
  await expect(f.runtime.answerAsk(ask.id, "close-early", null, "page")).rejects.toThrow(/explicit/i);
  await f.answer(ask, "close-early");
  expect(f.k.quest(f.q.id)).toMatchObject({ phase: "done", outcome: "closed-early" });
  const waypoints = f.k.summary(f.q.id).waypoints;
  expect(waypoints.map(w => waypointLabel(w.state))).toEqual(["Skipped", "Skipped"]);
  expect(waypoints.map(w => w.madeBy)).toEqual([["maker"], []]);
  expect(f.port.linkedEntries(f.q.id)).toEqual(expect.arrayContaining(["w1", "w2"].map(waypointId => expect.objectContaining({
    link: { boardQuestId: f.q.id, waypointId }, review: expect.objectContaining({ kind: "waiver", actor: { kind: "user" } }),
  }))));
  const events = f.k.store.events("lead", 0, 500).filter(e => e.boardQuestId === f.q.id);
  const wrapped = events.filter(e => e.type === "quest.wrapped");
  expect(wrapped).toHaveLength(1);
  expect(wrapped[0]).toMatchObject({ actor: { kind: "user" }, data: { phase: { from: "closing", to: "done" }, closure: "closed-early", receipt: { kind: "ask-answer", id: ask.id }, waivers: [
    { waypointId: "w1", state: "reported", reason: "The owner cancelled the next shift", askId: ask.id },
    { waypointId: "w2", state: "planned", askId: ask.id },
  ] } });
  expect(readTale(f.k, f.k.summary(f.q.id))).toMatchObject({ closure: "closed-early", waivers: wrapped[0]!.data.waivers });
  expect(f.k.member("maker")?.verifiedWins).toBe(0);
  expect(f.k.store.get("serviceRecords", f.q.id)).toMatchObject({ outcome: "closed-early", waypoints: { verified: 0, waived: 2 } });
  f.port.linkedEntries = () => [waypointEntry("maker", f.q.id), { ...waypointEntry("maker", f.q.id, "w1", "a2"), status: "verified" }];
  expect(f.k.summary(f.q.id).waypoints[0]).toMatchObject({ state: "skipped", verifiedBy: null });
});

it("replaces a pending proposal and returns to build without waivers on Keep open", async () => {
  const f = await fixture(); await f.propose(); const first = f.pending()[0]!;
  await f.propose({ reason: "Another reason" }); const [second] = f.pending();
  expect(f.pending()).toHaveLength(1);
  expect(f.k.store.get("asks", first.id)).toMatchObject({ state: "withdrawn" });
  await f.answer(second!, "hold");
  expect(f.k.quest(f.q.id).phase).toBe("build");
  expect(f.k.summary(f.q.id).waypoints.map(w => w.state)).toEqual(["reported", "planned"]);
});

it("withdraws the close-early request when stopped and records a stop, not a wrap", async () => {
  const f = await fixture();
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  await f.propose(); const ask = f.pending()[0]!;
  await f.runtime.stop(f.q.id);
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "quest-stopped" });
  expect(f.k.quest(f.q.id)).toMatchObject({ phase: "stopped", outcome: "stopped" });
  expect(f.k.store.latestQuestEvent(f.q.id, "quest.wrapped")).toBeNull();
});

it("won't silently waive a waypoint whose state changed after the card was shown", async () => {
  const f = await fixture(); await f.propose(); const ask = f.pending()[0]!;
  f.port.linkedEntries = () => [{ ...waypointEntry("maker", f.q.id), status: "rejected" }];
  await expect(f.answer(ask, "close-early")).rejects.toThrow(/changed.*propose/i);
  expect(f.k.quest(f.q.id).phase).toBe("build");
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "closing-stale", answer: null });
  expect(f.k.store.runtime("lead").reanchor).toMatch(/closing card/i);
  expect(f.k.store.latestQuestEvent(f.q.id, "quest.wrapped")).toBeNull();
});

it.each(["accepted", "skipped"] as const)("withdraws an outdated closing card when the Keeper settles work as %s", async as => {
  const f = await fixture({ keeperCheck: true });
  await f.propose(); const ask = f.pending()[0]!;
  f.k.settle("lead", { boardQuestId: f.q.id, waypointId: as === "accepted" ? "w1" : "w2", as, reason: "The work no longer waits" });
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "closing-stale" });
  expect(f.k.quest(f.q.id).phase).toBe("build");
  expect(f.k.store.runtime("lead").reanchor).toMatch(/closing card/i);
});

it("lists every open pull request and applies the default, user ownership and forge close from the answer", async () => {
  const f = await fixture({ settled: true });
  const record = (head: string, state: "draft" | "ready" | "merged", n: number, verified = false) => f.k.store.recordPullRequest({
    keeperThreadId: "lead", boardQuestId: f.q.id, projectId: "project", owner: "maker", url: `https://github.com/example/repo/pull/${n}`,
    forge: "gh", state, head, base: "main", memberHead: "a".repeat(40), pushedHead: null, verifiedCommit: verified ? "a".repeat(40) : null,
  }, f.time());
  const keep = record("keep", "draft", 1), take = record("take", "ready", 2, true), close = record("close", "draft", 3);
  record("merged", "merged", 4);
  await f.propose(); const ask = f.pending()[0]!;
  expect(ask.effect).toMatchObject({ type: "conclude", draft: { pullRequests: [
    expect.objectContaining({ id: keep.id, state: "draft", owner: "maker", headVerified: false }),
    expect.objectContaining({ id: take.id, state: "ready", headVerified: true }),
    expect.objectContaining({ id: close.id }),
  ] } });
  const forge = vi.spyOn(f.runtime.placements().forge, "close").mockResolvedValue({ state: "closed" });
  f.k.store.transferPullRequests("maker", f.time());
  await f.answer(ask, "conclude", [{ id: take.id, action: "you" }, { id: close.id, action: "close" }]);
  expect(forge).toHaveBeenCalledOnce();
  expect(forge.mock.calls[0]?.[0]).toMatchObject({ id: close.id, forge: "gh" });
  expect(f.k.store.get("pullRequests", keep.id)).toMatchObject({ owner: "lead", state: "draft" });
  expect(f.k.store.get("pullRequests", take.id)).toMatchObject({ owner: "user", state: "ready" });
  expect(f.k.store.get("pullRequests", close.id)).toMatchObject({ state: "closed" });
  expect(f.k.store.latestQuestEvent(f.q.id, "pull-request.changed")?.data).toMatchObject({ id: close.id, state: "closed", askId: ask.id });
});

it("moves an open draft to the Keeper when its Smith is released, without closing it", async () => {
  const f = await fixture();
  const pr = f.k.store.recordPullRequest({ keeperThreadId: "lead", boardQuestId: f.q.id, projectId: "project", url: "https://github.com/example/repo/pull/1", owner: "maker", forge: "gh", head: "maker-work", base: "main", memberHead: "a".repeat(40), pushedHead: null, verifiedCommit: null, state: "draft" }, f.time());
  f.bb.sdk.threads.stop = async () => ({ ok: true });
  expect(await f.runtime.release("lead", "maker", "End of shift")).toBe(true);
  expect(f.k.store.get("pullRequests", pr.id)).toMatchObject({ owner: "lead", state: "draft" });
  expect(f.k.store.latestQuestEvent(f.q.id, "pull-request.changed")?.data).toMatchObject({ owner: "lead", state: "draft" });
});

it("withdraws the closing card when a recorded pull request head changes, without calling the forge", async () => {
  const f = await fixture({ settled: true });
  const pr = f.k.store.recordPullRequest({ keeperThreadId: "lead", boardQuestId: f.q.id, projectId: "project", url: "https://github.com/example/repo/pull/1", owner: "maker", forge: "gh", head: "maker-work", base: "main", memberHead: "a".repeat(40), pushedHead: null, verifiedCommit: null, state: "draft" }, f.time());
  const forge = f.runtime.placements().forge;
  vi.spyOn(forge, "inspect").mockResolvedValue({ state: "draft" });
  const close = vi.spyOn(forge, "close").mockResolvedValue({ state: "closed" });
  await f.propose(); const ask = f.pending()[0]!;
  f.k.store.changePullRequest({ ...pr, pushedHead: "b".repeat(40) }, f.time());
  await expect(f.answer(ask, "conclude", [{ id: pr.id, action: "close" }])).rejects.toThrow(/pull requests changed/i);
  expect(close).not.toHaveBeenCalled();
  expect(f.k.store.get("asks", ask.id)).toMatchObject({ state: "withdrawn", withdrawnCause: "closing-stale", answer: null });
  expect(f.k.store.get("pullRequests", pr.id)).toMatchObject({ state: "draft", pushedHead: "b".repeat(40) });
  expect(f.k.quest(f.q.id).phase).toBe("build");
});

it("clears a stale head verdict on read and records a forge failure without retrying on a repeated answer", async () => {
  const f = await fixture({ settled: true });
  const oldHead = "a".repeat(40), newHead = "b".repeat(40);
  const pr = f.k.store.recordPullRequest({ keeperThreadId: "lead", boardQuestId: f.q.id, projectId: "project", url: "https://github.com/example/repo/pull/1", owner: "maker", forge: "gh", head: "maker-work", base: "main", memberHead: oldHead, pushedHead: null, verifiedCommit: oldHead, state: "draft" }, f.time());
  const forge = f.runtime.placements().forge;
  vi.spyOn(forge, "inspect").mockResolvedValue({ state: "ready", headCommit: newHead });
  const close = vi.spyOn(forge, "close").mockRejectedValue(new Error("Forge offline"));
  await f.propose(); const ask = f.pending()[0]!;
  expect(ask.effect).toMatchObject({ draft: { pullRequests: [{ headVerified: false, state: "ready", headCommit: newHead }] } });
  await expect(f.answer(ask, "conclude", [{ id: "unknown", action: "close" }])).rejects.toThrow(/shown on this card/i);
  expect(close).not.toHaveBeenCalled();
  const choices = [{ id: pr.id, action: "close" as const }];
  expect(await f.answer(ask, "conclude", choices)).toMatchObject({ pullRequestErrors: [expect.stringContaining("Forge offline")] });
  expect(f.k.store.get("pullRequests", pr.id)).toMatchObject({ state: "ready", verifiedCommit: null, closeRequest: { askId: ask.id, error: "Forge offline" } });
  await f.answer(ask, "conclude", choices);
  expect(close).toHaveBeenCalledOnce();
});

it("uses Close early for a quest with no map and recommends keeping it open", async () => {
  const f = setup(); dbs.push(f.k.store.db);
  const q = await seedQuest(f.k, "lead", "Unplanned", "Unplanned");
  const { askId } = await f.runtime.proposeWrap("lead", q.id, "Nothing was needed", "");
  expect(f.k.quest(q.id).phase).toBe("closing");
  expect(f.k.summary(q.id).move).toMatchObject({ who: "you", text: "Can “Unplanned” close early?" });
  expect(f.k.store.get("asks", askId!)).toMatchObject({ effect: { type: "close-early", draft: { unsettled: [], noPlan: true } }, options: [
    { id: "close-early", detail: "No quest map was written.", recommended: false }, { id: "hold", recommended: true },
  ] });
  await f.runtime.answerAsk(askId!, "hold", null, "page", true);
  expect(f.k.quest(q.id).phase).toBe("scout");
  const reason = "The alert was fixed upstream before we planned";
  const again = await f.runtime.proposeWrap("lead", q.id, "Nothing was needed", "", undefined, undefined, { reason });
  expect(f.k.store.get("asks", again.askId!)?.effect).toMatchObject({ draft: { reason } });
  await f.runtime.answerAsk(again.askId!, "close-early", null, "page", true);
  expect(f.k.quest(q.id)).toMatchObject({ phase: "done", outcome: "closed-early", waivers: [] });
  expect(f.k.summary(q.id).move.text).toBe("Returned, closed early without a quest map");
  expect(f.k.store.latestQuestEvent(q.id, "quest.wrapped")?.data).toMatchObject({ closure: "closed-early", noPlan: true, waivers: [], closeReason: reason });
  expect(readTale(f.k, f.k.summary(q.id))).toMatchObject({ closeReason: reason });
});

it("keeps ended waypoint calls visible without offering Undo or rewriting their history", async () => {
  const f = await fixture({ settled: true });
  const first = f.k.store.query("decisions", "boardQuestId", f.q.id).find(d => d.waypointCall?.as === "skipped")!;
  await f.propose();
  await f.answer(f.pending()[0]!, "conclude");
  const ledger = await f.harness.invokeRpc("ledger", { threadId: "lead" });
  expect(ledger).toMatchObject({ decidedForYou: [expect.objectContaining({ id: first.id, undoUnavailable: true })] });
  expect(f.k.store.get("decisions", first.id)?.reversible).toBe(true);
});
