// @vitest-environment node
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { TavernRuntime } from "../../src/server/runtime";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { dispatch049 } from "./dispatch-fixture";
import { makeThreadResponse } from "./host";
import { fixtureActivity } from "./member-fixture";
import { setup } from "./runtime-fixture";
import { planInput, putQuestFixture, seedQuest } from "./support";

const morning = (day: number, hour = 7) => new Date(2026, 0, day, hour).getTime();
const daily = { cadence: "daily" as const, at: "07:00", duty: "Read the public tracker" };
const receipt = { act: "answerAsk", surface: "page", attribution: "client" } as const;

async function fixture() {
  const f = setup();
  f.advance(morning(5, 6) - f.time());
  registerTools(f.bb, f.runtime);
  registerRpc(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Watch the tracker", "Watch");
  f.k.bind("watch", "ranger", "lark", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: false, title: "Watch", brief: {
    outcome: "Watch read-only", doneWhen: "Report changes", mode: "make-it-work", outOfScope: "Writes", context: [], questions: [], timeboxMinutes: null,
  } });
  f.runtime.spawnBriefDelivered("watch");
  f.runtime.keep("lead", "watch", undefined, "Standing duty", true);
  let status: "active" | "idle" = "idle";
  let runtime = f.runtime;
  const messages: string[] = [];
  f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, status: threadId === "watch" ? status : "idle", environmentId: "env", parentThreadId: threadId === "watch" ? "lead" : null });
  f.bb.sdk.threads.send = async ({ threadId, input }) => {
    const text = typeof input === "string" ? input : input.map(block => block.type === "text" ? block.text : "").join("\n");
    if (threadId === "watch" && (await runtime.dispatch(dispatch049({ threadId, text, pluginId: "tavern", status }))).action === "proceed") messages.push(text);
    return { ok: true, delivery: "sent" };
  };
  const propose = async (schedules: unknown[] = [daily], threadId = "lead") => {
    await f.harness.behavior.invokeAgentTool("tavern_keep", { member: "watch", permanent: true, why: "Check for changes", schedules }, { threadId });
    return f.k.store.openAsks("lead", q.id).find(ask => ask.effect?.type === "member-schedules")!;
  };
  const approve = async (schedules?: unknown[]) => {
    const ask = await propose(schedules);
    f.k.answerAsk(ask.id, "approve", null, "page", "user", undefined, {}, receipt);
  };
  const approveCard = (askId: string) => f.harness.invokeRpc("answerAsk", { askId, optionId: "approve", note: null, via: "page" });
  return { ...f, q, propose, approve, approveCard, messages, active: () => { status = "active"; }, idle: () => { status = "idle"; },
    sweep: () => runtime.sweep(), restart: () => {
      const store = new KeeperStore(new Database(f.k.store.db.serialize()));
      runtime = new TavernRuntime(f.bb, new Keeper(store, f.port, f.time), f.runtime.registry);
      return store;
    },
    schedules: () => f.k.member("watch")?.permanent?.schedules,
    at: (time: number) => f.advance(time - f.time()),
  };
}

it("wakes at the daily time once, then persists the next run and records the round", async () => {
  const f = await fixture();
  await f.approve();
  expect(f.schedules()?.[0]?.nextAt).toBe(morning(5));
  await f.sweep();
  expect(f.messages).toEqual([]);
  f.at(morning(5));
  await f.sweep();
  await f.sweep();
  expect(f.messages).toEqual([expect.stringContaining("Scheduled round (daily 07:00): Read the public tracker")]);
  expect(f.schedules()?.[0]?.nextAt).toBe(morning(6));
  expect(await f.harness.invokeRpc("ledger", { threadId: "lead" })).toMatchObject({ scheduledRounds: [
    expect.objectContaining({ type: "member.schedule-round", at: morning(5), data: expect.objectContaining({ nextAt: morning(6) }) }),
  ] });
  const duplicate = dispatch049({ threadId: "watch", pluginId: "tavern", text: f.messages[0] });
  await expect(f.runtime.dispatch(duplicate)).resolves.toMatchObject({ action: "reject" });
});

it.each(["request", "approval"] as const)("schedules and admits the next round when the member rests before %s", async stage => {
  const f = await fixture();
  if (stage === "request") fixtureActivity(f.k, "watch", "done");
  const ask = await f.propose();
  if (stage === "approval") fixtureActivity(f.k, "watch", "done");
  expect(f.k.member("watch")?.engagement).toBe("resting");
  expect(f.schedules()).toBeUndefined();

  await expect(f.approveCard(ask.id)).resolves.toMatchObject({ ok: true });
  expect(f.schedules()).toMatchObject([{ ...daily, nextAt: morning(5) }]);
  f.at(morning(5));
  await f.sweep();
  expect(f.messages).toEqual([expect.stringContaining(daily.duty)]);
  expect(f.schedules()?.[0]?.nextAt).toBe(morning(6));
});

