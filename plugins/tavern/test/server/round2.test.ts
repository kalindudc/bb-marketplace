// @vitest-environment node
import { withMemberFixtures } from "./member-fixture";
import { concludeQuest } from "./support";
import { seedQuest } from "./support";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { fakePort, planInput } from "./support";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makeThreadResponse, makePluginAgentConfigurationContext } from "./host";
import { registerTools } from "../../src/server/tools";
import { registerRpc } from "../../src/server/rpc";
import { TavernRuntime } from "../../src/server/runtime";
import { Keeper } from "../../src/server/keeper/service";
import { journalEntrySchema } from "../../src/shared/schema";
import { gitSha, placementRecord, sourceSnapshot } from "./placement-fixture";
import { patchMemberDetails } from "../../src/server/member-engagement";

const brief = {
  outcome: "Build",
  mode: "make-it-work" as const,
  outOfScope: "Production",
  doneWhen: "Tests pass",
  context: [],
  questions: [],
  timeboxMinutes: null,
};
const ask = {
  kind: "decision" as const,
  question: "Which fixture?",
  why: "A small choice",
  options: [{ id: "small", label: "Small", detail: "", recommended: true }],
  meanwhile: "Read",
  holds: [],
};
async function approved() {
  const f = setup(),
    q = await seedQuest(f.k,"lead", "A", "A");
  f.k.plan("lead", {
    ...planInput(q.id),
    party: [
      { classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] },
    ],
  });
  f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
  return {
    ...f,
    q,
    input: { classId: "smith", boardQuestId: q.id, waypointId: "w1", title: "Build", brief },
  };
}

