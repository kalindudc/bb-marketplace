// @vitest-environment node
import { expect, it } from "vitest";
import { ownershipSteps } from "../../src/server/keeper/succession-ownership";
import { captureRequestSources, readRequestSources } from "../../src/server/request-sources";
import { PlacementStore } from "../../src/server/placement/store";
import { setup } from "./runtime-fixture";
import { placementRecord } from "./placement-fixture";
import { seedQuest, waypointEntry } from "./support";
import { createJournalStore } from "../../src/server/journal/store";

const user = { kind: "user" } as const;
const party = [{ threadId: "maker", notifications: "stuck" as const }];

it("moves one charge and its unread work without changing source bytes or historical actors", async () => {
  const { k, runtime, time } = setup();
  const raw = 'Keep the exact bytes: "π" 🦊.';
  const quest = await seedQuest(k, "lead", raw, "Carry the charge");
  const manifest = captureRequestSources(k, "lead", quest.id);
  k.bind("maker", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: quest.id, waypointId: null, title: "Work", errand: false,
    brief: { outcome: "Work", mode: "make-it-work", doneWhen: "Evidence", outOfScope: "Publish", context: [], questions: [], timeboxMinutes: null }, requestSources: manifest });
  const ask = k.ask("lead", { kind: "decision", effect: { type: "answer-blocker" }, question: "Which option?", why: "Both apply", options: [{ id: "keep", label: "Keep", detail: "Leave it", recommended: true }, { id: "change", label: "Change", detail: "Change it", recommended: false }], holds: [], meanwhile: "Work continues" });
  const placements = new PlacementStore(k.store.db);
  const placement = placements.reserve(placementRecord({ keeperThreadId: "lead", questId: quest.id, memberThreadId: "maker" }), { maxMakers: 10, maxCheckers: 10 });
  k.store.db.prepare("INSERT INTO questlog_logs(thread_id,hydrated) VALUES(?,1)").run("lead");
  const entry = { ...waypointEntry("lead", quest.id), link: null };
  k.store.db.prepare("INSERT INTO questlog_entries(thread_id,id,data) VALUES(?,?,?)").run("lead", entry.id, JSON.stringify(entry));
  k.store.db.prepare("INSERT INTO questlog_history(thread_id,before_data,after_data,action,actor,state) VALUES(?,?,?,?,?,'undo')").run("lead", "[]", JSON.stringify([entry]), "add", JSON.stringify(entry.createdBy));
  const seen = k.store.event(time(), "lead", quest.id, "report.filed", "Already seen");
  const unread = k.store.event(time(), "lead", quest.id, "report.filed", "Still unread", {}, { kind: "agent", threadId: "maker" });
  k.store.patch("lead", { cursor: seen, factContinuation: { eventId: unread, offset: 23 } });
  k.store.putTick({ id: "old-tick", threadId: "lead", text: "Do not replay this input", cursor: unread, reportIds: [], reanchor: null, createdAt: time(), attempted: true, rowId: "old-row", state: "queued" });
  const journal = createJournalStore(runtime.bb, k.store.db, { roleOf: id => k.member(id), invalidate: () => {}, isRetired: id => k.succession.fence(id)?.kind === "retired" });
  const routeId = manifest.sources[0]!.routeId;
  const pr = k.store.recordPullRequest({ keeperThreadId: "lead", boardQuestId: quest.id, projectId: "project",
    url: "https://example.test/repo/pull/12", forge: null, head: "feature", base: "main", owner: "lead", memberThreadId: "maker",
    memberHead: "a".repeat(40), pushedHead: null, verifiedCommit: null, state: "draft" }, time());
  expect(k.quest(quest.id).keeperThreadId).toBe("lead");
  expect(k.store.all("members").find(member => member.threadId === "maker")?.keeperThreadId).toBe("lead");
  expect(k.member("maker")?.keeperThreadId).toBe("lead");
  expect(k.store.get("routes", routeId)?.keeperThreadId).toBe("lead");
  expect(k.store.get("pullRequests", pr.id)).toEqual(pr);
  expect(journal.get("lead").entries).toContainEqual(entry);

  const succession = runtime.succession.state;
  expect(succession.fence("lead")).toBeNull();
  expect(succession.fence("successor")).toBeNull();
  const op = succession.propose("lead", user, "Fresh context");
  succession.prepare(op.id, party);
  succession.bindCandidate(op.id, "successor");
  expect(succession.fence("lead")).toEqual({ kind: "preparing" });
  expect(succession.fence("successor")).toEqual({ kind: "candidate" });
  succession.cutover(op.id, ownershipSteps(k));

  expect(k.quest(quest.id).keeperThreadId).toBe("successor");
  expect(k.member("maker")?.keeperThreadId).toBe("successor");
  expect(k.store.get("routes", routeId)?.keeperThreadId).toBe("successor");
  expect(k.store.get("pullRequests", pr.id)).toEqual({ ...pr, keeperThreadId: "successor", owner: "successor" });
  expect(journal.get("successor").entries).toContainEqual({ ...entry, threadId: "successor", owner: "successor" });
  expect(succession.get(op.id).followups.members).toEqual([{ ...party[0], done: false }]);
  expect(readRequestSources(k, "maker", { manifestId: manifest.id })).toMatchObject({ text: raw, source: manifest.sources[0] });
  expect(captureRequestSources(k, "successor", quest.id).sources).toEqual(manifest.sources);
  expect(k.memory.userWords({ ...k.store.get("routes", manifest.sources[0]!.routeId)!, userText: undefined, sourceMessageId: undefined, summary: "A paraphrase" })).toBe(raw);
  expect(k.store.db.prepare("SELECT thread_id FROM tavern_messages WHERE id=?").pluck().get(manifest.sources[0]!.sourceMessageId)).toBe("lead");
  expect(k.store.get("asks", ask.id)).toMatchObject({ keeperThreadId: "successor", state: "open" });
  await runtime.answerAsk(ask.id, "keep", null, "page", true);
  await expect(runtime.answerAsk(ask.id, "change", null, "page", true)).rejects.toThrow(/no longer open|already answered/i);
  expect(k.store.get("asks", ask.id)?.answer?.optionId).toBe("keep");
  expect(JSON.parse(String(k.store.db.prepare("SELECT data FROM questlog_entries WHERE thread_id=? AND id=?").pluck().get("successor", entry.id)))).toEqual({ ...entry, threadId: "successor", owner: "successor" });
  const history = k.store.db.prepare("SELECT after_data,actor FROM questlog_history WHERE thread_id=?").get("successor") as { after_data: string; actor: string };
  expect(JSON.parse(history.after_data)[0]).toMatchObject({ id: entry.id, threadId: "successor", owner: "successor" });
  expect(JSON.parse(history.actor)).toEqual(entry.createdBy);
  expect(placements.get(placement.id)).toEqual(placement);
  expect(placements.counts("successor").makers).toBe(1);
  expect(k.store.tick("old-tick")).toMatchObject({ state: "cancelled", text: "" });
  expect(k.store.runtime("successor")).toMatchObject({ cursor: seen, factContinuation: { eventId: unread, offset: 23 } });
  expect(k.store.unreadEvents("successor", seen)).toContainEqual(expect.objectContaining({ id: unread, actor: { kind: "agent", threadId: "maker" }, keeperThreadId: "lead" }));
  expect(k.store.unreadEvents("successor", seen).some(event => event.id === seen)).toBe(false);
  expect(journal.get("lead").entries).toEqual([]);
  await journal.ready("lead");
  expect(k.store.db.prepare("SELECT 1 FROM questlog_logs WHERE thread_id='lead'").get()).toBeUndefined();
});
