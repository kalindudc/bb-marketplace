// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { rpcContract } from "../../src/shared/contract";
import { briefForPrompt } from "../../src/server/brief-prompt";
import { SettingsStore } from "../../src/server/settings/store";
import { registerTools } from "../../src/server/tools";
import { makePluginAgentConfigurationContext } from "./host";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest } from "./support";

const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

async function fixture(waypointCount = 1) {
  const f = setup(); dbs.push(f.k.store.db);
  registerTools(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Read the report", "Report");
  const plan = planInput(q.id);
  const waypoints = Array.from({ length: waypointCount }, (_, i) => ({ ...plan.waypoints[0]!, id: `w${i + 1}`, title: `Step ${i + 1}`, check: "warden" as const, optional: i > 0 }));
  f.k.plan("lead", { ...plan, waypoints, party: [{ classId: "smith", characterId: null, model: null, purpose: "Check the report", waypointIds: ["w1"] }] });
  f.k.answerAsk(f.k.store.openAsks("lead", q.id)[0]!.id, "approve", null, "page", "user");
  const call = (name: string, input: unknown, threadId = "lead") => f.harness.behavior.invokeAgentTool(name, input, { threadId });
  return { ...f, q, call };
}

const brief = { outcome: "Scout", mode: "make-it-work" as const, outOfScope: "Other work", doneWhen: "Answers given", context: [] as string[], questions: ["What changed?"], timeboxMinutes: 5 };
const scout = (q: string, title: string) => ({ classId: "ranger", boardQuestId: q, title, brief });

it("closes and reloads a quest with long tale text, next steps, a long skip reason and more than 24 waivers", async () => {
  const f = await fixture(26);
  const { registerRpc } = await import("../../src/server/rpc");
  registerRpc(f.bb, f.runtime);
  const outcome = "outcome ".repeat(700).trim();
  const left = "left ".repeat(900).trim();
  const next = Array.from({ length: 6 }, () => "next ".repeat(60).trim());
  const reason = "Close early because the work changed. ".repeat(20).trim();
  const skipReason = "Already done outside this quest. ".repeat(20).trim();
  f.k.settle("lead", { boardQuestId: f.q.id, waypointId: "w26", as: "skipped", reason: skipReason });
  await f.call("tavern_wrap", { boardQuestId: f.q.id, outcome, left, next, reason });
  const ask = f.k.store.openAsks("lead", f.q.id).find(a => a.kind === "conclude")!;
  await f.harness.invokeRpc("answerAsk", { askId: ask.id, optionId: "close-early", note: null, via: "page" });
  const waivers = f.k.quest(f.q.id).waivers!;
  expect(waivers).toHaveLength(25);
  expect(f.k.store.get("serviceRecords", f.q.id)).toMatchObject({ waivers, waypoints: { waived: 25 } });
  const detail = rpcContract.boardQuest.output.parse(await f.harness.invokeRpc("boardQuest", { id: f.q.id }));
  expect(detail?.tale).toMatchObject({ outcome, left, next, closeReason: reason, waivers, skipped: [{ waypointId: "w26", reason: skipReason }] });
});

it("hires one scout, records a shortened decision, and names the shortening", async () => {
  const f = await fixture();
  const title = "t".repeat(500);
  const result = await f.call("tavern_hire", scout(f.q.id, title));
  expect(result).toContain("Hired");
  expect(result).toContain("Scouting decision text shortened");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.k.store.all("members").find(m => m.classId === "ranger")?.title).toBe(title);
  const decision = f.k.store.all("decisions").find(d => d.text.includes("for reversible scouting"));
  expect(decision?.text).toMatch(/…$/);
});

it("names the created thread rather than inviting a second hire if bookkeeping fails after spawn", async () => {
  const f = await fixture();
  vi.spyOn(f.k, "decide").mockImplementationOnce(() => { throw new Error("Fixture: could not record this decision"); });
  const result = await f.call("tavern_hire", scout(f.q.id, "Check the facts"));
  const member = f.k.store.all("members").find(m => m.classId === "ranger")!;
  expect(result).toContain(member.threadId);
  expect(result).toContain("Do not hire again");
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  expect(f.k.store.all("hires")).toHaveLength(1);
});

it("budgets the delivered brief and configured prompt without losing exact stored context", async () => {
  const f = await fixture();
  const firstPath = "./read-first.txt";
  const omitted = "./read-next-verbatim.txt";
  const context = [firstPath, ...Array.from({ length: 140 }, (_, i) => `docs/${i}/` + "a".repeat(1600)), omitted];
  const result = await f.call("tavern_hire", { ...scout(f.q.id, "Scout the facts"), brief: { ...brief, context } });
  const notice = "Limit: limits.intake.briefPromptBytes = 32000 (Settings, Limits)";
  expect(result).toContain(notice);
  const member = f.k.store.all("members").find(m => m.classId === "ranger")!;
  const spawn = f.harness.inspection.sdk.callsTo("threads.spawn")[0]!.args[0] as { input: { text: string }[] };
  expect(spawn.input[0]?.text).toContain(firstPath);
  expect(spawn.input[0]?.text).toContain(notice);
  expect(Buffer.byteLength(spawn.input[0]!.text)).toBeLessThan(35000);
  expect(f.k.store.runtime(member.threadId).brief?.context).toEqual(context);
  const instructions = f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: member.threadId } })).instructions;
  expect(instructions).toContain(notice);
  expect(await f.call("tavern_status", { section: "brief" }, member.threadId)).toContain(firstPath);
  expect(await f.call("tavern_status", { section: "brief", memberThreadId: member.threadId }, "lead")).toContain(firstPath);
  const exact = JSON.stringify(f.k.store.runtime(member.threadId).brief, null, 2);
  const page = await f.call("tavern_status", { section: "brief", offset: exact.lastIndexOf(omitted) }, member.threadId);
  expect(page).toContain(omitted);
  await expect(f.call("tavern_status", { section: "brief", memberThreadId: "lead" }, member.threadId)).rejects.toThrow(/keeper/i);
  await expect(f.call("tavern_status", {}, member.threadId)).rejects.toThrow(/keeper/i);

  const settings = f.runtime.settings = new SettingsStore(f.k.store.db);
  settings.update({ revision: settings.snapshot().revision, patch: { limits: { intake: { briefPromptBytes: 1024 } } }, why: "Reduce the prompt budget" });
  const adjusted = f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: member.threadId } })).instructions;
  expect(adjusted).toContain("Limit: limits.intake.briefPromptBytes = 1024");
  expect(adjusted).toContain(firstPath);
  expect(adjusted).not.toContain(context[1]!);
  expect(f.k.store.runtime(member.threadId).brief?.context).toEqual(context);
  f.k.store.patch(member.threadId, { scopePending: "scope-pending" });
  await expect(f.call("tavern_status", { section: "brief" }, member.threadId)).rejects.toThrow(/scope decision/i);
  expect(f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: member.threadId } })).instructions).not.toContain(firstPath);
  expect(await f.call("tavern_status", { section: "brief", memberThreadId: member.threadId })).toContain(firstPath);
});

it("counts UTF-8 and JSON escapes while shortening multiple prose fields", () => {
  const text = '🌱\\\n"'.repeat(300);
  const saved = { ...brief, outcome: text, doneWhen: text, outOfScope: text };
  const result = briefForPrompt(saved, 1024);
  expect(Buffer.byteLength(JSON.stringify(result.brief))).toBeLessThanOrEqual(1024);
  expect(result.notice).toContain("Brief shortened");
  expect(result.brief.outcome).toMatch(/…$/);
  expect(saved.outcome).toBe(text);
});