describe("round 2 reservations and routing", () => {
  it("H-1 releases a rejected 4xx spawn and rolls back the party slot", async () => {
    const f = await approved();
    f.bb.sdk.threads.spawn = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 400: invalid model"))
      .mockResolvedValueOnce(makeThreadResponse({ id: "replacement", parentThreadId: "lead" }));
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("HTTP 400");
    expect(f.k.store.all("hires")).toHaveLength(0);
    await expect(f.runtime.hire("lead", "project", f.input)).resolves.toMatchObject({
      threadId: "replacement",
    });
    expect(f.k.store.get("staffing", `${f.q.id}:1:smith`)?.slots[0]?.uses).toBe(1);
  });
  it("H-1 keeps uncertain reservations until five minutes and releases them after a complete child scan", async () => {
    const f = await approved();
    f.bb.sdk.threads.spawn = async () => {
      throw new Error("connection lost");
    };
    const list = vi.fn(async () => []);
    f.bb.sdk.threads.list = list;
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("connection lost");
    f.advance(299_999);
    await f.runtime.sweep();
    expect(f.k.store.all("hires")).toHaveLength(1);
    expect(list).not.toHaveBeenCalled();
    f.advance(1);
    await f.runtime.sweep();
    expect(list).toHaveBeenCalled();
    expect(f.k.store.all("hires")).toHaveLength(0);
    expect(f.k.store.get("staffing", `${f.q.id}:1:smith`)?.slots[0]?.uses).toBe(0);
  });
  it("H-1 reconciles a real child instead of freeing its reservation on reload", async () => {
    const f = await approved();
    f.bb.sdk.threads.spawn = async () => {
      throw new Error("response lost");
    };
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow();
    const intent = f.k.store.all("hires")[0]!;
    const token = f.k.store.db
      .prepare("SELECT id FROM tavern_records WHERE kind='hires'")
      .get() as { id: string };
    const child = makeThreadResponse({
      id: "existing",
      parentThreadId: "lead",
      createdAt: intent.createdAt + 1,
      originPluginId: "tavern",
    });
    f.bb.sdk.threads.list = vi.fn().mockResolvedValue([child]);
    f.bb.sdk.threads.getPluginMetadata = async () => ({ hireToken: token.id });
    f.advance(300_000);
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.reconcile();
    expect(f.k.member("existing")?.boardQuestId).toBe(f.q.id);
    expect(f.k.store.all("hires")).toHaveLength(0);
    expect(f.k.store.runtime("existing").briefVersion).toBe(1);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    await expect(restarted.hire("lead", "project", f.input)).rejects.toThrow(/greenlit party/);
  });
  it("H-1 clears a legacy unbound reservation on load through the sweep, without changing the live database by hand", async () => {
    const f = setup();
    f.k.store.put("hires", "legacy-token", {
      classId: "ranger",
      characterId: "otto",
      projectId: "project",
      createdAt: f.time() - 300_001,
      owner: {
        keeperThreadId: "lead",
        boardQuestId: null,
        waypointId: null,
        errand: true,
        title: "Read",
        brief,
      },
    });
    f.bb.sdk.threads.list = vi.fn().mockResolvedValue([]);
    await new TavernRuntime(f.bb, f.k, f.runtime.registry).reconcile();
    expect(f.k.store.all("hires")).toHaveLength(0);
    expect(f.k.store.events("lead").some((event) => event.type === "hire.expired")).toBe(true);
  });
  it("H-1 keeps the reservation if the child scan itself fails", async () => {
    const f = await approved();
    f.bb.sdk.threads.spawn = async () => {
      throw new Error("response lost");
    };
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow();
    f.bb.sdk.threads.list = async () => {
      throw new Error("host unavailable");
    };
    f.advance(300_000);
    await f.runtime.sweep();
    expect(f.k.store.all("hires")).toHaveLength(1);
  });
  it.each([false, true])(
    "M-1 applies the first steer with a later message queued or joined (%s)",
    async (joined) => {
      const f = await approved();
      await f.runtime.dispatch(dispatch049({ text: "A: stage first" }));
      await f.runtime.dispatch({
        ...dispatch049({ text: "What is the ETA?", status: "active" }),
        ...(joined ? { attempt: "join-turn" as const } : {}),
      });
      const route = f.k.route("lead", {
        kind: "steer",
        boardQuestId: f.q.id,
        summary: "stage first",
      });
      expect(() => f.k.plan("lead", { ...planInput(f.q.id), fromSteer: route.id })).not.toThrow();
      f.k.route("lead", { kind: "question", summary: "eta" });
      expect(() => f.k.plan("lead", { ...planInput(f.q.id), fromSteer: route.id })).not.toThrow();
      const other = await f.k.openQuest("lead", "B", "B").catch(() => null);
      if (other) expect(() => f.k.plan("lead", planInput(other.id))).toThrow(/route/);
      f.k.endTurn("lead");
      expect(() => f.k.plan("lead", { ...planInput(f.q.id), fromSteer: route.id })).toThrow(
        /applicable|expired/,
      );
    },
  );
  it("M-1 preserves a queued steer until its following turn, not the preceding turn, ends", async () => {
    const f = await approved();
    f.k.receiveUser("lead", "A: stage first", null, "row", f.time(), false);
    const route = f.k.route("lead", {
      kind: "steer",
      boardQuestId: f.q.id,
      summary: "stage first",
    });
    f.k.endTurn("lead");
    expect(() => f.k.plan("lead", { ...planInput(f.q.id), fromSteer: route.id })).not.toThrow();
    f.k.receiveUser("lead", "A: stage first", null, "row", f.time(), true);
    f.k.endTurn("lead");
    expect(() => f.k.plan("lead", { ...planInput(f.q.id), fromSteer: route.id })).toThrow(
      /applicable|expired/,
    );
  });
});

function linked(threadId: string, boardQuestId: string, status: string) {
  return journalEntrySchema.parse({
    threadId,
    id: "a1",
    parentId: null,
    description: "Build",
    status,
    owner: threadId,
    note: null,
    evidence: [{ kind: "command", ref: "test", detail: "ok", exitCode: 0 }],
    review:
      status === "verified"
        ? {
            actor: { kind: "agent", threadId: "checker" },
            at: 1_000_000,
            evidence: [],
            reason: null,
          }
        : null,
    link: { boardQuestId, waypointId: "w1" },
    order: 0,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    createdBy: { kind: "tavern" },
    updatedBy: { kind: "tavern" },
  });
}

