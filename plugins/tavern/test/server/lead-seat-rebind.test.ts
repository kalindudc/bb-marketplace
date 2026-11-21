// @vitest-environment node
import { expect, it, vi } from "vitest";
import { makeThreadResponse } from "./host";
import { ownershipSteps } from "../../src/server/keeper/succession-ownership";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest, waypointEntry } from "./support";
import { createJournalStore } from "../../src/server/journal/store";

it("moves the live seat once in the cutover transaction with its journal result and unchanged hire history", async () => {
  const f = setup(), { k } = f;
  const parent = await seedQuest(k, "lead", "Coordinate two tracks", "Tracks");
  const input = planInput(parent.id);
  k.plan("lead", { ...input, waypoints: [{ ...input.waypoints[0]!, owner: "keeper" }], party: [{ classId: "keeper", characterId: null, model: "anthropic/claude-sonnet-5-5", purpose: "Coordinate the child", waypointIds: ["w1"], leadEnvelope: { depth: 1, members: 2, rangers: 0 } }] });
  k.answerAsk(k.store.openAsks("lead", parent.id)[0]!.id, "approve", null, "page", "user");
  const lead = await f.runtime.hire("lead", "project", { classId: "keeper", boardQuestId: parent.id, waypointId: "w1", title: "Child work", brief: { outcome: "Coordinate two tracks", mode: "make-it-work", outOfScope: "No deployment", doneWhen: "Both tracks pass", context: [], questions: [], timeboxMinutes: null } });
  const child = await k.openQuest(lead.threadId, "Child quest", "Child");
  const link = k.store.get("leadLinks", lead.leadLinkId!)!;
  const journal = createJournalStore(f.bb, k.store.db, { roleOf: id => k.member(id), invalidate: () => {} });
  const entry = waypointEntry(lead.threadId, parent.id);
  k.store.db.prepare("INSERT INTO questlog_logs(thread_id,hydrated) VALUES(?,1)").run(lead.threadId);
  k.store.db.prepare("INSERT INTO questlog_entries(thread_id,id,data) VALUES(?,?,?)").run(lead.threadId, entry.id, JSON.stringify(entry));
  const result = { eventId: 20, makerThreadId: lead.threadId, entryId: entry.id };
  k.store.put("leadLinks", link.id, { ...link, result });
  const op = k.succession.propose(lead.threadId, { kind: "user" }, "Refresh lead");
  k.succession.prepare(op.id, []);
  k.succession.bindCandidate(op.id, "successor");
  expect(journal.get(lead.threadId).entries).toContainEqual(entry);
  expect(k.store.get("leadLinks", link.id)?.result).toEqual(result);
  const steps = ownershipSteps(k);
  expect(() => k.succession.cutover(op.id, [...steps, () => { throw new Error("Cutover failed"); }])).toThrow("Cutover failed");
  expect(k.member("successor")).toBeNull();
  expect(k.quest(child.id).keeperThreadId).toBe(lead.threadId);
  expect(k.store.get("leadLinks", link.id)).toMatchObject({ childKeeperThreadId: lead.threadId, result });
  expect(k.succession.cutover(op.id, steps).state).toBe("done");
  expect(k.store.get("leadLinks", link.id)?.result).toEqual({ ...result, makerThreadId: "successor" });
  expect(k.quest(child.id).keeperThreadId).toBe("successor");
  expect(k.succession.current(lead.threadId)).toBe("successor");
  expect(journal.get("successor").entries).toContainEqual({ ...entry, threadId: "successor", owner: "successor" });
  expect(journal.get(lead.threadId).entries).toHaveLength(0);
  expect(() => k.succession.cutover(op.id, steps)).toThrow();
  expect(k.store.activeStaffing("lead").map(m => m.threadId)).toEqual(["successor"]);
  expect(k.store.get("leadLinks", link.id)).toMatchObject({ childKeeperThreadId: "successor", childQuestId: child.id, generation: 2, result: { ...result, makerThreadId: "successor" } });
  expect(k.store.events("lead").find(event => event.type === "lead.bound")?.data).toMatchObject({ memberThreadId: lead.threadId, receipt: { kind: "hire", id: link.hireToken } });
  expect(k.member("successor")).toMatchObject({ leadLinkId: link.id, waypointId: "w1", engagement: "active" });
  expect(() => k.require(lead.threadId, "keeper")).toThrow();
  expect(k.require("successor", "keeper").threadId).toBe("successor");

  let successor = makeThreadResponse({ id: "successor", visibility: "hidden" });
  const get = vi.spyOn(f.bb.sdk.threads, "get").mockImplementation(async ({ threadId }) => threadId === "successor"
    ? successor : makeThreadResponse({ id: threadId, parentThreadId: "lead", parentNotifications: "stuck" }));
  const update = vi.spyOn(f.bb.sdk.threads, "update").mockImplementation(async input => {
    if (input.threadId === "successor") successor = { ...successor,
      parentThreadId: input.parentThreadId ?? successor.parentThreadId,
      parentNotifications: input.parentNotifications ?? successor.parentNotifications,
      visibility: input.visibility ?? successor.visibility };
    return successor;
  });
  await f.runtime.succession.advance(op.id);
  expect(successor).toMatchObject({ parentThreadId: "lead", parentNotifications: "stuck", visibility: "visible" });
  expect(update.mock.calls.map(([input]) => input)).toEqual([
    { threadId: "successor", parentThreadId: "lead", parentNotifications: "stuck" },
    { threadId: "successor", visibility: "visible" },
  ]);
  get.mockRestore(); update.mockRestore();
});
