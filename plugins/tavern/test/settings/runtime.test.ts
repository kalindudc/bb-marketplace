// @vitest-environment node
import { putQuestFixture } from "../server/support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../server/runtime-fixture";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { LIMITS } from "../../src/server/limits";
import { planSchema } from "../../src/shared/schema";
import { planInput } from "../server/support";
import { dispatch049, queued049 } from "../server/dispatch-fixture";
import { registerRpc } from "../../src/server/rpc";

function fixture() {
  const f = setup();
  const settings = new SettingsStore(f.k.store.db, f.time);
  const insights = new InsightsReader(f.k.store.db, settings, f.time);
  f.runtime.enableSettings(settings, insights);
  return { ...f, settings, insights };
}
describe("live settings integration", () => {
  it("preserves the message and typing holds, then applies a changed hold without reload", () => {
    const f = fixture();
    f.k.store.patch("lead", { typingAt: f.time() - 44000 });
    expect(f.runtime.held("lead")).toBe(true);
    f.advance(1001);
    expect(f.runtime.held("lead")).toBe(false);
    f.settings.update({ revision: 0, patch: { knobs: { typingHoldSeconds: 90 } }, why: "Longer typing hold" });
    expect(f.runtime.held("lead")).toBe(true);
    f.k.store.patch("lead", { typingAt: null, userAt: f.time() - 59000 });
    expect(f.runtime.held("lead")).toBe(true);
    f.advance(1001);
    expect(f.runtime.held("lead")).toBe(false);
  });
  it("changes the review budget and model picker overlay without mutating class files", () => {
    const f = fixture(), original = f.runtime.registry.read().classes.find(c => c.id === "smith")!;
    f.settings.update({ revision: 0, patch: { attention: { reviewBudget: 7 }, classes: { smith: { provider: "openai", model: "new-model", reasoning: "high" } } }, why: "Use selected execution" });
    expect(f.runtime.review().budget).toBe(7);
    expect(f.runtime.snapshot().classes.find(c => c.id === "smith")).toMatchObject({ provider: "openai", model: "new-model", reasoning: "high" });
    expect(f.runtime.registry.read().classes.find(c => c.id === "smith")).toEqual(original);
  });
  it("applies party and Ranger ceilings while requiring each Ranger brief's own time box", async () => {
    const f = fixture();
    f.settings.update({ revision: 0, patch: { keepers: { partyMax: 1 }, knobs: { rangerTimeboxMaxMinutes: 8 } }, why: "Smaller party and scouting ceiling" });
    const input = { classId: "ranger", title: "Scout", errand: true,
      brief: { outcome: "Read", mode: "make-it-work" as const, outOfScope: "", doneWhen: "Read", context: [], questions: ["What exists?"], timeboxMinutes: 9 } };
    await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/at most 8/);
    await f.runtime.hire("lead", "project", { ...input, brief: { ...input.brief, timeboxMinutes: 6 } });
    await expect(f.runtime.hire("lead", "project", { ...input, brief: { ...input.brief, timeboxMinutes: 6 } })).rejects.toThrow(/party budget/);
  });
  it("keeps pushes off in quiet hours without holding orchestration", async () => {
    const f = fixture(), push = vi.spyOn(f.bb.sdk.plugins, "callRpc");
    f.settings.update({ revision: 0, patch: { attention: { quietHours: { start: "23:00", end: "02:00", timeZone: "UTC" } } }, why: "Sleep" });
    await f.runtime.push("lead", "Blocker", "Waiting for you");
    expect(push).not.toHaveBeenCalled();
    expect(f.runtime.held("lead")).toBe(false);
    f.settings.update({ revision: 1, patch: { attention: { quietHours: null, notify: "none" } }, why: "No notifications" });
    await f.runtime.push("lead", "Blocker", "Waiting for you");
    expect(push).not.toHaveBeenCalled();
  });
  it("preserves default notification eligibility and sends each new ask once in all mode", async () => {
    const f = fixture(), push = vi.spyOn(f.bb.sdk.plugins, "callRpc");
    const input = { reversible: true, kind: "decision" as const, question: "Use a small fixture?", why: "Reversible",
      options: [{ id: "small", label: "Small", detail: "", recommended: true }], meanwhile: "Keep scouting", holds: [] };
    f.k.ask("lead", input); await Promise.resolve(); expect(push).not.toHaveBeenCalled();
    f.settings.update({ revision: 0, patch: { attention: { notify: "all" } }, why: "Notify for all asks" });
    const ask = f.k.ask("lead", { ...input, question: "Use the second fixture?" });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    await f.runtime.push("lead", ask.question, ask.why, ask.id); expect(push).toHaveBeenCalledTimes(1);
  });
  it("automatically archives only ended quests through the reversible archive path", () => {
    const f = fixture(); f.advance(40 * LIMITS.dayMs);
    const base = { keeperThreadId: "lead", title: "Old", short: "Old", planVersion: 0, greenlitVersion: null, createdAt: 1_000_000, updatedAt: 1_000_000, archivedAt: null };
    putQuestFixture(f.k.store, "done", { ...base, id: "done", phase: "done", endedAt: f.time() - 10 * LIMITS.dayMs });
    putQuestFixture(f.k.store, "stopped", { ...base, id: "stopped", phase: "stopped", endedAt: f.time() - 10 * LIMITS.dayMs });
    putQuestFixture(f.k.store, "active", { ...base, id: "active", phase: "scout", endedAt: null });
    f.runtime.settingsMaintenance();
    expect(f.k.quest("done").archivedAt).toBeNull();
    f.settings.update({ revision: 0, patch: { data: { autoArchiveDays: 7 } }, why: "Archive old ended quests" });
    f.advance(60_001); f.runtime.settingsMaintenance();
    expect(f.k.quest("done").archivedAt).not.toBeNull();
    expect(f.k.quest("stopped").archivedAt).not.toBeNull();
    expect(f.k.quest("active").archivedAt).toBeNull();
    expect(f.k.store.events("lead").filter(event => event.type === "quest.archived").every(event => event.actor.kind === "tavern")).toBe(true);
    f.k.archiveQuests(["done"], false, { kind: "user" }); expect(f.k.quest("done").archivedAt).toBeNull();
  });
  it("holds new hires while paused and re-anchors exactly once when resumed", async () => {
    const f = fixture(), reanchor = vi.spyOn(f.k, "reanchor");
    f.settings.update({ revision: 0, patch: { tavern: { paused: true } }, why: "Pause" });
    f.runtime.settingsChanged();
    await expect(f.runtime.hire("lead", "project", { classId: "ranger", title: "Scout", errand: true,
      brief: { outcome: "Read", mode: "make-it-work", outOfScope: "", doneWhen: "Read", context: [], questions: ["What exists?"], timeboxMinutes: 3 } })).rejects.toThrow(/paused/i);
    f.settings.update({ revision: 1, patch: { tavern: { paused: false } }, why: "Resume" });
    f.runtime.settingsChanged();
    f.runtime.settingsChanged();
    expect(reanchor.mock.calls.filter(call => /resum|unpaus/i.test(call[1]))).toHaveLength(1);
  });
  it("rechecks an already waiting queued tick on unpause", async () => {
    const f = fixture(), recheck = vi.mocked(f.bb.experimental_hooks.recheck);
    const ctx = dispatch049({ rows: [queued049("waiting", "[Tavern tick] pending", f.time(), { pluginId: "tavern" })] });
    f.settings.update({ revision: 0, patch: { tavern: { paused: true } }, why: "Pause" }); f.runtime.settingsChanged();
    expect(await f.runtime.dispatch(ctx)).toEqual({ action: "wait", reason: "Tavern is paused" });
    recheck.mockClear();
    f.settings.update({ revision: 1, patch: { tavern: { paused: false } }, why: "Resume" }); f.runtime.settingsChanged();
    await vi.waitFor(() => expect(recheck).toHaveBeenCalledWith("message.dispatch"));
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "proceed" });
  });
  it("rechecks an already waiting queued tick after the manual Resume card", async () => {
    const f = fixture(), recheck = vi.mocked(f.bb.experimental_hooks.recheck);
    registerRpc(f.bb, f.runtime);
    const ctx = dispatch049({ rows: [queued049("waiting", "[Tavern tick] pending", f.time(), { pluginId: "tavern" })] });
    f.k.store.patch("lead", { manualStopAt: f.time() });
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    recheck.mockClear(); await f.harness.invokeRpc("resumeKeeper", { threadId: "lead" });
    await vi.waitFor(() => expect(recheck).toHaveBeenCalledWith("message.dispatch"));
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "proceed" });
  });
  it("prunes only optional samples, never orchestration history, with keep-forever as default", () => {
    const f = fixture(); f.advance(40 * LIMITS.dayMs);
    const old = f.time() - 31 * LIMITS.dayMs;
    f.insights.record("tick.held", { reason: "typing" }, "lead", null, "old", old);
    f.insights.record("tick.sent", {}, "lead", null, "new");
    f.k.store.event(old, "lead", null, "note.recorded", "Keep the fact");
    expect(f.insights.prune()).toBe(0);
    f.settings.update({ revision: 0, patch: { data: { historyDays: 30 } }, why: "Retain optional samples for a month" });
    expect(f.insights.prune()).toBe(1);
    expect(f.insights.data(0).events.some(e => e.text === "Keep the fact")).toBe(true);
    expect(f.insights.data(0).events.some(e => e.id === "sample:old")).toBe(false);
  });
  it("keeps old plans explicit unless reversibility is declared", () => {
    const input = { ...planInput("quest"), version: 1, createdAt: 1, fromSteer: null };
    expect(planSchema.parse(input).reversible).toBe(false);
    expect(planSchema.parse({ ...input, reversible: true }).reversible).toBe(true);
  });
});
