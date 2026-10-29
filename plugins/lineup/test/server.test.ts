import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import lineup from "../server";

function setup(settings: Record<string, number> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lineup", settings });
  lineup(bb);
  return { bb, harness };
}

type State = { lineup: Array<{ providerId: string; model: string }>; lastView: string };

const gpt = { providerId: "pi", model: "openai/gpt-5.5" };
const sol = { providerId: "codex", model: "gpt-6.1-sol" };
const opus = { providerId: "claude-code", model: "claude-opus-5-5" };

describe("Lineup server", () => {
  it("starts with an empty lineup on bb's own tab", async () => {
    const { harness } = setup();
    expect(await harness.behavior.callRpc("state", null)).toEqual({ lineup: [], lastView: "native" });
  });

  it("pins and unpins one model at a time and tells every window", async () => {
    const { harness } = setup();
    await harness.behavior.callRpc("pin", { ...gpt, pinned: true });
    expect(await harness.behavior.callRpc("pin", { ...gpt, pinned: true })).toEqual({ lineup: [gpt], lastView: "native" });
    expect(await harness.behavior.callRpc("pin", { ...gpt, pinned: false })).toEqual({ lineup: [], lastView: "native" });
    expect(harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual([
      "state-changed",
      "state-changed",
      "state-changed",
    ]);
  });

  it("moves a pinned model up or down", async () => {
    const { harness } = setup();
    await harness.behavior.callRpc("pin", { ...gpt, pinned: true });
    await harness.behavior.callRpc("pin", { ...sol, pinned: true });
    expect(((await harness.behavior.callRpc("move", { ...sol, delta: -1 })) as State).lineup).toEqual([sol, gpt]);
    await expect(harness.behavior.callRpc("move", { ...sol, delta: 2 })).rejects.toThrow();
  });

  it("keeps every change when writes overlap", async () => {
    const { harness } = setup();
    await Promise.all([
      harness.behavior.callRpc("pin", { ...gpt, pinned: true }),
      harness.behavior.callRpc("pin", { ...sol, pinned: true }),
      harness.behavior.callRpc("setLastView", { view: "lineup" }),
      harness.behavior.callRpc("pin", { ...opus, pinned: true }),
    ]);
    const state = (await harness.behavior.callRpc("state", null)) as State;
    expect(state.lastView).toBe("lineup");
    expect(state.lineup).toEqual([gpt, sol, opus]);
  });

  it("remembers the last tab and rejects unknown ones", async () => {
    const { harness } = setup();
    await harness.behavior.callRpc("pin", { ...gpt, pinned: true });
    expect(await harness.behavior.callRpc("setLastView", { view: "recent" })).toEqual({ lineup: [gpt], lastView: "recent" });
    await expect(harness.behavior.callRpc("setLastView", { view: "starred" })).rejects.toThrow();
  });

  it("keeps writing after a failed write", async () => {
    const { bb, harness } = setup();
    const set = bb.storage.kv.set.bind(bb.storage.kv);
    let fail = true;
    bb.storage.kv.set = async (key, value) => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      return set(key, value);
    };
    await expect(harness.behavior.callRpc("pin", { ...gpt, pinned: true })).rejects.toThrow("disk full");
    expect(((await harness.behavior.callRpc("pin", { ...sol, pinned: true })) as State).lineup).toEqual([sol]);
  });

  it("starts empty and logs a warning when stored state is unreadable", async () => {
    const { bb, harness } = setup();
    await bb.storage.kv.set("state", { lineup: "nope" });
    expect(await harness.behavior.callRpc("state", null)).toEqual({ lineup: [], lastView: "native" });
    expect(JSON.stringify(harness.inspection.logEntries)).toContain("does not match the schema");
  });

  it("lists the models recent threads ran on, up to the configured limit", async () => {
    const { harness } = setup({ recentLimit: 2 });
    const listed: unknown[] = [];
    harness.inspection.sdk.stub("threads.list", async (args: { offset: number; limit: number }) => {
      listed.push(args);
      return [
        { id: "a", providerId: "pi", updatedAt: 30 },
        { id: "b", providerId: "codex", updatedAt: 20 },
        { id: "c", providerId: "pi", updatedAt: 10 },
      ].slice(args.offset, args.offset + args.limit);
    });
    const byThread: Record<string, string> = { a: "openai/gpt-5.5", b: "gpt-5.5", c: "anthropic/claude-opus-5-5" };
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async ({ threadId }: { threadId: string }) => ({
      model: byThread[threadId],
      permissionMode: "auto",
      reasoningLevel: "high",
      serviceTier: "default",
      source: "client/turn/requested",
    }));
    expect(await harness.behavior.callRpc("recent", null)).toEqual({
      models: [
        { providerId: "pi", model: "openai/gpt-5.5", usedAt: 30 },
        { providerId: "codex", model: "gpt-5.5", usedAt: 20 },
      ],
    });
    expect(listed).toEqual([{ offset: 0, limit: 500 }]);
  });

  it("leaves out a thread whose model cannot be read instead of failing Recent", async () => {
    const { harness } = setup();
    harness.inspection.sdk.stub("threads.list", async () => [
      { id: "gone", providerId: "pi", updatedAt: 30 },
      { id: "b", providerId: "codex", updatedAt: 20 },
    ]);
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async ({ threadId }: { threadId: string }) => {
      if (threadId === "gone") throw new Error("thread not found");
      return { model: "gpt-5.5", permissionMode: "auto", reasoningLevel: "high", serviceTier: "default", source: "client/turn/requested" };
    });
    expect(await harness.behavior.callRpc("recent", null)).toEqual({
      models: [{ providerId: "codex", model: "gpt-5.5", usedAt: 20 }],
    });
    expect(JSON.stringify(harness.inspection.logEntries)).toContain("Recent skips thread gone: thread not found");
  });

  it("builds the catalog with each provider's brand prefix and every model", async () => {
    const { harness } = setup();
    harness.inspection.sdk.stub("providers.list", async () => [
      { id: "codex", displayName: "Codex", strings: { brandPrefix: "GPT-" } },
      { id: "broken", displayName: "Broken", strings: {} },
    ]);
    harness.inspection.sdk.stub("providers.models", async ({ providerId }: { providerId: string }) => {
      if (providerId === "broken") throw new Error("not signed in");
      return {
        modelLoadError: null,
        models: [{ model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" }],
        selectedOnlyModels: [{ model: "gpt-4", displayName: "GPT-4", routeProviderId: "legacy" }],
      };
    });
    expect(await harness.behavior.callRpc("catalog", null)).toEqual({
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          brandPrefix: "GPT-",
          models: [
            { model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" },
            { model: "gpt-4", displayName: "GPT-4", routeProviderId: "legacy" },
          ],
        },
      ],
    });
    expect(JSON.stringify(harness.inspection.logEntries)).toContain("could not load broken models");
  });
});