async function stuckMember(stuck: string) {
  const f = await approved();
  registerTools(f.bb, f.runtime);
  const member = await f.runtime.hire("lead", "project", f.input);
  let status: "active" | "stopping" | "error" | "idle" = "idle";
  let archivedAt: number | null = null;
  const read = () => makeThreadResponse({ id: member.threadId, status, archivedAt });
  const get = f.bb.sdk.threads.get;
  f.bb.sdk.threads.get = async input => input.threadId === member.threadId ? read() : get(input);
  const stop = f.bb.sdk.threads.stop = vi.fn(async () => { status = "idle"; return { ok: true as const }; });
  if (stuck === "running turn") status = "active";
  if (stuck === "stuck releasing") {
    status = "stopping";
    stop.mockImplementationOnce(async () => ({ ok: true }));
    expect(await f.runtime.release("lead", member.threadId, "Previous stop request")).toBe(false);
  }
  let correction: string | null = null;
  if (stuck.startsWith("brief")) {
    correction = "Use the corrected fixture";
    patchMemberDetails(f.k.store, member.threadId, { delivery: {
      id: "brief-correction", text: correction, assignmentText: correction, attempts: 1,
      nextAttemptAt: 0, attemptedAt: 0, hostAfterSeq: 0, error: null,
      state: stuck === "brief queued" ? "queued" : "unconfirmed",
    } });
  }
  if (stuck.startsWith("placement") || stuck === "failed provider") {
    const services = f.runtime.placements();
    vi.spyOn(services, "host", "get").mockReturnValue({ call: vi.fn(), onWorkerExit: () => () => {} });
    services.store.reserve(placementRecord({ memberThreadId: member.threadId, keeperThreadId: "lead", questId: f.q.id }), { maxMakers: 2, maxCheckers: 2 });
    if (stuck === "placement waiting") {
      vi.spyOn(services.preserve, "beforeRelease")
        .mockResolvedValueOnce({ state: "waiting", message: "Waiting for its turn so its work can be saved." })
        .mockImplementation(async () => {
          expect(status).toBe("idle");
          const store = services.store;
          const snapshot = store.saveSnapshot(sourceSnapshot({ purpose: "wip", sourceThreadId: member.threadId, makerThreadId: member.threadId }));
          store.pinSnapshot(snapshot.id, gitSha, gitSha, "sha1");
          const record = store.byMember(member.threadId)!;
          const cancelled = store.cancel(record.id, record.generation);
          store.update(cancelled.id, cancelled.generation, row => ({ ...row, phase: "releasing", preservation: {
            ...row.preservation, source: "saved", snapshotId: snapshot.id, liveOwnerThreadId: null, stopConfirmed: true,
          } }), "released");
          store.finishRelease(cancelled.id, cancelled.generation, true);
          archivedAt = 1;
          return { state: "released" };
        });
    }
    if (stuck === "placement lost") {
      archivedAt = 1;
      f.runtime.updateThread(read());
    }
    if (stuck === "failed provider") {
      f.bb.sdk.threads.archive = vi.fn(async ({ threadId }) => { archivedAt = 1; return { ok: true as const, archivedThreadIds: [threadId] }; });
      status = "active";
      stop.mockImplementationOnce(async () => ({ ok: true }));
      f.k.store.patch(member.threadId, {
        placementExecution: { target: { kind: "provider", environmentProviderId: "test-workspace", inputs: {}, machine: { type: "new", machineProviderId: "test-machine", inputs: {} }, workspace: "dedicated-machine" }, providerId: "pi", model: "missing-model" },
      });
      await f.runtime.failed(member.threadId, "Failed to resolve Pi model missing-model", "first-turn");
      expect(f.k.member(member.threadId)?.engagement).toBe("releasing");
    }
  }
  const reason = "Replace one stuck member";
  const release = (replace = false) => f.harness.behavior.invokeAgentTool("tavern_release",
    { memberThreadId: member.threadId, reason, ...(replace ? { replace: true } : {}) }, { threadId: "lead" });
  return { ...f, member, stop, release, reason, correction };
}

const stuckCases = ["running turn", "brief queued", "brief unconfirmed", "placement waiting", "placement lost", "stuck releasing", "failed provider"];

