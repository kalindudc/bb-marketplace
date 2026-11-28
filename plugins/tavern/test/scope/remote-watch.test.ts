// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostOutput } from "../../src/host-contract";
import * as checker from "../../src/scope/checker";
import * as engine from "../../src/scope/engine";
import * as paths from "../../src/scope/paths";
import * as preparation from "../../src/scope/prepare";
import * as worktree from "../../src/scope/worktree";
import { scopeForClass } from "../../src/scope/presets";
import { ScopeStore } from "../../src/scope/store";
import { registerWatcher, type RemoteScopeObservation } from "../../src/scope/watch";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const binding = { placementId: "placement", generation: 1, endpointId: "member-workspace", revision: 2, scopeDigest: "d".repeat(64) };
const denied: engine.Decision = { allow: false, ruleId: "git-push-main", reason: "This push is outside the acknowledged scope." };
function setup(providerId = "codex", mode: "enforce" | "watch" | "off" = "enforce") {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "remote-watch-")); roots.push(root);
  const store = new ScopeStore(root); store.write("member", { ...scopeForClass("smith"), mode, threadId: "member", issuedAt: 1 });
  const now = Date.now(), handlers = new Map<string, Function>(), stop = vi.fn(), onViolation = vi.fn(), onObservationHold = vi.fn(), onActObservation = vi.fn();
  const row = (seq: number, type = "item/started", extra: Record<string, unknown> = {}) => ({ id: "event-" + seq, seq, type, createdAt: now + seq, data: { item: { id: "call", type: "commandExecution", command: "git push origin main", cwd: "/guest/member", ...extra } } });
  let rows = [row(1)];
  const list = vi.fn(async ({ afterSeq }: { afterSeq: string }) => rows.filter(value => value.seq > Number(afterSeq)));
  const prepare = vi.fn(async (call: engine.ScopeCall): Promise<HostOutput<"prepareCall">> => ({ call: { ...call, cwd: "/guest/member" }, scopeRevision: binding.revision, scopeDigest: binding.scopeDigest, decision: { allow: true } }));
  let execution: RemoteScopeObservation | undefined = { kind: "ready", hostId: "guest-host", cwd: "/guest/member", binding, prepare };
  const remoteForThread = vi.fn(() => execution);
  const fail = () => { throw new Error("A controller-local guest probe ran"); };
  const getThread = vi.fn(fail), getEnvironment = vi.fn(fail), cwdForThread = vi.fn(fail);
  const bb = { events: { on: (name: string, fn: Function) => handlers.set(name, fn) }, onDispose: vi.fn(), log: { warn: vi.fn() }, sdk: { threads: { stop, get: getThread, events: { list } }, environments: { get: getEnvironment } } } as unknown as BbPluginApi;
  registerWatcher(bb, store, { onViolation, onObservationHold, onActObservation, cwdForThread, remoteForThread });
  vi.spyOn(checker, "bindChecks").mockImplementation(fail); vi.spyOn(engine, "evaluate").mockImplementation(fail);
  vi.spyOn(preparation, "prepareCall").mockImplementation(fail); vi.spyOn(worktree, "needsWorktree").mockImplementation(fail);
  vi.spyOn(worktree, "checkedWorktreeRoot").mockImplementation(fail); vi.spyOn(worktree, "gitWorktreeRoot").mockImplementation(fail); vi.spyOn(paths, "realPath").mockImplementation(fail);
  const isArmed = vi.spyOn(store, "isArmed").mockImplementation(fail);
  return { root, store, row, prepare, remoteForThread, stop, onViolation, onObservationHold, onActObservation, cwdForThread, getThread, getEnvironment, isArmed, list,
    setExecution: (value: RemoteScopeObservation | undefined) => { execution = value; }, setRows: (value: typeof rows) => { rows = value; },
    emit: (sequence = 1) => handlers.get("experimental_thread.events")!({ thread: { id: "member", providerId }, sequence }) as Promise<void>,
  };
}
it("uses the acknowledged host decision without any local arm, PID, path or policy preparation", async () => {
  const f = setup(); await f.emit();
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.remoteForThread.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(f.stop).not.toHaveBeenCalled(); expect(f.store.violations()).toEqual([]); expect(f.store.progress("member").cursor).toBe(1);
  for (const probe of [f.cwdForThread, f.getThread, f.getEnvironment, f.isArmed]) expect(probe).not.toHaveBeenCalled();
});
it("forwards an owned PR act from the host decision to the Ledger observer", async () => {
  const f = setup();
  const url = "https://github.com/example/repo/pull/12", command = `gh pr comment ${url} -b fixed`;
  f.setRows([f.row(1, "item/started", { command })]);
  f.prepare.mockImplementationOnce(async call => ({ call, scopeRevision: binding.revision, scopeDigest: binding.scopeDigest,
    decision: { allow: true, acts: [{ kind: "publish", ruleId: "pr-owned-write", why: "Owned PR", ownedPullRequest: { url, command } }] } }));
  await f.emit(); await f.emit();
  expect(f.onActObservation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ eventId: "event-1:pr:0", pullRequestUrl: url, command, act: "publish" }));
});

