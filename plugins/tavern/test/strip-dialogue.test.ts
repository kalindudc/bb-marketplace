// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { dialogueSlot, validateDialogue, type StripScene } from "../src/shared/strip-scene";
import { BubbleQuota, DialogueWatches, dialogueProfile, requestDialogue, type DialogueProfile } from "../src/server/strip-dialogue";
import { MIGRATIONS } from "../src/server/migrations";
import { KeeperStore } from "../src/server/keeper/store";
import { registerDialogueWatch } from "../src/server/strip-dialogue-watch";
import { makeThreadResponse } from "./server/host";
import { putMemberFixture } from "./server/member-fixture";
import { setup } from "./server/runtime-fixture";

const scene: StripScene = { role: "smith", stage: "work", activity: "unknown", moment: "assignment", posture: "clear", revision: "private-id", at: 200 };
const profile: DialogueProfile = { endpoint: "https://example.test/responses", apiKey: "test-key", model: "small-model", inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5 };
const endpoint = { TAVERN_SPEECH_PROFILE: JSON.stringify({ ...profile, apiKey: undefined, qualified: true }), TAVERN_SPEECH_API_KEY: profile.apiKey };

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

  it("is disabled without a trusted host profile and rejects prices above its daily ceiling", () => {
    expect(dialogueProfile({})).toBeNull();
    expect(dialogueProfile(endpoint)).toEqual(profile);
    expect(dialogueProfile({ ...endpoint, TAVERN_SPEECH_PROFILE: JSON.stringify({ ...profile, apiKey: undefined, qualified: true, inputUsdPerMillion: 10 }) })).toBeNull();
    expect(dialogueProfile({ ...endpoint, TAVERN_SPEECH_PROFILE: JSON.stringify({ ...profile, apiKey: undefined, qualified: true, endpoint: "http://example.test" }) })).toBeNull();
  });

  it("does not transmit raw fields, uses a hard cap, and reads the provider usage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "completed", model: "small-model",
      usage: { input_tokens: 100, output_tokens: 5 }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "The anvil awaits." }] }] })));
    const secret = "https://example.test/personal?token=private";
    const signal = new AbortController().signal;
    const context = { ...scene, revision: secret };
    const answer = await requestDialogue(profile, context, signal, fetcher);
    expect(answer).toEqual({ text: "The anvil awaits.", inputTokens: 100, outputTokens: 5 });
    const [, init] = fetcher.mock.calls[0]!;
    expect(init?.body).not.toContain(secret);
    expect(init?.body).not.toContain("private-id");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: profile.model, max_output_tokens: 64, store: false, reasoning: { effort: "none" } });
    expect(init?.signal).toBe(signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("only sends a fresh commit to the same seat's already-watching panes", async () => {
    const baseline = { ...scene, revision: "first", at: 10 };
    const commit = { ...scene, revision: "next", at: 201 };
    const first = vi.fn(), split = vi.fn(), late = vi.fn(), other = vi.fn();
    const states = new Map([["seat-a", baseline], ["seat-b", baseline]]);
    const complete = vi.fn(async () => "The anvil awaits.");
    const watch = new DialogueWatches(id => ({ scene: states.get(id)!, voice: "full" }), () => true, complete, () => 202);
    watch.subscribe("seat-a", first);
    watch.subscribe("seat-a", split);
    watch.subscribe("seat-b", other);
    await watch.changed("seat-a");
    expect(complete).not.toHaveBeenCalled();
    states.set("seat-a", commit);
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

  it("aborts and discards a reply if the seat goes on hold or loses its last pane", async () => {
    let value = { ...scene, revision: "first" };
    let finish!: (text: string) => void;
    const reply = new Promise<string>(done => { finish = done; });
    const complete = vi.fn((_scene: StripScene, _signal: AbortSignal) => reply);
    const send = vi.fn();
    const watch = new DialogueWatches(() => ({ scene: value, voice: "full" }), () => true, complete, () => 202);
    const close = watch.subscribe("seat-a", send);
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
    vi.spyOn(f.runtime, "config").mockReturnValue({ ...config, tavern: { ...config.tavern, voice: "full" } });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ status: "completed", model: profile.model,
      usage: { input_tokens: 54, output_tokens: 6 }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "The anvil awaits." }] }] })));
    try {
      f.k.bind("maker", "smith", "bram", "project");
      putMemberFixture(f.k.store, "maker", { role: "member", keeperThreadId: "lead", errand: true, engagement: "active" });
      registerDialogueWatch(host.bb, f.runtime, profile);
      const denied = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=maker&project=foreign");
      const hidden = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=hidden&project=project");
      expect(denied.closeCalls[0]?.code).toBe(1008);
      expect(hidden.closeCalls[0]?.code).toBe(1008);
      const pane = await host.harness.experimental_openWebSocket("/strip-dialogue?thread=maker&project=project");
      await pane.receive(JSON.stringify({ moment: "wrapped", revision: "fabricated" }));
      expect(fetcher).not.toHaveBeenCalled();
      f.advance(100);
      f.k.store.patch("maker", { lastBriefAt: f.time(), briefVersion: 1 });
      f.k.store.event(f.time(), "lead", null, "member.briefed", "Private fixture title", { memberThreadId: "maker" });
      await vi.waitFor(() => expect(pane.sent).toHaveLength(1));
      expect(JSON.parse(String(pane.sent[0])).text).toBe("The anvil awaits.");
      expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain("maker");
      await pane.close();
    } finally { await host.harness.lifecycle.dispose(); fetcher.mockRestore(); (db as unknown as Database.Database).close(); }
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
    } finally { db.close(); }
  });
});
