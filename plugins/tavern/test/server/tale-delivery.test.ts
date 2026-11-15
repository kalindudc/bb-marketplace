// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { seedQuest, planInput } from "./support";
import { registerRpc } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";
import { makeThreadResponse } from "./host";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";
import { captureTaleDelivery, backfillTaleDelivery } from "../../src/server/tale";
const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
async function fixture(overrides: Record<string, unknown> = {}) {
  const f = setup(overrides); dbs.push(f.k.store.db);
  const q = await seedQuest(f.k, "lead", "Delivery", "Deliver");
  const directive = `::tavern-tale{quest="${q.id}"}`;
  const wrap = () => f.k.store.event(f.time(), "lead", q.id, "quest.wrapped", "Done", { outcome: "Done" });
  return { ...f, q, directive, wrap };
}
it("captures from the idle runtime path and backfills only on explicit detail reads", async () => {
  const output = vi.fn(async (): Promise<{ output: string }> => ({ output: `Answer\n\n${f.directive}` }));
  const f = await fixture({ threads: { output } }); f.wrap();
  registerRpc(f.bb, f.runtime);
  await f.harness.invokeRpc("room", {});
  expect(output).not.toHaveBeenCalled();
  await f.harness.invokeRpc("boardQuest", { id: f.q.id });
  await f.harness.invokeRpc("boardQuest", { id: f.q.id });
  expect(output).toHaveBeenCalledTimes(1);
  const g = await fixture(); g.wrap();
  g.runtime.memberEnded(makeThreadResponse({ id: "lead" }), `Idle answer\n${g.directive}`);
  expect(g.k.store.get("taleDeliveries", g.q.id)?.text).toContain("Idle answer");
});
it("stores next actions on the wrap event and requires the bounded tool field", async () => {
  const f = await fixture(); registerTools(f.bb, f.runtime);
  f.k.plan("lead", { ...planInput(f.q.id), waypoints: [{ ...planInput(f.q.id).waypoints[0]!, optional: true }] });
  await f.runtime.wrap("lead", f.q.id, "Delivered", "", [{ waypointId: "w1", reason: "Not needed" }], ["Read the report"]);
  expect(f.k.store.events("lead", 0, 200).find(event => event.type === "quest.wrapped")?.data.next).toEqual(["Read the report"]);
  const tool = f.harness.inspection.registrations.agentTools.find(tool => tool.name === "tavern_wrap")!;
  const parameters = (tool as unknown as { parameters: { required: string[]; properties: Record<string, unknown> } }).parameters;
  expect(parameters.required).toContain("next");
  expect(parameters.properties.next).toMatchObject({ maxItems: 5, items: { maxLength: 200 } });
});
it("preserves deliveries and backfill attempts through a records backup", async () => {
  const f = await fixture(); f.wrap();
  captureTaleDelivery(f.k, "lead", f.directive);
  f.k.store.put("taleDeliveryAttempts", f.q.id, { attemptedAt: f.time() });
  const records = new BackupRecords(f.k.store.db, new SettingsStore(f.k.store.db, f.time));
  const snapshot = records.capture();
  const g = setup(); dbs.push(g.k.store.db);
  g.k.store.db.exec("DELETE FROM tavern_records; DELETE FROM tavern_runtime");
  new BackupRecords(g.k.store.db, new SettingsStore(g.k.store.db, g.time)).restore(snapshot);
  expect(g.k.store.get("taleDeliveries", f.q.id)).toEqual(f.k.store.get("taleDeliveries", f.q.id));
  expect(g.k.store.get("taleDeliveryAttempts", f.q.id)).toEqual({ attemptedAt: f.time() });
});
it("retells without wrap effects and retains each telling's frozen delivery", async () => {
  const f = await fixture();
  f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), phase: "done" });
  f.wrap(); captureTaleDelivery(f.k, "lead", `First delivery\n${f.directive}`);
  const old = f.k.store.get("taleDeliveries", f.q.id);
  const before = f.k.store.all("members"), record = f.k.store.all("serviceRecords");
  const events = f.k.store.events("lead", 0, 200).length;
  await f.runtime.wrap("lead", f.q.id, "New record", "Nothing", [], ["Read the new report"]);
  expect(f.k.store.events("lead", 0, 200)).toHaveLength(events + 1);
  expect(f.k.store.events("lead", 0, 200).at(-1)?.type).toBe("quest.retold");
  expect(f.k.store.all("members")).toEqual(before);
  expect(f.k.store.all("serviceRecords")).toEqual(record);
  expect(f.k.quest(f.q.id).phase).toBe("done");
  captureTaleDelivery(f.k, "lead", `Second delivery\n${f.directive}`);
  expect(f.k.store.get("taleDeliveries", f.q.id)).toEqual(old);
  registerRpc(f.bb, f.runtime);
  const detail = await f.harness.invokeRpc("boardQuest", { id: f.q.id }) as { tale: { delivery: { text: string }; outcome: string; next: string[] } };
  expect(detail.tale).toMatchObject({ outcome: "New record", next: ["Read the new report"], delivery: { text: `Second delivery\n${f.directive}` } });
  await expect(f.runtime.wrap("outsider", f.q.id, "Wrong", "", [], [])).rejects.toThrow();
});
it("captures only the owning Keeper's own directive after wrapping, once", async () => {
  const f = await fixture();
  captureTaleDelivery(f.k, "lead", f.directive);
  expect(f.k.store.get("taleDeliveries", f.q.id)).toBeNull();
  f.wrap();
  captureTaleDelivery(f.k, "lead", '::tavern-tale{quest="other"}');
  captureTaleDelivery(f.k, "other", f.directive);
  expect(f.k.store.get("taleDeliveries", f.q.id)).toBeNull();
  captureTaleDelivery(f.k, "lead", `Answer\n\n${f.directive}`);
  captureTaleDelivery(f.k, "lead", `Replacement\n${f.directive}`);
  expect(f.k.store.get("taleDeliveries", f.q.id)).toMatchObject({ text: `Answer\n\n${f.directive}`, truncated: false });
});
it.each([
  ["unbroken text", "x".repeat(25000), false],
  ["single fenced block", "\x60\x60\x60ui\n" + "x".repeat(25000) + "\n\x60\x60\x60", true],
  ["fenced lines", "\x60\x60\x60ui\n" + "A complete line.\n".repeat(1700) + "\x60\x60\x60", true],
])("keeps a nonempty bounded prefix of %s without a blank boundary", async (_name, body, fenced) => {
  const f = await fixture(); f.wrap();
  captureTaleDelivery(f.k, "lead", `${body}\n${f.directive}`);
  const delivery = f.k.store.get("taleDeliveries", f.q.id)!;
  expect(delivery.truncated).toBe(true);
  expect(delivery.text.length).toBeGreaterThan(100);
  expect(delivery.text.length).toBeLessThanOrEqual(24000);
  if (fenced) expect(delivery.text.endsWith("\n\x60\x60\x60")).toBe(true);
});
it("expires idle capture at 24 hours and cuts oversized delivery at a block boundary", async () => {
  const f = await fixture(); f.wrap();
  captureTaleDelivery(f.k, "lead", `Answer\n\n${"x".repeat(24000)}\n\n${f.directive}`);
  expect(f.k.store.get("taleDeliveries", f.q.id)).toMatchObject({ text: "Answer", truncated: true });
  const g = await fixture(); g.wrap(); g.advance(86400001);
  captureTaleDelivery(g.k, "lead", g.directive);
  expect(g.k.store.get("taleDeliveries", g.q.id)).toBeNull();
});
it("backfills once, including unsuccessful and failed attempts, without the idle time limit", async () => {
  const f = await fixture(); f.wrap(); f.advance(86400001);
  const output = vi.fn(async () => ({ output: `Delivered\n${f.directive}` }));
  await backfillTaleDelivery(f.k, f.q, output); await backfillTaleDelivery(f.k, f.q, output);
  expect(output).toHaveBeenCalledTimes(1);
  expect(f.k.store.get("taleDeliveries", f.q.id)?.text).toContain("Delivered");
  const g = await fixture(); g.wrap();
  const missing = vi.fn(async () => ({ output: "No directive" }));
  await Promise.all([backfillTaleDelivery(g.k, g.q, missing), backfillTaleDelivery(g.k, g.q, missing)]);
  expect(missing).toHaveBeenCalledTimes(1);
  expect(g.k.store.get("taleDeliveries", g.q.id)).toBeNull();
  const h = await fixture(); h.wrap();
  const failed = vi.fn(async (): Promise<{output: string | null}> => { throw Error("offline"); });
  await expect(backfillTaleDelivery(h.k, h.q, failed)).rejects.toThrow("offline");
  await backfillTaleDelivery(h.k, h.q, failed);
  expect(failed).toHaveBeenCalledTimes(1);
});
