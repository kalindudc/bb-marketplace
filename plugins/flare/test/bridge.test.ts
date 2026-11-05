// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleLine, replyFor } from "../src/bridge";
import { NOT_AN_AGENT, RENDER_MARKER, parseRenderPrompt, renderPrompt } from "../src/provider";

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "flare-bridge-"));
  output = captureBridgeJsonRpcOutput();
});

afterEach(() => {
  output.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("the renderer bridge", () => {
  it("passes bb's provider bridge conformance suite", async () => {
    const report = await runBridgeConformance({
      transport: { send: handleLine, takeMessages: output.takeMessages },
      providerId: "flare",
      session: {
        cwd: workspaceDir,
        promptInput: [{ type: "text", text: renderPrompt("fl_1", "**Finding** · Root cause found"), mentions: [] }],
        zeroWorkPromptInput: [{ type: "text", text: RENDER_MARKER, mentions: [] }],
        icons: { pluginId: "flare", names: ["flare"] },
      },
      timeoutMs: 5_000,
    });
    output.restore();
    const failed = report.results.filter((result) => result.status !== "pass");
    expect(failed, formatConformanceReport(report)).toEqual([]);
    expect(report.passed).toBe(true);
  }, 30_000);

  it("echoes only what follows Flare's marker, and answers anything else with a note", () => {
    expect(replyFor(renderPrompt("fl_abc123", '# Hello\n\n```ui\nCard("x", [])\n```'))).toBe('# Hello\n\n```ui\nCard("x", [])\n```');
    // Prompts written before flares carried their id still render.
    expect(replyFor(`${RENDER_MARKER}Old flare`)).toBe("Old flare");
    expect(parseRenderPrompt(renderPrompt("fl_abc123", "x"))).toEqual({ flareId: "fl_abc123", text: "x" });
    expect(replyFor("hi there")).toBe(NOT_AN_AGENT);
  });
});