it("does not demand a local Pi marker and evaluates only completion", async () => {
  const f = setup("pi"); await f.emit(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
  f.setRows([f.row(2, "item/completed")]); f.prepare.mockImplementation(async call => ({ call, scopeRevision: binding.revision, scopeDigest: binding.scopeDigest, decision: denied }));
  await f.emit(2); expect(f.prepare).toHaveBeenCalledOnce(); expect(f.isArmed).not.toHaveBeenCalled(); expect(f.stop).toHaveBeenCalledOnce();
  expect(f.store.violations()).toMatchObject([{ ruleId: "git-push-main", seq: 2, stopped: true }]);
});
it("records a preflight block without remote or local inspection", async () => {
  const f = setup("pi"); f.setRows([f.row(2, "item/completed", { status: "failed", error: engine.BLOCK_MARKER + " blocked before execution" })]); await f.emit(2);
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.store.violations()).toMatchObject([{ prevented: true, stopped: false }]); expect(f.store.progress("member").cursor).toBe(2);
});
it("persists an unavailable observation without consuming the event, then retries the same sequence", async () => {
  const f = setup(); f.setExecution({ kind: "unavailable", reason: "The member host is reconnecting." }); await f.emit();
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.store.progress("member").cursor).toBe(0); expect(f.stop).not.toHaveBeenCalled(); expect(f.store.violations()).toEqual([]);
  expect(new ScopeStore(f.root).observationHold("member")).toMatchObject({ threadId: "member", seq: 1, reason: expect.stringContaining("reconnecting") });
  expect(f.onObservationHold).toHaveBeenCalledOnce();
  f.setExecution({ kind: "ready", hostId: "guest-host", cwd: "/guest/member", binding, prepare: f.prepare }); await f.emit();
  expect(f.store.progress("member").cursor).toBe(1); expect(f.store.observationHold("member")).toBeNull(); expect(f.prepare).toHaveBeenCalledOnce();
});
it("holds lookup failures instead of falling through to controller-local probes", async () => {
  const f = setup(); f.remoteForThread.mockImplementation(() => { throw new Error("Private placement lookup unavailable"); }); await f.emit();
  expect(f.store.progress("member").cursor).toBe(0); expect(f.store.observationHold("member")).toMatchObject({ seq: 1 });
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.cwdForThread).not.toHaveBeenCalled(); expect(f.isArmed).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.store.violations()).toEqual([]);
});
it("holds failed host inspections without fabricating a violation or duplicating hold notifications", async () => {
  const f = setup(); f.prepare.mockRejectedValue(new Error("Host disconnected")); await f.emit(); await f.emit();
  expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.store.progress("member").cursor).toBe(0); expect(f.store.observationHold("member")).toMatchObject({ seq: 1, binding });
  expect(f.onObservationHold).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled(); expect(f.onViolation).not.toHaveBeenCalled(); expect(f.store.violations()).toEqual([]);
});
it.each(["revision", "digest"])("retains the event when the host's delivery %s is stale", async field => {
  const f = setup(); f.prepare.mockImplementation(async call => ({ call, scopeRevision: field === "revision" ? 3 : binding.revision, scopeDigest: field === "digest" ? "e".repeat(64) : binding.scopeDigest, decision: denied })); await f.emit();
  expect(f.store.progress("member").cursor).toBe(0); expect(f.store.observationHold("member")).toMatchObject({ seq: 1 }); expect(f.stop).not.toHaveBeenCalled(); expect(f.store.violations()).toEqual([]);
});
it.each(["generation", "released", "host", "root", "unavailable"])("rejects a reply whose private assignment became %s while inspection awaited", async state => {
  const f = setup(); let enter!: () => void, reply!: (value: HostOutput<"prepareCall">) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  f.prepare.mockImplementation(() => { enter(); return new Promise(resolve => { reply = resolve; }); });
  const running = f.emit(); await entered;
  f.setExecution(state === "released" ? undefined : state === "unavailable" ? { kind: "unavailable", reason: "Host lost" } : { kind: "ready", hostId: state === "host" ? "replacement-host" : "guest-host", cwd: state === "root" ? "/guest/replacement" : "/guest/member", binding: { ...binding, generation: state === "generation" ? 2 : 1 }, prepare: f.prepare });
  reply({ call: { kind: "bash", toolName: "bash", input: { command: "git push origin main" }, cwd: "/guest/member" }, scopeRevision: binding.revision, scopeDigest: binding.scopeDigest, decision: denied }); await running;
  expect(f.store.progress("member").cursor).toBe(0); expect(f.store.observationHold("member")).toMatchObject({ seq: 1 }); expect(f.stop).not.toHaveBeenCalled(); expect(f.store.violations()).toEqual([]); expect(f.cwdForThread).not.toHaveBeenCalled();
});
it("holds a corrupt cursor separately without inventing a remote policy violation", async () => {
  const f = setup(); writeFileSync(f.store.file("member") + ".cursor", "invalid cursor"); await f.emit();
  expect(f.store.observationHold("member")).toMatchObject({ eventId: "cursor:1", seq: 1 });
  expect(() => f.store.progress("member")).toThrow(); expect(f.stop).not.toHaveBeenCalled(); expect(f.store.violations()).toEqual([]); expect(f.isArmed).not.toHaveBeenCalled();
});
it("does not use an obsolete local binding error instead of the host decision", async () => {
  const f = setup(); const record = f.store.records.get("member")!; f.store.records.set("member", { ...record, error: "No controller-local guest checkout" }); await f.emit();
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled(); expect(f.store.progress("member").cursor).toBe(1);
});
it("rejects an old host worker reply that has no decision", async () => {
  const f = setup(); f.prepare.mockImplementation(async call => ({ call, scopeRevision: binding.revision, scopeDigest: binding.scopeDigest }) as HostOutput<"prepareCall">); await f.emit();
  expect(f.store.progress("member").cursor).toBe(0); expect(f.store.observationHold("member")).toMatchObject({ seq: 1 }); expect(f.store.violations()).toEqual([]); expect(f.stop).not.toHaveBeenCalled();
});
it("requires the private binding to remain ready immediately before the host call", async () => {
  const f = setup(); f.remoteForThread.mockReturnValueOnce({ kind: "ready", hostId: "guest-host", cwd: "/guest/member", binding, prepare: f.prepare }).mockReturnValue({ kind: "unavailable", reason: "Binding revoked" }); await f.emit();
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.store.progress("member").cursor).toBe(0); expect(f.store.observationHold("member")).toMatchObject({ seq: 1 });
});
it("does not carry a successful old-generation stop into a replacement assignment", async () => {
  const f = setup(); f.prepare.mockImplementation(async call => ({ call, scopeRevision: binding.revision, scopeDigest: binding.scopeDigest, decision: denied })); await f.emit(); expect(f.stop).toHaveBeenCalledOnce();
  f.setExecution({ kind: "ready", hostId: "guest-host", cwd: "/guest/member", binding: { ...binding, generation: 2 }, prepare: f.prepare });
  f.prepare.mockImplementation(async call => ({ call, scopeRevision: binding.revision, scopeDigest: binding.scopeDigest, decision: { allow: true } })); f.setRows([f.row(2)]); await f.emit(2);
  expect(f.prepare).toHaveBeenCalledTimes(2); expect(f.stop).toHaveBeenCalledOnce(); expect(f.store.progress("member").cursor).toBe(2);
});
it("does not retry an old generation's failed stop against a replacement assignment", async () => {
  const f = setup(); f.stop.mockRejectedValueOnce(new Error("Stop unavailable"));
  f.prepare.mockImplementation(async call => ({ call, scopeRevision: binding.revision, scopeDigest: binding.scopeDigest, decision: denied })); await f.emit();
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.store.progress("member")).toMatchObject({ cursor: 1, pendingStop: true, pendingBinding: binding });
  const next = { ...binding, generation: 2, revision: 1, scopeDigest: "a".repeat(64) };
  f.setExecution({ kind: "ready", hostId: "guest-host", cwd: "/guest/member", binding: next, prepare: f.prepare });
  f.prepare.mockImplementation(async call => ({ call, scopeRevision: next.revision, scopeDigest: next.scopeDigest, decision: { allow: true } })); f.setRows([f.row(2)]); await f.emit(2);
  expect(f.stop).toHaveBeenCalledOnce(); expect(f.store.progress("member")).toMatchObject({ cursor: 2, pendingStop: false }); expect(f.store.violations()).toHaveLength(1);
});
it("holds a failed event-stream read without pretending the member violated policy", async () => {
  const f = setup(); f.list.mockRejectedValueOnce(new Error("Event stream unavailable")); await f.emit();
  expect(f.store.progress("member").cursor).toBe(0); expect(f.store.observationHold("member")).toMatchObject({ eventId: "events:1", seq: 1 });
  expect(f.stop).not.toHaveBeenCalled(); expect(f.store.violations()).toEqual([]); await f.emit();
  expect(f.store.progress("member").cursor).toBe(1); expect(f.store.observationHold("member")).toBeNull();
});
it("passes the checked private binding to the violation callback for controller-side fencing", async () => {
  const f = setup(); f.prepare.mockImplementation(async call => ({ call, scopeRevision: binding.revision, scopeDigest: binding.scopeDigest, decision: denied })); await f.emit();
  expect(f.onViolation).toHaveBeenCalledWith(expect.objectContaining({ threadId: "member", ruleId: "git-push-main" }), expect.objectContaining({ ...binding, hostId: "guest-host", cwd: "/guest/member" }));
});
it("keeps watch-mode hold and denial observations non-blocking and off completely inert", async () => {
  const f = setup("codex", "watch"); f.setExecution({ kind: "unavailable", reason: "Reconnecting" }); await f.emit();
  expect(f.store.observationHold("member")).toMatchObject({ seq: 1 }); expect(f.onObservationHold).not.toHaveBeenCalled();
  f.setExecution({ kind: "ready", hostId: "guest-host", cwd: "/guest/member", binding, prepare: f.prepare }); f.prepare.mockImplementation(async call => ({ call, scopeRevision: binding.revision, scopeDigest: binding.scopeDigest, decision: denied })); await f.emit();
  expect(f.store.violations()).toMatchObject([{ stopped: false, mode: "watch" }]); expect(f.stop).not.toHaveBeenCalled(); expect(f.onViolation).not.toHaveBeenCalled();
  f.store.setMode("member", "off"); f.remoteForThread.mockClear(); f.setRows([f.row(2)]); await f.emit(2); expect(f.remoteForThread).not.toHaveBeenCalled();
});
