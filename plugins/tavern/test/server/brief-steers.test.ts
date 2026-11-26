// @vitest-environment node
import { expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { seedLegacyQuest, seedQuest, planInput } from "./support";
import { captureRequestSources } from "../../src/server/request-sources";
import { rpcHandlers } from "../../src/server/rpc";
import { patchThreadFixture, putMemberFixture } from "./member-fixture";

const brief = { outcome: "Format the output", mode: "make-it-work" as const, outOfScope: "Publish", doneWhen: "Tests pass", context: [], questions: ["What changed?"], timeboxMinutes: null };
async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Format", "Format");
  f.k.plan("lead", planInput(q.id));
  const other = seedLegacyQuest(f.k, "lead", "Other", "Other");
  const manifest = captureRequestSources(f.k, "lead", q.id);
  for (const [threadId, classId] of [["maker", "smith"], ["checker", "warden"]] as const)
    f.k.bind(threadId, classId, null, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", title: "Work", errand: false, brief, requestSources: manifest });
  const steer = (text: string, id = q.id) => {
    f.advance(1);
    f.k.receiveUser("lead", text);
    const route = f.k.route("lead", { kind: "steer", boardQuestId: id, summary: "Paraphrase", notes: [] });
    f.k.store.patch("lead", { userAt: null });
    return route;
  };
  const warnings = () => f.k.summary(q.id).briefSteers ?? [];
  const sends = () => f.harness.inspection.sdk.callsTo("threads.send").map(c => (c.args[0] as { input: { text: string }[] }).input[0]!.text).filter(t => t.startsWith("[Tavern tick]"));
  return { ...f, q, other, steer, warnings, sends };
}

it("shows actual applicable steers missed by both Smith and Warden, then clears the re-briefed member", async () => {
  const f = await fixture();
  expect(f.warnings()).toEqual([]);
  f.steer("Something on the other quest", f.other.id);
  expect(f.warnings()).toEqual([]);
  const steer = f.steer("use two columns");
  const expected = ["maker", "checker"].map(memberThreadId => ({ memberThreadId, at: steer.messageAt, excerpt: "use two columns" }));
  expect(f.warnings()).toEqual(expect.arrayContaining(expected));
  expect((await rpcHandlers(f.runtime).boardQuest({ id: f.q.id })).quest.briefSteers).toEqual(expect.arrayContaining(expected));
  expect((await rpcHandlers(f.runtime).ledger({ threadId: "lead" })).boardQuests.find(q => q.id === f.q.id)?.briefSteers).toEqual(expect.arrayContaining(expected));
  await f.runtime.tell("lead", "maker", "Use the new layout");
  expect(f.warnings()).toEqual([expected[1]]);
});

it("marks a real hire after a steer and stops showing the fact when the member is released", async () => {
  const f = await fixture();
  const member = await f.runtime.hire("lead", "project", { classId: "ranger", boardQuestId: f.q.id, errand: false, title: "Scout", brief: { ...brief, timeboxMinutes: 5 } });
  f.steer("use the short heading");
  expect(f.warnings().find(w => w.memberThreadId === member.threadId)?.excerpt).toBe("use the short heading");
  patchThreadFixture(f.k.store, member.threadId, { released: { reason: "Not needed", decisionId: "release" } });
  expect(f.warnings().some(w => w.memberThreadId === member.threadId)).toBe(false);
});

it("keeps the warning for a resting member until a delivered re-brief", async () => {
  const f = await fixture();
  putMemberFixture(f.k.store, "maker", { state: "done" });
  f.steer("Keep the header");
  expect(f.warnings().find(w => w.memberThreadId === "maker")?.excerpt).toBe("Keep the header");
  await f.runtime.tell("lead", "maker", "Keep the header");
  expect(f.warnings().some(w => w.memberThreadId === "maker")).toBe(false);
});

it("leaves a held quest's warning in the view and sends it once after resume", async () => {
  const f = await fixture();
  f.k.setQuestHeld(f.q.id, true, { kind: "user" });
  f.steer("Keep the heading");
  expect(f.warnings()).toHaveLength(2);
  const tick = async () => { f.advance(61_000); await f.runtime.tick("lead"); };
  await tick();
  expect(f.sends().join("\n")).not.toContain("brief predates");
  f.k.setQuestHeld(f.q.id, false, { kind: "user" });
  await tick();
  expect(f.sends().at(-1)).toContain("brief predates the user's steer");
  await tick();
  expect(f.sends().filter(text => text.includes("brief predates"))).toHaveLength(1);
});

it("only delivers brief warnings when the missing source set changes", async () => {
  const f = await fixture();
  const tick = async () => { f.advance(61_000); await f.runtime.tick("lead"); };
  f.steer("use two columns");
  await tick();
  expect(f.sends().at(-1)).toContain("brief predates the user's steer");
  expect(f.sends().at(-1)).toContain('use two columns');
  expect(f.sends().filter(t => t.includes("brief predates"))).toHaveLength(1);
  await tick();
  expect(f.sends().filter(t => t.includes("brief predates"))).toHaveLength(1);
  f.steer("keep the header");
  await tick();
  expect(f.sends().filter(t => t.includes("brief predates"))).toHaveLength(2);
  expect(f.sends().at(-1)).toContain('keep the header');
  await tick();
  expect(f.sends().filter(t => t.includes("brief predates"))).toHaveLength(2);
});