describe("round 2 release, ask and scout policies", () => {
  it.each(stuckCases.filter(stuck => stuck !== "placement lost"))("supports a separate bounded hire after a plain release (%s)", async stuck => {
    const f = await stuckMember(stuck);
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(stuck.startsWith("brief")
      ? "This party slot already has a live member with a pending re-brief. Retry or release that member before hiring a replacement."
      : "The greenlit party");
    const reply = await f.release();
    if (stuck === "placement waiting") {
      expect(reply).toContain("Waiting for its turn so its work can be saved.");
      await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow("The greenlit party");
      expect(await f.release()).toContain("Released");
    } else expect(reply).toContain("Released");
    await expect(f.runtime.hire("lead", "project", f.input)).resolves.toMatchObject({ waypointId: "w1" });
  });
  it("cleans up a lost placement even after its archive was observed", async () => {
    const f = await stuckMember("placement lost");
    expect(await f.release()).toContain("its work was not saved");
    expect(f.runtime.placements().store.byMember(f.member.threadId)?.phase).toBe("released");
    await expect(f.runtime.hire("lead", "project", f.input)).resolves.toMatchObject({ waypointId: "w1" });
  });
  it("releases while a cancelled brief send still awaits a host reply", async () => {
    const f = await stuckMember("running turn");
    let sent!: (input: string) => void;
    let refuse!: (error: Error) => void;
    const entered = new Promise<string>(resolve => { sent = resolve; });
    const reply = new Promise<never>((_, reject) => { refuse = reject; });
    f.bb.sdk.threads.send = async ({ input }) => {
      sent(input![0]!.type === "text" ? input![0]!.text : "");
      return reply;
    };
    const tell = f.runtime.tell("lead", f.member.threadId, "Correct the fixture");
    const oldInput = await entered;
    try {
      expect(await f.release()).toContain("Released");
      await expect(f.runtime.hire("lead", "project", f.input)).resolves.toMatchObject({ waypointId: "w1" });
      expect(await f.runtime.dispatch(dispatch049({ threadId: f.member.threadId, pluginId: "tavern", text: oldInput }))).not.toMatchObject({ action: "proceed" });
    } finally {
      refuse(new Error("The cancelled send never reached the member"));
      await expect(tell).resolves.toMatchObject({ status: "cancelled" });
    }
    expect(f.k.member(f.member.threadId)).toMatchObject({ engagement: "archived", disposition: "released" });
  });
  it("retains the allocation when the host never acknowledges the individual stop", async () => {
    const f = await stuckMember("running turn");
    const stopped = f.stop.getMockImplementation()!;
    let requested!: () => void;
    const requestedStop = new Promise<void>(resolve => { requested = resolve; });
    f.stop.mockImplementationOnce(() => {
      requested();
      return new Promise(() => {});
    });
    vi.useFakeTimers();
    try {
      const pending = f.release(true);
      await requestedStop;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toContain("release stop for child-1000000 timed out");
      expect(f.k.store.allocated(f.q.id, "smith")).toBe(1);
    } finally { vi.useRealTimers(); }
    f.stop.mockImplementation(stopped);
    expect(await f.release(true)).toContain("Replaced");
  });
  it("reconciles an uncertain replacement spawn without hiring another child", async () => {
    const f = await stuckMember("running turn");
    const spawn = f.bb.sdk.threads.spawn = vi.fn().mockRejectedValue(new Error("Connection lost after spawn"));
    expect(await f.release(true)).toContain("Connection lost after spawn");
    const pending = f.k.store.all("hires")[0]!;
    expect(pending.replacesThreadId).toBe(f.member.threadId);
    expect(await f.release(true)).toContain("The replacement hire is pending");
    const replacement = makeThreadResponse({ id: "recovered", createdAt: pending.createdAt + 1, parentThreadId: "lead", originPluginId: "tavern" });
    const token = f.k.store.db.prepare("SELECT id FROM tavern_records WHERE kind='hires'").get() as { id: string };
    f.bb.sdk.threads.list = vi.fn().mockResolvedValue([replacement]);
    f.bb.sdk.threads.getPluginMetadata = async () => ({ hireToken: token.id });
    f.advance(300_000);
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.reconcile();
    expect(await restarted.replaceMember("lead", "project", f.member.threadId, f.reason)).toMatchObject({ state: "replaced", threadId: replacement.id });
    expect(spawn).toHaveBeenCalledOnce();
    expect(f.k.store.events("lead", 0, 200).filter(event => event.type === "member.replaced")).toHaveLength(1);
  });
  it("does not request a replacement while Stop all holds the party", async () => {
    const f = await stuckMember("running turn");
    f.k.store.put("stopAll", "tavern", { state: "stopped", since: f.time(), by: { kind: "user" }, receipt: null });
    await expect(f.release(true)).rejects.toThrow(/Tavern is stopped by you/);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.k.store.activeStaffing("lead").map(member => member.threadId)).toEqual([f.member.threadId]);
  });
  it("does not turn a replacement into an exception to the original slot budget", async () => {
    const f = await stuckMember("running turn");
    const key = `${f.q.id}:1:smith`;
    const allocation = f.k.store.get("staffing", key)!;
    f.k.store.put("staffing", key, { ...allocation, slots: [{ memberThreadId: f.member.threadId, uses: 1 + f.runtime.config().keepers.replacementsPerSlot }] });
    expect(await f.release(true)).toContain("Limit: keepers.replacementsPerSlot = 4");
    expect(f.k.member(f.member.threadId)).toMatchObject({ engagement: "archived", disposition: "released" });
    expect(f.k.store.activeStaffing("lead")).toEqual([]);
  });
  it.each(stuckCases)("stops and replaces a member with %s without losing its waypoint", async stuck => {
    const f = await stuckMember(stuck);
    if (stuck === "placement waiting") {
      expect(await f.release(true)).toContain("Waiting for its turn so its work can be saved.");
      expect(f.k.store.allocated(f.q.id, "smith")).toBe(1);
      expect(f.k.store.events("lead", 0, 200).some(e => e.type === "member.replaced")).toBe(false);
    }
    const proof = linked(f.member.threadId, f.q.id, "verified");
    f.port.linkedEntries = () => [proof];
    const reply = await f.release(true);
    expect(f.k.summary(f.q.id).waypoints[0]).toMatchObject({ state: "verified", evidenceCount: 1, verifiedBy: "checker" });
    if (stuck === "placement waiting") {
      const store = f.runtime.placements().store;
      expect(store.byMember(f.member.threadId)?.preservation).toMatchObject({ source: "saved", snapshotId: "snapshot" });
      expect(store.snapshot("snapshot")?.homeCommit).toBe(gitSha);
    }
    expect(reply).toContain("Replaced");
    if (stuck === "placement lost") {
      expect(reply).toContain("its work was not saved");
      expect(f.stop).not.toHaveBeenCalled();
    } else expect(f.stop).toHaveBeenCalledWith({ threadId: f.member.threadId });
    const [replacement] = f.k.store.activeStaffing("lead");
    expect(replacement).toMatchObject({ waypointId: "w1", classId: "smith", boardQuestId: f.q.id });
    expect(replacement!.threadId).not.toBe(f.member.threadId);
    const { context, ...brief } = f.k.store.runtime(replacement!.threadId).brief!;
    expect({ ...brief, context: [] }).toEqual(f.input.brief);
    if (f.correction) expect(context.join("\n")).toContain(f.correction);
    else expect(context).toEqual([]);
    expect(f.k.store.get("staffing", `${f.q.id}:1:smith`)?.slots[0]).toEqual({ memberThreadId: replacement!.threadId, uses: 2 });
    const replaced = () => f.k.store.events("lead", 0, 200).filter(e => e.type === "member.replaced");
    expect(replaced()).toEqual([expect.objectContaining({ boardQuestId: f.q.id, data: expect.objectContaining({
      memberThreadId: f.member.threadId, replacementThreadId: replacement!.threadId, waypointId: "w1", reason: f.reason,
    }) })]);
    expect(await f.release(true)).toContain(replacement!.threadId);
    expect(replaced()).toHaveLength(1);
  });
  const replacementCases = [
    ...["todo", "doing", "blocked", "rejected"].map(status => ({
      status, title: `excludes released ${status} work`, projection: { state: "verified", evidenceCount: 1 },
    })),
    { status: "done", title: "keeps a released submission waiting for a check", projection: { state: "reported", evidenceCount: 2 } },
  ];
  it.each(replacementCases)(
    "M-2 $title without losing history or crediting the previous owner",
    async ({ status, projection }) => {
      const f = await approved();
      f.bb.sdk.threads.stop = async () => ({ ok: true });
      const previous = await f.runtime.hire("lead", "project", f.input);
      await f.runtime.release("lead", previous.threadId, "Replace stalled work");
      const replacement = await f.runtime.hire("lead", "project", f.input);
      const rows = [
        linked(previous.threadId, f.q.id, status),
        linked(replacement.threadId, f.q.id, "verified"),
      ];
      const get = f.port.get;
      f.port.get = (threadId) => ({
        ...get(threadId),
        entries: rows.filter((entry) => entry.threadId === threadId),
      });
      f.port.linkedEntries = () => rows;
      const waypoint = f.k.summary(f.q.id).waypoints[0]!;
      expect(waypoint).toMatchObject(projection);
      expect(waypoint.ownerMember?.threadId).toBe(replacement.threadId);
      expect(f.port.get(previous.threadId).entries[0]?.status).toBe(status);
    },
  );
  it("M-2 keeps released members' verified work credited", async () => {
    const f = await approved();
    f.bb.sdk.threads.stop = async () => ({ ok: true });
    const member = await f.runtime.hire("lead", "project", f.input);
    await f.runtime.release("lead", member.threadId, "Retire after verified work");
    const proof = linked(member.threadId, f.q.id, "verified");
    f.port.linkedEntries = () => [proof];
    const waypoint = f.k.summary(f.q.id).waypoints[0]!;
    expect(waypoint).toMatchObject({ state: "verified", evidenceCount: 1, verifiedBy: "checker" });
    expect(waypoint.ownerMember?.threadId).toBe(member.threadId);
    expect(f.port.linkedEntries(f.q.id)).toEqual([proof]);
  });
  it("M-2 releases a stale member, records a reversible decision and permits its bounded replacement", async () => {
    const f = await approved();
    registerTools(f.bb, f.runtime);
    f.bb.sdk.threads.stop = vi.fn(async () => ({ ok: true as const }));
    const member = await f.runtime.hire("lead", "project", f.input);
    f.advance(21 * 60_000);
    f.k.stale();
    f.advance(21 * 60_000);
    f.k.stale();
    expect(f.k.member(member.threadId)?.strikes).toBe(2);
    expect(f.k.store.events("lead").at(-1)?.text).toContain("tavern_release");
    const result = await f.harness.behavior.invokeAgentTool(
      "tavern_release",
      {
        memberThreadId: member.threadId,
        reason: "No progress after two strikes",
      },
      { threadId: "lead" },
    );
    expect(result).toContain("Released");
    expect(f.bb.sdk.threads.stop).toHaveBeenCalledWith({ threadId: member.threadId });
    expect(f.k.member(member.threadId)).toMatchObject({ engagement: "archived", disposition: "released" });
    expect(
      f.k.store
        .query("decisions", "keeperThreadId", "lead")
        .some((d) => d.reversible && d.source === "keeper" && /Release/.test(d.text)),
    ).toBe(true);
    await expect(f.runtime.hire("lead", "project", f.input)).resolves.toBeTruthy();
    f.runtime.updateThread(makeThreadResponse({ id: member.threadId, status: "idle", archivedAt: f.time() }));
    expect(f.k.member(member.threadId)?.engagement).toBe("archived");
  });
  it("M-2 keeps the slot until stopping is confirmed, then completes release in the sweep", async () => {
    const f = await approved();
    const member = await f.runtime.hire("lead", "project", f.input);
    f.bb.sdk.threads.stop = async () => ({ ok: true });
    f.bb.sdk.threads.get = vi
      .fn()
      .mockResolvedValueOnce(makeThreadResponse({ id: member.threadId, status: "active" }))
      .mockResolvedValueOnce(makeThreadResponse({ id: member.threadId, status: "stopping" }))
      .mockResolvedValue(makeThreadResponse({ id: member.threadId, status: "idle" }));
    expect(await f.runtime.release("lead", member.threadId, "Stalled")).toBe(false);
    expect(f.k.store.allocated(f.q.id, "smith")).toBe(1);
    await f.runtime.sweep();
    expect(f.k.store.allocated(f.q.id, "smith")).toBe(0);
    f.runtime.updateThread(makeThreadResponse({ id: member.threadId, status: "active" }));
    expect(f.k.store.allocated(f.q.id, "smith")).toBe(0);
  });
  it("L-a requires an explicit reversible declaration for a timed decision, including after reload", () => {
    const f = setup();
    expect(() => f.k.ask("lead", { effect: {type:"decision"}, ...ask, proceedInMinutes: 1 })).toThrow(/reversible/);
    expect(() => f.k.ask("lead", { effect: {type:"decision"}, ...ask, reversible: false, proceedInMinutes: 1 })).toThrow(
      /reversible/,
    );
    const created = f.k.ask("lead", { effect: {type:"decision"}, ...ask, reversible: true, proceedInMinutes: 1 });
    f.advance(60_000);
    withMemberFixtures(new Keeper(f.k.store, f.port, f.time)).defaults();
    expect(f.k.store.get("asks", created.id)?.state).toBe("defaulted");
  });
  it.each(["ranger", "wanderer"])(
    "L-b scouts a greenlit quest with %s without expanding the party",
    async (classId) => {
      const f = await approved();
      await expect(
        f.runtime.hire("lead", "project", {
          classId,
          boardQuestId: f.q.id,
          title: "Read",
          brief: { ...brief, questions: ["1. Why?"], timeboxMinutes: 5 },
        }),
      ).resolves.toMatchObject({ classId });
      expect(f.k.asks("lead").filter((a) => a.state === "open")).toHaveLength(0);
      expect(
        f.k.store
          .query("decisions", "keeperThreadId", "lead")
          .some((d) => d.reversible && /scout/i.test(d.text)),
      ).toBe(true);
    },
  );
  it("L-c keeps an old open ask in the room after more than 200 newer closed asks", async () => {
    const f = setup();
    registerRpc(f.bb, f.runtime);
    const old = f.k.ask("lead", { ...ask, effect: { type: "decision" } });
    for (let n = 0; n < 205; n++) {
      const recent = f.k.ask("lead", { effect: {type:"decision"}, ...ask, question: `Ask ${n}` });
      f.k.answerAsk(recent.id, "small", null, "page", "user");
    }
    const room = (await f.harness.invokeRpc("room", {})) as { asks: { id: string }[] };
    expect(room.asks.map((a) => a.id)).toContain(old.id);
  });
});

