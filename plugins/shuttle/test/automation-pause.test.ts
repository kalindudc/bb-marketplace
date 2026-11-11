// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createShuttlePlugin } from "../server";
import { Shuttle } from "../src/shuttle";
import { harness, pr } from "./helpers";

const DAY = 86_400_000;

function setup() {
  const h = harness();
  vi.spyOn(h.port, "setSettings").mockImplementation(async (patch) => { Object.assign(h.settings, patch); });
  return h;
}

describe("automation pauses", () => {
  it("expires at the deadline without needing a tick, while lists keep syncing", async () => {
    const h = setup();
    await h.shuttle.sync();
    h.clock.now += 1000;
    const until = h.clock.now + DAY;
    await h.shuttle.setAutomationPause({ mode: "until", until });
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    expect(h.store.prByKey("forge:acme/app#3")).not.toBeNull();
    expect(h.port.spawned).toHaveLength(0);
    expect(h.shuttle.overview()).toMatchObject({ paused: true, pauseUntil: until });
    expect(h.shuttle.settings().pauseAutomations).toBe(true);

    h.clock.now = until;
    expect(h.shuttle.overview()).toMatchObject({ paused: false, pauseUntil: null });
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(1);
  });

  it("survives rebuilding Shuttle with the same store, including a deadline missed while closed", async () => {
    const h = setup();
    const until = h.clock.now + DAY;
    await h.shuttle.setAutomationPause({ mode: "until", until });
    const reopen = () => new Shuttle({ store: h.store, port: h.port, now: () => h.clock.now, settings: () => h.settings, runner: h.runner });
    expect(reopen().overview()).toMatchObject({ paused: true, pauseUntil: until });
    h.clock.now = until + DAY;
    expect(reopen().overview()).toMatchObject({ paused: false, pauseUntil: null });
  });

  it("replaces or cancels a timed pause, and never expires an indefinite pause", async () => {
    const h = setup();
    await h.shuttle.setAutomationPause({ mode: "until", until: h.clock.now + DAY });
    const until = h.clock.now + 7 * DAY;
    await h.shuttle.setAutomationPause({ mode: "until", until });
    expect(h.shuttle.overview()).toMatchObject({ paused: true, pauseUntil: until });
    await h.shuttle.setAutomationPause({ mode: "resume" });
    expect(h.shuttle.overview()).toMatchObject({ paused: false, pauseUntil: null });

    await h.shuttle.setAutomationPause({ mode: "indefinite" });
    h.clock.now += 30 * DAY;
    expect(h.shuttle.overview()).toMatchObject({ paused: true, pauseUntil: null });
    await h.shuttle.setAutomationPause({ mode: "until", until: h.clock.now + DAY });
    expect(h.settings.pauseAutomations).toBe(false);
    expect(h.shuttle.overview()).toMatchObject({ paused: true, pauseUntil: h.clock.now + DAY });
  });

  it("rejects invalid deadlines without changing the current pause", async () => {
    const h = setup();
    await h.shuttle.setAutomationPause({ mode: "indefinite" });
    for (const until of [h.clock.now - 1, h.clock.now, Number.NaN, Infinity, h.clock.now + 0.5, 9e15]) {
      await expect(h.shuttle.setAutomationPause({ mode: "until", until })).rejects.toThrow("Choose a future date and time");
    }
    expect(h.shuttle.overview()).toMatchObject({ paused: true, pauseUntil: null });
    expect(h.port.setSettings).toHaveBeenCalledTimes(1);
  });

  it("publishes the expiry on a tick, so open pages refresh", async () => {
    const h = setup();
    await h.shuttle.sync();
    await h.shuttle.setAutomationPause({ mode: "until", until: h.clock.now + 1000 });
    const publishes = h.port.publishes;
    h.clock.now += 1000;
    await h.shuttle.tick();
    expect(h.port.publishes).toBeGreaterThan(publishes);
    expect(h.shuttle.overview()).toMatchObject({ paused: false, pauseUntil: null });
  });

  it("holds feedback delivery but leaves the manual send available", async () => {
    const h = setup();
    h.lists.authored = [pr(1, { author: "me" })];
    await h.shuttle.sync();
    h.port.addThread("thr_owner");
    await h.shuttle.link("forge:acme/app#1", "thr_owner");
    await h.shuttle.sync();
    await h.shuttle.setAutomationPause({ mode: "until", until: h.clock.now + DAY });
    h.activity[1] = { items: [{ id: "review-1", kind: "review", author: "ana", state: "changes requested", body: "Fix the race" }] };
    h.clock.now += 3 * 60_000;
    await h.shuttle.sync();
    h.clock.now += 3 * 60_000;
    await h.shuttle.deliver();
    expect(h.port.sent).toHaveLength(0);
    expect(await h.shuttle.sendUnread("thr_owner")).toBe(1);
    expect(h.port.sent[0]!.text).toContain("Fix the race");
  });

  it("holds automatic agent assignment until the deadline", async () => {
    const h = setup();
    h.port.projects = [{ id: "proj_app", name: "app", gitRemoteUrl: "git@forge.test:acme/app.git" }];
    h.settings.autoAgent = true;
    h.port.addThread("thr_opener1", "Opener");
    h.lists.authored = [pr(1, { author: "me", head_ref: "work-thr_opener1" })];
    const until = h.clock.now + DAY;
    await h.shuttle.setAutomationPause({ mode: "until", until });
    await h.shuttle.sync();
    expect(h.shuttle.view("forge:acme/app#1").agent).toBeNull();
    h.clock.now = until;
    await h.shuttle.sync();
    expect(h.shuttle.view("forge:acme/app#1").agent).toMatchObject({ threadId: "thr_opener1", auto: true });
  });

  it("leaves the previous pause intact when saving settings fails", async () => {
    const h = setup();
    const until = h.clock.now + DAY;
    await h.shuttle.setAutomationPause({ mode: "until", until });
    vi.mocked(h.port.setSettings).mockRejectedValueOnce(new Error("settings unavailable"));
    await expect(h.shuttle.setAutomationPause({ mode: "resume" })).rejects.toThrow("settings unavailable");
    expect(h.shuttle.overview()).toMatchObject({ paused: true, pauseUntil: until });
  });
});

