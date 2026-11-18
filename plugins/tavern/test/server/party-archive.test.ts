// @vitest-environment node
import { concludeQuest, putQuestFixture } from "./support";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest, planInput } from "./support";
import { makeThreadResponse } from "./host";
const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const brief = { outcome: "Check", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null };
async function fixture() {
  const f = setup(); dbs.push(f.k.store.db);
  const q = await seedQuest(f.k, "lead", "Build", "Build");
  f.k.plan("lead", { ...planInput(q.id), waypoints: [{ ...planInput(q.id).waypoints[0]!, optional: true }] });
  const bind = (id: string, classId = "warden") => f.k.bind(id, classId, classId === "warden" ? "vex" : "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Check", brief });
  bind("released"); bind("failed", "smith"); bind("stopped"); bind("current", "ranger");
  f.k.store.patch("released", { released: { reason: "Replaced", decisionId: "release" } });
  f.k.activity("failed", "failed"); f.k.activity("stopped", "stopped");
  const archived = new Set<string>();
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, archivedAt: archived.has(threadId) ? f.time() : null }));
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  f.bb.sdk.threads.archive = vi.fn(async ({ threadId }) => { archived.add(threadId); return { ok: true as const, archivedThreadIds: [threadId] }; });
  return { ...f, q, bind, archived };
}
it("wrap archives the whole party without crediting released, failed or stopped members", async () => {
  const f = await fixture();
  const excluded = ["released", "failed", "stopped"].map(id => f.k.member(id));
  await concludeQuest(f.runtime, "lead", f.q.id, "Done", "", [{ waypointId: "w1", reason: "Not needed" }], []);
  expect([...f.archived].sort()).toEqual(["current", "failed", "released", "stopped"]);
  expect(["released", "failed", "stopped"].map(id => f.k.member(id))).toEqual(excluded);
  expect(f.k.member("current")?.state).toBe("done");
  expect(f.archived.has("lead")).toBe(false);
});
it("queues archives for released members only after Stop has completed", async () => {
  const f = await fixture();
  let active = true;
  f.bb.sdk.threads.get = vi.fn(async ({ threadId }) => makeThreadResponse({ id: threadId, status: active && threadId === "current" ? "active" : "idle" }));
  expect((await f.runtime.stop(f.q.id)).phase).toBe("stopping");
  expect(f.bb.sdk.threads.archive).not.toHaveBeenCalled();
  active = false;
  expect((await f.runtime.stop(f.q.id)).phase).toBe("stopped");
  expect([...f.archived].sort()).toEqual(["current", "failed", "released", "stopped"]);
});
it.each(["done", "stopped"] as const)("repairs stranded %s parties once, preserves user-unarchived threads, and retries failures", async phase => {
  const f = await fixture();
  putQuestFixture(f.k.store, f.q.id, { ...f.k.quest(f.q.id), phase, endedAt: f.time() });
  f.k.store.event(f.time(), "lead", f.q.id, "thread.archived", "Previously archived", { memberThreadId: "current", keeperArchiveRequested: true });
  f.k.store.event(f.time(), "lead", f.q.id, "thread.unarchived", "User restored", { memberThreadId: "current" });
  f.k.store.event(f.time(), "lead", f.q.id, "thread.unarchived", "User restored without an archive receipt", { memberThreadId: "stopped" });
  let fail = true;
  const archive = f.bb.sdk.threads.archive;
  f.bb.sdk.threads.archive = vi.fn(async args => { if (fail && args.threadId === "released") throw Error("offline"); return archive(args); });
  await f.runtime.reconcile();
  expect(f.k.store.runtime("released").archivePending).toBe(true);
  expect(f.archived.has("current")).toBe(false);
  expect(f.archived.has("stopped")).toBe(false);
  fail = false;
  await f.runtime.sweep();
  expect(f.archived.has("released")).toBe(true);
  expect(f.k.store.runtime("released").archivePending).toBe(false);
  f.archived.delete("released");
  vi.mocked(f.bb.sdk.threads.archive).mockClear();
  await f.runtime.reconcile();
  expect(f.bb.sdk.threads.archive).not.toHaveBeenCalled();
});
it("leaves active quests and errands outside the startup repair", async () => {
  const f = await fixture();
  f.k.bind("errand", "ranger", "juno", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Scout", brief });
  await f.runtime.reconcile();
  expect(f.bb.sdk.threads.archive).not.toHaveBeenCalled();
  for (const id of ["released", "failed", "stopped", "current", "errand"]) expect(f.k.store.runtime(id).archivePending).not.toBe(true);
});
it("holds repaired archives during closing time and later resumes cleanup", async () => {
  const f = await fixture();
  putQuestFixture(f.k.store, f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time() });
  const held = vi.spyOn(f.runtime.away, "cleanupHeld").mockReturnValue(true);
  await f.runtime.reconcile();
  expect(f.bb.sdk.threads.archive).not.toHaveBeenCalled();
  expect(f.k.store.runtime("released").archivePending).toBe(true);
  held.mockReturnValue(false);
  await f.runtime.sweep();
  expect(f.archived.has("released")).toBe(true);
});
it("holds whole-party archive cleanup during closing time", async () => {
  const f = await fixture();
  vi.spyOn(f.runtime.away, "cleanupHeld").mockReturnValue(true);
  await concludeQuest(f.runtime, "lead", f.q.id, "Done", "", [{ waypointId: "w1", reason: "Not needed" }], []);
  expect(f.bb.sdk.threads.archive).not.toHaveBeenCalled();
  for (const id of ["released", "failed", "stopped", "current"]) expect(f.k.store.runtime(id).archivePending).toBe(true);
});
