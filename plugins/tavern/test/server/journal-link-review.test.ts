// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createJournalStore } from "../../src/server/journal/store";
import { PlacementStore } from "../../src/server/placement/store";
import { placementRecord } from "./placement-fixture";
import { setup } from "./runtime-fixture";
import { planInput, seedLegacyQuest, seedQuest } from "./support";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Publishing", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null };
const proof = [{ kind: "command" as const, ref: "node check.js", detail: "Pass", exitCode: 0 }];

async function fixture(fallbackToRawRole = false) {
  const f = setup();
  f.bb.sdk.threads.getPluginMetadata = async () => ({});
  f.bb.sdk.threads.stop = async () => ({ ok: true });
  const journal = createJournalStore(f.bb, f.k.store.db, {
    roleOf: id => f.runtime.journalRole(id) ?? (fallbackToRawRole ? f.k.store.get("members", id) : null),
    invalidate: () => {},
    reviewed: review => f.runtime.serviceRecords.reviewed(review),
  });
  Object.assign(f.port, journal);
  const q = await seedQuest(f.k, "lead", "Build", "Build");
  const foreign = seedLegacyQuest(f.k, "lead", "Other work", "Other");
  const bind = (threadId: string, classId: string, boardQuestId: string, waypointId: string | null, model?: string) => {
    f.k.bind(threadId, classId, classId === "warden" ? "rook" : "bram", "project", {
      keeperThreadId: "lead", boardQuestId, waypointId, title: "Work", brief, errand: false,
    });
    if (model) f.k.store.patch(threadId, { classExecutionChoice: { providerId: "pi", model, recordedAt: f.time(), reasoningLevel: null, modelSource: null, reasoningSource: null } });
  };
  bind("maker", "smith", q.id, "w1", "anthropic/claude-sonnet");
  bind("other", "smith", q.id, "w2");
  bind("checker", "warden", q.id, null, "openai/gpt");
  bind("same-family", "warden", q.id, null, "anthropic/claude-opus");
  bind("unknown", "warden", q.id, null);
  bind("foreign", "warden", foreign.id, null, "openai/gpt");
  const base = planInput(q.id);
  const waypoint = { ...base.waypoints[0]!, owner: null, check: "warden" as const };
  f.k.plan("lead", { ...base, waypoints: [waypoint, { ...waypoint, id: "w2", owner: "other" }, { ...waypoint, id: "w3" }, { ...waypoint, id: "w4", actor: "user", check: "you" }] });
  f.k.answerAsk(f.k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
  const add = async (threadId: string, description: string, owner?: string) => {
    expect(await journal.runTool(threadId, { action: "add", description, owner })).toMatchObject({ isError: false });
    return journal.get(threadId).entries.at(-1)!.id;
  };
  const link = (threadId: string, id: string, waypointId = "w1", boardQuestId = q.id) =>
    journal.runTool(threadId, { action: "link", id, link: { boardQuestId, waypointId } });
  const submit = (threadId: string, id: string) => journal.runTool(threadId, { action: "done", id, evidence: proof });
  return { ...f, q, foreign, journal, add, link, submit };
}

it("keeps a plain journal usable without an owner, link or evidence, even on a member thread", async () => {
  const f = await fixture();
  for (const threadId of ["solo", "maker"]) {
    const id = await f.add(threadId, "Plain checklist");
    expect(await f.journal.runTool(threadId, { action: "start", id })).toMatchObject({ isError: false });
    expect(await f.journal.runTool(threadId, { action: "done", id })).toMatchObject({ isError: false });
    expect(f.journal.get(threadId).entries[0]).toMatchObject({ status: "done", link: null, owner: null, evidence: [] });
    expect(await f.journal.runTool(threadId, { action: "undo" })).toMatchObject({ isError: false });
    expect(await f.journal.runTool(threadId, { action: "delete", id })).toMatchObject({ isError: false });
  }
});

it("links an active member's own entry without a Keeper edit, but not outside its assignment", async () => {
  const f = await fixture();
  const id = await f.add("maker", "Retry case");
  const delegated = await f.add("maker", "Other person’s work", "other");
  expect(await f.link("maker", id, "w1", f.foreign.id)).toMatchObject({ isError: true });
  for (const waypointId of ["w2", "w3", "w4", "missing"]) expect(await f.link("maker", id, waypointId)).toMatchObject({ isError: true });
  expect(await f.link("maker", delegated)).toMatchObject({ isError: true });
  expect(await f.journal.runTool("other", { action: "link", threadId: "maker", id, link: { boardQuestId: f.q.id, waypointId: "w2" } })).toMatchObject({ isError: true });
  const maker = f.k.member("maker");
  expect(await f.link("maker", id)).toMatchObject({ isError: false });
  expect(f.k.member("maker")).toEqual(maker);
  const owned = await f.add("other", "Explicitly assigned by the plan");
  expect(await f.link("other", owned, "w2")).toMatchObject({ isError: false });
  expect(await f.journal.runTool("maker", { action: "done", id })).toMatchObject({ isError: true, text: expect.stringMatching(/evidence/) });
  expect(await f.journal.runTool("maker", { action: "link", id, link: null })).toMatchObject({ isError: true });
  expect(await f.journal.runTool("maker", { action: "undo" })).toMatchObject({ isError: true });
  expect(f.journal.get("maker").entries).toMatchObject([{ id, link: { boardQuestId: f.q.id, waypointId: "w1" } }, { id: delegated, link: null }]);
});

it("does not treat queued brief targets as assignments until the brief lands", async () => {
  const f = await fixture();
  const id = await f.add("maker", "Work from the follow-up");
  const send = f.bb.sdk.threads.send;
  f.bb.sdk.threads.send = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockImplementation(send);
  expect(await f.runtime.tell("lead", "maker", "Add another case", undefined, undefined, ["w3"])).toMatchObject({ status: "retrying" });
  expect(await f.link("maker", id, "w3")).toMatchObject({ isError: true });
  f.advance(61_000);
  await f.runtime.retryInitialBriefs("lead");
  expect(await f.link("maker", id, "w3")).toMatchObject({ isError: false });
});

it("lets a slotless same-quest Warden find and check submitted evidence, keeping review boundaries", async () => {
  const f = await fixture();
  expect(f.k.checkerWaypoints("checker")).toEqual([]);
  const privateId = await f.add("maker", "Private note");
  await f.journal.prepare("maker");
  const id = f.journal.linkWaypoint("maker", { boardQuestId: f.q.id, waypointId: "w1" }, "Ready for a check", "maker", { kind: "tavern" });
  const verify = (checker: string, evidence = proof) => f.journal.runTool(checker, { action: "verify", threadId: "maker", id, evidence });
  const reject = () => f.journal.runTool("checker", { action: "reject", threadId: "maker", id, reason: "Missing a case" });
  expect(await verify("checker")).toMatchObject({ isError: true, text: expect.stringMatching(/reported done/) });
  expect(await reject()).toMatchObject({ isError: true });
  expect(await f.submit("maker", id)).toMatchObject({ isError: false });
  const listed = await f.journal.runTool("checker", { action: "list", threadId: "maker" });
  expect(listed).toMatchObject({ isError: false, text: expect.stringContaining("Ready for a check") });
  expect(listed.text).not.toContain("Private note");
  expect(await f.journal.runTool("checker", { action: "get", threadId: "maker", id: privateId, ids: [id] })).toMatchObject({ isError: true });
  expect(await verify("foreign")).toMatchObject({ isError: true });
  expect(await verify("maker")).toMatchObject({ isError: true });
  expect(await verify("same-family")).toMatchObject({ isError: true, text: expect.stringMatching(/same-family/) });
  expect(await verify("checker", [])).toMatchObject({ isError: true, text: expect.stringMatching(/own evidence/) });
  expect(await reject()).toMatchObject({ isError: false });
  expect(await f.journal.runTool("maker", { action: "done", id })).toMatchObject({ isError: true, text: expect.stringMatching(/after that rejection/) });
  expect(await f.journal.runTool("maker", { action: "done", id, evidence: [{ ...proof[0]!, detail: "New case passes" }] })).toMatchObject({ isError: false });
  expect(await verify("unknown")).toMatchObject({ isError: false, text: expect.stringContaining("check independence not established") });
  expect(f.k.store.all("serviceVerdicts")).toEqual(expect.arrayContaining([
    expect.objectContaining({ verdict: "rejected", independence: "independent" }),
    expect.objectContaining({ verdict: "verified", independence: "not-established" }),
  ]));
});

it.each(["verify", "reject"] as const)("does not let a second Warden %s an independently verified entry", async action => {
  const f = await fixture();
  const id = await f.add("maker", "Work");
  expect(await f.link("maker", id)).toMatchObject({ isError: false });
  expect(await f.submit("maker", id)).toMatchObject({ isError: false });
  const target = { threadId: "maker", id, evidence: proof };
  expect(await f.journal.runTool("checker", { action: "verify", ...target })).toMatchObject({ isError: false });
  const before = f.journal.get("maker").entries;
  expect(await f.journal.runTool("unknown", { action, ...target, ...(action === "reject" ? { reason: "I disagree" } : {}) })).toMatchObject({ isError: true });
  expect(f.journal.get("maker").entries).toEqual(before);
  expect(f.k.store.all("serviceVerdicts")).toMatchObject([{ verdict: "verified", independence: "independent", checker: { threadId: "checker" } }]);
});

it("refuses a released Warden even if the role lookup returns its raw member record", async () => {
  const f = await fixture(true);
  const id = await f.add("maker", "Awaiting a check");
  expect(await f.link("maker", id)).toMatchObject({ isError: false });
  expect(await f.submit("maker", id)).toMatchObject({ isError: false });
  expect(await f.runtime.release("lead", "checker", "No longer needed")).toBe(true);
  expect(f.runtime.journalRole("checker")).toBeNull();
  expect(f.k.store.get("members", "checker")).toMatchObject({ classId: "warden", boardQuestId: f.q.id });
  expect(await f.journal.runTool("checker", { action: "reject", threadId: "maker", id, reason: "Too late" })).toMatchObject({ isError: true });
  expect(f.journal.get("maker").entries[0]).toMatchObject({ status: "done", review: null });
  expect(f.k.store.all("serviceVerdicts")).toHaveLength(0);
});

it("does not let an active Warden review other Wardens or other targets than its placed snapshot", async () => {
  const f = await fixture();
  for (const threadId of ["other", "unknown", "checker"]) {
    await f.journal.prepare(threadId);
    const id = f.journal.linkWaypoint(threadId, { boardQuestId: f.q.id, waypointId: "w2" }, "Work", threadId, { kind: "tavern" });
    expect(await f.submit(threadId, id)).toMatchObject({ isError: false });
    if (threadId === "other") continue;
    expect(await f.journal.runTool("checker", { action: "verify", threadId, id, evidence: proof })).toMatchObject({ isError: true });
  }
  f.k.store.patch("checker", { reviewTarget: { boardQuestId: f.q.id, waypointId: "w1", makerThreadId: "maker", entryIds: ["00"], snapshotId: "snapshot" } });
  expect(await f.journal.runTool("checker", { action: "verify", threadId: "other", id: "00", evidence: proof })).toMatchObject({ isError: true, text: expect.stringMatching(/exact submitted journal targets/) });
});

it("does not allow a slotless local Warden to bypass the placed maker's snapshot check", async () => {
  const f = await fixture();
  new PlacementStore(f.k.store.db).reserve(placementRecord({ keeperThreadId: "lead", memberThreadId: "maker", questId: f.q.id }), { maxMakers: 2, maxCheckers: 2 });
  const id = await f.add("maker", "Placed submission");
  expect(await f.link("maker", id)).toMatchObject({ isError: false });
  expect(await f.submit("maker", id)).toMatchObject({ isError: false });
  for (const action of ["verify", "reject"] as const) {
    expect(await f.journal.runTool("checker", { action, threadId: "maker", id, evidence: proof, reason: "Missing a case" })).toMatchObject({ isError: true, text: expect.stringMatching(/pinned.*snapshot/) });
  }
  expect(f.journal.get("maker").entries[0]?.status).toBe("done");
});

it("leaves unfinished entries and checked proof intact on release, and release revokes link and review authority", async () => {
  const f = await fixture();
  const open = await f.add("maker", "Unfinished");
  const done = await f.add("maker", "Finished");
  for (const id of [open, done]) expect(await f.link("maker", id)).toMatchObject({ isError: false });
  expect(await f.journal.runTool("maker", { action: "start", id: open })).toMatchObject({ isError: false });
  expect(await f.submit("maker", done)).toMatchObject({ isError: false });
  expect(await f.journal.runTool("checker", { action: "verify", threadId: "maker", id: done, evidence: proof })).toMatchObject({ isError: false });
  const before = f.journal.get("maker").entries;
  expect(await f.runtime.release("lead", "maker", "Free the seat")).toBe(true);
  expect(f.journal.get("maker").entries).toEqual(before);
  const extra = await f.add("maker", "Still a plain journal");
  expect(await f.link("maker", extra)).toMatchObject({ isError: true });
  expect(await f.runtime.release("lead", "checker", "Finished checking")).toBe(true);
  expect(await f.journal.runTool("checker", { action: "reject", threadId: "maker", id: done, reason: "Too late" })).toMatchObject({ isError: true });
  expect(f.journal.get("maker").entries.find(entry => entry.id === done)).toEqual(before.find(entry => entry.id === done));
});