describe("the pause RPC", () => {
  it("persists across plugin reloads, respects the old toggle, and validates input", async () => {
    let now = Date.parse("2026-11-11T12:00:00Z");
    const initial = createFakePluginHost({ pluginId: "shuttle", sdk: { subscribe: () => () => {} } });
    const { bb } = initial;
    let host = initial.harness;
    const plugin = createShuttlePlugin({ now: () => now });
    await plugin(bb);
    try {
      const until = now + DAY;
      await host.behavior.callRpc("setAutomationPause", { mode: "until", until });
      expect(await host.behavior.callRpc("overview", {})).toMatchObject({ paused: true, pauseUntil: until });
      host = (await host.lifecycle.reload(plugin)).harness;
      expect(await host.behavior.callRpc("overview", {})).toMatchObject({ paused: true, pauseUntil: until });
      await expect(host.behavior.callRpc("setAutomationPause", { mode: "until", until: now })).rejects.toThrow("Choose a future date and time");
      await expect(host.behavior.callRpc("setAutomationPause", { mode: "until", until: "tomorrow" })).rejects.toThrow();
      await host.behavior.setSettings({ pauseAutomations: true });
      expect(await host.behavior.callRpc("overview", {})).toMatchObject({ paused: true, pauseUntil: null });
      await host.behavior.setSettings({ pauseAutomations: false });
      expect(await host.behavior.callRpc("overview", {})).toMatchObject({ paused: false, pauseUntil: null });
      await host.behavior.callRpc("setAutomationPause", { mode: "until", until });
      now = until;
      host = (await host.lifecycle.reload(plugin)).harness;
      expect(await host.behavior.callRpc("overview", {})).toMatchObject({ paused: false, pauseUntil: null });
    } finally {
      await host.lifecycle.dispose();
    }
  });
});
