// @vitest-environment node
import { expect, it } from "vitest";
import { runProcess } from "../../src/host/process";

it("captures bounded output and closes stdin after its input", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdin.on('data', x => process.stdout.write(x)); process.stderr.write('diagnostic')"], { input: "payload", timeoutMs: 5000 });
  expect(result).toEqual({ code: 0, stdout: "payload", stderr: "diagnostic", timedOut: false });
});
it("rejects an aborted child operation", async () => {
  const controller = new AbortController();
  const result = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
});
it("reports its deadline without waiting for the child's own timer", async () => {
  const result = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
  expect(result.timedOut).toBe(true);
});
it("bounds output before terminating an overflowing process", async () => {
  await expect(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { timeoutMs: 5000, maxBuffer: 16 })).rejects.toMatchObject({ stdout: "x".repeat(16), message: expect.stringContaining("maxBuffer") });
});
