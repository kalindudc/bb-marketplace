// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makeThreadResponse } from "./host";
import { registerTools } from "../../src/server/tools";
import { catalog, model, providerSdk } from "./provider-fixture";
import { seedQuest } from "./support";
import { rpcHandlers } from "../../src/server/rpc";
import { portableSuccession } from "../../src/server/keeper/succession-store";

const client = { experimental_caller: { kind: "client" } } as never;

function scratch(outcome: "reply" | "lost" | "refused" | "absent" = "reply") {
  let keeperModel: string;
  let queue: ReturnType<typeof queued049>[] = [];
  const f = setup({ providers: { ...providerSdk(), models: async () => catalog([model(keeperModel)]) }, threads: {
    get: async ({ threadId }: { threadId: string }) => threadId === "lead" ? lead : threadId === "child" ? child : candidate!,
    list: async (input?: { parentThreadId?: string }) => !input?.parentThreadId && candidate ? [candidate] : [],
    defaultExecutionOptions: async () => null,
    queuedMessages: { list: async ({ threadId }: { threadId: string }) => threadId === "lead" ? queue : [] },
    interactions: { list: async () => [] },
    events: { list: async () => [] },
    getPluginMetadata: async () => metadata,
    archive: async () => ({ ok: true, archivedThreadIds: ["successor"] }),
    update: async ({ threadId, parentThreadId, parentNotifications, visibility }: { threadId: string; parentThreadId?: string; parentNotifications?: "auto" | "off" | "stuck"; visibility?: "visible" }) => {
      if (threadId === "child") {
        expect(f.k.member("child")?.keeperThreadId).toBe("successor");
        expect(parentNotifications).toBe("stuck");
        if (!parentThreadId || !parentNotifications) throw new Error("The host needs both parent fields");
        child = { ...child, parentThreadId, parentNotifications };
        throw new Error("Lost reply after changing the parent");
      }
      expect(visibility).toBe("visible");
      candidate = { ...candidate!, visibility: "visible" };
      return candidate;
    },
  } });
  keeperModel = f.runtime.snapshot().classes.find(c => c.id === "keeper")!.model!;
  let lead = makeThreadResponse({ id: "lead", title: "Keeper", status: "idle", environmentId: "env", activeBackgroundAgentCount: 0 });
  let child = makeThreadResponse({ id: "child", parentThreadId: "lead", parentNotifications: "stuck", lifecycleOwnerThreadId: "lead" });
  let candidate: ReturnType<typeof makeThreadResponse> | undefined;
  let metadata: unknown;
  const first = vi.fn();
  const runModel = vi.fn();
  const threads = f.bb.sdk.threads;
  const spawn = vi.fn<typeof threads.spawn>(async args => {
    expect(args).toMatchObject({ visibility: "hidden", environment: { type: "reuse", environmentId: "env" } });
    expect(args.parentThreadId).toBeUndefined();
    expect(args.lifecycleOwnerThreadId).toBeUndefined();
    expect(f.runtime.succession.state.get(request.id)).toMatchObject({ state: "preparing", spawnIntent: { projectId: "project", environmentId: "env" } });
    if (outcome === "refused") throw Object.assign(new Error("The host refused to create this thread"), { status: 422 });
    if (outcome === "absent") throw Object.assign(new Error("Host disconnected before creation was confirmed"), { status: 500 });
    candidate = makeThreadResponse({ id: "successor", originPluginId: "tavern", status: "pending", visibility: "hidden", sourceThreadId: null, lifecycleOwnerThreadId: null });
    metadata = args.pluginMetadata;
    const textBlock = args.input?.[0];
    if (textBlock?.type !== "text") throw new Error("Missing first input");
    const ctx = { ...dispatch049({ threadId: candidate.id, status: "pending", pluginId: "tavern", text: textBlock.text, submission: args.pluginSubmission }), thread: candidate };
    first(ctx);
    if (outcome === "lost") throw new Error("The reply was lost after thread creation");
    const decision = await f.runtime.dispatch(ctx);
    if (decision.action === "proceed") runModel();
    expect(decision).toMatchObject({ action: "wait", reason: expect.stringContaining("cutover") });
    return candidate;
  });
  Object.assign(threads, { spawn });
  const request = f.runtime.succession.request("lead", { kind: "user" }, "New context");
  return { ...f, first, runModel, spawn, request, child: () => child, busy: () => { lead = { ...lead, status: "active" }; },
    queue: (row: ReturnType<typeof queued049>) => { queue = [row]; f.runtime.queued(row); },
    late: () => {
      candidate = makeThreadResponse({ id: "successor", createdAt: f.time(), originPluginId: "tavern", status: "pending", visibility: "hidden", sourceThreadId: null, lifecycleOwnerThreadId: null });
      metadata = spawn.mock.calls[0]![0].pluginMetadata;
    },
  };
}

