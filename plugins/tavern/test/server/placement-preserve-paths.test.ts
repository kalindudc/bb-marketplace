// @vitest-environment node
import { patchThreadFixture, runtimeFixture } from "./member-fixture";
import { concludeQuest, putQuestFixture } from "./support";
import { afterEach, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerTools } from "../../src/server/tools";
import { settleCancelledHire } from "../../src/server/hires";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";
import { placementRecord } from "./placement-fixture";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.k.store.db.close(); });
const brief = { outcome: "Draft", doneWhen: "Tests pass", mode: "make-it-work" as const, outOfScope: "Production", context: [], questions: [], timeboxMinutes: null };
async function fixture(placed = true) {
  const archived = new Set<string>();
  const archive = vi.fn(async ({ threadId }: { threadId: string }) => { archived.add(threadId); return { ok: true }; });
  const unarchive = vi.fn(async ({ threadId }: { threadId: string }) => { archived.delete(threadId); return { ok: true }; });
  const f = setup({ threads: { archive, unarchive, stop: async () => ({ ok: true }), queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) }, get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, archivedAt: archived.has(threadId) ? 100 : null }) } });
  fixtures.push(f);
  const quest = await seedQuest(f.k, "lead", "Draft", "Tested draft");
  f.k.plan("lead", { ...planInput(quest.id), waypoints: [{ ...planInput(quest.id).waypoints[0]!, optional: true }] });
  f.k.answerAsk(f.k.store.openAsks("lead", quest.id)[0]!.id, "approve", null, "page", "user");
  const owner = { keeperThreadId: "lead", boardQuestId: quest.id, waypointId: null, errand: false, title: "Draft", brief };
  f.k.bind("child", "smith", "vale", "project", owner);
  f.runtime.spawnBriefDelivered("child");
  if (placed) f.runtime.placements().store.reserve(placementRecord({ memberThreadId: "child", keeperThreadId: "lead", questId: quest.id }), { maxMakers: 2, maxCheckers: 2 });
  const local = vi.spyOn(f.runtime, "preserveWorkOrRefuse").mockResolvedValue(null);
  vi.spyOn(f.runtime.placements(), "host", "get").mockReturnValue({ call: vi.fn(), onWorkerExit: () => () => {} });
  const save = vi.spyOn(f.runtime.placements().preserve, "beforeRelease").mockResolvedValue({ state: "blocked", message: "save refused" });
  const wrap = () => concludeQuest(f.runtime, "lead", quest.id, "Draft tested", "", [{ waypointId: "w1", reason: "Optional" }]);
  return { ...f, quest, owner, archive, unarchive, archived, local, save, wrap };
}

function confirmPlacementRelease(f: Awaited<ReturnType<typeof fixture>>) {
  const placements = f.runtime.placements().store, record = placements.byMember("child")!;
  const cancelled = placements.cancel(record.id, record.generation);
  placements.update(cancelled.id, cancelled.generation, current => ({ ...current, phase: "releasing",
    preservation: { ...current.preservation, source: current.preservation.source === "saved" ? "saved" : "not-needed",
      liveOwnerThreadId: null, stopConfirmed: true } }), "released");
  placements.finishRelease(cancelled.id, cancelled.generation, true);
  f.archived.add("child");
  return { state: "released" as const };
}

it("does not complete a placed release from a host reply alone, and records one release after reconciliation", async () => {
  const f = await fixture();
  f.save.mockResolvedValue({ state: "released" });
  expect(await f.runtime.release("lead", "child", "Release")).toBe(false);
  expect(f.k.member("child")?.engagement).toBe("releasing");
  expect(f.k.store.events("lead").filter(event => event.type === "member.released")).toHaveLength(0);
  confirmPlacementRelease(f);
  expect(await f.runtime.release("lead", "child", "Release")).toBe(true);
  expect(await f.runtime.release("lead", "child", "Release")).toBe(true);
  expect(f.k.store.events("lead").filter(event => event.type === "member.released").map(e => e.data.engagement)).toEqual([{ from: "releasing", to: "released" }]);
  expect(f.k.member("child")).toMatchObject({ engagement: "archived", disposition: "released" });
  expect(f.k.store.events("lead").filter(e => e.type === "thread.archived")).toHaveLength(1);
  expect(f.archive).not.toHaveBeenCalled();
});

