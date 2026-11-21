// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerScopes, type HostScopeState, type RemoteScopeObservation } from "../../src/scope";
import { ScopeStore } from "../../src/scope/store";
import * as paths from "../../src/scope/paths";
import * as checker from "../../src/scope/checker";
import extension from "../../adapters/pi/extension";

const roots: string[] = [];
const binding = { kind: "host" as const, placementId: "placement", generation: 1 };
const identity = { placementId: "placement", generation: 1, endpointId: "endpoint", revision: 1, scopeDigest: "a".repeat(64), hostId: "guest", cwd: "/guest/work" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-host-binding-")); roots.push(root);
  const envs = new Map<string, Function>(), handlers = new Map<string, Function>();
  const local = vi.fn((): {} | Promise<{}> => { throw new Error("Controller paths must not be read"); });
  const host = vi.fn<(threadId: string) => HostScopeState | undefined>(() => undefined);
  const remote = vi.fn<() => RemoteScopeObservation | undefined>(() => undefined), stop = vi.fn(), onHold = vi.fn();
  const bb = {
    providers: { experimental_contributeEnv: (id: string, fn: Function) => envs.set(id, fn) },
    events: { on: (name: string, fn: Function) => handlers.set(name, fn) }, onDispose: vi.fn(), log: { warn: vi.fn() },
    sdk: { threads: { stop, get: local, events: { list: async () => [{ id: "event", seq: 1, type: "item/completed", createdAt: Date.now() + 1, data: { item: { type: "commandExecution", command: "git push origin main", cwd: "/guest/work" } } }] } }, environments: { get: local } },
  } as unknown as BbPluginApi;
  const start = (lookup = true) => registerScopes(bb, { dataDir: root, policyOptions: { home: root }, guard: { agentDir: join(root, ".pi/agent") }, installGuard: false, pathsForThread: local, onViolation: vi.fn(), onObservationHold: onHold, ...(lookup ? { hostScopeForThread: host } : {}), remoteForThread: remote });
  const env = async (hostId = "guest", threadId: string | null = "member") => envs.get("pi")!({ threadId, projectId: "project", hostId });
  const ready = (scopes: ReturnType<typeof start>): Extract<HostScopeState, { kind: "ready" }> => ({
    kind: "ready", templateDigest: scopes.hostTemplate("member").templateDigest, expected: { ...identity },
    acknowledged: { binding: { ...identity }, scopeFile: "/guest/data/scopes/member.json", variables: { HOME: "/guest/home", TMPDIR: "/guest/tmp", BB_THREAD_STORAGE: "/guest/storage" } },
  });
  return { root, local, host, remote, stop, onHold, handlers, start, env, ready, envs };
}
it("persists an unbound effective host template without any controller path binding", async () => {
  const f = fixture(), scopes = f.start();
  vi.spyOn(paths, "bindPaths").mockImplementation(() => { throw new Error("Local bindPaths"); });
  vi.spyOn(checker, "bindChecks").mockImplementation(() => { throw new Error("Local bindChecks"); });
  const input = scopes.resolve("warden", {}).scope;
  input.checks = { worktree: "/guest/carried", commands: ["npm run audit-me"] };
  input.expectedWorktree = "/guest/carried"; input.writes.deny.push("/guest/protected");
  const written = await scopes.writeScope("member", input, { binding });
  const snapshot = scopes.hostTemplate("member");
  expect(snapshot.template).toEqual(written); expect(snapshot.template.checks).toEqual(input.checks);
  expect(snapshot.template.writes.deny).toContain("/guest/protected"); expect(snapshot.template.writes.allow.some(path => path.includes("${"))).toBe(true);
  expect(snapshot.template.env.variables.HOME).toBeUndefined(); expect(f.local).not.toHaveBeenCalled();
  expect(snapshot.templateDigest).toBe(createHash("sha256").update(JSON.stringify(snapshot.template), "utf8").digest("hex"));
  expect(JSON.parse(readFileSync(join(f.root, "scopes/member.json"), "utf8")).controllerBinding).toEqual(binding);
  expect(scopes.status().threads[0]).toMatchObject({ binding, hostScope: "unresolved", armed: false });
});
it("keeps grants, narrowings and template fingerprint through reload and rebind without policy resolution", async () => {
  const f = fixture(), first = f.start(); await first.writeScope("member", first.resolve("smith", {}, { tools: { deny: ["web_*"] } }).scope, { binding });
  await first.applyOverride("member", { allowRules: ["git-push-main"] }, { approvedRuleIds: ["git-push-main"] });
  const before = first.hostTemplate("member"), scopes = f.start(false);
  await scopes.rebindScope("member"); expect(scopes.hostTemplate("member")).toEqual(before); expect(f.local).not.toHaveBeenCalled(); expect(await f.env()).toEqual([]);
  await scopes.applyOverride("member", { tools: { deny: ["cortex_*"] } }); const after = scopes.hostTemplate("member");
  expect(after.templateDigest).not.toBe(before.templateDigest); expect(after.template.tools.deny).toEqual(expect.arrayContaining(["web_*", "cortex_*"]));
  expect(after.template.shell.allow.some(rule => rule.id === "git-push-main")).toBe(true);
  expect(scopes.status().threads[0].binding).toEqual(binding);
  const copy = scopes.hostTemplate("member"); copy.template.writes.deny.push("mutated copy"); expect(scopes.hostTemplate("member")).toEqual(after);
});
it.each(["ready", "unavailable", "throws"])("classifies a %s private host lookup before any local path probe", async kind => {
  const f = fixture(), scopes = f.start();
  if (kind === "throws") f.host.mockImplementation(() => { throw new Error("Lookup unavailable"); });
  else f.host.mockReturnValue(kind === "ready" ? { kind: "ready", templateDigest: "b".repeat(64), expected: identity, acknowledged: { binding: identity, scopeFile: "/guest/scope.json", variables: {} } } : { kind: "unavailable", reason: "Provisioning" });
  await scopes.writeScope("member", scopes.resolve("ranger", {}).scope); await scopes.rebindScope("member");
  expect(f.local).not.toHaveBeenCalled(); expect(scopes.status().threads[0].binding?.kind).toBe("host"); expect(await f.env()).toEqual([]);
});
it.each(["ready", "unavailable", "throws"])("does not locally bind a %s remote watcher lookup even without the new ACK lookup", async kind => {
  const f = fixture(), scopes = f.start(false);
  if (kind === "throws") f.remote.mockImplementation(() => { throw new Error("Remote lookup failed"); });
  else f.remote.mockReturnValue(kind === "unavailable" ? { kind: "unavailable", reason: "Unreachable" } : { kind: "ready", hostId: identity.hostId, cwd: identity.cwd, binding: identity, prepare: async call => ({ call, scopeRevision: identity.revision, scopeDigest: identity.scopeDigest, decision: { allow: true } }) });
  await scopes.writeScope("member", scopes.resolve("ranger", {}).scope); expect(await f.env()).toEqual([]); expect(f.local).not.toHaveBeenCalled(); expect(scopes.status().threads[0].binding?.kind).toBe("host");
});
it.each(["pi", "claude-code", "codex"])("projects only the checked native ACK and host variables for %s", async provider => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  f.host.mockReturnValue(f.ready(scopes)); const entries = await f.envs.get(provider)!({ threadId: "member", projectId: "project", hostId: "guest" });
  const env = Object.fromEntries(entries.map((entry: { name: string; value: string }) => [entry.name, entry.value]));
  expect(env).toMatchObject({ TAVERN_SCOPE_FILE: "/guest/data/scopes/member.json", HOME: "/guest/home", TMPDIR: "/guest/tmp", BB_THREAD_STORAGE: "/guest/storage", TAVERN_SCOPE_MODE: "enforce" });
  expect(JSON.stringify(env)).not.toContain(f.root); expect(entries.length).toBeLessThanOrEqual(32); expect(f.local).not.toHaveBeenCalled();
  expect(scopes.status().threads[0]).toMatchObject({ hostScope: "acknowledged", armed: false });
});
it.each(["placementId", "generation", "endpointId", "revision", "scopeDigest", "hostId", "cwd"])("withholds env for an ACK with stale %s", async field => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  const state = f.ready(scopes); Object.assign(state.acknowledged.binding, { [field]: typeof identity[field as keyof typeof identity] === "number" ? 2 : field === "scopeDigest" ? "b".repeat(64) : "replacement" });
  f.host.mockReturnValue(state); expect(await f.env()).toEqual([]); expect(f.local).not.toHaveBeenCalled();
});
it("withholds a foreign expected owner, wrong execution host and stale template even when the ACK agrees", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("smith", {}).scope, { binding });
  const old = f.ready(scopes); f.host.mockReturnValue(old); expect(await f.env("other-host")).toEqual([]);
  const foreign = f.ready(scopes); foreign.expected.placementId = "foreign"; foreign.acknowledged.binding.placementId = "foreign"; f.host.mockReturnValue(foreign); expect(await f.env()).toEqual([]);
  f.host.mockReturnValue(old); await scopes.applyOverride("member", { tools: { deny: ["web_*"] } }); expect(await f.env()).toEqual([]);
  f.host.mockReturnValue(f.ready(scopes)); expect((await f.env()).some((entry: { name: string }) => entry.name === "TAVERN_SCOPE_FILE")).toBe(true);
});
it.each(["pending", "missing", "throws", "async"])("returns no scope env for %s native state", async kind => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  if (kind === "pending") f.host.mockReturnValue({ kind: "unavailable", reason: "No ACK" });
  if (kind === "throws") f.host.mockImplementation(() => { throw new Error("Offline"); });
  if (kind === "async") f.host.mockReturnValue(new Promise(() => {}) as unknown as HostScopeState);
  expect(await f.env()).toEqual([]); expect(f.local).not.toHaveBeenCalled(); expect(await f.env("guest", null)).toEqual([]);
});
it.each(["reserved", "invalid-name", "nul", "oversized", "too-many", "entry-budget", "relative-path"])("rejects %s native env without truncation or local fallback", async kind => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  const state = f.ready(scopes);
  if (kind === "reserved") state.acknowledged.variables.TAVERN_SCOPE_FILE = "/foreign/scope";
  if (kind === "invalid-name") state.acknowledged.variables.badName = "value";
  if (kind === "nul") state.acknowledged.variables.EXTRA = "a\0b";
  if (kind === "oversized") state.acknowledged.variables.EXTRA = "x".repeat(65537);
  if (kind === "too-many") state.acknowledged.variables = Object.fromEntries(Array.from({ length: 31 }, (_, i) => ["KEY_" + i, "value"]));
  if (kind === "entry-budget") state.acknowledged.variables = Object.fromEntries(Array.from({ length: 31 }, (_, i) => ["KEY_" + i, "value"]));
  if (kind === "relative-path") state.acknowledged.scopeFile = "relative/scope.json";
  f.host.mockReturnValue(state); expect(await f.env()).toEqual([]); expect(f.local).not.toHaveBeenCalled();
});
it("never sends controller template variables as native env", async () => {
  const f = fixture(), scopes = f.start(), input = scopes.resolve("ranger", {}).scope;
  input.env.variables = { HOME: "/server/home", TMPDIR: "/server/tmp", BB_THREAD_STORAGE: "/server/storage", CUSTOM: "policy literal" };
  await scopes.writeScope("member", input, { binding }); const state = f.ready(scopes); state.acknowledged.variables.CUSTOM = "native rendered value"; f.host.mockReturnValue(state);
  const entries = await f.env(); expect(entries).toContainEqual(expect.objectContaining({ name: "CUSTOM", value: "native rendered value" })); expect(JSON.stringify(entries)).not.toContain("/server/");
});
it("retains host classification across corrupt templates and a missing lookup after restart", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  writeFileSync(join(f.root, "scopes/member.json"), "corrupt"); const restored = f.start(false);
  expect(restored.status().threads[0].binding?.kind).toBe("host"); expect(await f.env()).toEqual([]); expect(f.local).not.toHaveBeenCalled(); expect(() => restored.hostTemplate("member")).toThrow();
});
it("rejects controller template files in the pi guard before path/Git probing or arming", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  vi.stubEnv("TAVERN_SCOPE_FILE", join(f.root, "scopes/member.json")); vi.stubEnv("BB_THREAD_ID", "member");
  vi.spyOn(paths, "realPath").mockImplementation(() => { throw new Error("Guest paths must not be probed"); });
  const handlers = new Map<string, Function>(); extension({ on: (name, fn) => handlers.set(name, fn), getActiveTools: () => ["read", "tavern_ready"], setActiveTools: vi.fn() });
  handlers.get("session_start")!({}, { cwd: f.root });
  expect(handlers.get("tool_call")!({ toolName: "read", input: {} }, { cwd: f.root })).toMatchObject({ block: true, reason: expect.stringContaining("host-bound") });
  expect(handlers.get("tool_call")!({ toolName: "tavern_ready", input: {} }, { cwd: f.root })).toBeUndefined(); expect(new ScopeStore(f.root).isArmed("member")).toBe(false);
});
it("holds host-bound tool observations while the remote watcher callback is still unactivated", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  await f.handlers.get("experimental_thread.events")!({ thread: { id: "member", providerId: "pi" }, sequence: 1 });
  expect(f.stop).not.toHaveBeenCalled(); expect(f.onHold).toHaveBeenCalledOnce(); expect(scopes.violations()).toEqual([]); expect(scopes.observationHolds("member")).toMatchObject([{ seq: 1 }]);
});
it("retains mode/owner metadata and invalidates an earlier template ACK on mode changes", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding }); f.host.mockReturnValue(f.ready(scopes));
  scopes.setMode("watch"); expect(await f.env()).toEqual([]); expect(new ScopeStore(f.root).records.get("member")?.binding).toEqual(binding);
  f.host.mockReturnValue(f.ready(scopes)); expect(await f.env()).toContainEqual(expect.objectContaining({ name: "TAVERN_SCOPE_MODE", value: "watch" }));
});
it("fences an in-flight local rebind before a host-bound write can be overwritten", async () => {
  const f = fixture(); f.local.mockReturnValue({}); const scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope);
  let release!: (value: {}) => void, began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  f.local.mockImplementation(() => { began(); return new Promise(resolve => { release = resolve; }); });
  const pending = scopes.rebindScope("member"); const rejected = expect(pending).rejects.toThrow(/released|binding/i); await started;
  const writing = scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding }); release({}); await rejected; await writing;
  expect(scopes.status().threads[0].binding).toEqual(binding); expect(await f.env()).toEqual([]);
});
it("retains an orphaned host marker after an interrupted initial template write", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  rmSync(join(f.root, "scopes/member.json")); const restored = f.start(false);
  expect(restored.status().threads[0]).toMatchObject({ binding, hostScope: "unresolved", armed: false }); expect(await f.env()).toEqual([]); expect(f.local).not.toHaveBeenCalled();
  await restored.writeScope("member", restored.resolve("ranger", {}).scope, { binding }); expect(restored.hostTemplate("member").template.threadId).toBe("member");
});
it("does not downgrade a corrupt host marker to local authority", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  writeFileSync(join(f.root, "scopes/member.json.host"), "invalid host marker"); const restored = f.start(false);
  expect(restored.status().threads[0].binding).toEqual({ kind: "host", placementId: null, generation: null }); expect(await f.env()).toEqual([]); expect(f.local).not.toHaveBeenCalled();
});
it("uses the full SDK env budget without injecting speed bumps", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  const state = f.ready(scopes); for (let i = 0; i < 27; i++) state.acknowledged.variables["EXTRA_" + i] = "native"; f.host.mockReturnValue(state);
  const entries = await f.env(); expect(entries).toHaveLength(32); expect(entries).toContainEqual(expect.objectContaining({ name: "EXTRA_26", value: "native" }));
  state.acknowledged.variables.ONE_TOO_MANY = "native"; expect(await f.env()).toEqual([]);
});
it("bounds native environment UTF-8 bytes without discarding host-provided Git configuration", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding });
  const state = f.ready(scopes); state.acknowledged.variables.EXTRA = "é".repeat(33000); f.host.mockReturnValue(state); expect(await f.env()).toEqual([]);
  delete state.acknowledged.variables.EXTRA; state.acknowledged.variables.GIT_CONFIG_COUNT = "0"; expect(await f.env()).toContainEqual(expect.objectContaining({ name: "GIT_CONFIG_COUNT", value: "0" }));
});
it("refuses lower generations or another placement without releasing the original scope", async () => {
  const f = fixture(), scopes = f.start(); await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding: { ...binding, generation: 2 } });
  await expect(scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding })).rejects.toThrow(/generation/i);
  await expect(scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding: { ...binding, placementId: "other" } })).rejects.toThrow(/placement/i);
  scopes.clearScope("member"); expect(new ScopeStore(f.root).records.has("member")).toBe(false);
  await scopes.writeScope("member", scopes.resolve("ranger", {}).scope, { binding }); expect(scopes.status().threads[0].binding).toEqual(binding);
});