it("refuses new schedule requests and pending approvals after release", async () => {
  const f = await fixture();
  const ask = await f.propose();
  f.bb.sdk.threads.stop = async () => ({ ok: true });
  expect(await f.runtime.release("lead", "watch", "Watch complete")).toBe(true);
  expect(f.k.member("watch")?.disposition).toBe("released");

  await expect(f.propose()).rejects.toThrow(/permanent member/);
  await expect(f.approveCard(ask.id)).rejects.toThrow(/permanent member/);
  expect(f.schedules()).toBeUndefined();
});

it("uses the server's local weekday and coalesces missed rounds across a restart", async () => {
  const f = await fixture();
  await f.approve([{ ...daily, cadence: "weekly", weekday: 2 }]);
  expect(f.schedules()?.[0]?.nextAt).toBe(morning(6));
  const store = f.restart();
  f.at(morning(7));
  await f.sweep();
  expect(f.messages[0]).toContain("Scheduled round (weekly Tue 07:00)");
  f.at(morning(29));
  await f.sweep();
  await f.sweep();
  expect(f.messages).toHaveLength(2);
  expect(store.get("members", "watch")?.permanent?.schedules?.[0]?.nextAt).toBe(new Date(2026, 1, 3, 7).getTime());
});

it("waits while the member is mid-turn, then runs only once when it is idle", async () => {
  const f = await fixture();
  await f.approve();
  f.active();
  f.at(morning(8));
  await f.sweep();
  expect(f.messages).toHaveLength(0);
  expect(f.schedules()?.[0]?.nextAt).toBe(morning(5));
  f.idle();
  await Promise.all([f.sweep(), f.sweep()]);
  expect(f.messages).toHaveLength(1);
  expect(f.schedules()?.[0]?.nextAt).toBe(morning(9));
});

it.each(["Stop all", "Closing time", "held", "stopping", "stopped", "done", "released", "spend"] as const)("never wakes on %s", async (block) => {
  const f = await fixture();
  await f.approve();
  f.at(morning(5));
  if (block === "Stop all") await f.runtime.stopAll.stop({ kind: "user" });
  else if (block === "Closing time") await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.q.id, endState: "pause" }] });
  else if (block === "released") await f.runtime.release("lead", "watch", "Complete");
  else if (block === "spend") f.k.store.put("quests", f.q.id, { ...f.k.quest(f.q.id), spendBudget: { cents: 1, reached: { at: f.time(), usdNanos: 10_000_000 } } });
  else putQuestFixture(f.k.store, f.q.id, { ...f.k.quest(f.q.id), phase: block });
  await f.sweep();
  expect(f.messages).toEqual([]);
  expect(f.k.store.events("lead").some(event => event.type === "member.schedule-round")).toBe(false);
});

it("rechecks the quest at admission if a hold starts after the sweep starts sending", async () => {
  const f = await fixture();
  await f.approve();
  f.at(morning(5));
  const send = f.bb.sdk.threads.send;
  f.bb.sdk.threads.send = async args => {
    if (args.threadId === "watch") f.k.setQuestHeld(f.q.id, true, { kind: "user" });
    return send(args);
  };
  await f.sweep();
  expect(f.messages).toHaveLength(0);
  expect(f.schedules()?.[0]?.nextAt).toBe(morning(5));
});

