// @vitest-environment node
import { withMemberFixtures } from "./member-fixture";
import { putQuestFixture } from "./support";
import { afterEach, expect, it } from "vitest";
import { Keeper } from "../../src/server/keeper/service";
import { registerJournal } from "../../src/server/journal";
import { TavernRuntime } from "../../src/server/runtime";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
it("a real accepted rebrief removes maker proof but keeps the Warden's independent check and completed catch", async () => {
  const f = setup(); databases.push(f.k.store.db);
  f.bb.sdk.plugins.list = async () => ({ plugins: [] });
  f.bb.sdk.threads.getPluginMetadata = async () => ({});
  let k: Keeper, runtime: TavernRuntime;
  const journal = registerJournal(f.bb, f.k.store.db, {
    roleOf: id => runtime?.journalRole(id) ?? null,
    invalidate: () => {}, reviewed: input => runtime.serviceRecords.reviewed(input), superseded: input => runtime.serviceRecords.superseded(input),
  });
  k = withMemberFixtures(new Keeper(f.k.store, journal, f.time, () => {})); runtime = new TavernRuntime(f.bb, k, f.runtime.registry);
  k.receiveUser("lead", "Return exactly unknown for NaN."); k.route("lead", { kind: "new-quest", summary: "Format", notes: [] });
  const q = await k.openQuest("lead", "Format", "Exact wording");
  const brief = { outcome: "Format", mode: "make-it-work" as const, outOfScope: "Publish", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null };
  for (const [threadId, classId, characterId] of [["maker", "smith", "juno"], ["checker", "warden", "vex"]]) k.bind(threadId!, classId!, characterId!, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false, title: "Format", brief });
  k.store.put("members", "checker", { ...k.member("checker")!, checkIndependence: "independent" });
  const plan = planInput(q.id);
  k.plan("lead", { ...plan, waypoints: [{ ...plan.waypoints[0]!, owner: "maker" }], party: [{ classId: "warden", characterId: "vex", model: null, purpose: "Check", waypointIds: ["w1"] }] });
  await journal.prepare("maker");
  const id = journal.linkWaypoint("maker", { boardQuestId: q.id, waypointId: "w1" }, "Format", "maker", { kind: "tavern" });
  const run = async (threadId: string, input: unknown) => {
    const result = await f.harness.behavior.invokeAgentTool("journal", input, { threadId });
    expect(typeof result, JSON.stringify(result)).toBe("string");
  };
  await run("maker", { action: "done", id, evidence: [{ kind: "command", ref: "npm test", detail: "Old tests pass", exitCode: 0 }] });
  await run("checker", { action: "reject", threadId: "maker", id, reason: "Missing NaN case", evidence: [{ kind: "file", ref: "format.js:2", detail: "Wrong NaN output", exitCode: null }] });
  await run("maker", { action: "done", id, evidence: [{ kind: "command", ref: "npm test", detail: "New NaN case passes", exitCode: 0 }] });
  await run("checker", { action: "verify", threadId: "maker", id, evidence: [{ kind: "command", ref: "npm test", detail: "Independent NaN check passes", exitCode: 0 }] });
  expect(k.store.all("serviceVerdicts").find(row => row.verdict === "verified")?.fixesRejectionId).toBeTruthy();
  runtime.spawnBriefDelivered("maker");
  expect(await runtime.tell("lead", "maker", "Also cover infinity.")).toMatchObject({ status: "delivered" });
  expect(journal.get("maker").entries.find(entry => entry.id === id)).toMatchObject({ status: "doing", review: null, evidence: [] });
  expect(k.store.all("serviceVerdicts").find(row => row.verdict === "verified")).toHaveProperty("superseded");
  putQuestFixture(k.store, q.id, { ...k.quest(q.id), phase: "stopped", endedAt: f.time() }); runtime.serviceRecords.record(q.id);
  const records = runtime.serviceRecords.read();
  expect(records.find(row => row.characterId === "vex")?.warden).toMatchObject({ checks: 2, independentChecks: 2, caughtDefects: 1 });
  expect(records.find(row => row.characterId === "juno")).toBeUndefined();
  expect(records.find(row => row.characterId === "wren")?.keeper).toMatchObject({ verifiedWaypoints: 0, verifiedReturns: 0 });
});
