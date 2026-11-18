// @vitest-environment node
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
  const f = setup({ threads: { archive, stop: async () => ({ ok: true }), queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) }, get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, archivedAt: archived.has(threadId) ? 100 : null }) } });
  fixtures.push(f);
  const quest = await seedQuest(f.k, "lead", "Draft", "Tested draft");
  f.k.plan("lead", { ...planInput(quest.id), waypoints: [{ ...planInput(quest.id).waypoints[0]!, optional: true }] });
  const owner = { keeperThreadId: "lead", boardQuestId: quest.id, waypointId: null, errand: false, title: "Draft", brief };
  f.k.bind("child", "smith", "vale", "project", owner);
  f.runtime.spawnBriefDelivered("child");
  if (placed) f.runtime.placements().store.reserve(placementRecord({ memberThreadId: "child", keeperThreadId: "lead", questId: quest.id }), { maxMakers: 2, maxCheckers: 2 });
  const local = vi.spyOn(f.runtime, "preserveWorkOrRefuse").mockResolvedValue(null);
  vi.spyOn(f.runtime.placements(), "host", "get").mockReturnValue({ call: vi.fn(), onWorkerExit: () => () => {} });
  const save = vi.spyOn(f.runtime.placements().preserve, "beforeRelease").mockResolvedValue({ state: "blocked", message: "save refused" });
  const wrap = () => f.runtime.wrap("lead", quest.id, "Draft tested", "", [{ waypointId: "w1", reason: "Optional" }]);
  return { ...f, quest, owner, archive, archived, local, save, wrap };
}

it.each(["wrap", "conclude", "cellar", "delete"] as const)("preserves a placed member before %s archives it and retains a failed save for Retry", async path => {
  const f = await fixture();
  let pending: string[];
  if (path === "wrap") pending = (await f.wrap()).pendingArchives;
  else if (path === "conclude") {
    const proposed = await f.runtime.proposeWrap("lead", f.quest.id, "Draft tested", "", [{ waypointId: "w1", reason: "Optional" }], []);
    expect(f.save).not.toHaveBeenCalled();
    await f.runtime.answerAsk(proposed.askId!, "conclude", null, "page", true);
    pending = f.k.store.runtime("child").archivePending ? ["child"] : [];
  } else {
    f.k.store.put("quests", f.quest.id, { ...f.k.quest(f.quest.id), phase: "done", endedAt: f.time() });
    pending = path === "cellar" ? (await f.runtime.archiveBoardQuests([f.quest.id], true)).pendingArchives : (await f.runtime.deleteBoardQuest(f.quest.id)).pendingArchives;
  }
  expect(pending).toContain("child");
  expect(f.save).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalledWith("child");
  expect(f.archive.mock.calls.some(([input]) => input.threadId === "child")).toBe(false);
  expect(f.k.store.runtime("child").archiveError).toContain("save refused");
  f.save.mockResolvedValue({ state: "released" });
  expect(await f.runtime["archiveMembers"]([f.k.member("child")!])).toEqual([]);
  expect(f.archive.mock.calls.some(([input]) => input.threadId === "child")).toBe(false);
  expect(f.k.store.runtime("child")).toMatchObject({ archivePending: false, archiveError: null });
});

it("keeps a placed errand's report archive pending with the exact blocker and never runs local preservation", async () => {
  const f = await fixture(); registerTools(f.bb, f.runtime);
  f.k.store.put("members", "child", { ...f.k.member("child")!, boardQuestId: null, errand: true });
  const report = { status: "done", outcome: "Drafted", evidence: [], artifacts: [] };
  const reply = await f.harness.behavior.invokeAgentTool("tavern_report", report, { threadId: "child" });
  expect(String(reply)).toContain("save refused");
  expect(f.save).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
  expect(f.k.store.runtime("child")).toMatchObject({ archivePending: true, archiveError: expect.stringContaining("save refused") });
  f.save.mockResolvedValue({ state: "released" });
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

it("keeps unplaced release on main's non-committing path", async () => {
  const f = await fixture(false);
  f.local.mockResolvedValue("local save refused");
  expect(await f.runtime.release("lead", "child", "Release")).toBe(true);
  expect(f.local).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  expect(f.archive).not.toHaveBeenCalled();
});
it("does not use the stale pre-preservation active thread after placed release succeeds", async () => {
  const f = await fixture();
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }));
  f.save.mockResolvedValue({ state: "released" });
  expect(await f.runtime.release("lead", "child", "Release")).toBe(true);
  expect(f.k.store.runtime("child").released).toBeTruthy();
});
it("keeps a placed errand's normal preservation wait quiet and records done after archive", async () => {
  const f = await fixture(); registerTools(f.bb, f.runtime);
  f.k.store.put("members", "child", { ...f.k.member("child")!, boardQuestId: null, errand: true });
  f.save.mockResolvedValue({ state: "waiting", message: "Waiting for Vale to finish its turn so its work can be saved." });
  const activity = vi.spyOn(f.k, "activity");
  await f.harness.behavior.invokeAgentTool("tavern_report", { status: "done", outcome: "Drafted", evidence: [], artifacts: [] }, { threadId: "child" });
  expect(f.k.store.events("lead").some(event => event.type === "quest.archive-failed")).toBe(false);
  expect(activity).not.toHaveBeenCalledWith("child", "done");
  f.save.mockResolvedValue({ state: "released" });
  await f.runtime["archiveMembers"]([f.k.member("child")!]);
  expect(activity.mock.calls.filter(([threadId, state]) => threadId === "child" && state === "done")).toHaveLength(1);
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
    return { state: "released" };
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
  f.save.mockImplementation(async () => { f.archived.add("child"); return { state: "released" }; });
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
