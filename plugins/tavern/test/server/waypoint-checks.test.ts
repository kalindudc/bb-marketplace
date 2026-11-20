// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { attention } from "../../src/server/attention";
import { memberCredits } from "../../src/server/tale";
import { rpcHandlers } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest, waypointEntry } from "./support";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const baseWaypoint = planInput("fixture").waypoints[0]!;
const completed = { status: "done" as const, outcome: "The evidence is attached.", evidence: [], artifacts: [], confidence: null, voice: null };

async function fixture() {
  const f = setup(); databases.push(f.k.store.db);
  registerTools(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Watch the release", "Watch");
  const base = planInput(q.id);
  const ask = (kind: "greenlight" | "conclude") => f.k.store.openAsks("lead", q.id).find(a => a.kind === kind);
  const tool = (name: string, args: Record<string, unknown>) => f.harness.behavior.invokeAgentTool(name, args, { threadId: "lead" });
  const settle = (as: "accepted" | "skipped" | "open", waypointId = "w1", reason = "No more work is needed") => tool("tavern_settle", { boardQuestId: q.id, waypointId, as, reason });
  const propose = (waypoints: unknown[], extra: Record<string, unknown> = {}) => tool("tavern_plan", { ...base, waypoints, ...extra });
  const summary = () => f.k.summary(q.id);
  const approve = () => f.runtime.answerAsk(ask("greenlight")!.id, "approve", null, "page", true);
  const conclude = async () => {
    const card = await f.runtime.proposeWrap("lead", q.id, "Watch complete", "");
    expect(summary().phase).toBe("closing");
    expect(ask("conclude")?.options[0]?.id).toBe("conclude");
    await f.runtime.answerAsk(card.askId!, "conclude", null, "page", true);
  };
  const bind = (threadId: string, classId: "warden" | "ranger") => f.k.bind(threadId, classId, classId === "warden" ? "rook" : "fern", "project", {
    keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Watch the release",
    brief: { outcome: "Watch the release", mode: "make-it-work", outOfScope: "Deploying", doneWhen: "Updates read", context: [], questions: [], timeboxMinutes: null },
  });
  const entries = (rows: ReturnType<typeof waypointEntry>[]) => {
    f.port.linkedEntries = () => rows;
    const get = f.port.get;
    f.port.get = id => ({ ...get(id), entries: rows.filter(row => row.threadId === id) });
  };
  return { ...f, q, base, ask, propose, settle, approve, summary, conclude, bind, entries };
}

describe("planned waypoint checks", () => {
  it("takes a three-waypoint watch from scout to done without hiring a Warden or earning verified wins", async () => {
    const f = await fixture();
    expect(f.summary().phase).toBe("scout");
    const waypoints = [1, 2, 3].map(i => ({ ...baseWaypoint, id: `w${i}`, title: `Read update ${i}`, check: "none" }));
    await f.propose(waypoints);
    expect(f.summary().phase).toBe("greenlight");
    await f.approve();
    expect(f.summary().phase).toBe("build");
    f.bind("watcher", "ranger");
    f.entries(waypoints.map(({ id }, i) => waypointEntry("watcher", f.q.id, id, `a${i + 1}`)));
    f.k.report("watcher", completed);
    expect(f.summary().waypoints.map(w => [w.check, w.state])).toEqual(Array(3).fill(["none", "done"]));
    await f.conclude();
    expect(f.summary().phase).toBe("done");
    expect(f.summary().members.map(m => [m.classId, m.verifiedWins])).toEqual([["ranger", 0]]);
    expect(f.k.store.get("serviceRecords", f.q.id)?.waypoints).toMatchObject({ verified: 0, total: 3 });
  });

  it("waits for Keeper acceptance and keeps the Ledger and attention list on the same resolution word", async () => {
    const f = await fixture();
    await f.propose([{ ...baseWaypoint, check: "keeper" }]);
    await f.approve();
    await expect(f.settle("accepted")).rejects.toThrow(/reported/i);
    f.bind("maker", "ranger");
    f.entries([waypointEntry("maker", f.q.id)]);
    expect(f.summary().waypoints[0]?.state).toBe("reported");
    const early = await f.runtime.proposeWrap("lead", f.q.id, "Watch complete", "");
    expect(f.ask("conclude")?.effect?.type).toBe("close-early");
    await f.runtime.answerAsk(early.askId!, "hold", null, "page", true);
    await f.settle("accepted", "w1", "The source notes answer the question");
    const waypoint = f.summary().waypoints[0]!;
    expect(waypoint).toMatchObject({ state: "accepted", resolutionReason: "The source notes answer the question", verifiedBy: null });
    const item = attention(f.k.store, { boardQuestId: f.q.id }).items.find(item => item.kind === "decided")!;
    expect(item.title).toMatch(new RegExp(`\\b${waypoint.state}\\b`, "i"));
    const ledger = await rpcHandlers(f.runtime).ledger({ threadId: "lead" });
    expect(ledger.boardQuests.find(q => q.id === f.q.id)?.waypoints[0]?.state).toBe(waypoint.state);
    expect(ledger.decidedForYou).toContainEqual(expect.objectContaining({ id: item.id, text: item.title, reversible: true }));
    await f.conclude();
    expect(f.k.member("maker")?.verifiedWins).toBe(0);
  });

  it("explains required checks in new plans while preserving a stored plan and old skip", async () => {
    const f = await fixture();
    await expect(f.propose([baseWaypoint])).rejects.toThrow(/warden.*keeper.*none/i);
    f.k.plan("lead", { ...f.base, waypoints: [baseWaypoint, { ...baseWaypoint, id: "w2", optional: true }] });
    const key = `${f.q.id}:1:w2`;
    f.k.store.put("skips", key, { boardQuestId: f.q.id, version: 1, waypointId: "w2" });
    f.k.store.event(f.time(), "lead", f.q.id, "waypoint.skipped", "Old skip", { waypointId: "w2", version: 1, reason: "Not needed" });
    f.entries([waypointEntry("maker", f.q.id)]);
    expect(f.summary().waypoints).toMatchObject([{ check: "warden", state: "reported" }, { check: "warden", state: "skipped", resolutionReason: "Not needed" }]);
  });

  it("lets the Keeper skip only optional work and reopen or Undo the call", async () => {
    const f = await fixture();
    await f.propose([{ ...baseWaypoint, check: "warden" }, { ...baseWaypoint, id: "w2", check: "none", optional: true }]);
    await f.approve();
    await expect(f.settle("skipped")).rejects.toThrow(/optional/i);
    await f.settle("skipped", "w2");
    expect(f.summary().waypoints[1]?.state).toBe("skipped");
    const skip = f.k.store.query("decisions", "boardQuestId", f.q.id).find(d => /skipped/i.test(d.text))!;
    expect(skip).toMatchObject({ reversible: true, source: "keeper" });
    await f.runtime.undoDecision(skip.id);
    expect(f.summary().waypoints[1]?.state).toBe("planned");
    await f.settle("skipped", "w2");
    await f.settle("open", "w2", "The update is needed after all");
    expect(f.summary().waypoints[1]?.state).toBe("planned");
    const reopened = f.k.store.query("decisions", "boardQuestId", f.q.id).find(d => /reopened/i.test(d.text))!;
    await f.runtime.undoDecision(reopened.id);
    expect(f.summary().waypoints[1]?.state).toBe("skipped");
  });

  it("settles your mark, but leaves an answered outside gate open until the Keeper accepts it", async () => {
    const f = await fixture();
    const link = vi.spyOn(f.port, "linkWaypoint");
    await f.propose([{ ...baseWaypoint, actor: "user", check: "you", owner: null }, { ...baseWaypoint, id: "w2", actor: "outside", check: "keeper", owner: "Release team" }]);
    await f.approve();
    expect(link).toHaveBeenCalledWith("lead", { boardQuestId: f.q.id, waypointId: "w1" }, baseWaypoint.title, "You", { kind: "agent", threadId: "lead" });
    const entry = waypointEntry("lead", f.q.id);
    f.entries([{ ...entry, doneBy: { kind: "agent", threadId: "lead" } }]);
    expect(f.summary().waypoints[0]?.state).not.toBe("done");
    f.entries([{ ...entry, doneBy: { kind: "user" } }]);
    await expect(f.settle("accepted", "w2")).rejects.toThrow(/gate answer/i);
    f.k.memory.gate("lead", { boardQuestId: f.q.id, waypointId: "w2", askedWho: "Release team", via: "Their channel", answer: "No, not this week" });
    expect(f.summary().waypoints).toMatchObject([{ check: "you", state: "done" }, { check: "keeper", state: "planned", gate: { answer: "No, not this week" } }]);
    await f.settle("accepted", "w2", "Deferring until next week meets the goal");
    expect(f.summary().waypoints[1]).toMatchObject({ state: "accepted", resolutionReason: "Deferring until next week meets the goal", gate: { answer: "No, not this week" } });
    const decision = f.k.store.query("decisions", "boardQuestId", f.q.id).at(-1)!;
    await f.runtime.undoDecision(decision.id);
    expect(f.summary().waypoints[1]).toMatchObject({ state: "planned", gate: { answer: "No, not this week" } });
    await f.settle("accepted", "w2", "Deferring until next week meets the goal");
    await f.conclude();
  });

  it("asks again for weaker checks, or applies the same change from a routed steer with Undo", async () => {
    const f = await fixture();
    await f.propose([{ ...baseWaypoint, check: "warden" }]);
    await f.approve();
    await f.propose([{ ...baseWaypoint, check: "none" }]);
    expect(f.ask("greenlight")?.effect).toMatchObject({ type: "greenlight", planVersion: 2 });
    f.advance(1);
    f.k.receiveUser("lead", "Drop the Warden check for this watch.");
    const route = f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "No Warden check", notes: [] });
    await f.propose([{ ...baseWaypoint, check: "none" }], { fromSteer: route.id });
    expect(f.summary().phase).toBe("build");
    expect(f.ask("greenlight")).toBeUndefined();
    const decision = f.k.store.query("decisions", "boardQuestId", f.q.id).find(d => d.source === "steer")!;
    expect(decision).toMatchObject({ sourceRef: route.id, reversible: true, checkChange: { steer: { text: "Drop the Warden check for this watch." } } });
    expect(attention(f.k.store, { boardQuestId: f.q.id }).items).toContainEqual(expect.objectContaining({ id: decision.id, kind: "decided" }));
    await f.runtime.undoDecision(decision.id);
    expect(f.summary().phase).toBe("greenlight");
    expect(f.ask("greenlight")?.effect).toMatchObject({ planVersion: 3 });
  });

  it("does not let a pending replacement hide an omitted unsettled Warden check", async () => {
    const f = await fixture();
    await f.propose([{ ...baseWaypoint, check: "warden" }]);
    await f.approve();
    await f.propose([{ ...baseWaypoint, id: "w2", check: "none" }]);
    expect(f.ask("greenlight")?.effect).toMatchObject({ planVersion: 2, requiresExplicit: true });
    await f.propose([{ ...baseWaypoint, id: "w3", check: "none" }]);
    expect(f.ask("greenlight")?.effect).toMatchObject({ planVersion: 3, requiresExplicit: true });
  });

  it("does not demand a new greenlight to take a finished check off the map", async () => {
    const f = await fixture();
    await f.propose([{ ...baseWaypoint, check: "warden" }]);
    await f.approve();
    f.entries([{ ...waypointEntry("maker", f.q.id), status: "verified" }]);
    expect(f.summary().waypoints[0]?.state).toBe("verified");
    await f.propose([{ ...baseWaypoint, id: "w2", check: "none" }]);
    expect(f.ask("greenlight")).toBeUndefined();
    expect(f.summary().phase).toBe("build");
  });

  it("does not let automatic approval replace explicit greenlight for weaker checks", async () => {
    const f = await fixture();
    const party = [{ classId: "ranger", characterId: null, model: null, purpose: "Watch", waypointIds: ["w1"] }];
    await f.propose([{ ...baseWaypoint, check: "warden" }], { party });
    await f.approve();
    const settings = f.k.settings;
    f.k.settings = () => ({ ...settings(), keepers: { ...settings().keepers, greenlight: "by-size" } });
    await f.propose([{ ...baseWaypoint, check: "keeper" }], { party, reversible: true });
    expect(f.ask("greenlight")?.effect).toMatchObject({ planVersion: 2, requiresExplicit: true });
    expect(f.summary().phase).toBe("greenlight");
    expect(f.k.quest(f.q.id).greenlitVersion).toBe(1);
  });

  it("converts skips in an existing open conclude draft to decisions when it is answered", async () => {
    const f = await fixture();
    await f.propose([{ ...baseWaypoint, check: "warden", optional: true }]);
    await f.approve();
    const ask = f.k.ask("lead", {
      boardQuestId: f.q.id, kind: "conclude", question: "Can the watch finish?", why: "No watch was needed", meanwhile: "Waiting", holds: ["w1"],
      options: [{ id: "conclude", label: "Conclude", detail: "Tell the tale", recommended: true }],
      effect: { type: "conclude", draft: { outcome: "No watch needed", left: "", skipped: [{ waypointId: "w1", reason: "No release" }] } },
    });
    await f.runtime.answerAsk(ask.id, "conclude", null, "page", true);
    expect(f.summary().waypoints[0]).toMatchObject({ state: "skipped", resolutionReason: "No release" });
    expect(f.k.store.query("decisions", "boardQuestId", f.q.id)).toContainEqual(expect.objectContaining({ source: "ask", sourceRef: ask.id, waypointCall: { planVersion: 1, waypointId: "w1", as: "skipped" } }));
    expect(f.k.store.all("skips")).toEqual([]);
  });

  it("uses the same verified resolution for summary, tale credits and service credit", async () => {
    const f = await fixture();
    await f.propose([{ ...baseWaypoint, check: "warden" }, { ...baseWaypoint, id: "w2", check: "none" }]);
    await f.approve();
    f.bind("maker", "ranger"); f.bind("checker", "warden");
    const verdict = (id: string, entryId: string) => ({ ...waypointEntry("maker", f.q.id, id, entryId), status: "verified" as const, updatedBy: { kind: "agent" as const, threadId: "checker" } });
    f.entries([verdict("w1", "a1"), verdict("w2", "a2")]);
    expect(f.summary().waypoints.map(w => w.state)).toEqual(["verified", "done"]);
    await f.conclude();
    expect(memberCredits(f.summary())).toEqual([
      { memberThreadId: "maker", madeWaypointIds: ["w1", "w2"], verifiedWaypointIds: [] },
      { memberThreadId: "checker", madeWaypointIds: [], verifiedWaypointIds: ["w1"] },
    ]);
    expect(f.k.member("maker")?.verifiedWins).toBe(1);
    expect(f.k.store.get("serviceRecords", f.q.id)).toMatchObject({ waypoints: { verified: 1, total: 2 }, credits: expect.arrayContaining([expect.objectContaining({ role: "maker", verifiedWaypoints: 1 })]) });
  });
});
