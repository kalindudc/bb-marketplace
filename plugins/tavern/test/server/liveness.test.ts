// @vitest-environment node
import { fixtureActivity, patchThreadFixture, putMemberFixture } from "./member-fixture";
import { planInput, putQuestFixture } from "./support";
import { seedQuest } from "./support";
import { describe, expect, it } from "vitest";
import { isLiveKeeper, isLiveMember, isOpenQuest } from "../../src/server/liveness";
import { setup } from "./runtime-fixture";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null };
async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  const member = f.k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Build", brief });
  return { ...f, q, member };
}
describe("shared lifecycle purposes", () => {
  it("keeps the failed member's slot but leaves the move with the Keeper", async () => {
    const { k, q, member } = await fixture();
    k.plan("lead", planInput(q.id));
    const ask = k.store.openAsks("lead", q.id)[0]!;
    k.answerAsk(ask.id, "approve", null, "page", "user");
    expect(k.summary(q.id).move.who).toBe("party");
    k.activity(member.threadId, "failed");
    expect(k.store.activeStaffing("lead").map(row => row.threadId)).toContain(member.threadId);
    expect(k.summary(q.id).move.who).toBe("keeper");
  });
  it("keeps done rebriefs out of work counts while retaining the slot", async () => {
    const { k, member } = await fixture();
    const done = { ...member, engagement: "resting" as const };
    expect(isLiveMember(k.store, done, "work")).toBe(false);
    expect(isLiveMember(k.store, done, "brief")).toBe(true);
    expect(isLiveMember(k.store, done, "occupy")).toBe(false);
    putMemberFixture(k.store, done.threadId, done);
    patchThreadFixture(k.store, done.threadId, { pendingBrief: { id: "b", text: "Again", attempts: 0, nextAttemptAt: 0, attemptedAt: null, hostAfterSeq: null, error: null } });
    const rebriefed = k.member(done.threadId)!;
    expect(isLiveMember(k.store, rebriefed, "occupy")).toBe(true);
    expect(isLiveMember(k.store, done, "work")).toBe(false);
    expect(isLiveMember(k.store, { ...rebriefed, state: "failed" }, "occupy")).toBe(true);
  });
  it.each(["done", "stopped", "stopping"] as const)("excludes linked %s quests for every purpose", async phase => {
    const { k, q, member } = await fixture();
    putQuestFixture(k.store, q.id, { ...q, phase } as typeof q);
    for (const purpose of ["work", "brief", "occupy"] as const) expect(isLiveMember(k.store, member, purpose)).toBe(false);
    expect(isOpenQuest(k.quest(q.id))).toBe(false);
  });
  it("keeps solos and unattached errands independent but follows an errand's parent quest", async () => {
    const { k, q, member } = await fixture();
    const solo = k.bind("solo", "smith", "juno", "project");
    const errand = k.bind("errand", "ranger", "juno", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Scout", brief });
    putQuestFixture(k.store, q.id, { ...q, phase: "done", endedAt: k.now() });
    expect(isLiveMember(k.store, solo)).toBe(true);
    expect(isLiveMember(k.store, errand)).toBe(true);
    expect(isLiveMember(k.store, { ...member, errand: true })).toBe(false);
  });
  it.each([{ archivedAt: 1 }, { deletedAt: 1 }, { releasePending: "stop" }, { released: { reason: "stop", decisionId: "d" } }, { archivePending: true }])("excludes unavailable member %j", async state => {
    const { k, member } = await fixture();
    patchThreadFixture(k.store, member.threadId, state);
    for (const purpose of ["work", "brief", "occupy"] as const) expect(isLiveMember(k.store, k.member(member.threadId), purpose)).toBe(purpose === "occupy" && "releasePending" in state);
  });
  it("respects manual-stop for automation but not stale cached Keeper stopped state", () => {
    const { k } = setup();
    fixtureActivity(k, "lead", "stopped");
    expect(isLiveKeeper(k.store, k.member("lead"))).toBe(true);
    k.store.patch("lead", { manualStopAt: k.now() });
    expect(isLiveKeeper(k.store, k.member("lead"), "automatic")).toBe(false);
    expect(isLiveKeeper(k.store, k.member("lead"), "present")).toBe(true);
    patchThreadFixture(k.store, "lead", { deletedAt: k.now() });
    expect(isLiveKeeper(k.store, k.member("lead"), "present")).toBe(false);
  });
});
