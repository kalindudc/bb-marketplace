// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Sqlite from "better-sqlite3";
import { setup } from "../server/runtime-fixture";
import { settingsViewSchema } from "../../src/shared/settings";
import { insightsSchema } from "../../src/shared/insights";
const location = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => location.home }));
import tavern from "../../server";
let close: (() => Promise<void>) | undefined;
afterEach(async () => { try { await close?.(); } finally { close = undefined; vi.unstubAllEnvs(); } });
it("registers core, live settings, Insights and CLI together through the real server entrypoint", async () => {
  location.home = mkdtempSync(join(tmpdir(), "tavern-server-settings-"));
  vi.stubEnv("HOME", location.home);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(location.home, "pi-agent"));
  const db = new Sqlite(join(location.home, "data.db")), f = setup({ plugins: { list: async () => ({ plugins: [] }) } });
  const disposals: (() => unknown)[] = [];
  Object.assign(f.bb, {
    storage: { database: () => db, migrate: (_db: unknown, statements: string[]) => { for (const statement of statements) db.exec(statement); } },
    settings: { define: () => ({ get: async () => ({ scopes: "enforce" }), onChange: () => {} }) },
    ui: { registerMentionProvider: vi.fn() }, background: { service: vi.fn() },
    experimental_hooks: { ...f.bb.experimental_hooks, on: vi.fn() }, onDispose: (fn: () => unknown) => disposals.push(fn),
  });
  close = async () => { for (const dispose of disposals.reverse()) await dispose(); db.close(); (f.k.store.db as unknown as Sqlite.Database).close(); rmSync(location.home, { recursive: true, force: true }); };
  await tavern(f.bb);
  const before = settingsViewSchema.parse(JSON.parse(JSON.stringify(await f.harness.invokeRpc("settings", null))));
  expect(before.effective.attention.reviewBudget).toBe(3);
  expect(await f.harness.invokeRpc("settingsUpdate", { revision: before.revision, patch: { attention: { reviewBudget: 7 } }, why: "Live server wiring" })).toMatchObject({ code: "ok" });
  expect(await f.harness.invokeRpc("room", {})).toMatchObject({ review: { budget: 7 }, hearthFlicker: true });
  const invalidations = vi.spyOn(f.bb.rpc, "experimental_invalidate");
  let revision = 1;
  for (const value of [false, true]) {
    invalidations.mockClear();
    expect(await f.harness.invokeRpc("settingsUpdate", { revision: revision++, patch: { tavern: { levels: value, widgetRow: value, hearthFlicker: value } }, why: "Presentation preference" })).toMatchObject({ code: "ok" });
    expect(invalidations.mock.calls.flatMap(([tags]) => tags)).toContain("tavern:settings");
    expect(await f.harness.invokeRpc("registry", {})).toMatchObject({ levels: value });
    expect(await f.harness.invokeRpc("decor", { threadId: "untyped" })).toMatchObject({ widgetRow: value });
    expect(await f.harness.invokeRpc("room", {})).toMatchObject({ hearthFlicker: value });
  }
  expect(insightsSchema.parse(JSON.parse(JSON.stringify(await f.harness.invokeRpc("insights", { range: "7d" }))))).toMatchObject({ range: "7d", cost: null });
  expect(await f.harness.invokeRpc("settingsExport", {})).toMatchObject({ toml: expect.stringContaining("review_budget = 7") });
  expect(f.harness.inspection.registrations.cli).toHaveLength(1);
});