it("preserves local work before archiving a released member and records it on the quest", async () => {
  const f = await fixture(false);
  f.local.mockResolvedValueOnce("A patch could not be saved");
  expect(await f.runtime.release("lead", "child", "Work complete")).toBe(false);
  expect(f.archive).not.toHaveBeenCalled();
  expect(f.k.member("child")).toMatchObject({ engagement: "archiving", disposition: "released" });
  expect(await f.runtime.release("lead", "child", "Work complete")).toBe(true);
  expect(f.local.mock.invocationCallOrder.at(-1)).toBeLessThan(f.archive.mock.invocationCallOrder[0]!);
  expect(f.archive).toHaveBeenCalledExactlyOnceWith({ threadId: "child" });
  expect(f.save).not.toHaveBeenCalled();
  expect(f.k.member("child")).toMatchObject({ engagement: "archived", disposition: "released" });
  const history = f.k.store.events("lead").filter(e => e.type === "member.released" || e.type === "thread.archived");
  expect(history.map(e => e.type)).toEqual(["member.released", "thread.archived"]);
  expect(history.every(e => e.boardQuestId === f.quest.id)).toBe(true);
});

it("lets a Keeper find and archive their earlier live releases only on request", async () => {
  const f = await fixture(false);
  registerTools(f.bb, f.runtime);
  for (const id of ["second", "already", "active", "other"]) f.k.bind(id, "smith", "vale", "project", f.owner);
  f.k.store.put("members", "other", { ...f.k.member("other")!, keeperThreadId: "other-keeper" });
  for (const id of ["child", "second", "already", "other"])
    patchThreadFixture(f.k.store, id, { released: { reason: "Released earlier", decisionId: `old-${id}` } });
  f.archived.add("already");
  f.runtime.updateThread(await f.bb.sdk.threads.get({ threadId: "already" }));
  await f.runtime["finishMemberCleanup"]("lead");
  expect(f.archive).not.toHaveBeenCalled();
  const call = (name: string, input: Record<string, unknown>) => f.harness.behavior.invokeAgentTool(name, input, { threadId: "lead" });
  const status = async () => JSON.parse(String(await call("tavern_status", {}))).releasedNotArchived;
  const firstPage = JSON.parse(String(await call("tavern_status", { limit: 1 })));
  expect(firstPage).toMatchObject({ releasedNotArchived: [expect.objectContaining({ threadId: "child" })], nextReleasedNotArchivedOffset: 1 });
  const before = await status();
  expect(before).toEqual([expect.objectContaining({ threadId: "child" }), expect.objectContaining({ threadId: "second" })]);
  const release = (threadId: string) => call("tavern_release", { memberThreadId: threadId, reason: "Archive earlier release" });
  await expect(release("other")).rejects.toThrow(/your own party/);
  for (const { threadId } of before) {
    expect(await release(threadId)).toContain("Archived");
    await release(threadId);
  }
  expect(await status()).toEqual([]);
  expect(f.archive.mock.calls.map(([args]) => args.threadId)).toEqual(["child", "second"]);
  expect(f.harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
  expect(f.k.store.events("lead").filter(e => e.type === "thread.archived" && e.data.keeperArchiveRequested)).toHaveLength(2);
  expect(f.k.store.events("lead").filter(e => e.type === "member.released")).toHaveLength(0);
});

it("keeps a placed release final after decision Undo and after opening the thread for reading", async () => {
  const f = await fixture();
  f.save.mockImplementation(async () => confirmPlacementRelease(f));
  expect(await f.runtime.release("lead", "child", "Work complete")).toBe(true);
  const decision = f.k.store.all("decisions").find(d => d.text.startsWith("Release "))!;
  await f.runtime.undoDecision(decision.id);
  expect(f.k.store.get("decisions", decision.id)?.undone).toBe(true);
  expect(f.unarchive).not.toHaveBeenCalled();
  expect(f.archived.has("child")).toBe(true);
  expect(await f.runtime.unarchiveMember("lead", "child")).toMatchObject({ released: true });
  expect(f.k.member("child")).toMatchObject({ engagement: "released", disposition: "released" });
  expect(f.k.store.activeStaffing("lead")).toEqual([]);
  expect(await f.runtime.release("lead", "child", "Done reading")).toBe(true);
  expect(f.archive).toHaveBeenCalledExactlyOnceWith({ threadId: "child" });
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.k.member("child")).toMatchObject({ engagement: "archived", disposition: "released" });
});

