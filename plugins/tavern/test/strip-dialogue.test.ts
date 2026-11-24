// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { dialogueSlot, validateDialogue, type SpeechContext, type StripScene } from "../src/shared/strip-scene";
import { SpeechAttempts, DialogueWatches } from "../src/server/strip-dialogue";
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
    const complete = vi.fn((_scene: SpeechContext, _signal: AbortSignal) => reply);
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

  it("checks the socket binding and accepts only bound clicks, due ambient requests and committed events", async () => {
    const f = setup();
    const host = createFakePluginHost({ pluginId: "tavern", sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({
      id: threadId, projectId: "project", visibility: threadId === "hidden" ? "hidden" : "visible",
    }) } } });
    const db = f.k.store.db;
    const config = f.runtime.config();
    const configured = vi.spyOn(f.runtime, "config").mockReturnValue({ ...config, tavern: { ...config.tavern, voice: "full", contextualSpeech: false } });
    const complete = vi.fn(async (_scene: SpeechContext, _config: unknown, _signal: AbortSignal, reserve: () => boolean): Promise<string | null> => reserve() ? "The anvil awaits." : null);
    const speech = { complete, dispose: vi.fn(async () => {}), refresh: vi.fn(async () => {}), setWatching: vi.fn(), stop: vi.fn(async () => {}) };
    try {
      f.k.bind("maker", "smith", "bram", "project");
      putMemberFixture(f.k.store, "maker", { role: "member", keeperThreadId: "lead", errand: true, engagement: "active" });
      const refresh = registerDialogueWatch(host.bb, f.runtime, speech);
      const off = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=maker&project=project");
      expect(off.closeCalls[0]?.code).toBe(1008);
      configured.mockReturnValue({ ...config, tavern: { ...config.tavern, voice: "full", contextualSpeech: true, speechGapMinutes: 1 } });
      refresh();
      const denied = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=maker&project=foreign");
      const hidden = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=hidden&project=project");
      expect(denied.closeCalls[0]?.code).toBe(1008);
      expect(hidden.closeCalls[0]?.code).toBe(1008);
      expect(speech.setWatching).not.toHaveBeenCalled();
      const pane = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=maker&project=project");
      const request = (kind: "ambient" | "click", at = f.time()) => JSON.stringify({ kind, at });
      await pane.receive(JSON.stringify({ kind: "click", at: 1, stage: "rest" }));
      await pane.receive(request("ambient"));
      expect(complete).not.toHaveBeenCalled();
      f.advance(100);
      f.k.store.patch("maker", { lastBriefAt: f.time(), briefVersion: 1 });
      f.k.store.event(f.time(), "lead", null, "member.briefed", "Private fixture title", { memberThreadId: "maker" });
      await vi.waitFor(() => expect(pane.sent).toHaveLength(1));
      expect(JSON.parse(String(pane.sent[0])).text).toBe("The anvil awaits.");
      expect(new SpeechAttempts(f.k.store).used(f.time())).toBe(1);
      f.advance(36_000);
      const ambientAt = f.time();
      const otherPane = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=maker&project=project");
      await pane.receive(request("ambient"));
      await vi.waitFor(() => expect(pane.sent).toHaveLength(2));
      expect(JSON.parse(String(pane.sent[1]))).toMatchObject({ request: { kind: "ambient", at: ambientAt }, text: "The anvil awaits." });
      expect(complete.mock.lastCall?.[0]).toEqual({ role: "smith", stage: "work", moment: "ambient" });
      await pane.receive(request("ambient", ambientAt + 1));
      expect(new SpeechAttempts(f.k.store).used(f.time())).toBe(2);
      expect(pane.sent).toHaveLength(2);
      expect(otherPane.sent).toHaveLength(0);

      const reply = "The lantern warms us.";
      let finish!: (text: string) => void;
      complete.mockImplementationOnce(async (_scene, _config, _signal, reserve) => reserve()
        ? new Promise<string>(done => { finish = done; }) : null);
      const clicked = otherPane.receive(request("click", 1));
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      await otherPane.receive(request("click", 2));
      await pane.receive(request("click", 3));
      expect(complete).toHaveBeenCalledTimes(3);
      expect(complete.mock.lastCall?.[0]).toEqual({ role: "smith", stage: "work", moment: "click" });
      finish(reply);
      await clicked;
      await vi.waitFor(() => expect(otherPane.sent).toHaveLength(1));
      expect(JSON.parse(String(otherPane.sent[0]))).toMatchObject({ request: { kind: "click", at: 2 }, text: reply });
      expect(JSON.parse(String(pane.sent[2]))).toMatchObject({ request: { kind: "click", at: 3 }, text: reply });
      expect(new SpeechAttempts(f.k.store).used(f.time())).toBe(3);
      await otherPane.close();
      expect(speech.setWatching.mock.calls).toEqual([[true]]);
      await pane.close();
      expect(speech.setWatching.mock.calls).toEqual([[true], [false]]);
    } finally { await host.harness.lifecycle.dispose(); (db as unknown as Database.Database).close(); }
  });

  it("rejects duplicate events but counts every distinct attempt until UTC rollover", () => {
    const db = new Database(":memory:");
    try {
      db.exec(MIGRATIONS.join(";\n"));
      const wrap = new KeeperStore(db as never);
      const t = Date.UTC(2026, 5, 2, 23, 59, 58);
      const attempts = new SpeechAttempts(wrap);
      expect(attempts.reserve("thread-one", t, t)).toBe(true);
      expect(new SpeechAttempts(wrap).reserve("thread-one", t, t + 1)).toBe(false);
      for (let i = 1; i <= 505; i++) expect(attempts.reserve("thread-one", t + i, t + i)).toBe(true);
      expect(attempts.used(t + 505)).toBe(506);
      expect(attempts.reserve("thread-one", t + 504, t + 505)).toBe(false);
      expect(attempts.reserve("thread-one", t + 999, t + 2001)).toBe(false);
      expect(attempts.reserve("thread-one", t + 2001, t + 2001)).toBe(true);
      expect(attempts.used(t + 2001)).toBe(1);
    } finally { db.close(); }
  });
});
