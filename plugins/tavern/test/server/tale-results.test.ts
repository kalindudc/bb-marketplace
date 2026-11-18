// @vitest-environment node
import { putQuestFixture, concludeQuest } from "./support";
import { afterEach, expect, it } from "vitest";
import { taleResultsSchema } from "../../src/shared/tale-results";
import { readTale } from "../../src/server/tale";
import { setup } from "./runtime-fixture";
import { registerTools } from "../../src/server/tools";
import { seedQuest, planInput } from "./support";
const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const results = { figures: [{ label: "Checks", value: "42", note: "All passed" }], chart: { title: "Cost", type: "bars" as const, unit: "usd", labels: ["Before", "After"], series: [{ name: "Model", values: [2, 1] }] } };
it.each([{}, { figures: [] }])("refuses results with neither figures nor a chart", value => { expect(() => taleResultsSchema.parse(value)).toThrow(/figure or a chart/); });
it("accepts the bounded fixed results shape", () => { expect(taleResultsSchema.parse(results)).toEqual(results); });
it.each([
  { ...results, figures: Array(5).fill(results.figures[0]) },
  { ...results, figures: [{ label: "x".repeat(41), value: "1" }] },
  { ...results, figures: [{ label: "x", value: "x".repeat(25) }] },
  { ...results, figures: [{ label: "x", value: "1", note: "x".repeat(81) }] },
  { ...results, chart: { ...results.chart, title: "x".repeat(81) } },
  { ...results, chart: { ...results.chart, unit: "x".repeat(13) } },
  { ...results, chart: { ...results.chart, labels: ["One"] } },
  { ...results, chart: { ...results.chart, labels: Array(13).fill("x") } },
  { ...results, chart: { ...results.chart, labels: ["x".repeat(25), "b"] } },
  { ...results, chart: { ...results.chart, series: [] } },
  { ...results, chart: { ...results.chart, series: Array(4).fill(results.chart.series[0]) } },
  { ...results, chart: { ...results.chart, series: [{ name: "x".repeat(25), values: [1, 2] }] } },
  { ...results, chart: { ...results.chart, series: [{ name: "a", values: [1] }] } },
  { ...results, chart: { ...results.chart, series: [{ name: "a", values: [Infinity, 2] }] } },
  { ...results, source: "Load('/tmp/x')" },
])("refuses invalid results %#", value => { expect(() => taleResultsSchema.parse(value)).toThrow(); });
it("explains mismatched labels and values", () => {
  const value = { ...results, chart: { ...results.chart, series: [{ name: "Model", values: [1] }] } };
  expect(() => taleResultsSchema.parse(value)).toThrow(/one value per label/i);
});
it("refuses malformed tool results before changing a tale and gives the final-message guidance", async () => {
  const f = setup(); dbs.push(f.k.store.db); registerTools(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Build", "Build");
  putQuestFixture(f.k.store, q.id, { ...f.k.quest(q.id), phase: "done", endedAt: f.time() });
  const input = { boardQuestId: q.id, outcome: "Retold", left: "", next: [], results: { ...results, chart: { ...results.chart, series: [{ name: "Model", values: [1, 2, 3] }] } } };
  await expect(f.harness.behavior.invokeAgentTool("tavern_wrap", input, { threadId: "lead" })).rejects.toThrow(/one value per label/);
  expect(f.k.store.events("lead").some(event => event.type === "quest.retold")).toBe(false);
  const reply = await f.harness.behavior.invokeAgentTool("tavern_wrap", { ...input, results }, { threadId: "lead" });
  expect(reply).toContain("results.figures");
  expect(reply).toContain("results.chart");
  expect(reply).toContain("no notes about your process or tools");
  expect(reply).toContain("Do not repeat the next list");
  const tool = f.harness.inspection.registrations.agentTools.find(tool => tool.name === "tavern_wrap")!;
  expect(tool.description).toContain("check_ui");
  expect(tool.description).toContain("fix every error");
  expect(reply).toContain("check_ui");
  expect(reply).toContain("fix every error");
  for (const text of [tool.description, reply]) {
    expect(text).toContain("check tool is absent");
    expect(text).toContain("keep the block simple");
    expect(text).toContain("do not ask the user");
  }
  expect(tool.description).toContain("Do not repeat the next list");
});
it.each([{}, { figures: [] }, { chart: { title: "Broken" } }])("drops invalid stored results from wraps and retellings", async stored => {
  const f=setup();dbs.push(f.k.store.db);
  const q=await seedQuest(f.k,"lead","Build","Build");
  f.k.store.event(f.time(),"lead",q.id,"quest.wrapped","Done",{outcome:"Done",results:stored});
  expect(readTale(f.k,f.k.summary(q.id))).toMatchObject({outcome:"Done"});
  expect(readTale(f.k,f.k.summary(q.id))?.results).toBeUndefined();
  f.k.store.event(f.time(),"lead",q.id,"quest.retold","Retold",{outcome:"Retold",results:stored});
  expect(readTale(f.k,f.k.summary(q.id))).toMatchObject({outcome:"Retold"});
  expect(readTale(f.k,f.k.summary(q.id))?.results).toBeUndefined();
});
it("stores results on wrap and retell, reads the newest and permits old events", async () => {
  const f = setup(); dbs.push(f.k.store.db);
  const q = await seedQuest(f.k, "lead", "Build", "Build");
  f.k.plan("lead", { ...planInput(q.id), waypoints: [{ ...planInput(q.id).waypoints[0]!, optional: true }] });
  await concludeQuest(f.runtime, "lead", q.id, "First", "", [{ waypointId: "w1", reason: "Optional" }], [], results);
  expect(readTale(f.k, f.k.summary(q.id))?.results).toEqual(results);
  const next = { figures: [{ label: "Now", value: "43" }] };
  await concludeQuest(f.runtime, "lead", q.id, "Second", "", [], [], next);
  expect(readTale(f.k, f.k.summary(q.id))?.results).toEqual(next);
  await concludeQuest(f.runtime, "lead", q.id, "Legacy", "", [], []);
  expect(readTale(f.k, f.k.summary(q.id))?.results).toBeUndefined();
});