it("holds the fake host's first input before the candidate can run a model, and fences the Keeper tools", async () => {
  const f = scratch();
  expect(await f.runtime.succession.prepare(f.request.id)).toMatchObject({ state: "preparing", candidate: "successor" });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.first).toHaveBeenCalledTimes(1);
  expect(f.runModel).not.toHaveBeenCalled();
  expect(f.k.member("successor")).toBeNull();
  expect(f.runtime.succession.state.get(f.request.id)).toMatchObject({ state: "preparing", candidate: "successor" });
  expect(f.runtime.succession.state.current("lead")).toBe("lead");
  expect(f.runtime.succession.state.fence("lead")).toEqual({ kind: "preparing" });
  registerTools(f.bb, f.runtime);
  await expect(f.harness.behavior.invokeAgentTool("tavern_status", {}, { threadId: "lead" })).rejects.toThrow(/succession/i);
  const row = queued049("queued", "Keep these words", f.time());
  f.runtime.queued(row);
  expect(f.k.store.runtime("lead").pending).toEqual([expect.objectContaining({ id: f.k.store.messageId(row.id), text: "Keep these words" })]);
  expect(await f.runtime.dispatch(dispatch049({ rows: [row] }))).toMatchObject({ action: "wait" });
});

it("reconciles a lost spawn reply from host creation metadata without asking for a second child", async () => {
  const f = scratch("lost");
  expect(await f.runtime.succession.prepare(f.request.id)).toMatchObject({ state: "recovering", candidate: null });
  await f.runtime.succession.prepare(f.request.id);
  const first = f.first.mock.calls[0]![0];
  expect(await f.runtime.dispatch({ ...first, experimental_submission: null })).toMatchObject({ action: "wait" });
  expect(f.runtime.succession.state.get(f.request.id)).toMatchObject({ state: "preparing", candidate: "successor" });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.runtime.succession.state.current("successor")).toBe("lead");
});

it("records a definite pre-cutover failure and gives the same Keeper its authority back", async () => {
  const f = scratch("refused");
  expect(await f.runtime.succession.prepare(f.request.id)).toMatchObject({ state: "failed", problem: expect.stringContaining("refused") });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.runtime.succession.state.current("lead")).toBe("lead");
  expect(f.runtime.succession.state.fence("lead")).toBeNull();
  expect(f.k.require("lead", "keeper").threadId).toBe("lead");
});

