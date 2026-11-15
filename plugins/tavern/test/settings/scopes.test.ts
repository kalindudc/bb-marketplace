// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setup } from "../server/runtime-fixture";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights/index";
import { registerScopeSettings } from "../../src/server/scopes";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
async function fixture(initial: "enforce" | "watch" | "off", userMode?: typeof initial) {
  const root = mkdtempSync(join(tmpdir(), "tavern-canonical-settings-")); roots.push(root);
  const f = setup();
  const store = new SettingsStore(f.k.store.db, f.time, () => f.runtime.settingsChanged());
  f.runtime.enableSettings(store, new InsightsReader(f.k.store.db, store, f.time));
  if (userMode) store.update({ revision: 0, patch: { scopes: { mode: userMode } }, why: "Persisted user mode" });
  let saved = initial, listener: ((next: { scopes: string }, previous: { scopes: string }) => void) | undefined;
  const set = vi.fn(async ({ scopes }: { scopes: typeof initial }) => {
    const previous = saved; saved = scopes;
    if (scopes !== previous) listener?.({ scopes }, { scopes: previous });
  });
  Object.assign(f.bb, { settings: { define: () => ({ get: async () => ({ scopes: saved }), experimental_set: set,
    onChange: (fn: typeof listener) => { listener = fn; } }) } });
  await registerScopeSettings(f.bb, f.runtime, { dataDir: root, installGuard: false, policyOptions: { home: root } });
  return { ...f, store, set, saved: () => saved };
}
it("imports an existing non-default SDK scope preference instead of weakening it on upgrade", async () => {
  const f = await fixture("watch");
  expect(f.store.read().scopes.mode).toBe("watch");
  expect(f.runtime.scopes!.api.mode()).toBe("watch");
  expect(f.store.snapshot().history[0]!.reason).toMatch(/existing|legacy/i);
});
it("lets an explicit database preference win and mirrors it to the old SDK control", async () => {
  const f = await fixture("off", "enforce");
  expect(f.runtime.scopes!.api.mode()).toBe("enforce"); expect(f.saved()).toBe("enforce");
  f.store.update({ revision: f.store.snapshot().revision, patch: { scopes: { mode: "watch" } }, why: "Watch from the new page" });
  await vi.waitFor(() => expect(f.saved()).toBe("watch"));
  expect(f.runtime.scopes!.api.mode()).toBe("watch");
});
it("audits old SDK control changes in the database without a mirror loop", async () => {
  const f = await fixture("enforce");
  await f.set({ scopes: "off" });
  expect(f.store.read().scopes.mode).toBe("off"); expect(f.runtime.scopes!.api.mode()).toBe("off");
  expect(f.store.snapshot().history).toHaveLength(1); expect(f.store.snapshot().history[0]!.by).toBe("user");
});
