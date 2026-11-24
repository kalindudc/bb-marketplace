// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { dialogueSlot, validateDialogue, type StripScene } from "../src/shared/strip-scene";
import { BubbleQuota, DialogueWatches } from "../src/server/strip-dialogue";
import { MIGRATIONS } from "../src/server/migrations";
import { KeeperStore } from "../src/server/keeper/store";
import { registerDialogueWatch } from "../src/server/strip-dialogue-watch";
import { makeThreadResponse } from "./server/host";
import { putMemberFixture } from "./server/member-fixture";
import { setup } from "./server/runtime-fixture";

const scene: StripScene = { role: "smith", stage: "work", activity: "unknown", moment: "assignment", posture: "clear", revision: "private-id", at: 200 };

describe("contextual strip dialogue", () => {
  it("speaks only for live committed milestones in the selected voice", () => {
    expect(dialogueSlot(scene, "full")).toBe("working");
    expect(dialogueSlot(scene, "light")).toBeNull();
    expect(dialogueSlot({ ...scene, moment: "verified" }, "light")).toBe("verified");
    expect(dialogueSlot({ ...scene, moment: "wrapped" }, "light")).toBe("wrap");
    expect(dialogueSlot({ ...scene, moment: "plan-ready" }, "full")).toBe("working");
    for (const moment of ["none", "report"] as const) expect(dialogueSlot({ ...scene, moment }, "full")).toBeNull();
    expect(dialogueSlot({ ...scene, posture: "held" }, "full")).toBeNull();
    expect(dialogueSlot(scene, "off")).toBeNull();
  });

  it("rejects unexpected syntax, unsupported claims, and excessive text", () => {
    expect(validateDialogue("The anvil awaits.")).toBe("The anvil awaits.");
    for (const text of [null, "A path. A second path.", "I merged the patch.", "Try https://example.test", "Okay\nNow", "**The path!**", "I verified the work.", "A B C D E F G H I J K.", "A".repeat(57) + "."]) expect(validateDialogue(text)).toBeNull();
  });

  it("only sends a fresh commit to the same seat's already-watching panes", async () => {
    const baseline = { ...scene, revision: "first", at: 10 };
    const commit = { ...scene, revision: "next", at: 201 };
    const first = vi.fn(), split = vi.fn(), late = vi.fn(), other = vi.fn();
    const states = new Map([["seat-a", baseline], ["seat-b", baseline]]);
    let now = 200;
    const complete = vi.fn(async () => "The anvil awaits.");
    const watch = new DialogueWatches(id => ({ scene: states.get(id)!, voice: "full" }), () => true, complete, () => now);
    watch.subscribe("seat-a", first);
    watch.subscribe("seat-a", split);
    watch.subscribe("seat-b", other);
    await watch.changed("seat-a");
    expect(complete).not.toHaveBeenCalled();
    states.set("seat-a", commit);
    now = 202;
    const request = watch.changed("seat-a");
    watch.subscribe("seat-a", late);
    await watch.changed("seat-a");
    await request;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith({ revision: "next", text: "The anvil awaits." });
    expect(split).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });

  it("never spends on an old milestone when a pane returns to its revision", async () => {
    let value: StripScene = { ...scene, revision: "neutral", at: null };
    const complete = vi.fn(async () => "The anvil awaits.");
    const watch = new DialogueWatches(() => ({ scene: value, voice: "full" }), () => true, complete, () => 200);
    watch.subscribe("seat-a", vi.fn());
    value = { ...scene, revision: "assignment", at: 100 };
    await watch.changed("seat-a");
    expect(complete).not.toHaveBeenCalled();
  });

  it("accepts a slow reply for the live revision but never a superseded one", async () => {
    let now = 201;
    let value = { ...scene, revision: "first", at: 100 };
    let finish!: (text: string) => void;
    const complete = vi.fn(() => new Promise<string>(done => { finish = done; }));
    const send = vi.fn();
    const watch = new DialogueWatches(() => ({ scene: value, voice: "full" }), () => true, complete, () => now);
    watch.subscribe("seat-a", send);
    value = { ...value, revision: "second", at: now };
    const first = watch.changed("seat-a");
    now += 3000;
    finish("The anvil awaits.");
    await first;
    expect(send).toHaveBeenCalledExactlyOnceWith({ revision: "second", text: "The anvil awaits." });
    value = { ...value, revision: "third", at: now };
    const second = watch.changed("seat-a");
    value = { ...value, revision: "fourth", at: now + 1 };
    await watch.changed("seat-a");
    finish("The anvil awaits.");
    await second;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("aborts and discards a reply if the seat goes on hold or loses its last pane", async () => {
    let value = { ...scene, revision: "first" };
    let finish!: (text: string) => void;
    const reply = new Promise<string>(done => { finish = done; });
    const complete = vi.fn((_scene: StripScene, _signal: AbortSignal) => reply);
    const send = vi.fn();
    let now = 200;
    const watch = new DialogueWatches(() => ({ scene: value, voice: "full" }), () => true, complete, () => now);
    const close = watch.subscribe("seat-a", send);
    now = 202;
    value = { ...value, revision: "second", at: 201 };
    const request = watch.changed("seat-a");
    close?.();
    expect(complete.mock.calls[0]![1].aborted).toBe(true);
    finish("The anvil awaits.");
    await request;
    expect(send).not.toHaveBeenCalled();
  });

  it("binds the hosted watch before dispatch and ignores frames sent by a client", async () => {
    const f = setup();
    const host = createFakePluginHost({ pluginId: "tavern", sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId, projectId: "project", visibility: threadId === "hidden" ? "hidden" : "visible",
    }) } } });
    const db = f.k.store.db;
    const config = f.runtime.config();
    const configured = vi.spyOn(f.runtime, "config").mockReturnValue({ ...config, tavern: { ...config.tavern, voice: "full", contextualSpeech: false } });
    const complete = vi.fn(async (_scene: unknown, _config: unknown, _signal: AbortSignal, reserve: () => boolean) => reserve() ? "The anvil awaits." : null);
    const speech = { complete, dispose: vi.fn(async () => {}) };
    try {
      f.k.bind("maker", "smith", "bram", "project");
      putMemberFixture(f.k.store, "maker", { role: "member", keeperThreadId: "lead", errand: true, engagement: "active" });
      const refresh = registerDialogueWatch(host.bb, f.runtime, speech);
      const off = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=maker&project=project");
      expect(off.closeCalls[0]?.code).toBe(1008);
      configured.mockReturnValue({ ...config, tavern: { ...config.tavern, voice: "full", contextualSpeech: true } });
      refresh();
      const denied = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=maker&project=foreign");
      const hidden = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=hidden&project=project");
      expect(denied.closeCalls[0]?.code).toBe(1008);
      expect(hidden.closeCalls[0]?.code).toBe(1008);
      const pane = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=maker&project=project");
      await pane.receive(JSON.stringify({ moment: "wrapped", revision: "fabricated" }));
      expect(complete).not.toHaveBeenCalled();
      f.advance(100);
      f.k.store.patch("maker", { lastBriefAt: f.time(), briefVersion: 1 });
      f.k.store.event(f.time(), "lead", null, "member.briefed", "Private fixture title", { memberThreadId: "maker" });
      await vi.waitFor(() => expect(pane.sent).toHaveLength(1));
      expect(JSON.parse(String(pane.sent[0])).text).toBe("The anvil awaits.");
      expect(new BubbleQuota(f.k.store).used(f.time())).toBe(1);
      await pane.close();
    } finally { await host.harness.lifecycle.dispose(); (db as unknown as Database.Database).close(); }
  });

  it("reserves atomically and keeps daily limits across restarts, panes and UTC rollover", () => {
    const db = new Database(":memory:");
    try {
      db.exec(MIGRATIONS.join(";\n"));
      const wrap = new KeeperStore(db as never);
      const t = Date.UTC(2026, 5, 2, 23, 59, 58);
      const quota = new BubbleQuota(wrap);
      expect(quota.reserve("thread-one", t, t)).toBe(true);
      expect(new BubbleQuota(wrap).reserve("thread-one", t, t + 1)).toBe(false);
      for (let i = 1; i < 12; i++) expect(quota.reserve("thread-one", t + i, t + i)).toBe(true);
      expect(quota.reserve("thread-one", t + 20, t + 20)).toBe(false);
      for (let i = 0; i < 88; i++) expect(quota.reserve(`thread-${i}`, t + i, t + i)).toBe(true);
      expect(quota.reserve("another", t + 100, t + 100)).toBe(false);
      expect(quota.reserve("thread-one", t + 999, t + 2001)).toBe(false);
      expect(quota.reserve("thread-one", t + 2001, t + 2001)).toBe(true);
      const limits = { speechThreadLimit: 2, speechInstallLimit: 3 };
      expect(quota.used(t + 2001)).toBe(1);
      expect(quota.reserve("thread-one", t + 2002, t + 2002, limits)).toBe(true);
      expect(quota.reserve("thread-one", t + 2003, t + 2003, limits)).toBe(false);
      expect(quota.reserve("another", t + 2004, t + 2004, limits)).toBe(true);
      expect(quota.reserve("third", t + 2005, t + 2005, limits)).toBe(false);
      expect(quota.used(t + 2005)).toBe(3);
    } finally { db.close(); }
  });
});