it("retries lost follow-up replies after cutover without replacing the member or sending another bootstrap", async () => {
  const f = scratch();
  const quest = await seedQuest(f.k, "lead", "Carry the charge", "Carry it");
  f.k.bind("child", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: quest.id, waypointId: null, errand: false, title: "Work",
    brief: { outcome: "Work", doneWhen: "Evidence", outOfScope: "Publish", mode: "make-it-work", context: [], questions: [], timeboxMinutes: null } });
  await f.runtime.settleWakes();
  await f.runtime.succession.advance(f.request.id);
  expect(f.k.quest(quest.id).keeperThreadId).toBe("successor");
  expect(f.runtime.succession.state.get(f.request.id).followups.members[0]?.done).toBe(false);
  await f.runtime.succession.advance(f.request.id);
  const op = f.runtime.succession.state.get(f.request.id);
  expect(op.followups).toEqual({ members: [{ threadId: "child", notifications: "stuck", done: true }], visible: true, bootstrap: false });
  expect(f.child()).toMatchObject({ parentThreadId: "successor", parentNotifications: "stuck", lifecycleOwnerThreadId: "lead" });
  const first = f.first.mock.calls[0]![0];
  expect(await f.runtime.dispatch({ ...first, experimental_submission: null })).toMatchObject({ action: "proceed" });
  f.runtime.dispatched({ ...queued049("boot", first.input.text, f.time(), { pluginId: "tavern" }), threadId: "successor" });
  expect(f.runtime.succession.state.get(op.id).followups.bootstrap).toBe(true);
  expect(await f.runtime.dispatch(dispatch049({ text: "This must stay here" }))).toMatchObject({ action: "reject", message: expect.stringContaining("retired in Tavern") });
  await f.runtime.succession.advance(f.request.id);
  expect(f.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(2);
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(f.harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
});

it("archives only the unused candidate if a verified transfer cannot cut over", async () => {
  const f = scratch();
  expect(await f.runtime.succession.prepare(f.request.id)).toMatchObject({ state: "preparing", candidate: "successor" });
  f.busy();
  expect(await f.runtime.succession.advance(f.request.id)).toMatchObject({ state: "failed", candidateArchived: true });
  expect(f.harness.inspection.sdk.callsTo("threads.archive").map(call => call.args[0])).toEqual([{ threadId: "successor" }]);
  expect(f.k.succession.current("lead")).toBe("lead");
  expect(f.k.succession.fence("lead")).toBeNull();
});

it("bounds an absent spawn and archives a late candidate without reviving the cancelled transfer", async () => {
  const f = scratch("absent");
  expect(await f.runtime.succession.advance(f.request.id)).toMatchObject({ state: "recovering" });
  f.advance(601_000);
  expect(await f.runtime.succession.advance(f.request.id)).toMatchObject({ state: "failed" });
  expect(f.k.succession.fence("lead")).toBeNull();
  f.late();
  expect(await f.runtime.succession.advance(f.request.id)).toMatchObject({ state: "failed", candidateArchived: true });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.k.member("successor")).toBeNull();
});

it.each(["proposed", "recovering"] as const)("lets the user cancel a %s refresh", async phase => {
  const f = scratch("absent");
  if (phase === "recovering") await f.runtime.succession.advance(f.request.id);
  await rpcHandlers(f.runtime).cancelKeeperRefresh({ threadId: "lead", successionId: f.request.id }, client);
  expect(f.k.succession.get(f.request.id)).toMatchObject({ state: "failed", problem: expect.stringContaining("cancelled") });
  expect(f.k.succession.fence("lead")).toBeNull();
  expect(f.k.store.events("lead").at(-1)?.actor).toMatchObject({ kind: "user" });
});

it("fences the hidden restored successor until the user finishes an attested handover", async () => {
  const f = scratch();
  const op = await f.runtime.succession.advance(f.request.id);
  const restored = portableSuccession({ ...op, followups: { ...op.followups, visible: false } });
  f.k.store.put("keeperSuccessions", op.id, restored);
  f.late();
  expect(await f.runtime.dispatch(dispatch049({ threadId: "successor", text: "Do this now" }))).toMatchObject({ action: "wait" });
  await f.runtime.succession.sweep();
  expect(f.k.succession.get(op.id).restored).toBe(true);
  await rpcHandlers(f.runtime).finishKeeperHandover({ threadId: "successor", successionId: op.id }, client);
  expect(f.k.succession.get(op.id).restored).not.toBe(true);
  f.runtime.dispatched({ ...queued049("boot", f.first.mock.calls[0]![0].input.text, f.time(), { pluginId: "tavern" }), threadId: "successor" });
  expect(f.k.succession.propose("successor", { kind: "user" }, "Again").generation).toBe(2);
});

it("explains why an incoming message stopped the refresh and leaves it with the original Keeper", async () => {
  const f = scratch();
  expect(await f.runtime.succession.prepare(f.request.id)).toMatchObject({ state: "preparing" });
  f.queue(queued049("late-user", "Stay in this thread", f.time()));
  expect(await f.runtime.succession.advance(f.request.id)).toMatchObject({ state: "failed", problem: "Your message cancelled the refresh; press Refresh again when ready." });
  expect(f.k.succession.fence("lead")).toBeNull();
  expect(f.k.store.runtime("lead").pending).toContainEqual(expect.objectContaining({ text: "Stay in this thread" }));
});

it("lets the predecessor settle before writing the spawn intent", async () => {
  const f = scratch();
  f.busy();
  await f.runtime.succession.prepare(f.request.id);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.runtime.succession.state.get(f.request.id).state).toBe("proposed");
  expect(f.runtime.succession.state.fence("lead")).toBeNull();
});
