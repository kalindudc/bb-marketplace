// @vitest-environment node
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import { enforcePluginCliOutputLimit } from "@get-bb/plugin-sdk/internal/host-policy";
import { expect, it, vi } from "vitest";
import type { Ask } from "../../src/shared/schema";
import { registerCli } from "../../src/server/cli";
import { setup } from "./runtime-fixture";

function statusFixture(asks: Ask[]) {
  const f = setup();
  vi.spyOn(f.k.store, "openAsks").mockReturnValue(asks);
  if (asks.length === 0) vi.spyOn(f.runtime, "review").mockReturnValue({ ...f.runtime.review(), waiting: "x".repeat(PLUGIN_CLI_OUTPUT_MAX_BYTES) as unknown as number });
  registerCli(f.bb, f.runtime);
  return async (args: string[]) => {
    const result = await f.harness.inspection.registrations.cli[0]!.run(["status", ...args], {});
    return enforcePluginCliOutputLimit({ exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }, false);
  };
}
function asks(count: number, body: string): Ask[] {
  return Array.from({ length: count }, (_, id) => ({ id: String(id), keeperThreadId: "keeper-" + id, createdAt: id, draft: { to: "fixture", body } }) as Ask);
}
it("reports that fixed status fields do not fit after the lists are empty", async () => {
  expect(await statusFixture([])([])).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/status.*too large/i) });
});
it("prints the entire status beyond Tavern's former 60,000-character cut", async () => {
  const input = asks(100, "é".repeat(900)), run = statusFixture(input);
  const result = await run([]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).asks).toEqual(input);
});
it("prints valid JSON under BB's byte limit and describes older omissions", async () => {
  const input = asks(Math.ceil(PLUGIN_CLI_OUTPUT_MAX_BYTES / 8000) + 100, "é".repeat(4000)), run = statusFixture(input);
  const result = await run([]);
  expect(result.exitCode).toBe(0);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(PLUGIN_CLI_OUTPUT_MAX_BYTES);
  const status = JSON.parse(result.stdout);
  expect(status).toMatchObject({ members: expect.any(Array), asks: expect.any(Array), review: expect.any(Object), truncated: { asks: expect.any(Number), narrow: expect.stringContaining("--thread") } });
  expect(status.truncated.asks).toBeGreaterThan(0);
  expect(status.asks).toEqual(input.slice(status.truncated.asks));
  const narrowed = await run(["--thread", "keeper-0"]);
  expect(narrowed.exitCode).toBe(0);
  expect(JSON.parse(narrowed.stdout).asks).toEqual(input.slice(0, 1));
});
