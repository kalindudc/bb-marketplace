// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost as createRpcHost } from "@get-bb/plugin-sdk/testing";
import { setup } from "./runtime-fixture";
import { dispatch049 } from "./dispatch-fixture";
import { makeThreadResponse } from "./host";
import { rpcContract } from "../../src/shared/contract";
import { boardQuestSchema } from "../../src/shared/schema";
import { registerRpc, rpcHandlers } from "../../src/server/rpc";
import { readStatus, statusInput } from "../../src/server/status";
import { Keeper } from "../../src/server/keeper/service";
import { planInput, waypointEntry } from "./support";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../../src/server/migrations";
import { BackupRecords } from "../../src/server/backup/records";
import { SettingsStore } from "../../src/server/settings/store";
import { KeeperStore } from "../../src/server/keeper/store";
import { registerTools } from "../../src/server/tools";
import { makePluginAgentConfigurationContext } from "./host";

const brief = { outcome: "Check", mode: "make-it-work" as const, outOfScope: "Publish", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null };
const reason = "Hold the checker handoff for my explicit signal";
const rpcHosts: ReturnType<typeof createRpcHost>[] = [];
afterEach(async () => { for (const host of rpcHosts.splice(0)) await host.harness.lifecycle.dispose(); });
async function goal(held = true) {
  const f = setup();
  f.k.receiveUser("lead", `Build labelCount. ${held ? reason : "Check when ready"}.`);
  const route = f.k.route("lead", { kind: "new-quest", summary: "Build labelCount", notes: [], ...(held ? { checkerHandoffHold: { reason } } : {}) });
  const q = await f.k.openQuest("lead", "Add labelCount", "Labels");
  return { ...f, q, route };
}
function hold(f: Awaited<ReturnType<typeof goal>>) {
  f.k.receiveUser("lead", reason);
  f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Hold checking", notes: [], checkerHandoffHold: { reason } });
  return f.k.quest(f.q.id).checkerHandoffHold!;
}
function checker(f: Awaited<ReturnType<typeof goal>>) {
  return f.k.bind("checker", "warden", null, "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: null, errand: false, title: "Check labels", brief });
}
async function ready() {
  const f = await goal(false);
  f.k.bind("maker", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: "w1", errand: false, title: "Make labels", brief });
  const entry = waypointEntry("maker", f.q.id);
  const get = f.port.get;
  f.port.get = threadId => ({ ...get(threadId), entries: threadId === "maker" ? [entry] : [] });
  f.port.linkedEntries = () => [entry];
  const plan = planInput(f.q.id);
  f.k.plan("lead", { ...plan, waypoints: [{ ...plan.waypoints[0]!, owner: "maker" }], party: [{ classId: "warden", characterId: null, model: null, purpose: "Check labels", waypointIds: ["w1"] }] });
  const ask = f.k.store.openAsks("lead", f.q.id).find(ask => ask.kind === "greenlight")!;
  f.k.answerAsk(ask.id, "approve", null, "page", "user");
  return { ...f, input: { classId: "warden", boardQuestId: f.q.id, waypointId: "w1", title: "Check labels", brief } };
}
const askInput = { kind: "blocker" as const, question: "Release?", why: "User words may release", options: [{ id: "release", label: "Release", detail: "", recommended: false }], holds: [], meanwhile: "Maker continues" };