it("needs an exact user answer to add schedules, and only the Keeper or client can narrow them", async () => {
  const f = await fixture();
  await expect(f.propose([daily], "watch")).rejects.toThrow();
  const ask = await f.propose();
  expect(f.schedules()).toBeUndefined();
  expect(() => f.k.answerAsk(ask.id, "approve", null, "chat", "keeper")).toThrow(/explicit answer/);
  expect(() => f.k.answerAsk(ask.id, "approve", null, "timer", "default")).toThrow(/explicit answer/);
  await expect(f.runtime.answerAsk(ask.id, "approve", null, "cli", true, "terminal", { ...receipt, surface: "terminal" })).rejects.toThrow(/explicit answer/);
  expect(f.schedules()).toBeUndefined();
  f.k.answerAsk(ask.id, "deny", null, "page", "user", undefined, {}, receipt);
  expect(f.schedules()).toBeUndefined();
  await f.approve([daily, { ...daily, at: "08:00" }, { ...daily, at: "09:00" }]);
  await expect(f.propose()).rejects.toThrow(/three|3/);
  const [first, second] = f.schedules()!;
  const control = { threadId: "watch", id: first!.id, action: "pause" };
  await expect(f.harness.invokeRpc("updateMemberSchedule", control, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow();
  await f.harness.invokeRpc("updateMemberSchedule", control, { experimental_caller: { kind: "client" } });
  await f.harness.behavior.invokeAgentTool("tavern_keep", { member: "watch", why: "Stop this round", schedule: { id: second!.id, action: "remove" } }, { threadId: "lead" });
  expect(f.schedules()).toMatchObject([{ id: first!.id, paused: true }, { at: "09:00" }]);
  f.at(morning(5));
  await f.sweep();
  expect(f.messages).toHaveLength(0);
});

it.each([[{ ...daily, at: "24:01" }], [{ ...daily, cadence: "weekly" }], [{ ...daily, weekday: 7 }], [{ ...daily, duty: "x".repeat(301) }], [daily, daily, daily, daily]])("rejects malformed schedules before opening an ask", async (...schedules) => {
  const f = await fixture();
  await expect(f.propose(schedules)).rejects.toThrow(/schedule|cadence|weekday|duty|HH:MM/i);
  expect(f.k.store.openAsks("lead", f.q.id)).toHaveLength(0);
});

async function proposedSlot(schedules = [daily]) {
  const f = await fixture();
  const input = planInput(f.q.id);
  const slot = { classId: "smith", characterId: null, model: null, purpose: "Watch", waypointIds: ["w1"], permanent: { why: "Standing duty", schedules } };
  const plan = f.k.plan("lead", { ...input, party: [slot] });
  const ask = f.k.store.openAsks("lead", f.q.id).find(ask => ask.kind === "greenlight")!;
  const approve = () => f.k.answerAsk(ask.id, "approve", null, "page", "user", undefined, {}, receipt);
  const hire = () => f.runtime.hire("lead", "project", { classId: "smith", boardQuestId: f.q.id, waypointId: "w1", title: "Watch", brief: { outcome: "Watch", mode: "make-it-work", outOfScope: "Writes", doneWhen: "Report changes", context: [], questions: [], timeboxMinutes: null } });
  const control = (threadId: string, id: string, action: "pause" | "remove") => f.harness.invokeRpc("updateMemberSchedule", { threadId, id, action });
  f.bb.sdk.threads.stop = async () => ({ ok: true });
  return { ...f, input, slot, plan, ask, approve, hire, control };
}

it("requires fresh greenlight when a plan changes the schedules of an approved permanent slot", async () => {
  const f = await proposedSlot();
  expect(f.plan.party[0]?.permanent?.schedules).toEqual([daily]);
  expect(() => f.k.answerAsk(f.ask.id, "approve", null, "page", "user")).toThrow(/explicit answer/);
  f.approve();
  const first = await f.hire();
  expect(f.k.member(first.threadId)?.permanent?.schedules).toMatchObject([{ ...daily, nextAt: morning(5) }]);
  const revised = f.k.plan("lead", { ...f.input, party: [{ ...f.slot, permanent: { ...f.slot.permanent, schedules: [{ ...daily, at: "08:00" }] } }] });
  expect(revised.party[0]?.permanent?.decisionId).not.toBe(f.plan.party[0]?.permanent?.decisionId);
  expect(f.k.quest(f.q.id).phase).toBe("greenlight");
});

it("does not accept a terminal answer as a scheduled slot's greenlight", async () => {
  const f = await proposedSlot();
  await expect(f.runtime.answerAsk(f.ask.id, "approve", null, "cli", true, "terminal", { ...receipt, surface: "terminal" })).rejects.toThrow(/explicit answer/);
  expect(f.k.quest(f.q.id).greenlitVersion).toBeNull();
  expect(f.k.store.get("asks", f.ask.id)?.state).toBe("open");
});

it("keeps paused and removed schedules when replacing a permanent slot occupant", async () => {
  const f = await proposedSlot([daily, { ...daily, at: "08:00" }]);
  f.approve();
  const first = await f.hire();
  const [paused, removed] = f.k.member(first.threadId)!.permanent!.schedules!;
  await f.control(first.threadId, paused!.id, "pause");
  await f.control(first.threadId, removed!.id, "remove");
  const replacement = await f.runtime.replaceMember("lead", "project", first.threadId, "Replace stuck turn");
  if (replacement.state !== "replaced") throw new Error(JSON.stringify(replacement));
  expect(f.k.member(replacement.threadId)?.permanent?.schedules).toEqual([{ ...paused, paused: true }]);
});

it("keeps a re-hired slot empty if the user removes its last schedule before the new member binds", async () => {
  const f = await proposedSlot();
  f.approve();
  const first = await f.hire();
  const id = f.k.member(first.threadId)!.permanent!.schedules![0]!.id;
  expect(await f.runtime.release("lead", first.threadId, "Free the seat")).toBe(true);
  const spawn = f.bb.sdk.threads.spawn;
  f.bb.sdk.threads.spawn = async args => {
    await f.control(first.threadId, id, "remove");
    return spawn(args);
  };
  const next = await f.hire();
  expect(f.k.member(next.threadId)?.permanent?.schedules).toEqual([]);
});
