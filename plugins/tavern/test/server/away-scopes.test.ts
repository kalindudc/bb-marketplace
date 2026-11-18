// @vitest-environment node
import { seedQuest } from "./support";
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
  it("rebinds existing guarded local drafts on close and restores base/grants on return", async () => {
    const f = await fixture();
    await f.runtime.hire("lead", "project", f.input);
    expect(f.runtime.away.snapshot()).toMatchObject({ watchedByQuest: [{ questId: f.q.id, watchedCount: 0 }] });
    const before = structuredClone(f.runtime.scopes!.view("child")!.scope);
    const result = await f.close();
    expect(result.state).toMatchObject({ watchedCount: 0, heldCount: 0 });
    expect(f.stop).not.toHaveBeenCalled();
    const current = f.runtime.scopes!.view("child")!.scope!;
    expect(hasAwayDenials(current, result.state.window!)).toBe(true);
    expect(evaluate(current, { kind: "bash", toolName: "bash", input: { command: "rm draft.md" }, cwd: f.work }).allow).toBe(false);
    expect(evaluate(current, { kind: "write", toolName: "write", input: { path: join(f.work, "draft.md") }, cwd: f.work }).allow).toBe(true);
    await f.runtime.away.return({ kind: "explicit-return", threadId: null, refId: null });
    expect(f.runtime.scopes!.view("child")!.scope).toEqual(before);
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