describe("user checker-handoff holds", () => {
  it("binds an opening hold and its native source to the opened quest", async () => {
    const f = await goal();
    expect(f.q.checkerHandoffHold).toMatchObject({ routeId: f.route.id, sourceMessageId: f.route.sourceMessageId, sourceText: `Build labelCount. ${reason}.`, reason, release: null });
    expect(f.k.summary(f.q.id).checkerHandoffHold).toEqual(f.q.checkerHandoffHold);
  });

  it("refuses a Warden before project lookup, reservation or spawn", async () => {
    const f = await goal();
    const lookup = vi.spyOn(f.runtime, "prepareRegistry");
    await expect(f.runtime.hire("lead", "project", { classId: "warden", boardQuestId: f.q.id, title: "Check labels", brief })).rejects.toThrow(/checker handoff.*Held until the user releases it/i);
    expect(lookup).not.toHaveBeenCalled();
    expect(f.k.store.all("hires")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("rechecks a hold recorded during registry preparation", async () => {
    const f = await goal(false);
    const prepare = f.runtime.prepareRegistry.bind(f.runtime);
    vi.spyOn(f.runtime, "prepareRegistry").mockImplementation(async projectId => { const result = await prepare(projectId); hold(f); return result; });
    await expect(f.runtime.hire("lead", "project", { classId: "warden", boardQuestId: f.q.id, title: "Check labels", brief })).rejects.toThrow(/checker handoff.*held/i);
    expect(f.k.store.all("hires")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("rechecks after host preparation and frees the unused reservation", async () => {
    const f = await ready();
    const get = f.bb.sdk.threads.get;
    let recorded = false;
    f.bb.sdk.threads.get = async input => {
      if (input.threadId === "lead" && !recorded) { recorded = true; hold(f); }
      return get(input);
    };
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/checker handoff.*held/i);
    expect(recorded).toBe(true);
    expect(f.k.store.all("hires")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("holds an in-flight child through initial admission and does not claim it was briefed", async () => {
    const f = await ready();
    f.bb.sdk.threads.spawn = async () => { hold(f); return makeThreadResponse({ id: "late-child", parentThreadId: "lead" }); };
    const child = await f.runtime.hire("lead", "project", f.input);
    expect(child.briefPending).toBe(true);
    expect(f.k.store.runtime(child.threadId).initialBriefAt).toBeUndefined();
    const reservation = f.k.store.all("hires")[0]!;
    expect(reservation.memberThreadId).toBe(child.threadId);
    const ctx = dispatch049({ threadId: child.threadId, status: "pending" });
    ctx.thread = makeThreadResponse({ id: child.threadId, status: "pending", parentThreadId: "lead" });
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait" });
    f.k.releaseCheckerHandoff(f.q.id, f.k.quest(f.q.id).checkerHandoffHold!.id, "page");
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "proceed" });
    expect(f.k.store.runtime(child.threadId).initialBriefAt).toBeDefined();
  });

  it("carries an active hold through a real records backup restore", async () => {
    const f = await goal();
    const source = new BackupRecords(f.k.store.db, new SettingsStore(f.k.store.db, f.time));
    const db = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS) db.exec(migration);
      new BackupRecords(db, new SettingsStore(db, f.time)).restore(source.capture());
      const restored = new Keeper(new KeeperStore(db), f.port, f.time);
      expect(restored.quest(f.q.id).checkerHandoffHold).toEqual(f.q.checkerHandoffHold);
      expect(() => restored.assertCheckerHandoff("warden", f.q.id)).toThrow(/checker handoff.*held/i);
    } finally { db.close(); }
  });

  it("does not release for a reporting promise, completed note, or manual resume", async () => {
    const f = await goal();
    f.k.receiveUser("lead", "Tell me when it has been independently checked");
    f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Report when checked", notes: [{ kind: "commitment", text: "Tell the user when independently checked", boardQuestId: f.q.id, dueAt: null, condition: "When checked" }] });
    for (const note of f.k.memory.notes("lead", 100)) f.k.memory.complete("lead", note.id);
    f.k.store.patch("lead", { manualStopAt: f.time() });
    f.k.userAction("lead", "User resumed", true);
    expect(f.k.quest(f.q.id).checkerHandoffHold?.release).toBeNull();
  });

  it("does not send or queue a fresh rebrief to an existing Warden", async () => {
    const f = await goal(); checker(f);
    await expect(f.runtime.tell("lead", "checker", "Check now")).rejects.toThrow(/checker handoff.*held/i);
    expect(f.k.store.runtime("checker").pendingBrief).toBeUndefined();
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("holds an existing pending Warden brief without consuming a delivery attempt", async () => {
    const f = await goal(); checker(f);
    f.k.store.patch("checker", { pendingBrief: { id: "brief-held", text: "Check now", attempts: 0, nextAttemptAt: f.time(), attemptedAt: null, hostAfterSeq: null, error: null } });
    expect(await f.runtime.sendInitialBrief("checker", "Check now")).toEqual({ briefPending: true });
    expect(f.k.store.runtime("checker").pendingBrief?.attempts).toBe(0);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("waits before registry or scope admission on a held Warden turn", async () => {
    const f = await goal(); checker(f);
    const lookup = vi.spyOn(f.runtime, "prepareRegistry");
    const ctx = dispatch049({ threadId: "checker" });
    ctx.thread = makeThreadResponse({ id: "checker", parentThreadId: "lead", status: "pending" });
    expect(await f.runtime.dispatch(ctx)).toMatchObject({ action: "wait", reason: expect.stringMatching(/checker handoff.*held/i) });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps hold state through schema/backup JSON and a new Keeper instance", async () => {
    const f = await goal();
    expect(boardQuestSchema.parse(JSON.parse(JSON.stringify(f.q))).checkerHandoffHold).toEqual(f.q.checkerHandoffHold);
    const restarted = new Keeper(f.k.store, f.port, f.time);
    expect(restarted.activeCheckerHolds("lead")).toMatchObject([{ id: f.q.id, checkerHandoffHold: { release: null } }]);
  });

  it("prints authoritative active holds in both ledger forms and paged status", async () => {
    const f = await goal();
    for (let i = 0; i < 110; i++) f.k.memory.note("lead", { kind: "fact", text: `Later fact ${i}`, boardQuestId: null, dueAt: null, condition: null });
    for (const text of [f.k.restatement("lead"), f.k.priorities("lead")]) {
      expect(text).toContain("Active user holds");
      expect(text).not.toContain(f.q.checkerHandoffHold!.id);
      expect(text).toContain("waiting for the user\'s release");
      expect(text).toContain(f.q.title);
    }
    expect(readStatus(f.runtime, "lead", statusInput.parse({ section: "holds" }))).toMatchObject({ holds: [{ id: f.q.id }] });
  });

  it("never gives hold control ids or self-release instructions to agents", async () => {
    const f = await goal();
    const id = f.q.checkerHandoffHold!.id;
    const ask = f.k.ask("lead", { ...askInput, boardQuestId: f.q.id, releaseHoldId: id });
    const outputs = [f.k.restatement("lead"), f.k.priorities("lead"), JSON.stringify(f.k.ledger("lead")),
      f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "lead" } })).instructions,
      ...["summary", "holds", "asks", "events"].map(section => JSON.stringify(readStatus(f.runtime, "lead", statusInput.parse({ section }))))];
    for (const output of outputs) expect(output).not.toContain(id);
    expect(f.k.checkerHandoffProblem("warden", f.q.id)).toContain("Held until the user releases it from the Tavern page or by answering the hold\'s ask. You cannot release it; tell the user what is waiting.");
    expect(f.k.checkerHandoffProblem("warden", f.q.id)).not.toContain(id);
    expect(f.k.store.get("asks", ask.id)?.releaseHoldId).toBe(id);
  });

  it("lets the Keeper raise a release ask by quest without receiving a hold id", async () => {
    const f = await goal(); registerTools(f.bb, f.runtime);
    const definition = f.harness.inspection.registrations.agentTools.find(tool => tool.name === "tavern_ask")!;
    expect(JSON.stringify(definition)).not.toContain("releaseHoldId");
    await f.harness.behavior.invokeAgentTool("tavern_ask", { ...askInput, boardQuestId: f.q.id, releaseCheckerHandoff: true }, { threadId: "lead" });
    expect(f.k.store.openAsks("lead", f.q.id)[0]?.releaseHoldId).toBe(f.q.checkerHandoffHold!.id);
    const output = await f.harness.behavior.invokeAgentTool("tavern_status", { section: "holds" }, { threadId: "lead" });
    expect(JSON.stringify(output)).not.toContain(f.q.checkerHandoffHold!.id);
  });

  it("exposes the hold in the existing page and thread-card quest DTOs", async () => {
    const f = await goal();
    const handlers = rpcHandlers(f.runtime);
    const detail = await handlers.boardQuest({ id: f.q.id });
    const decor = await handlers.decor({ threadId: "lead" });
    expect(f.q.checkerHandoffHold).toBeDefined();
    expect(rpcContract.boardQuest.output.parse(detail).quest.checkerHandoffHold).toEqual(f.q.checkerHandoffHold);
    expect(rpcContract.decor.output.parse(decor).keeperView?.boardQuests[0]?.checkerHandoffHold).toEqual(f.q.checkerHandoffHold);
  });

  it("releases only the exact current hold through an explicit client control", async () => {
    const f = await goal();
    const host = createRpcHost({ pluginId: "tavern" });
    rpcHosts.push(host);
    registerRpc(host.bb, f.runtime);
    const call = (input: unknown, plugin = false) => host.harness.behavior.callRpc("releaseCheckerHandoff", input, plugin ? { experimental_caller: { kind: "plugin", pluginId: "tavern" } } : { experimental_caller: { kind: "client" } });
    const input = { boardQuestId: f.q.id, holdId: f.q.checkerHandoffHold!.id, via: "page" as const };
    await expect(call(input, true)).rejects.toThrow(/explicit client action/i);
    await expect(call(input)).resolves.toMatchObject({ checkerHandoffHold: { release: { at: f.time(), via: "page", askId: null } } });
    expect(f.k.activeCheckerHolds("lead")).toHaveLength(0);
    hold(f);
    await expect(call(input)).rejects.toThrow(/no longer current/i);
  });

  it("does not replay a completed release as a new Return or wake action", async () => {
    const f = await goal();
    const host = createRpcHost({ pluginId: "tavern" }); rpcHosts.push(host); registerRpc(host.bb, f.runtime);
    const input = { boardQuestId: f.q.id, holdId: f.q.checkerHandoffHold!.id, via: "page" };
    const call = () => host.harness.behavior.callRpc("releaseCheckerHandoff", input, { experimental_caller: { kind: "client" } });
    await call();
    f.k.store.patch("lead", { manualStopAt: f.time() });
    const returned = vi.spyOn(f.runtime.away, "return");
    await call();
    expect(returned).not.toHaveBeenCalled();
    expect(f.k.store.runtime("lead").manualStopAt).toBe(f.time());
    expect(f.k.store.events("lead").filter(event => event.type === "checker-handoff.released")).toHaveLength(1);
  });

  it("lets the Keeper offer a never-timed release ask, not answer it", async () => {
    const f = await goal();
    const ask = f.k.ask("lead", { ...askInput, boardQuestId: f.q.id, releaseHoldId: f.q.checkerHandoffHold!.id });
    expect(ask).toMatchObject({ kind: "blocker", proceedAt: null, releaseHoldId: f.q.checkerHandoffHold!.id, question: 'Release the checker handoff for “Add labelCount”?' });
    expect(ask.options.map(option => option.id)).toEqual(["release", "keep-held"]);
    await expect(f.runtime.answerAsk(ask.id, "release", null, "chat", false)).rejects.toThrow(/explicit client action/i);
    expect(f.k.quest(f.q.id).checkerHandoffHold?.release).toBeNull();
    await f.runtime.answerAsk(ask.id, "release", null, "page", true);
    expect(f.k.quest(f.q.id).checkerHandoffHold?.release).toMatchObject({ askId: ask.id, via: "page" });
  });

  it("keep-held, withdrawal and attempts to default do not release", async () => {
    const f = await goal();
    const input = { ...askInput, boardQuestId: f.q.id, releaseHoldId: f.q.checkerHandoffHold!.id };
    expect(() => f.k.ask("lead", { ...input, kind: "decision", reversible: true, proceedInMinutes: 1 })).toThrow(/never-timed blocker/i);
    const ask = f.k.ask("lead", input);
    expect(() => f.k.answerAsk(ask.id, "release", null, "timer", "default")).toThrow();
    await f.runtime.answerAsk(ask.id, "keep-held", null, "page", true);
    expect(f.k.quest(f.q.id).checkerHandoffHold?.release).toBeNull();
    const next = f.k.ask("lead", input);
    f.k.withdrawAsk(next.id, "turn-recovered");
    expect(f.k.quest(f.q.id).checkerHandoffHold?.release).toBeNull();
  });
});