it.each(["wrap", "conclude", "cellar", "delete"] as const)("preserves a placed member before %s archives it and retains a failed save for Retry", async path => {
  const f = await fixture();
  let pending: string[];
  if (path === "wrap") pending = (await f.wrap()).pendingArchives;
  else if (path === "conclude") {
    f.k.settle("lead", { boardQuestId: f.quest.id, waypointId: "w1", as: "skipped", reason: "Optional" });
    const proposed = await f.runtime.proposeWrap("lead", f.quest.id, "Draft tested", "", []);
    expect(f.save).not.toHaveBeenCalled();
    await f.runtime.answerAsk(proposed.askId!, "conclude", null, "page", true);
    pending = runtimeFixture(f.k.store, "child").archivePending ? ["child"] : [];
  } else {
    putQuestFixture(f.k.store, f.quest.id, { ...f.k.quest(f.quest.id), phase: "done", endedAt: f.time() });
    pending = path === "cellar" ? (await f.runtime.archiveBoardQuests([f.quest.id], true)).pendingArchives : (await f.runtime.deleteBoardQuest(f.quest.id)).pendingArchives;
  }
  expect(pending).toContain("child");
  expect(f.save).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalledWith("child");
  expect(f.archive.mock.calls.some(([input]) => input.threadId === "child")).toBe(false);
  expect(runtimeFixture(f.k.store, "child").archiveError).toContain("save refused");
  f.save.mockImplementation(async () => confirmPlacementRelease(f));
  expect(await f.runtime["archiveMembers"]([f.k.member("child")!])).toEqual([]);
  expect(f.archive.mock.calls.some(([input]) => input.threadId === "child")).toBe(false);
  expect(runtimeFixture(f.k.store, "child")).toMatchObject({ archivePending: false, archiveError: null });
});

it("keeps a placed errand's report archive pending with the exact blocker and never runs local preservation", async () => {
  const f = await fixture(); registerTools(f.bb, f.runtime);
  f.k.store.put("members", "child", { ...f.k.member("child")!, boardQuestId: null, errand: true });
  const report = { status: "done", outcome: "Drafted", evidence: [], artifacts: [] };
  const reply = await f.harness.behavior.invokeAgentTool("tavern_report", report, { threadId: "child" });
  expect(String(reply)).toContain("save refused");
  expect(f.save).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
  expect(runtimeFixture(f.k.store, "child")).toMatchObject({ archivePending: true, archiveError: expect.stringContaining("save refused") });
  f.save.mockImplementation(async () => confirmPlacementRelease(f));
  expect(await f.runtime["archiveMembers"]([f.k.member("child")!])).toEqual([]);
  expect(f.archive).not.toHaveBeenCalled();
});

it("uses local preservation exactly once before an unplaced errand archive", async () => {
  const f = await fixture(false); registerTools(f.bb, f.runtime);
  f.k.store.put("members", "child", { ...f.k.member("child")!, boardQuestId: null, errand: true });
  await f.harness.behavior.invokeAgentTool("tavern_report", { status: "done", outcome: "Drafted", evidence: [], artifacts: [] }, { threadId: "child" });
  expect(f.local).toHaveBeenCalledOnce(); expect(f.save).not.toHaveBeenCalled(); expect(f.archive).toHaveBeenCalledOnce();
  expect(f.local.mock.invocationCallOrder[0]).toBeLessThan(f.archive.mock.invocationCallOrder[0]!);
});

it("does not use the stale pre-preservation active thread after placed release succeeds", async () => {
  const f = await fixture();
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }));
  f.save.mockImplementation(async () => confirmPlacementRelease(f));
  expect(await f.runtime.release("lead", "child", "Release")).toBe(true);
  expect(runtimeFixture(f.k.store, "child").released).toBeTruthy();
});
it("keeps a placed errand's normal preservation wait quiet and archives after confirmation", async () => {
  const f = await fixture(); registerTools(f.bb, f.runtime);
  f.k.store.put("members", "child", { ...f.k.member("child")!, boardQuestId: null, errand: true });
  f.save.mockResolvedValue({ state: "waiting", message: "Waiting for Vale to finish its turn so its work can be saved." });
  await f.harness.behavior.invokeAgentTool("tavern_report", { status: "done", outcome: "Drafted", evidence: [], artifacts: [] }, { threadId: "child" });
  expect(f.k.store.events("lead").some(event => event.type === "quest.archive-failed")).toBe(false);
  expect(f.k.member("child")?.engagement).toBe("archiving");
  f.save.mockImplementation(async () => confirmPlacementRelease(f));
  await f.runtime["archiveMembers"]([f.k.member("child")!]);
  expect(f.k.member("child")).toMatchObject({ engagement: "archived", disposition: "finished" });
});

