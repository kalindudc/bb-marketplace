// @vitest-environment node
import { seedLegacyQuest, seedQuest } from "./support";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { makeThreadResponse } from "./host";
import { planInput } from "./support";
import { dispatch049 } from "./dispatch-fixture";
import { evaluate } from "../../src/scope/engine";
import { hasAwayDenials } from "../../src/server/away/denials";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-away-scopes-")); roots.push(root);
  const work = join(root, "work"), storage = join(root, "storage"); mkdirSync(work); mkdirSync(storage);
  const stop = vi.fn(async (_: { threadId: string }) => ({ ok: true as const }));
  const f = setup({ environments: { get: async () => ({ hostId: "host", path: work, isGitRepo: true, isWorktree: true, environmentProviderId: "git-worktree" }) } });
  f.bb.sdk.threads.get = async ({ threadId }) => makeThreadResponse({ id: threadId, providerId: "pi", environmentId: "env", parentThreadId: "lead" });
  f.bb.sdk.threads.storageLocation = async () => ({ hostId: "host", storageRootPath: storage });
  f.bb.sdk.threads.stop = stop;
  f.bb.sdk.threads.queuedMessages.list = async () => [];
  f.bb.sdk.threads.updatePluginMetadata = async () => ({});
  f.bb.sdk.threads.spawn = vi.fn(async () => makeThreadResponse({ id: "child", environmentId: "env", parentThreadId: "lead" }));
  mkdirSync(join(root, ".pi/agent"), { recursive: true });
  f.runtime.enableScopes({ dataDir: root, installGuard: true, policyOptions: { home: root }, guard: { agentDir: join(root, ".pi/agent") } });
  const q = await seedQuest(f.k,"lead", "Draft", "Tests pass");
  f.k.plan("lead", { ...planInput(q.id), party: [{ classId: "smith", characterId: null, model: null, purpose: "Build", waypointIds: ["w1"] }] });
  f.k.answerAsk(f.k.asks("lead")[0]!.id, "approve", null, "page", "user");
  const input = { classId: "smith", boardQuestId: q.id, waypointId: "w1", title: "Draft", brief: { outcome: "Build a draft", mode: "make-it-work" as const, outOfScope: "Production", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null } };
  const close = () => f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: q.id, endState: "drafts-ready" }] });
  return { ...f, root, work, q, input, close, stop };
}
describe("Closing time local scope integration", () => {
  it("keeps an exempt permanent member working and receiving briefs without relaxing any closing acts", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    f.runtime.keep("lead", "child", undefined, "Ongoing watch", true);
    const exemption = f.runtime.keep("lead", "child", undefined, "Watch overnight", true, true);
    expect(f.runtime.away.snapshot().exemptByQuest).toEqual([{ questId: f.q.id, members: 1 }]);
    const result = await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.q.id, endState: "pause" }] });
    expect(result.state).toMatchObject({ heldCount: 0, eligibleByQuest: [{ questId: f.q.id, members: 0, watchedCount: 0 }],
      exemptByQuest: [{ questId: f.q.id, members: 1 }] });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.runtime.away.blocked("child")).toBe(false);
    await expect(f.runtime.away.dispatch(dispatch049({ threadId: "child", status: "idle", pluginId: "tavern" }))).resolves.toBeNull();
    await expect(f.runtime.tell("lead", "child", "Keep watching")).resolves.toMatchObject({ status: "delivered" });
    const scope = f.runtime.scopes!.view("child")!.scope!;
    expect(hasAwayDenials(scope, result.state.window!)).toBe(true);
    for (const [command, ruleId] of [["gh pr merge 1", /^closing-act$/], ["mail recipient@example.test", /^send-guard$/], ["fly deploy", /^closing-act$/]] as const)
      expect(evaluate(scope, { kind: "bash", toolName: "bash", input: { command }, cwd: f.work })).toMatchObject({ allow: false, ruleId: expect.stringMatching(ruleId) });
    await f.runtime.undoDecision(exemption.id);
    expect(f.k.member("child")?.permanent?.closingExemption).toBeUndefined();
    expect(f.k.member("child")?.permanent).toBeDefined();
    expect(f.runtime.away.blocked("child")).toBe(true);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith({ threadId: "child" });
  });

  it("delivers a scheduled round to an exempt guarded member during Pause", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    f.runtime.keep("lead", "child", undefined, "Ongoing watch", true);
    f.runtime.keep("lead", "child", undefined, "Watch overnight", true, true);
    const ask = f.runtime.keepSchedules("lead", "child", "Check the tracker", [{ cadence: "daily", at: "07:00", duty: "Read the tracker" }]);
    f.k.answerAsk(ask.id, "approve", null, "page", "user", undefined, {}, { act: "answerAsk", surface: "page", attribution: "client" });
    f.advance(f.k.member("child")!.permanent!.schedules![0]!.nextAt - f.time());
    await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.q.id, endState: "pause" }] });
    const rounds: string[] = [];
    f.bb.sdk.threads.send = async ({ threadId, input }) => {
      const text = typeof input === "string" ? input : input.map(block => block.type === "text" ? block.text : "").join("\n");
      if (threadId === "child" && (await f.runtime.dispatch(dispatch049({ threadId, text, pluginId: "tavern" }))).action === "proceed") rounds.push(text);
      return { ok: true, delivery: "sent" };
    };
    await f.runtime.sweep();
    expect(rounds).toEqual([expect.stringContaining("Scheduled round (daily 07:00): Read the tracker")]);
    expect(f.runtime.away.snapshot().status.closed).toBe(true);
  });

  it("holds a left-out quest even if its permanent member is exempt, guarded and watched work is allowed", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    f.runtime.keep("lead", "child", undefined, "Ongoing watch", true);
    f.runtime.keep("lead", "child", undefined, "Watch overnight", true, true);
    const other = seedLegacyQuest(f.k, "lead", "Other quest", "Other");
    const result = await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: other.id, endState: "pause" }], allowWatched: true });
    expect(f.runtime.away.blocked("child")).toBe(true);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith({ threadId: "child" });
    expect(result.state).toMatchObject({ heldCount: 1, eligibleByQuest: [{ questId: f.q.id, members: 1, watchedCount: 0 }], exemptByQuest: [] });
  });

  it.each(["non-exempt", "no-guard"] as const)("still pauses a %s permanent member", async mode => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    f.runtime.keep("lead", "child", undefined, "Ongoing watch", true);
    if (mode === "no-guard") f.runtime.keep("lead", "child", undefined, "Watch overnight", true, true);
    if (mode === "no-guard") rmSync(f.runtime.scopes!.api.status().guard.file);
    await f.runtime.away.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.q.id, endState: "pause" }] });
    expect(f.runtime.away.blocked("child")).toBe(true);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith({ threadId: "child" });
  });

  it("keeps the Ranger-only greenlight shortcut for ordinary slots, not permanent ones", async () => {
    const f = await fixture();
    const q = seedLegacyQuest(f.k, "lead", "Watch the signal", "Watch");
    const input = planInput(q.id);
    const slot = { classId: "ranger", characterId: null, model: null, purpose: "Watch", waypointIds: ["w1"] };
    f.k.plan("lead", { ...input, party: [slot] });
    expect(f.k.quest(q.id).phase).toBe("build");
    f.k.plan("lead", { ...input, party: [{ ...slot, permanent: { why: "Ongoing watch" } }] });
    expect(f.k.quest(q.id).phase).toBe("greenlight");
    expect(f.k.store.openAsks("lead", q.id)).toContainEqual(expect.objectContaining({ kind: "greenlight" }));
  });

  it("hires into an already approved seat without inheriting an unapproved permanent mark", async () => {
    const f = await fixture();
    const initial = f.k.summary(f.q.id).plan!;
    f.k.plan("lead", { ...initial, fromSteer: null, party: [{ ...initial.party[0]!, permanent: { why: "Daily checks" } }] });
    expect(f.k.quest(f.q.id)).toMatchObject({ phase: "greenlight", greenlitVersion: initial.version });
    await f.runtime.hire("lead", "project", f.input);
    expect(f.k.member("child")?.permanent).toBeUndefined();
  });

  it("keeps an approved permanent decision on a waypoint and slot reorder, but asks when the party grows", async () => {
    const f = await fixture();
    const initial = f.k.summary(f.q.id).plan!;
    const w2 = { ...initial.waypoints[0]!, id: "w2" };
    const normal = { classId: "warden", characterId: null, model: null, purpose: "Check", waypointIds: ["w1"] };
    const permanent = { ...initial.party[0]!, permanent: { why: "Daily checks" } };
    const input = { ...initial, fromSteer: null, waypoints: [...initial.waypoints, w2] };
    const approved = f.k.plan("lead", { ...input, party: [permanent, normal] });
    f.k.answerAsk(f.k.store.openAsks("lead", f.q.id)[0]!.id, "approve", null, "page", "user");
    const reused = f.k.plan("lead", { ...input, party: [normal, { ...permanent, waypointIds: ["w1", "w2"] }] });
    expect(reused.party[1]?.permanent).toEqual(approved.party[0]?.permanent);
    expect(f.k.quest(f.q.id).greenlitVersion).toBe(approved.version);
    expect(f.k.store.openAsks("lead", f.q.id)).toHaveLength(0);

    const rebalanced = f.k.plan("lead", { ...input, party: [normal, { ...normal, waypointIds: ["w2"] }] });
    expect(f.k.quest(f.q.id).greenlitVersion).toBe(approved.version);
    expect(f.k.store.openAsks("lead", f.q.id)).toHaveLength(0);

    f.k.plan("lead", { ...input, party: [...rebalanced.party, permanent] });
    expect(f.k.quest(f.q.id).phase).toBe("greenlight");
    expect(f.k.store.openAsks("lead", f.q.id)).toContainEqual(expect.objectContaining({ kind: "greenlight" }));
  });

  it.each(["ranger", "wanderer"])("does not trade an approved %s scout seat for a Smith without greenlight", async classId => {
    const f = await fixture();
    const base = f.k.summary(f.q.id).plan!;
    const smith = base.party[0]!;
    const w2 = { ...base.waypoints[0]!, id: "w2" };
    const input = { ...base, fromSteer: null, waypoints: [...base.waypoints, w2] };
    const approved = f.k.plan("lead", { ...input, party: [smith, { ...smith, classId, waypointIds: ["w2"] }] });
    f.k.answerAsk(f.k.store.openAsks("lead", f.q.id)[0]!.id, "approve", null, "page", "user");
    expect(f.k.quest(f.q.id).greenlitVersion).toBe(approved.version);
    const proposed = f.k.plan("lead", { ...input, party: [smith, { ...smith, waypointIds: ["w2"] }] });
    expect(f.k.store.openAsks("lead", f.q.id)).toContainEqual(expect.objectContaining({ kind: "greenlight", effect: expect.objectContaining({ planVersion: proposed.version }) }));
    await f.runtime.hire("lead", "project", f.input);
    await expect(f.runtime.hire("lead", "project", { ...f.input, waypointId: "w2" })).rejects.toThrow(/greenlit party/i);
  });

  it("moves capacity between approved working classes without spending a scout seat twice", async () => {
    const f = await fixture();
    const base = f.k.summary(f.q.id).plan!;
    const smith = base.party[0]!;
    const warden = { classId: "warden", characterId: null, model: null, purpose: "Review", waypointIds: ["w1"] };
    const ranger = { ...warden, classId: "ranger", purpose: "Scout" };
    const proposed = f.k.plan("lead", { ...base, fromSteer: null, party: [smith, warden, ranger] });
    f.k.answerAsk(f.k.store.openAsks("lead", f.q.id)[0]!.id, "approve", null, "page", "user");
    f.k.bind("watcher", "warden", "rook", "project", { keeperThreadId: "lead", boardQuestId: f.q.id,
      waypointId: "w1", errand: false, title: "Review", brief: f.input.brief });
    const w2 = { ...base.waypoints[0]!, id: "w2" };
    const waypoints = [...base.waypoints, w2];
    const party = [smith, { ...smith, waypointIds: ["w2"] }, ranger];
    f.k.plan("lead", { ...base, fromSteer: null, waypoints, party });
    expect(f.k.quest(f.q.id).greenlitVersion).toBe(proposed.version);
    expect(f.k.store.openAsks("lead", f.q.id)).toHaveLength(0);
    await f.runtime.hire("lead", "project", f.input);
    await expect(f.runtime.hire("lead", "project", { ...f.input, waypointId: "w2" })).rejects.toThrow(/greenlit party/i);

    f.k.plan("lead", { ...base, fromSteer: null, waypoints, party: [smith, { ...warden, classId: "wanderer" }] });
    expect(f.k.store.openAsks("lead", f.q.id)).toContainEqual(expect.objectContaining({ kind: "greenlight" }));
  });

  it("rechecks the permanent mark inside the reservation after a concurrent Undo", async () => {
    const f = await fixture();
    const initial = f.k.summary(f.q.id).plan!;
    const proposed = f.k.plan("lead", { ...initial, fromSteer: null, party: [{ ...initial.party[0]!, permanent: { why: "Daily checks" } }] });
    f.k.answerAsk(f.k.store.openAsks("lead", f.q.id)[0]!.id, "approve", null, "page", "user");
    const decisionId = proposed.party[0]!.permanent!.decisionId!;
    const assert = f.runtime.spend.assert.bind(f.runtime.spend);
    vi.spyOn(f.runtime.spend, "assert").mockImplementationOnce(assert).mockImplementationOnce(async id => {
      await assert(id);
      await f.runtime.undoDecision(decisionId);
    });
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/permanent slot changed/);
    expect(f.k.member("child")?.permanent).toBeUndefined();
    expect(f.k.store.all("hires").every(intent => !intent.permanent)).toBe(true);
  });

  it("requires greenlight for a new permanent slot, inherits it on hire and clears it from both on Undo", async () => {
    const f = await fixture();
    const initial = f.k.summary(f.q.id).plan!;
    const permanent = { why: "Daily checks" };
    f.k.plan("lead", { ...initial, fromSteer: null, party: [{ ...initial.party[0]!, permanent }] });
    expect(f.k.quest(f.q.id).phase).toBe("greenlight");
    f.k.answerAsk(f.k.store.openAsks("lead", f.q.id)[0]!.id, "approve", null, "page", "user");
    const planned = f.k.summary(f.q.id).plan!.party[0]!.permanent!;
    expect(planned).toMatchObject(permanent);
    await f.runtime.hire("lead", "project", f.input);
    expect(f.k.member("child")?.permanent).toEqual(planned);
    await f.runtime.undoDecision(planned.decisionId!);
    expect(f.k.summary(f.q.id).plan!.party[0]!.permanent).toBeUndefined();
    expect(f.k.member("child")?.permanent).toBeUndefined();
  });

  it("rebinds existing guarded local drafts on close and restores base/grants on return", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    expect(f.runtime.away.snapshot()).toMatchObject({ watchedByQuest: [{ questId: f.q.id, watchedCount: 0 }] });
    const before = structuredClone(f.runtime.scopes!.view("child")!.scope!);
    const namedMerge = { kind: "tool" as const, toolName: "mcp__github__merge_pull_request", input: {}, cwd: f.work };
    expect(evaluate(before, namedMerge)).toMatchObject({ allow: true });
    const result = await f.close();
    expect(result.state).toMatchObject({ watchedCount: 0, heldCount: 0 });
    expect(f.stop).not.toHaveBeenCalled();
    const current = f.runtime.scopes!.view("child")!.scope!;
    expect(hasAwayDenials(current, result.state.window!)).toBe(true);
    expect(evaluate(current, { kind: "bash", toolName: "bash", input: { command: "rm draft.md" }, cwd: f.work }).allow).toBe(false);
    expect(evaluate(current, { kind: "write", toolName: "write", input: { path: join(f.work, "draft.md") }, cwd: f.work }).allow).toBe(true);
    expect(evaluate(current, namedMerge)).toMatchObject({ allow: false, ruleId: "closing-act" });
    await f.runtime.away.return({ kind: "explicit-return", threadId: null, refId: null });
    const after = f.runtime.scopes!.view("child")!.scope!;
    expect(after).toEqual(before);
    expect(evaluate(after, namedMerge)).toMatchObject({ allow: true });
  });
  it("counts guarded and watched members together while interrupting only the watched default", async () => {
    const f = await fixture(); await f.runtime.hire("lead", "project", f.input);
    f.k.bind("watched", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: null, errand: true, title: "Scout", brief: f.input.brief });
    expect(f.runtime.away.snapshot()).toMatchObject({ eligibleByQuest: [{ questId: f.q.id, members: 2, watchedCount: 1 }], watchedByQuest: [{ questId: f.q.id, watchedCount: 1 }] });
    const result = await f.close();
    expect(result.state).toMatchObject({ eligibleByQuest: [{ questId: f.q.id, members: 2, watchedCount: 1 }], heldCount: 1 });
    expect(f.stop).toHaveBeenCalledExactlyOnceWith({ threadId: "watched" });
  });
  it("guards the first dispatch of a new local Pi hire while closed, before spawn returns", async () => {
    const f = await fixture();
    await f.close();
    f.bb.sdk.threads.spawn = vi.fn(async args => {
      const ctx = dispatch049({ threadId: "child", status: "pending", pluginId: "tavern", submission: args.pluginSubmission });
      ctx.thread = makeThreadResponse({ id: "child", status: "pending", providerId: "pi", environmentId: "env", parentThreadId: "lead" });
      ctx.input = { text: args.input![0]!.type === "text" ? args.input![0]!.text : "", blocks: args.input! };
      expect(await f.runtime.dispatch(ctx)).toEqual({ action: "proceed" });
      expect(hasAwayDenials(f.runtime.scopes!.view("child")!.scope!, f.runtime.away.snapshot().window!)).toBe(true);
      return ctx.thread;
    });
    await f.runtime.hire("lead", "project", f.input);
    expect(f.runtime.away.blocked("child")).toBe(false);
    expect(f.stop).not.toHaveBeenCalled();
  });
  it("does not pause a solo but still adds the local stop-list checks", async () => {
    const f = await fixture(), solo = f.k.bind("solo", "smith", "vale", "project");
    expect(solo.role).toBe("solo");
    await f.runtime.scopes!.ensure(solo);
    const result = await f.close();
    expect(f.runtime.away.blocked("solo")).toBe(false);
    expect(f.stop).not.toHaveBeenCalled();
    const scope = f.runtime.scopes!.view("solo")!.scope!;
    expect(hasAwayDenials(scope, result.state.window!)).toBe(true);
    expect(evaluate(scope, { kind: "bash", toolName: "bash", input: { command: "rm draft.md" }, cwd: f.work }).allow).toBe(false);
  });
  it("falls back to an explicit watched hold when the local shim is missing", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    rmSync(f.runtime.scopes!.api.status().guard.file);
    expect(await f.close()).toMatchObject({ state: { watchedCount: 1, heldCount: 1 } });
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.runtime.away.blocked("child")).toBe(true);
  });
});
