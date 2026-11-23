// @vitest-environment node
import { expect, it } from "vitest";
import { registerTools } from "../../src/server/tools";
import { freeHands } from "../../src/server/resting";
import { fixtureActivity } from "./member-fixture";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { placementRecord } from "./placement-fixture";
import { readStatus, statusInput } from "../../src/server/status";
import { concludeQuest, planInput, seedQuest } from "./support";

async function party() {
  const f = setup();
  registerTools(f.bb, f.runtime);
  const running = new Set(["watch", "rest"]);
  f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, status: running.has(threadId) ? "active" : "idle", environmentId: "env" });
  f.bb.sdk.threads.stop = async ({ threadId }) => { running.delete(threadId); return { ok: true }; };
  const q = await seedQuest(f.k, "lead", "Watch the tracker", "Tracker");
  const brief = { outcome: "Watch for changes", doneWhen: "Report changes", mode: "make-it-work" as const, outOfScope: "Writes", context: [], questions: [], timeboxMinutes: null };
  for (const id of ["watch", "rest"]) {
    f.k.bind(id, "ranger", "lark", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: id, brief });
    f.runtime.spawnBriefDelivered(id);
  }
  const mark = (member: string) => f.runtime.keep("lead", member, undefined, "Ongoing watch", true);
  return { ...f, q, mark, running };
}

it("keeps active and resting permanent members past the keep cap without stale, quiet or rest nudges; Undo restores normal rules", async () => {
  const f = await party();
  const watch = f.mark("watch"), rest = f.mark("rest");
  expect(watch).toMatchObject({ reversible: true, why: "Ongoing watch" });
  fixtureActivity(f.k, "rest", "done");
  f.advance(169 * 60 * 60_000);
  const events = () => f.k.store.events("lead", 0, 200).filter(e => ["member.stale", "member.quiet", "member.rest-reminder"].includes(e.type));
  f.k.stale("lead");
  f.runtime.remindResting("lead");
  expect(events()).toEqual([]);
  expect(f.k.member("watch")?.strikes).toBe(0);
  expect(freeHands(f.k, "lead").map(row => row.threadId)).not.toContain("rest");

  await f.runtime.undoDecision(watch.id);
  await f.runtime.undoDecision(rest.id);
  expect(f.k.member("watch")?.permanent).toBeUndefined();
  expect(f.k.member("rest")?.permanent).toBeUndefined();
  expect(() => f.runtime.keep("lead", "rest", f.time() + 169 * 60 * 60_000, "Follow-up")).toThrow(/hours/);
  f.k.stale("lead");
  f.runtime.remindResting("lead");
  expect(f.k.member("watch")?.strikes).toBe(1);
  expect(events().map(e => e.type)).toEqual(["member.stale", "member.rest-reminder"]);
  expect(freeHands(f.k, "lead").map(row => row.threadId)).toContain("rest");
});

it.each(["stale", "quiet"] as const)("drops a pending %s alert if the member becomes permanent during the wake-up lookup", async kind => {
  const f = await party();
  f.advance(169 * 60 * 60_000);
  if (kind === "quiet") fixtureActivity(f.k, "watch", "working");
  let resolve!: (ids: ReadonlySet<string>) => void;
  const lookup = new Promise<ReadonlySet<string>>(done => { resolve = done; });
  let candidates: string[] = [];
  const run = f.k.stale("lead", undefined, ids => { candidates = ids; return lookup; });
  expect(candidates).toContain("watch");
  f.mark("watch");
  resolve(new Set());
  await run;
  const alerts = f.k.store.events("lead").filter(e => e.data.memberThreadId === "watch" && ["member.stale", "member.quiet"].includes(e.type));
  expect(alerts).toEqual([]);
  expect(f.k.member("watch")?.strikes).toBe(0);
});

it("accepts only a reasoned permanent mark with no deadline at the tool boundary", async () => {
  const f = await party();
  const keep = (input: unknown) => f.harness.behavior.invokeAgentTool("tavern_keep", input, { threadId: "lead" });
  await expect(keep({ member: "watch", permanent: true, why: "" })).rejects.toThrow(/why/);
  await expect(keep({ member: "watch", permanent: true, until: f.time() + 1000, why: "Watch" })).rejects.toThrow(/either until/);
  await expect(keep({ member: "watch", why: "Watch", closingExempt: true })).rejects.toThrow(/either until/);
  await keep({ memberThreadId: "watch", permanent: true, why: "Watch" });
  expect(f.k.member("watch")?.permanent).toMatchObject({ why: "Watch" });
});

it("keeps a settled permanent member and its lost machine visible without nudging cleanup", async () => {
  const f = await party();
  f.mark("rest");
  fixtureActivity(f.k, "rest", "done");
  f.advance(40 * 60_000);
  const defaults = placementRecord();
  f.runtime.placements().store.reserve(placementRecord({ memberThreadId: "rest", keeperThreadId: "lead", questId: f.q.id,
    preservation: { ...defaults.preservation, source: "lost" } }), { maxMakers: 2, maxCheckers: 2 });
  const status = readStatus(f.runtime, "lead", statusInput.parse({}));
  expect(status).toMatchObject({ freeHands: [expect.objectContaining({ threadId: "rest", machineLost: true })],
    restingMembers: [expect.objectContaining({ threadId: "rest", machineLost: true, settled: true })] });
  const ledger = f.k.restatement("lead");
  expect(ledger).toMatch(/Resting, settled[\s\S]*machine lost/);
  expect(ledger).not.toContain("re-brief or release");
  f.runtime.remindResting("lead");
  expect(f.k.store.events("lead").some(e => e.type === "member.rest-reminder")).toBe(false);
});

it("refuses a Closing time exemption before the Keeper makes the member permanent", async () => {
  const f = await party();
  const keep = (why: string, closingExempt?: true) => f.harness.behavior.invokeAgentTool("tavern_keep", { member: "watch", permanent: true, why, closingExempt }, { threadId: "lead" });
  await expect(keep("Night shift", true)).rejects.toThrow(/make .*permanent first/i);
  expect(f.k.member("watch")?.permanent).toBeUndefined();
  await keep("Ongoing watch");
  await keep("Night shift", true);
  expect(f.k.member("watch")?.permanent).toMatchObject({ why: "Ongoing watch", closingExemption: { why: "Night shift" } });
});

it("does not exempt a permanent member from Stop all", async () => {
  const f = await party();
  f.mark("watch");
  const state = await f.runtime.stopAll.stop({ kind: "user" });
  expect(state.receipt?.entries.some(row => row.threadId === "watch")).toBe(true);
  expect(f.running.has("watch")).toBe(false);
});

it("still releases a permanent member and will not re-mark it after release", async () => {
  const f = await party();
  f.mark("watch");
  expect(await f.runtime.release("lead", "watch", "Watch complete")).toBe(true);
  expect(f.k.member("watch")?.engagement).toMatch(/released|archived/);
  expect(() => f.mark("watch")).toThrow();
});

it("archives a permanent member on quest close", async () => {
  const f = await party();
  f.mark("watch");
  const plan = planInput(f.q.id);
  f.k.plan("lead", { ...plan, waypoints: [{ ...plan.waypoints[0]!, optional: true }] });
  await concludeQuest(f.runtime, "lead", f.q.id, "Watch complete", "", [{ waypointId: "w1", reason: "Optional" }]);
  expect(f.k.quest(f.q.id).phase).toBe("done");
  expect(f.harness.inspection.sdk.callsTo("threads.archive")).toContainEqual({ path: "threads.archive", args: [{ threadId: "watch" }] });
});