describe("round 2 delivery and cleanup", () => {
  it("L-d compacts final tick text while retaining its dedupe receipt", async () => {
    const f = setup();
    f.k.reanchor("lead", "wake");
    await f.runtime.tick("lead");
    const row = f.k.store.db
      .prepare("SELECT id,data FROM tavern_outbox WHERE state='delivered'")
      .get() as { id: string; data: string };
    expect(JSON.parse(row.data).text).toBe("");
    const text = `[Tavern tick] id=${row.id}\nFacts`;
    expect((await f.runtime.dispatch(dispatch049({ text, pluginId: "tavern" }))).action).toBe(
      "reject",
    );
  });
  it("L-e commits wrapping before partial archive failure and retries cleanup", async () => {
    const f = await approved();
    const member = await f.runtime.hire("lead", "project", f.input);
    f.port.linkedEntries = () => [
      {
        ...fakePort().get(member.threadId).entries[0],
        threadId: member.threadId,
        id: "a1",
        parentId: null,
        description: "Build",
        status: "verified",
        evidence: [{ kind: "command", ref: "test", detail: "ok", exitCode: 0 }],
        link: { boardQuestId: f.q.id, waypointId: "w1" },
        owner: member.threadId,
        note: null,
        order: 0,
        createdAt: f.time(),
        updatedAt: f.time(),
        createdBy: { kind: "tavern" },
        updatedBy: { kind: "tavern" },
      },
    ];
    f.bb.sdk.threads.archive = vi
      .fn()
      .mockRejectedValueOnce(new Error("archive unavailable"))
      .mockResolvedValue({ ok: true });
    await concludeQuest(f.runtime, "lead", f.q.id, "Done", "");
    expect(f.k.quest(f.q.id).phase).toBe("done");
    expect(f.k.member(member.threadId)).toMatchObject({ engagement: "archiving", disposition: "retired unfinished" });
    await f.runtime.sweep();
    expect(f.bb.sdk.threads.archive).toHaveBeenCalledTimes(2);
  });
  it("L-f keeps quests and asks ahead of many standing rules and marks any cap", async () => {
    const f = setup();
    const q = await seedQuest(f.k,"lead", "Important board", "Board");
    f.k.ask("lead", { effect: {type:"decision"}, ...ask, boardQuestId: q.id, question: "Important open ask?" });
    for (let n = 0; n < 100; n++)
      f.k.addRule({
        scope: "keeper",
        scopeId: "lead",
        text: `${n} ${"rule ".repeat(98)}`,
        source: "user",
      });
    const config = f.runtime.configure(
      makePluginAgentConfigurationContext({ thread: { id: "lead" } }),
    );
    expect(config.instructions).toContain("Important board");
    expect(config.instructions).toContain("Important open ask?");
    expect(config.instructions).toMatch(/truncat|shorten|tavern_status/i);
  });
  it("L-g retires a failed queued tick and can deliver its undelivered facts again", async () => {
    const f = setup();
    f.bb.sdk.threads.send = vi
      .fn()
      .mockResolvedValueOnce({ delivery: "queued" })
      .mockResolvedValue({ delivery: "sent" });
    f.k.reanchor("lead", "wake");
    await f.runtime.tick("lead");
    const batch = f.k.store.pendingTick("lead")!;
    const failed = {
      ...queued049("failed", batch.text, f.time(), { pluginId: "tavern" }),
      failureReason: "dispatch failed",
    };
    f.bb.sdk.threads.queuedMessages.list = vi
      .fn()
      .mockResolvedValueOnce([failed])
      .mockResolvedValue([]);
    f.bb.sdk.threads.queuedMessages.delete = vi.fn(async () => ({ ok: true as const }));
    f.advance(60_000);
    await f.runtime.tick("lead");
    await f.runtime.tick("lead");
    expect(f.bb.sdk.threads.queuedMessages.delete).toHaveBeenCalled();
    expect(f.bb.sdk.threads.send).toHaveBeenCalledTimes(2);
  });
  it("L-h expires input after a retained root turn resumes its main run and then completes", async () => {
    const f = setup();
    const start = f.time();
    const events = [
      {
        seq: 1,
        createdAt: start + 1,
        type: "turn/started",
        scope: { kind: "turn", turnId: "root" },
        data: {},
      },
      {
        seq: 2,
        createdAt: start + 2,
        type: "turn/mainRun/updated",
        scope: { kind: "turn", turnId: "root" },
        data: { state: "idle" },
      },
    ];
    f.bb.sdk.threads.events.list = vi
      .fn()
      .mockImplementation(async ({ afterSeq }) =>
        events.filter((event) => event.seq > Number(afterSeq ?? 0)),
      );
    f.k.receiveUser("lead", "First message");
    await f.runtime.observe(makeThreadResponse({ id: "lead" }), 2);
    f.advance(10);
    await f.runtime.dispatch(dispatch049({ text: "Resume the main run" }));
    events.push({
      seq: 3,
      createdAt: start + 11,
      type: "turn/mainRun/updated",
      scope: { kind: "turn", turnId: "root" },
      data: { state: "running" },
    });
    events.push({
      seq: 4,
      createdAt: start + 12,
      type: "turn/completed",
      scope: { kind: "turn", turnId: "root" },
      data: {},
    });
    await f.runtime.observe(makeThreadResponse({ id: "lead" }), 4);
    expect(f.k.store.runtime("lead").pending).toHaveLength(0);
    expect(f.k.store.events("lead").filter((event) => event.type === "route.missed")).toHaveLength(
      2,
    );
  });
  it("L-h protects newly accepted input when an old boundary is observed late after a host read fails", async () => {
    const f = setup();
    f.k.receiveUser("lead", "First message");
    const start = f.time();
    f.advance(2000);
    const events = [
      {
        seq: 1,
        createdAt: start + 1,
        type: "turn/started",
        scope: { kind: "turn", turnId: "old" },
        data: {},
      },
      {
        seq: 2,
        createdAt: start + 100,
        type: "turn/mainRun/updated",
        scope: { kind: "turn", turnId: "old" },
        data: { state: "idle" },
      },
      {
        seq: 3,
        createdAt: start + 200,
        type: "turn/completed",
        scope: { kind: "turn", turnId: "old" },
        data: {},
      },
    ];
    f.bb.sdk.threads.events.list = vi
      .fn()
      .mockRejectedValueOnce(new Error("host unavailable"))
      .mockResolvedValue(events);
    await f.runtime.dispatch(dispatch049({ text: "New queued steer" }));
    await f.runtime.observe(makeThreadResponse({ id: "lead" }), 3);
    expect(f.k.store.runtime("lead").pending.map((p) => p.text)).toEqual(["New queued steer"]);
  });
  it("L-h does not expire a new message drained after main-run idle when the old background turn completes", async () => {
    const f = setup();
    const events = [
      {
        seq: 1,
        type: "turn/started",
        scope: { kind: "turn", turnId: "old" },
        data: { state: "active" },
      },
      {
        seq: 2,
        type: "turn/mainRun/updated",
        scope: { kind: "turn", turnId: "old" },
        data: { state: "idle" },
      },
    ];
    f.bb.sdk.threads.events.list = vi
      .fn()
      .mockImplementation(async ({ afterSeq }) =>
        events.filter((e) => e.seq > Number(afterSeq ?? 0)),
      );
    f.k.receiveUser("lead", "First message");
    await f.runtime.dispatch(
      dispatch049({ rows: [queued049("new-row", "New queued steer", f.time())] }),
    );
    events.push({
      seq: 3,
      type: "turn/completed",
      scope: { kind: "turn", turnId: "old" },
      data: { state: "idle" },
    });
    f.runtime.updateThread(makeThreadResponse({ id: "lead", status: "active" }));
    f.runtime.updateThread(makeThreadResponse({ id: "lead", status: "idle" }));
    await f.runtime.observe(makeThreadResponse({ id: "lead" }), 3);
    expect(f.k.store.runtime("lead").pending.map((p) => p.text)).toEqual(["New queued steer"]);
    expect(f.k.store.events("lead").filter((e) => e.type === "route.missed")).toHaveLength(1);
  });
});
