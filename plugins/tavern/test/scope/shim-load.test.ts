// @vitest-environment node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { guardLoaderSource } from "../../src/scope/install";
const jiti = join(process.env.TAVERN_TEST_PI_MODULES!, "jiti/lib/jiti.mjs");
it.skipIf(!existsSync(jiti))("loads the shim with pi's actual jiti: no-op budget, stale target and real scoped imports", () => {
  const root = mkdtempSync(join(tmpdir(), "tavern-jiti-probe-"));
  try {
    const trivial = join(root, "trivial.ts"), shim = join(root, "shim.ts"), real = join(root, "real.ts");
    writeFileSync(trivial, "export default () => {};\n");
    writeFileSync(shim, guardLoaderSource(join(root, "missing.ts")));
    writeFileSync(real, guardLoaderSource(resolve("adapters/pi/extension.ts")));
    const source = `
      import { createJiti } from ${JSON.stringify(pathToFileURL(jiti).href)};
      const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
      delete process.env.TAVERN_SCOPE_FILE; delete process.env.TAVERN_SCOPE_MODE;
      const times = { baseline: [], shim: [] }, hooks = [];
      const pi = { on: (name, fn) => hooks.push([name, fn]), getActiveTools: () => ["bash", "quest"], setActiveTools: () => {} };
      for (let n = 0; n < 4; n++) for (const [name, file] of [["baseline", ${JSON.stringify(trivial)}], ["shim", ${JSON.stringify(shim)}]]) {
        const start = performance.now(); const extension = await jiti.import(file, { default: true }); await extension(pi); times[name].push(performance.now() - start);
      }
      if (hooks.length) throw new Error("Unscoped loader registered hooks");
      process.env.TAVERN_SCOPE_FILE = ${JSON.stringify(join(root, "missing-scope.json"))};
      const stale = await jiti.import(${JSON.stringify(shim)}, { default: true }); await stale(pi);
      const staleResult = hooks.find(([name]) => name === "tool_call")[1]({ toolName: "bash" });
      hooks.length = 0;
      const current = await jiti.import(${JSON.stringify(real)}, { default: true }); await current(pi);
      const currentResult = hooks.find(([name]) => name === "tool_call")[1]({ toolName: "bash", input: { command: "ls" } }, { cwd: ${JSON.stringify(root)} });
      console.log(JSON.stringify({ times, staleResult, currentResult }));
    `;
    const report = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 30000 }));
    expect(report.staleResult.block).toBe(true); expect(report.currentResult.block).toBe(true);
    const warm = report.times.shim.slice(1).sort((a: number, b: number) => a - b)[1];
    expect(warm).toBeLessThan(100);
    if (process.env.TAVERN_TIMING_REPORT) writeFileSync(process.env.TAVERN_TIMING_REPORT, JSON.stringify(report.times));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
