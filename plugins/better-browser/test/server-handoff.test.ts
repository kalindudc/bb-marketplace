// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import betterBrowser from "../server";
import { SETTLE_MS } from "../src/signin";

describe("server-owned handoff state", () => {
  it("survives helper-tab switches and logs effects without application URLs", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "better-browser" });
    betterBrowser(bb);
    const input = { threadId: "thr_1", tabId: "tab_1", mode: "automatic", targetUrl: "https://app.example.test/?token=do-not-log" };
    const advance = (event: Record<string, unknown>) => harness.behavior.callRpc("handoff", { ...input, event });
    try {
      await advance({ type: "form", visible: true, now: 0 });
      expect(await advance({ type: "tick", now: SETTLE_MS })).toMatchObject({ effects: [{ kind: "sync" }] });
      await harness.behavior.callRpc("handoff", { ...input, tabId: "helper", targetUrl: null, event: { type: "url", onSignInPage: false, now: SETTLE_MS } });
      expect(await advance({ type: "synced", set: 2, now: SETTLE_MS + 100 })).toMatchObject({ effects: [{ kind: "reload" }] });
      expect(await advance({ type: "form", visible: true, now: SETTLE_MS + 200 })).toMatchObject({ episode: { phase: { kind: "checking" } }, effects: [], targetUrl: input.targetUrl });
      expect(await advance({ type: "tick", now: SETTLE_MS * 2 + 100 })).toMatchObject({ effects: [{ kind: "open" }] });
      expect(await advance({ type: "tick", now: SETTLE_MS * 3 })).toMatchObject({ effects: [] });
      const logs = JSON.stringify(harness.logEntries);
      expect(logs).toContain("handoff");
      expect(logs).not.toContain("do-not-log");
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
