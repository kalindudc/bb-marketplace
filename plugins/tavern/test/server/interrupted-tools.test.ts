// @vitest-environment node
import { runtimeFixture } from "./member-fixture";
import { seedLegacyQuest, seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { registerTools } from "../../src/server/tools";
import { setup } from "./runtime-fixture";
import { dispatch049 } from "./dispatch-fixture";
import { makeThreadResponse } from "./host";

const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Pushes", doneWhen: "Checks pass", context: [], questions: [], timeboxMinutes: null };
async function fixture() {
  const f = setup();
  const q = await seedQuest(f.k, "lead", "Build", "Build");
  f.k.endTurn("lead");
  f.k.bind("child", "smith", "bram", "project", {
    keeperThreadId: "lead", boardQuestId: q.id, waypointId: "w1", errand: false,
    title: "Build", displayName: "Juno", brief,
  });
  registerTools(f.bb, f.runtime);
  const invoke = (name: string, input: unknown, signal = new AbortController().signal) =>
    f.harness.inspection.registrations.agentTools.find(tool => tool.name === name)!.execute(input, { threadId: "lead", projectId: "project", signal });
  const events: { seq: number; createdAt: number; type: string; scope: { kind: string; turnId?: string }; data: Record<string, unknown> }[] = [];
  f.bb.sdk.threads.events.list = async args => events.filter(event => event.seq > Number(args.afterSeq ?? 0)) as never;
  const event = (type: string, data: Record<string, unknown>, turnId?: string) => {
    events.push({ seq: events.length + 1, createdAt: f.time(), type, scope: turnId ? { kind: "turn", turnId } : { kind: "thread" }, data });
  };
  const observe = () => f.runtime.observe(makeThreadResponse({ id: "lead" }), events.length);
  const route = f.k.store.query("routes", "keeperThreadId", "lead", 50).find(route => route.boardQuestId === q.id)!;
  const decision = { boardQuestId: q.id, text: "Keep the existing plan", why: "No change to scope", reversible: true, source: "keeper",
    coveredBy: { kind: "route", id: route.id }, options: ["Keep the plan", "Revise it"], consequence: { change: "None", audience: "The party", undo: "Revise the plan" }, unsure: false };
  return { ...f, q, invoke, event, observe, decision };
}

describe("Keeper tools and routing across Stop", () => {
  it("replays B1: preserves the unrouted Luc fact, then routes Carry on separately after Stop", async () => {
    const f = await fixture();
    seedLegacyQuest(f.k, "lead", "Earlier unrelated work", "Earlier work");
    f.event("turn/started", {}, "old");
    await f.observe();
    f.advance(10);
    await f.runtime.dispatch({ ...dispatch049({ text: "FYI Luc reviews this repo until 5pm", status: "active" }), attempt: "join-turn" });
    const calls = await Promise.allSettled([
      f.invoke("tavern_tell", { memberThreadId: "child", text: "Keep working" }),
      f.invoke("tavern_decide", f.decision),
    ]);
    for (const call of calls) {
      expect(call.status).toBe("rejected");
      if (call.status === "rejected") expect(String(call.reason)).toMatch(/route.*Luc.*no change/i);
    }
    f.advance(10);
    f.event("system/thread/interrupted", { reason: "manual-stop" });
    f.event("turn/completed", { status: "interrupted" }, "old");
    await f.observe();
    f.advance(10);
    await f.runtime.dispatch(dispatch049({ text: "Carry on, add the day assertion" }));
    expect(f.k.store.runtime("lead").pending.map(message => message.text)).toEqual([
      "FYI Luc reviews this repo until 5pm", "Carry on, add the day assertion",
    ]);
    const first = JSON.parse(await f.invoke("tavern_route", { kind: "aside", summary: "Luc reviews", notes: [{ kind: "fact", text: "Luc reviews until 5pm" }] }) as string);
    const next = JSON.parse(await f.invoke("tavern_route", { kind: "steer", boardQuestId: f.q.id, summary: "Add the day assertion", notes: [] }) as string);
    expect(first.userText).toContain("Luc");
    expect(next.userText).toContain("Carry on");
    expect(first.sourceMessageId).not.toBe(next.sourceMessageId);
    expect(f.k.store.events("lead").filter(event => event.type === "route.missed")).toEqual([]);
  });

  it("retains new input and its route when the interrupted turn's idle boundary arrives late", async () => {
    const f = await fixture();
    f.event("turn/started", {}, "old");
    await f.observe();
    f.advance(10);
    f.event("system/thread/interrupted", { reason: "manual-stop" });
    await f.observe();
    f.advance(10);
    await f.runtime.dispatch(dispatch049({ text: "Carry on" }));
    const routed = JSON.parse(await f.invoke("tavern_route", { kind: "steer", boardQuestId: f.q.id, summary: "Carry on", notes: [] }) as string);
    f.advance(10);
    f.event("turn/mainRun/updated", { state: "idle" }, "old");
    await f.observe();
    f.event("turn/completed", { status: "interrupted" }, "old");
    await f.observe();
    expect(f.k.applicableRoutes("lead").map(route => route.id)).toContain(routed.id);
    await expect(f.invoke("tavern_decide", f.decision)).resolves.toContain("Keep the existing plan");
  });

  it.each([false, true])("expires unrouted input only after a successful resumed turn (same native turn: %s)", async sameTurn => {
    const f = await fixture();
    f.event("turn/started", {}, "old");
    await f.observe();
    f.advance(10);
    await f.runtime.dispatch({ ...dispatch049({ text: "Old fact", status: "active" }), attempt: "join-turn" });
    f.advance(10);
    f.event("system/thread/interrupted", { reason: "manual-stop" });
    f.event("turn/completed", { status: "interrupted" }, "old");
    await f.observe();
    f.advance(10);
    await f.runtime.dispatch(dispatch049({ text: "Carry on" }));
    expect(f.k.store.runtime("lead").pending).toHaveLength(2);
    if (sameTurn) f.event("turn/mainRun/updated", { state: "running" }, "old");
    else f.event("turn/started", {}, "new");
    await f.observe();
    f.advance(10);
    f.event("turn/completed", { status: "completed" }, sameTurn ? "old" : "new");
    await f.observe();
    expect(f.k.store.runtime("lead").pending).toHaveLength(0);
    expect(f.k.store.events("lead").filter(event => event.type === "route.missed")).toHaveLength(2);
  });

  it.each(["tavern_tell", "tavern_decide"])("refuses %s cancelled before execution without changing anything", async name => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    const input = name === "tavern_tell" ? { memberThreadId: "child", text: "New work" } : f.decision;
    await expect(f.invoke(name, input, controller.signal)).rejects.toThrow(/cancelled|stopped/i);
    expect(f.k.store.all("decisions")).toEqual([]);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeUndefined();
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("lets an in-flight rebrief settle once after Stop and still routes the next user input", async () => {
    const f = await fixture();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let finish!: (value: { ok: true; delivery: "sent" }) => void;
    f.bb.sdk.threads.send = vi.fn<typeof f.bb.sdk.threads.send>(() => {
      entered();
      return new Promise<Awaited<ReturnType<typeof f.bb.sdk.threads.send>>>(resolve => { finish = resolve; });
    });
    const controller = new AbortController();
    f.event("turn/started", {}, "old");
    await f.observe();
    const call = f.invoke("tavern_tell", { memberThreadId: "child", text: "Keep working" }, controller.signal);
    await started;
    f.advance(10);
    f.event("system/thread/interrupted", { reason: "manual-stop" });
    f.event("turn/completed", { status: "interrupted" }, "old");
    controller.abort();
    await f.observe();
    f.advance(10);
    await f.runtime.dispatch(dispatch049({ text: "Carry on" }));
    finish({ ok: true, delivery: "sent" });
    await expect(call).resolves.toContain("Brief delivered to Juno");
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(runtimeFixture(f.k.store, "child").pendingBrief).toBeNull();
    const route = JSON.parse(await f.invoke("tavern_route", { kind: "steer", boardQuestId: f.q.id, summary: "Carry on", notes: [] }) as string);
    expect(route.userText).toBe("Carry on");
  });

  it("does not turn a completed synchronous decision into a cancellation failure", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const invalidate = f.bb.rpc.experimental_invalidate;
    f.bb.rpc.experimental_invalidate = tags => { controller.abort(); invalidate(tags); };
    await expect(f.invoke("tavern_decide", f.decision, controller.signal)).resolves.toContain("Keep the existing plan");
    expect(f.k.store.all("decisions")).toHaveLength(1);
  });

  it("explains a cancelled asynchronous failure without asserting that nothing applied", async () => {
    const f = await fixture();
    let fail!: (reason: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(f.runtime, "tell").mockImplementation(() => { entered(); return new Promise((_, reject) => { fail = reject; }); });
    const controller = new AbortController();
    const call = f.invoke("tavern_tell", { memberThreadId: "child", text: "Keep working" }, controller.signal);
    const rejected = expect(call).rejects.toThrow(/tavern_tell.*cancelled|tavern_tell.*stopped/i);
    await started;
    controller.abort();
    fail(new Error("Transport aborted"));
    await rejected;
  });
});
