import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import lineup from "../server";

function setup(settings: Record<string, number> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lineup", settings });
  lineup(bb);
  return { bb, harness };
}

const gpt = { providerId: "pi", model: "openai/gpt-5.5" };

describe("Lineup server", () => {
  it("starts with an empty lineup on bb's own tab", async () => {
    const { harness } = setup();
    expect(await harness.behavior.callRpc("state", null)).toEqual({ lineup: [], lastView: "native" });
  });

  it("saves the lineup without duplicates and tells every window", async () => {
    const { harness } = setup();
    const saved = await harness.behavior.callRpc("saveLineup", { lineup: [gpt, gpt] });
    expect(saved).toEqual({ lineup: [gpt], lastView: "native" });
    expect(await harness.behavior.callRpc("state", null)).toEqual(saved);
    expect(harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual(["state-changed"]);
  });

  it("remembers the last tab and rejects unknown ones", async () => {
    const { harness } = setup();
    await harness.behavior.callRpc("saveLineup", { lineup: [gpt] });
    expect(await harness.behavior.callRpc("setLastView", { view: "recent" })).toEqual({ lineup: [gpt], lastView: "recent" });
    await expect(harness.behavior.callRpc("setLastView", { view: "starred" })).rejects.toThrow();
  });

  it("starts empty and logs a warning when stored state is unreadable", async () => {
    const { bb, harness } = setup();
    await bb.storage.kv.set("state", { lineup: "nope" });
    expect(await harness.behavior.callRpc("state", null)).toEqual({ lineup: [], lastView: "native" });
    expect(JSON.stringify(harness.inspection.logEntries)).toContain("does not match the schema");
  });

  it("lists the models recent threads ran on, up to the configured limit", async () => {
    const { harness } = setup({ recentLimit: 2 });
    harness.inspection.sdk.stub("threads.list", async () => [
      { id: "a", providerId: "pi", updatedAt: 30 },
      { id: "b", providerId: "codex", updatedAt: 20 },
      { id: "c", providerId: "pi", updatedAt: 10 },
    ]);
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
