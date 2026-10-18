import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import switchboard from "../server";
import { EMPTY_LAYOUT } from "../src/layout";

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "switchboard" });
  switchboard(bb);
  return { bb, harness };
}

describe("Switchboard server", () => {
  it("returns an empty layout for empty storage", async () => {
    const { harness } = setup();
    expect(await harness.behavior.callRpc("getLayout")).toEqual(EMPTY_LAYOUT);
  });

  it("persists collapsed keys and signals each change", async () => {
    const { bb, harness } = setup();
    expect(await harness.behavior.callRpc("setCollapsed", { key: "section:review", collapsed: true }))
      .toEqual({ collapsed: ["section:review"] });
    expect(await bb.storage.kv.get("collapsed")).toEqual(["section:review"]);
    expect(await harness.behavior.callRpc("setCollapsed", { key: "section:review", collapsed: false }))
      .toEqual({ collapsed: [] });
    expect(harness.realtimeSignals).toEqual([
      { channel: "layout", payload: { key: "collapsed", value: ["section:review"] } },
      { channel: "layout", payload: { key: "collapsed", value: [] } },
    ]);
  });

  it("loads ordered containers and drops malformed stored entries", async () => {
    const { bb, harness } = setup();
    await bb.storage.kv.set("order:loose", ["a", "b"]);
    await bb.storage.kv.set("section-hues", { review: "violet", broken: "rainbow" });
    await bb.storage.kv.set("section-order", ["review"]);
    expect(await harness.behavior.callRpc("getLayout")).toEqual({
      sectionOrder: ["review"], sectionHues: { review: "violet" }, collapsed: [], order: { loose: ["a", "b"] },
      sectionSort: {}, snoozes: {}, sectionProjects: {},
    });
  });

  it("persists deduplicated thread and section orders and broadcasts each change", async () => {
    const { bb, harness } = setup();
    expect(await harness.behavior.callRpc("setOrder", { container: "section:review", ids: ["b", "a", "b"] }))
      .toEqual({ ids: ["b", "a"] });
    expect(await bb.storage.kv.get("order:section:review")).toEqual(["b", "a"]);
    expect(await harness.behavior.callRpc("setSectionOrder", { ids: ["review", "triage", "review"] }))
      .toEqual({ ids: ["review", "triage"] });
    expect(await bb.storage.kv.get("section-order")).toEqual(["review", "triage"]);
    expect(await harness.behavior.callRpc("getLayout")).toMatchObject({
      sectionOrder: ["review", "triage"], order: { "section:review": ["b", "a"] },
    });
    expect(harness.realtimeSignals).toEqual([
      { channel: "layout", payload: { key: "order:section:review", value: ["b", "a"] } },
      { channel: "layout", payload: { key: "section-order", value: ["review", "triage"] } },
    ]);
  });

  it("removes an emptied order key without disturbing another container", async () => {
    const { bb, harness } = setup();
    await harness.behavior.callRpc("setOrder", { container: "loose", ids: ["a"] });
    await harness.behavior.callRpc("setOrder", { container: "section:test", ids: ["x"] });
    expect(await harness.behavior.callRpc("setOrder", { container: "section:test", ids: [] }))
      .toEqual({ ids: [] });
    expect(await bb.storage.kv.get("order:section:test")).toBeUndefined();
    expect(await harness.behavior.callRpc("getLayout")).toEqual({ ...EMPTY_LAYOUT, order: { loose: ["a"] } });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "layout", payload: {
      key: "order:section:test", value: [],
    } });
  });

  it("sets and clears a section hue, broadcasting the entire map", async () => {
    const { bb, harness } = setup();
    expect(await harness.behavior.callRpc("setSectionHue", { sectionId: "review", hue: "violet" }))
      .toEqual({ sectionHues: { review: "violet" } });
    expect(await harness.behavior.callRpc("setSectionHue", { sectionId: "triage", hue: "teal" }))
      .toEqual({ sectionHues: { review: "violet", triage: "teal" } });
    expect(await harness.behavior.callRpc("setSectionHue", { sectionId: "review", hue: null }))
      .toEqual({ sectionHues: { triage: "teal" } });
    expect(await bb.storage.kv.get("section-hues")).toEqual({ triage: "teal" });
    expect(await harness.behavior.callRpc("getLayout")).toMatchObject({ sectionHues: { triage: "teal" } });
    expect(harness.realtimeSignals).toHaveLength(3);
    expect(harness.realtimeSignals[2]).toEqual({ channel: "layout", payload: { key: "section-hues", value: { triage: "teal" } } });
  });

  it("stores section sort, clears manual mode and publishes the full map", async () => {
    const { bb, harness } = setup();
    expect(await harness.behavior.callRpc("setSectionSort", { container: "section:review", mode: "recent" }))
      .toEqual({ sectionSort: { "section:review": "recent" } });
    expect(await harness.behavior.callRpc("setSectionSort", { container: "loose", mode: "status" }))
      .toEqual({ sectionSort: { "section:review": "recent", loose: "status" } });
    expect(await harness.behavior.callRpc("setSectionSort", { container: "section:review", mode: "manual" }))
      .toEqual({ sectionSort: { loose: "status" } });
    expect(await bb.storage.kv.get("section-sort")).toEqual({ loose: "status" });
    expect(await harness.behavior.callRpc("getLayout")).toMatchObject({ sectionSort: { loose: "status" } });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "layout", payload: {
      key: "section-sort", value: { loose: "status" },
    } });
  });

  it("stores and clears a section's default project and publishes the full map", async () => {
    const { bb, harness } = setup();
    expect(await harness.behavior.callRpc("setSectionProject", { container: "section:review", projectId: "p" }))
      .toEqual({ sectionProjects: { "section:review": "p" } });
    expect(await harness.behavior.callRpc("setSectionProject", { container: "loose", projectId: "q" }))
      .toEqual({ sectionProjects: { "section:review": "p", loose: "q" } });
    expect(await harness.behavior.callRpc("setSectionProject", { container: "section:review", projectId: null }))
      .toEqual({ sectionProjects: { loose: "q" } });
    expect(await bb.storage.kv.get("section-projects")).toEqual({ loose: "q" });
    expect(await harness.behavior.callRpc("getLayout")).toMatchObject({ sectionProjects: { loose: "q" } });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "layout", payload: {
      key: "section-projects", value: { loose: "q" },
    } });
  });

  it("stores snoozes, publishes whole maps, clears entries on deletion and rejects over 500 IDs", async () => {
    const { bb, harness } = setup();
    const before = Date.now();
    expect(await harness.behavior.callRpc("snooze", { threadIds: ["t", "t", "u"], until: before + 86_400_000 }))
      .toMatchObject({ snoozes: { t: { until: before + 86_400_000 }, u: { until: before + 86_400_000 } } });
    const stored = await bb.storage.kv.get("snooze:t") as { at: number; until: number };
    expect(stored.at).toBeGreaterThanOrEqual(before);
    expect(await harness.behavior.callRpc("getLayout")).toMatchObject({ snoozes: { t: stored } });
    expect(await harness.behavior.callRpc("unsnooze", { threadIds: ["u"] })).toEqual({ snoozes: { t: stored } });
    expect(await bb.storage.kv.get("snooze:u")).toBeUndefined();
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "t" }) });
    expect(await bb.storage.kv.get("snooze:t")).toBeUndefined();
    expect(await harness.behavior.callRpc("getLayout")).toMatchObject({ snoozes: {} });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "layout", payload: { key: "snoozes", value: {} } });
    await expect(harness.behavior.callRpc("snooze", {
      threadIds: Array.from({ length: 501 }, (_, index) => `t${index}`), until: before + 1,
    })).rejects.toThrow();
    await expect(harness.behavior.callRpc("unsnooze", {
      threadIds: Array.from({ length: 501 }, (_, index) => `t${index}`),
    })).rejects.toThrow();
  });

  it("rejects malformed new write inputs without storing or signalling", async () => {
    const { harness } = setup();
    const bad = [
      ["setOrder", { container: "section:", ids: ["a"] }],
      ["setOrder", { container: "pinned", ids: ["a"] }],
      ["setOrder", { container: "loose", ids: ["x".repeat(201)] }],
      ["setOrder", { container: "loose", ids: ["a"], unexpected: true }],
      ["setSectionOrder", { ids: [""] }],
      ["setSectionHue", { sectionId: "review", hue: "rainbow" }],
      ["setSectionProject", { container: "pinned", projectId: "p" }],
      ["setSectionProject", { container: "parent:a", projectId: "p" }],
      ["setSectionProject", { container: "loose", projectId: "has space" }],
      ["setSectionProject", { container: "loose", projectId: "" }],
    ] as const;
    for (const [method, input] of bad) await expect(harness.behavior.callRpc(method, input)).rejects.toThrow();
    expect(harness.realtimeSignals).toEqual([]);
  });

  it("rejects invalid collapse keys and publishes settings changes", async () => {
    const { harness } = setup();
    await expect(harness.behavior.callRpc("setCollapsed", { key: "order:bad", collapsed: true })).rejects.toThrow();
    await harness.behavior.setSettings({ density: "compact" });
    expect(harness.realtimeSignals).toContainEqual({ channel: "settings", payload: {} });
  });
});