it.each([true, false])("unarchives a done errand to the recorded state (placed: %s)", async placed => {
  const f = await fixture(placed);
  const child = f.k.member("child")!;
  f.k.store.put("members", "child", { ...child, boardQuestId: null, errand: true });
  f.bb.sdk.threads.unarchive = vi.fn(async ({ threadId }) => { f.archived.delete(threadId); return { ok: true as const, unarchivedThreadIds: [threadId] }; });
  if (placed) f.save.mockImplementation(async () => confirmPlacementRelease(f));
  const report = f.k.report("child", { status: "done", outcome: "Drafted", evidence: [], artifacts: [], confidence: null, voice: null });
  expect(await f.runtime.archiveMember("child", report.id)).toBeNull();
  const resumeTo = placed ? "released" : "resting";
  expect(f.k.store.runtime("child").memberEngagement?.archive).toEqual({ disposition: "finished", resumeTo });
  const reopened = await f.runtime.unarchiveMember("lead", "child");
  expect(f.k.member("child")?.engagement).toBe(resumeTo);
  if (placed) expect(reopened.message).toBe("Thread opened for reading. Its machine was released, so it can't take new work; hire a new member to continue.");
  else expect(reopened.message).toContain("available in your party");
});

it("does not offer a resting member with a lost machine or send it a brief", async () => {
  const f = await fixture();
  f.k.report("child", { status: "done", outcome: "Drafted", evidence: [], artifacts: [], confidence: null, voice: null });
  f.runtime.placements().preserve.observeLoss("child", "Its host was removed.");
  await expect(f.runtime.tell("lead", "child", "Draft the follow-up")).rejects.toThrow(/Smith.*Its machine was released, so it can't take new work; hire a new member to continue\./);
  expect(f.k.restatement("lead")).toMatch(/Free hands[\s\S]*machine lost: can't take new work; release it/);
  expect(f.k.member("child")?.engagement).toBe("resting");
  expect(f.save).not.toHaveBeenCalled();
});

it("keeps the disposition of unfinished placed work retired by wrap", async () => {
  const f = await fixture(); f.save.mockImplementation(async () => confirmPlacementRelease(f));
  expect((await f.wrap()).pendingArchives).toEqual([]);
  expect(f.k.store.runtime("child").memberEngagement?.archive).toEqual({ disposition: "retired unfinished", resumeTo: "released" });
  expect(f.k.store.runtime("child").memberEngagement?.release).toBeUndefined();
});

it("returns an externally archived unplaced quest member to its recorded rest", async () => {
  const f = await fixture(false);
  f.k.report("child", { status: "done", outcome: "Drafted", evidence: [], artifacts: [], confidence: null, voice: null });
  f.archived.add("child");
  f.runtime.updateThread(await f.bb.sdk.threads.get({ threadId: "child" }));
  f.bb.sdk.threads.unarchive = vi.fn(async ({ threadId }) => { f.archived.delete(threadId); return { ok: true as const, unarchivedThreadIds: [threadId] }; });
  expect((await f.runtime.unarchiveMember("lead", "child")).message).toContain("available in your party");
  expect(f.k.member("child")?.engagement).toBe("resting");
});

it("does not finish quest Stop while a member archived in bb still holds an unreconciled machine", async () => {
  const f = await fixture();
  f.archived.add("child");
  f.runtime.updateThread(await f.bb.sdk.threads.get({ threadId: "child" }));
  expect(f.k.member("child")?.engagement).toBe("archived");
  expect(f.runtime.placements().store.byMember("child")).toMatchObject({ phase: "blocked", blocked: { code: "preservation-owner-lost" } });
  const archived = f.k.store.runtime("child").memberEngagement?.archive;
  expect(await f.runtime.stop(f.quest.id)).toMatchObject({ phase: "stopping", unconfirmed: 1 });
  expect(f.k.summary(f.quest.id).members.find(m => m.threadId === "child")?.stopError).toContain("archived or deleted");
  expect(f.save).toHaveBeenCalledWith("child", expect.any(String));
  f.save.mockImplementation(async () => confirmPlacementRelease(f));
  expect(await f.runtime.stop(f.quest.id)).toMatchObject({ phase: "stopped", unconfirmed: 0 });
  expect(f.k.store.runtime("child").memberEngagement?.archive).toEqual(archived);
});

it.each(["Wrap", "Cellar"] as const)("%s retains outstanding cleanup of an already archived placement", async path => {
  const f = await fixture();
  f.archived.add("child");
  f.runtime.updateThread(await f.bb.sdk.threads.get({ threadId: "child" }));
  const archived = f.k.store.runtime("child").memberEngagement?.archive;
  const events = () => f.k.store.events("lead").filter(e => e.data.memberThreadId === "child" && e.data.engagement);
  const before = events();
  let result;
  if (path === "Wrap") result = await f.wrap();
  else {
    putQuestFixture(f.k.store, f.quest.id, { ...f.k.quest(f.quest.id), phase: "done", endedAt: f.time() });
    result = await f.runtime.archiveBoardQuests([f.quest.id], true);
  }
  expect(result.pendingArchives).toContain("child");
  expect(f.save).toHaveBeenCalledWith("child", expect.any(String));
  f.save.mockImplementation(async () => confirmPlacementRelease(f));
  expect(await f.runtime["archiveMembers"]([f.k.member("child")!])).toEqual([]);
  expect(f.k.store.runtime("child").memberEngagement?.archive).toEqual(archived);
  expect(events()).toEqual(before);
});

it("shows the preservation blocker in the Keeper's release reply", async () => {
  const f = await fixture(); registerTools(f.bb, f.runtime);
  const reply = await f.harness.behavior.invokeAgentTool("tavern_release", { memberThreadId: "child", reason: "Release" }, { threadId: "lead" });
  expect(String(reply)).toContain("save refused"); expect(String(reply)).toContain("Retry");
  expect(f.archive).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled();
});

it("lists unsaved declared files in the release reply and placement view", async () => {
  const f = await fixture(); registerTools(f.bb, f.runtime);
  const warning = "Release; Declared files not saved: /tmp/log.txt: outside the allowed checkout and thread-storage roots";
  f.save.mockImplementation(async () => {
    f.runtime.placements().store.update("placement", 1, record => ({ ...record, preservation: { ...record.preservation, source: "saved", artifacts: "unpreserved", artifactManifestId: "manifest", reason: warning } }));
    return confirmPlacementRelease(f);
  });
  const reply = await f.harness.behavior.invokeAgentTool("tavern_release", { memberThreadId: "child", reason: "Release" }, { threadId: "lead" });
  expect(String(reply)).toContain("/tmp/log.txt: outside");
  const record = f.runtime.placements().store.byMember("child")!;
  expect(f.runtime.placements().controller.view(record).preservationReason).toBe(warning);
});
it("preserves a cancelled placed hire before archive and does not archive twice", async () => {
  const f = await fixture();
  const intent = { classId: "smith", characterId: "vale", projectId: "project", createdAt: 0, owner: f.owner };
  const settle = () => settleCancelledHire(f.bb, f.k, "token", intent, "child", id => f.runtime["preserveCancelledHire"](id));
  await expect(settle()).rejects.toThrow("save refused");
  expect(f.archive).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled();
  f.save.mockImplementation(async () => confirmPlacementRelease(f));
  await settle(); expect(f.archive).not.toHaveBeenCalled();
  expect(f.k.store.get("hires", "token")).toBeNull();
});

it("preserves a cancelled local hire recovered on restart exactly once before archive", async () => {
  const f = await fixture(false);
  f.k.store.put("hires", "token", { classId: "smith", characterId: "vale", projectId: "project", createdAt: 0, cancelledAt: 1, memberThreadId: "child", owner: f.owner });
  await f.runtime.reconcile();
  expect(f.local).toHaveBeenCalledOnce(); expect(f.save).not.toHaveBeenCalled();
  expect(f.archive).toHaveBeenCalledOnce();
  expect(f.local.mock.invocationCallOrder[0]).toBeLessThan(f.archive.mock.invocationCallOrder[0]!);
  expect(f.k.store.get("hires", "token")).toBeNull();
});
