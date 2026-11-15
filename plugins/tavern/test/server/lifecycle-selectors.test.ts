// @vitest-environment node
import { seedQuest } from "./support";
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { planInput, waypointEntry } from "./support";
import { rpcHandlers } from "../../src/server/rpc";
import { boardMirrors } from "../../src/server/journal/board-mirrors";
import { journalEntrySchema } from "../../src/shared/schema";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null };
async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  const member = f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: true, title: "Build", brief });
  return { ...f, q, member };
}
it.each(["released", "release-pending", "archive-pending", "deleted", "archived", "ended"] as const)("SQL staffing, allocation and errand counts agree on %s members, and names stay taken while the thread is live", async state => {
  const f = await fixture();
  if (state === "released") f.k.store.patch("child", { released: { reason: "Done", decisionId: "d" } });
  if (state === "release-pending") f.k.store.patch("child", { releasePending: "Stop" });
  if (state === "archive-pending") f.k.store.patch("child", { archivePending: true });
  if (state === "deleted") f.k.store.patch("child", { deletedAt: f.time() });
  if (state === "archived") f.k.store.patch("child", { archivedAt: f.time() });
  if (state === "ended") f.k.store.put("quests", f.q.id, { ...f.q, phase: "done", endedAt: f.time() });
  const occupied = state === "release-pending" ? 1 : 0;
  expect(f.k.store.activeStaffing("lead")).toHaveLength(occupied);
  expect(f.k.store.allocated(f.q.id, "smith")).toBe(occupied);
  expect(f.k.store.errandsPage("lead", 100, 0).inFlightCount).toBe(occupied);
  const nameTaken = ["release-pending", "archive-pending", "ended"].includes(state);
  expect(f.runtime.busyCharacters("project").includes("juno")).toBe(nameTaken);
  f.advance(24 * 60 * 60_000);
  f.k.stale("lead");
  expect(f.k.member("child")?.strikes).toBe(0);
});
it("done pending rebriefs reserve slots but are not shown as active work", async () => {
  const f = await fixture();
  f.k.activity("child", "done");
  f.k.store.patch("child", { pendingBrief: { id: "b", text: "Again", attempts: 0, nextAttemptAt: 0, attemptedAt: null, hostAfterSeq: null, error: null } });
  expect(f.k.store.activeStaffing("lead")).toHaveLength(1);
  expect(f.k.store.allocated(f.q.id, "smith")).toBe(1);
  expect(f.k.store.errandsPage("lead", 100, 0).inFlightCount).toBe(1);
});
it.each(["archived", "quiet"] as const)("review budget ignores a %s Keeper's abandoned work", async state => {
  const f = await fixture();
  f.k.plan("lead", planInput(f.q.id));
  f.port.linkedEntries = () => [waypointEntry("child", f.q.id)];
  expect(f.runtime.review().waiting).toBe(1);
  f.k.store.patch("lead", state === "archived" ? { archivedAt: f.time() } : { manualStopAt: f.time() });
  expect(f.runtime.review("automatic").waiting).toBe(0);
  expect(f.runtime.review().waiting).toBe(state === "quiet" ? 1 : 0);
});
it("room keeps an old in-flight errand past 100 newer quest members and omits finished solos", async () => {
  const f = await fixture();
  for (let i = 0; i < 105; i++) f.k.store.put("members", `new-${i}`, { ...f.member, threadId: `new-${i}`, errand: false });
  f.k.bind("solo", "smith", "juno", "project");
  f.k.activity("solo", "done");
  const room = await rpcHandlers(f.runtime).room({});
  expect(room.keepers[0]?.errands.map(member => member.threadId)).toContain("child");
  expect(room.solos).toHaveLength(0);
});
it("confirmed releases emit the event used by insights and the tuner exactly once", async () => {
  const f = await fixture();
  f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
  await f.runtime.release("lead", "child", "Not needed");
  await f.runtime.release("lead", "child", "Not needed");
  expect(f.k.store.events("lead").filter(event => event.type === "member.released")).toMatchObject([{ data: { memberThreadId: "child" } }]);
});
it("a stopped board mirror is blocked, not completed", () => {
  const entry = journalEntrySchema.parse({ threadId: "lead", id: "00", link: null, description: "Quest: Build", boardQuestId: "board", status: "todo", parentId: null, owner: null, note: null, order: 0, createdAt: 1, updatedAt: 1, createdBy: { kind: "tavern" }, updatedBy: { kind: "tavern" }, evidence: [] });
  const [mirror] = boardMirrors([entry], [{ id: "board", title: "Build", phase: "stopped", updatedAt: 2, endedAt: 2 }], 3);
  expect(mirror).toMatchObject({ status: "blocked", doneAt: null, doneBy: null });
  expect(mirror?.note).not.toContain("use tavern_wrap");
});
it("unpause skips gone and manually stopped Keepers and closes old failure asks before reanchoring", () => {
  const f = setup();
  f.k.bind("gone", "keeper", "wren", "project");
  f.k.store.patch("gone", { archivedAt: f.time() });
  f.k.bind("quiet", "keeper", "wren", "project");
  f.k.store.patch("quiet", { manualStopAt: f.time() });
  const ask = f.k.ask("lead", { kind: "blocker", question: "Retry?", why: "Failed", options: [{ id: "retry", label: "Retry", detail: "", recommended: true }], meanwhile: "Wait", holds: [] });
  f.k.store.patch("lead", { failureCount: 2, failureAskId: ask.id, tickRefusalCount: 2 });
  const base = f.runtime.config();
  let paused = true;
  vi.spyOn(f.runtime, "config").mockImplementation(() => ({ ...base, tavern: { ...base.tavern, paused } }));
  vi.spyOn(f.runtime, "tick").mockResolvedValue();
  f.runtime.settingsChanged();
  paused = false;
  f.runtime.settingsChanged();
  expect(f.k.store.runtime("lead")).toMatchObject({ failureCount: 0, tickRefusalCount: 0, failureAskId: null });
  expect(f.k.store.get("asks", ask.id)?.state).toBe("withdrawn");
  expect(f.k.store.runtime("gone").reanchor).toBeNull();
  expect(f.k.store.runtime("quiet").reanchor).toBeNull();
});
