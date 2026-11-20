// @vitest-environment node
import { withMemberFixtures } from "../server/member-fixture";
import { seedQuest } from "../server/support";
import { describe, expect, it, vi } from "vitest";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { TavernRuntime } from "../../src/server/runtime";
import { setup } from "../server/runtime-fixture";
import { queued049 } from "../server/dispatch-fixture";
import { makeThreadResponse } from "../server/host";
import { planInput } from "../server/support";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { registerRpc } from "../../src/server/rpc";

async function fixture() {
  const rows: ReturnType<typeof queued049>[] = [], texts: string[] = [], deleted: { id: string; cursor: number }[] = [];
  let f: ReturnType<typeof setup>;
  f = setup({ threads: {
    get: async () => makeThreadResponse({ id: "lead", status: "idle" }),
    events: { list: async () => [] },
    queuedMessages: {
      list: async () => rows.slice(),
      delete: async ({ queuedMessageId }: { queuedMessageId: string }) => {
        deleted.push({ id: queuedMessageId, cursor: f.k.store.runtime("lead").cursor });
        const at = rows.findIndex(row => row.id === queuedMessageId); if (at >= 0) rows.splice(at, 1);
        return {};
      },
    },
    send: async ({ input }: { input: { type: string; text?: string }[] }) => {
      const text = input.map(block => block.text ?? "").join("\n"); texts.push(text);
      if (texts.length === 1) { rows.push(queued049("old-tick", text, f.time(), { pluginId: "tavern" })); return { delivery: "queued" }; }
      return { delivery: "sent" };
    },
  } });
  const settings = new SettingsStore(f.k.store.db, f.time), insights = new InsightsReader(f.k.store.db, settings, f.time);
  f.runtime.enableSettings(settings, insights); registerRpc(f.bb, f.runtime);
  const quest = await seedQuest(f.k,"lead", "Read", "Read"); f.k.plan("lead", planInput(quest.id));
  f.advance(61_000);
  f.k.store.event(f.time(), "lead", quest.id, "promise.due", "FACT-A survives the stopped queue");
  await f.runtime.tick("lead");
  expect(texts).toHaveLength(1);
  const old = f.k.store.pendingTick("lead")!;
  expect(old.state).toBe("queued");
  return { ...f, settings, rows, texts, deleted, old };
}
describe("quiet-end queued tick recovery", () => {
  for (const via of ["card", "resume", "unpause"] as const) {
    it(`rebuilds a stopped queued tick after ${via} without falsely delivering its facts`, async () => {
      const f = await fixture(), cursor = f.k.store.runtime("lead").cursor;
      if (via === "unpause") {
        f.settings.update({ revision: 0, patch: { tavern: { paused: true } }, why: "Pause" }); f.runtime.settingsChanged();
        f.settings.update({ revision: 1, patch: { tavern: { paused: false } }, why: "Unpause" }); f.runtime.settingsChanged();
      } else {
        f.k.store.patch("lead", { manualStopAt: f.time() });
        if (via === "card") {
          const ask = f.k.asks("lead").find(ask => ask.kind === "greenlight")!;
          await f.harness.invokeRpc("answerAsk", { askId: ask.id, optionId: "approve", note: null, via: "page" });
        } else await f.harness.invokeRpc("resumeKeeper", { threadId: "lead" });
      }
      await f.runtime.tick("lead");
      expect(f.deleted).toEqual([{ id: "old-tick", cursor }]);
      expect(f.k.store.tick(f.old.id)?.state).toBe("cancelled");
      expect(f.texts).toHaveLength(2); expect(f.texts[1]).toContain("FACT-A survives");
      expect(f.texts[1]).not.toBe(f.texts[0]);
      expect(f.k.store.runtime("lead").cursor).toBeGreaterThan(cursor);
    });
  }
  it("unpauses Tavern without resuming a manually stopped Keeper", async () => {
    const f = await fixture(), cursor = f.k.store.runtime("lead").cursor, stoppedAt = f.time();
    f.k.store.patch("lead", { manualStopAt: stoppedAt });
    f.settings.update({ revision: 0, patch: { tavern: { paused: true } }, why: "Pause" }); f.runtime.settingsChanged();
    f.settings.update({ revision: 1, patch: { tavern: { paused: false } }, why: "Unpause" }); f.runtime.settingsChanged();
    await f.runtime.tick("lead");
    expect(f.k.store.runtime("lead").manualStopAt).toBe(stoppedAt);
    expect(f.deleted).toEqual([]); expect(f.k.store.tick(f.old.id)?.state).toBe("queued");
    expect(f.k.store.runtime("lead").cursor).toBe(cursor); expect(f.texts).toHaveLength(1);
    await f.harness.invokeRpc("resumeKeeper", { threadId: "lead" }); await f.runtime.tick("lead");
    expect(f.k.store.runtime("lead").manualStopAt).toBeNull(); expect(f.texts).toHaveLength(2); expect(f.texts[1]).toContain("FACT-A survives");
  });
  it("retries a failed queue deletion after a fresh runtime loads the durable reset marker", async () => {
    const f = await fixture(), cursor = f.k.store.runtime("lead").cursor;
    f.k.store.patch("lead", { manualStopAt: f.time() }); f.k.userAction("lead", "Resume");
    vi.spyOn(f.bb.sdk.threads.queuedMessages, "delete").mockRejectedValueOnce(new Error("queue temporarily unavailable"));
    await expect(f.runtime.tick("lead")).rejects.toThrow("queue temporarily unavailable");
    expect(f.k.store.runtime("lead").queuedTickResetId).toBeTypeOf("string");
    expect(f.k.store.runtime("lead").cursor).toBe(cursor);
    const keeper = withMemberFixtures(new Keeper(new KeeperStore(f.k.store.db), f.port, f.time, () => {}));
    const runtime = new TavernRuntime(f.bb, keeper, f.runtime.registry), settings = new SettingsStore(f.k.store.db, f.time);
    runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
    await runtime.tick("lead");
    expect(keeper.store.runtime("lead").queuedTickResetId).toBeNull(); expect(f.k.store.tick(f.old.id)?.state).toBe("cancelled");
    expect(f.texts).toHaveLength(2); expect(f.texts[1]).toContain("FACT-A survives");
  });
  it("preserves user and other-plugin rows, keeping the cancelled tick's facts unread", async () => {
    const f = await fixture(), cursor = f.k.store.runtime("lead").cursor;
    f.rows.push(queued049("human", "[Tavern tick] user text", f.time()), queued049("foreign", "[Tavern tick] foreign text", f.time(), { pluginId: "other" }));
    f.k.store.patch("lead", { manualStopAt: f.time() });
    await f.harness.invokeRpc("resumeKeeper", { threadId: "lead" }); await f.runtime.tick("lead");
    expect(f.deleted.map(row => row.id)).toEqual(["old-tick"]);
    expect(f.rows.map(row => row.id)).toEqual(["human", "foreign"]);
    expect(f.k.store.runtime("lead").cursor).toBe(cursor);
    expect(f.texts).toHaveLength(1);
  });
});
