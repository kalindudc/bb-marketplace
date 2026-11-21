// @vitest-environment node
import { patchThreadFixture, runtimeFixture } from "../server/member-fixture";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../server/runtime-fixture";
import { planInput } from "../server/support";
import { TavernRuntime } from "../../src/server/runtime";

const brief = { outcome: "Implement the test", doneWhen: "Tests pass", mode: "make-it-work" as const, outOfScope: "", context: [], questions: [], timeboxMinutes: null };
const rebrief = "Continue with the next part of the approved task";
async function planned() {
  const f = setup();
  f.k.receiveUser("lead", "Build the test");
  f.k.route("lead", { kind: "new-quest", summary: "Build", notes: [] });
  const quest = await f.k.openQuest("lead", "Build the test", "Build");
  await f.runtime.plan("lead", { ...planInput(quest.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
  f.k.answerAsk(f.k.asks("lead").find(ask => ask.kind === "greenlight")!.id, "approve", null, "page", "user");
  const input = { classId: "smith", boardQuestId: quest.id, waypointId: "w1", title: "Build the test", brief };
  return { ...f, input };
}
describe("durable explicit briefs", () => {
  it("preserves a hired member's slot while a later brief fails and retries from sweep", async () => {
    const f = await planned(), spawn = vi.spyOn(f.bb.sdk.threads, "spawn");
    const member = await f.runtime.hire("lead", "project", f.input);
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValueOnce(new Error("socket hang up"));
    expect(await f.runtime.sendRebrief(member.threadId, rebrief)).toEqual({ briefPending: true });
    expect(runtimeFixture(f.k.store, member.threadId).pendingBrief).toMatchObject({ attempts: 1 });
    expect(f.k.store.events("lead", 0, 100).some(event => event.type === "member.unbriefed")).toBe(true);
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);
    f.advance(60_001); await f.runtime.sweep();
    expect(send.mock.calls.filter(([input]) => input.threadId === member.threadId)).toHaveLength(2);
    expect(runtimeFixture(f.k.store, member.threadId).pendingBrief).toBeNull();
    expect(f.k.store.runtime(member.threadId).briefVersion).toBe(2);
  });
  it("keeps a failed member's character leased while its later brief is pending", async () => {
    const f = await planned(), member = await f.runtime.hire("lead", "project", f.input);
    vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValueOnce(new Error("socket hang up"));
    await f.runtime.sendRebrief(member.threadId, rebrief);
    f.k.activity(member.threadId, "failed");
    expect(f.runtime.busyCharacters(member)).toContain(member.characterId);
    patchThreadFixture(f.k.store, member.threadId, { released: { reason: "Confirmed release", decisionId: "release-test" } });
    expect(f.runtime.busyCharacters(member)).not.toContain(member.characterId);
  });
  it("does not duplicate an accepted rebrief when its acknowledgement was lost", async () => {
    const f = await planned(), member = await f.runtime.hire("lead", "project", f.input);
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValueOnce(new Error("socket hang up after acceptance"));
    await f.runtime.sendRebrief(member.threadId, rebrief);
    const accepted = send.mock.calls[0]![0].input;
    vi.spyOn(f.bb.sdk.threads.events, "list").mockImplementation(async input => input.types?.includes("client/turn/requested") ? [{ seq: 1, createdAt: f.time(), type: "client/turn/requested", data: { originPluginId: "tavern", input: accepted } }] as never : []);
    f.advance(60_001); await f.runtime.sweep();
    expect(send.mock.calls.filter(([input]) => input.threadId === member.threadId)).toHaveLength(1);
    expect(runtimeFixture(f.k.store, member.threadId).pendingBrief).toBeNull();
    expect(f.k.store.runtime(member.threadId).briefVersion).toBe(2);
  });
  it("does not call a queued rebrief delivered before dispatch acknowledges it", async () => {
    const f = await planned(), member = await f.runtime.hire("lead", "project", f.input);
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    expect(await f.runtime.sendRebrief(member.threadId, rebrief)).toEqual({ briefPending: true });
    expect(f.k.store.runtime(member.threadId).briefVersion).toBe(1);
    f.runtime.dispatched({ threadId: member.threadId, originPluginId: "tavern", content: send.mock.calls[0]![0].input } as never);
    expect(runtimeFixture(f.k.store, member.threadId).pendingBrief).toBeNull();
    expect(f.k.store.runtime(member.threadId).briefVersion).toBe(2);
  });
  it("does not automatically resend a queued rebrief the user cancelled", async () => {
    const f = await planned(), member = await f.runtime.hire("lead", "project", f.input);
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockResolvedValueOnce({ delivery: "queued" } as never);
    await f.runtime.sendRebrief(member.threadId, rebrief);
    f.runtime.cancelled({ threadId: member.threadId, originPluginId: "tavern", content: send.mock.calls[0]![0].input } as never);
    f.advance(3_600_000); await f.runtime.sweep();
    expect(send.mock.calls.filter(([input]) => input.threadId === member.threadId)).toHaveLength(1);
    expect(f.k.store.openAsks("lead").some(ask => ask.kind === "blocker")).toBe(true);
  });
  it("does not retry a brief while Tavern is paused", async () => {
    const f = await planned(), member = await f.runtime.hire("lead", "project", f.input);
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockRejectedValueOnce(new Error("offline"));
    await f.runtime.sendRebrief(member.threadId, rebrief);
    let paused = true;
    const config = f.runtime.config();
    vi.spyOn(f.runtime, "config").mockImplementation(() => ({ ...config, tavern: { ...config.tavern, paused } }));
    f.runtime.settingsChanged();
    f.advance(60_001); await f.runtime.sweep();
    expect(send.mock.calls.filter(([input]) => input.threadId === member.threadId)).toHaveLength(1);
    paused = false; f.runtime.settingsChanged(); await f.runtime.sweep();
    expect(send.mock.calls.filter(([input]) => input.threadId === member.threadId)).toHaveLength(2);
  });
  it("survives a runtime restart with the exact stored rebrief and bounded retries", async () => {
    const f = await planned(), member = await f.runtime.hire("lead", "project", f.input);
    const send = vi.spyOn(f.bb.sdk.threads, "send").mockImplementation(async input => {
      if (input.threadId !== "lead") throw new Error("offline");
      return { delivery: "sent" } as never;
    });
    await f.runtime.sendRebrief(member.threadId, rebrief);
    const pending = runtimeFixture(f.k.store, member.threadId).pendingBrief!;
    const runtime = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    expect(await runtime.sendInitialBrief(member.threadId, pending.text)).toEqual({ briefPending: true });
    for (let attempt = 0; attempt < 10; attempt++) { f.advance(3_600_000); await runtime.sweep(); }
    const attempts = send.mock.calls.filter(([input]) => input.threadId === member.threadId);
    expect(attempts).toHaveLength(5);
    expect(attempts.every(([input]) => JSON.stringify(input.input).includes(pending.id))).toBe(true);
    expect(runtimeFixture(f.k.store, member.threadId).pendingBrief).toMatchObject({ attempts: 5 });
    expect(f.k.member(member.threadId)).not.toBeNull();
    const blockers = f.k.store.openAsks("lead").filter(ask => ask.kind === "blocker");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.options.map(option => option.id)).toEqual(["retry", "release"]);
    await runtime.sweep();
    expect(f.k.store.openAsks("lead").filter(ask => ask.kind === "blocker")).toHaveLength(1);
    await runtime.answerAsk(blockers[0]!.id, "retry", null, "page");
    expect(runtimeFixture(f.k.store, member.threadId).pendingBrief!.attempts).toBe(1);
  });
});
