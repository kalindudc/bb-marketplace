// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

function makeThreadResponse(input: Record<string, unknown> = {}) { return { providerId: "codex", ...input }; }
function createFakePluginHost(options: { pluginId: string; sdk: Record<string, any> }) {
  const handlers = new Map<string, Function[]>();
  const calls: { method: string; args: unknown }[] = [];
  const dispose: Function[] = [];
  const bb = {
    events: { on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); } },
    sdk: { threads: {
      get: async (args: unknown) => { calls.push({ method: "threads.get", args }); return options.sdk.threads.get(args); },
      stop: async (args: unknown) => { calls.push({ method: "threads.stop", args }); return options.sdk.threads.stop(args); },
      events: { list: async (args: unknown) => { calls.push({ method: "threads.events.list", args }); return options.sdk.threads.events.list(args); } },
    }, environments: { get: async (args: unknown) => { calls.push({ method: "environments.get", args }); return options.sdk.environments.get(args); } } },
    log: { warn: vi.fn(), error: vi.fn() },
    onDispose(hook: Function) { dispose.push(hook); },
  } as unknown as BbPluginApi;
  return { bb, harness: { behavior: { async emitThreadEvent(name: string, payload: unknown) { for (const fn of handlers.get(name) ?? []) await fn(payload); } }, inspection: { sdk: { callsTo: (method: string) => calls.filter(call => call.method === method) } }, lifecycle: { async dispose() { for (const fn of dispose) await fn(); } } } };
}
import { ScopeStore } from "../../src/scope/store";
import { envForScope } from "../../src/scope/env";
import { registerWatcher } from "../../src/scope/watch";
import { scopeForClass } from "../../src/scope/presets";
import { linkedWorktree } from "./git-fixture";
import { bindPaths } from "../../src/scope/paths";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "tavern-scope-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const store = new ScopeStore(temp());
  const s = bindPaths({ ...scopeForClass("ranger"), threadId: "t1", issuedAt: Date.now() - 10 }, { home: temp(), tmp: [tmpdir()], scopesDir: store.directory });
  store.write("t1", s);
  return { store, s };
}
describe("scope persistence and env", () => {
  it("writes atomically, restores the in-memory map, rejects traversal and clears markers", () => {
    const { store, s } = fixture();
    expect(JSON.parse(readFileSync(store.file("t1"), "utf8"))).toEqual({ ...s, presetProvenance: { id: s.preset, version: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(new ScopeStore(store.dataDir).records.get("t1")?.scope).toEqual(s);
    expect(() => store.file("../bad")).toThrow();
    store.arm(s); expect(store.isArmed("t1")).toBe(true);
    store.clear("t1"); expect(store.records.has("t1")).toBe(false); expect(store.isArmed("t1")).toBe(false);
  });
  it("retains corrupt scopes as scoped, so the resolver and watcher fail closed", () => {
    const { store } = fixture();
    writeFileSync(store.file("t1"), "invalid");
    const recovered = new ScopeStore(store.dataDir);
    expect(recovered.records.get("t1")?.error).toBeTruthy();
    expect(envForScope(recovered.records, "t1")).toContainEqual(expect.objectContaining({ name: "TAVERN_SCOPE_FILE" }));
  });
  it("resolves only scoped threads and injects opt-in speed bumps without I/O", () => {
    const { store, s } = fixture();
    expect(envForScope(store.records, null)).toEqual([]);
    expect(envForScope(store.records, "unknown")).toEqual([]);
    const vars = Object.fromEntries(envForScope(store.records, "t1").map(entry => [entry.name, entry.value]));
    expect(vars.TAVERN_SCOPE_FILE).toBe(store.file("t1")); expect(vars.GH_TOKEN).toBeUndefined(); expect(vars.GIT_CONFIG_COUNT).toBeTruthy();
    s.github = "none"; store.write("t1", s);
    expect(envForScope(store.records, "t1")).toContainEqual(expect.objectContaining({ name: "GH_TOKEN", value: "tavern-scope-denied" }));
    s.env = { poisonGh: false, blockGitPush: false, variables: {} }; store.write("t1", s);
    expect(envForScope(store.records, "t1").map(entry => entry.name)).toEqual(["TAVERN_SCOPE_FILE", "TAVERN_SCOPE_MODE"]);
  });
});
describe("provider-neutral watcher", () => {
  it("binds a late worktree from SDK environment data once and checks relative writes against it", async () => {
    const store = new ScopeStore(temp()), { worktree } = linkedWorktree(temp()), outside = temp();
    store.write("t1", bindPaths({ ...scopeForClass("smith"), threadId: "t1", issuedAt: Date.now() - 1 }, { home: temp(), tmp: [join(store.dataDir, "scratch")], scopesDir: store.directory }));
    let rows = [{ id: "e1", seq: 1, type: "item/started", createdAt: Date.now(), data: { item: { type: "fileChange", changes: [{ path: "inside" }] } } }];
    const { bb, harness } = createFakePluginHost({ pluginId: "tavern", sdk: { threads: {
      get: async () => ({ environmentId: "env1" }), stop: async () => ({}), events: { list: async () => rows },
    }, environments: { get: async () => ({ path: worktree, isWorktree: true }) } } });
    registerWatcher(bb, store, { onViolation: vi.fn() });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "t1" }), sequence: 1 });
    expect(store.violations()).toEqual([]);
    rows = [{ ...rows[0], id: "e2", seq: 2, data: { item: { type: "fileChange", changes: [{ path: join(outside, "outside") }] } } }];
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "t1" }), sequence: 2 });
    expect(store.violations()[0].ruleId).toBe("write-path");
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("environments.get")).toHaveLength(1);
    expect(store.records.get("t1")?.scope?.writes.allow).toContain("${worktree}");
    await harness.lifecycle.dispose();
  });
  it.each([null, "/", homedir(), "lookup-error"])("allows reader work when late worktree resolution fails, but still catches writes: %s", async path => {
    const store = new ScopeStore(temp());
    let writing = false;
    store.write("t1", bindPaths({ ...scopeForClass("smith"), threadId: "t1", issuedAt: 1 }, { home: temp(), tmp: [join(store.dataDir, "scratch")], scopesDir: store.directory }));
    const { bb, harness } = createFakePluginHost({ pluginId: "tavern", sdk: { threads: {
      get: async () => { if (path === "lookup-error") throw new Error("environment unavailable"); return { environmentId: path === null ? null : "env1" }; },
      stop: async () => ({}),
      events: { list: async () => [{ id: writing ? "e2" : "e1", seq: writing ? 2 : 1, type: "item/started", createdAt: Date.now(), data: { item: writing ? { type: "fileChange", changes: [{ path: "/outside/file" }] } : { type: "fileRead", path: "/tmp/x" } } }] },
    }, environments: { get: async () => ({ path }) } } });
    registerWatcher(bb, store, { onViolation: vi.fn() });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "t1" }), sequence: 1 });
    expect(store.violations()).toEqual([]);
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    writing = true;
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "t1" }), sequence: 2 });
    expect(store.violations()[0]).toMatchObject({ ruleId: "write-path", stopped: true });
    await harness.lifecycle.dispose();
  });
  it.each(["pi", "claude-code", "codex"])("stops and records a %s violation through the fake host", async providerId => {
    const { store, s } = fixture(); store.arm(s);
    const onViolation = vi.fn();
    const { bb, harness } = createFakePluginHost({ pluginId: "tavern", sdk: { threads: { stop: async () => ({}), events: { list: async () => [{ id: "e1", seq: 1, type: providerId === "pi" ? "item/completed" : "item/started", createdAt: Date.now(), data: { item: { type: "commandExecution", command: "git push origin main", cwd: process.cwd() } } }] } } } });
    registerWatcher(bb, store, { onViolation });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "t1", providerId }), sequence: 1 });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
    expect(onViolation).toHaveBeenCalledOnce(); expect(store.violations("t1")[0].ruleId).toBe("git-push");
    expect(new ScopeStore(store.dataDir).violations()).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
  it("stops pi's first tool item when the guard has not armed, but not phase-2 providers", async () => {
    const { store } = fixture();
    const { bb, harness } = createFakePluginHost({ pluginId: "tavern", sdk: { threads: { stop: async () => ({}), events: { list: async () => [{ id: "e1", seq: 1, type: "item/started", createdAt: Date.now(), data: { item: { type: "fileRead", path: "/tmp/x" } } }] } } } });
    registerWatcher(bb, store, { onViolation: vi.fn() });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "t1", providerId: "pi" }), sequence: 1 });
    expect(store.violations()[0].ruleId).toBe("guard-not-loaded");
    await harness.lifecycle.dispose();
  });
  it("contains a binding failure even when the previous bound scope allowed the call", async () => {
    const { store } = fixture(); store.failBinding("t1", new Error("storage unavailable"));
    const { bb, harness } = createFakePluginHost({ pluginId: "tavern", sdk: { threads: { stop: async () => ({}), events: { list: async () => [{ id: "e1", seq: 1, type: "item/started", createdAt: Date.now(), data: { item: { type: "fileRead", path: "/tmp/x" } } }] } } } });
    registerWatcher(bb, store, { onViolation: vi.fn() });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "t1", providerId: "codex" }), sequence: 1 });
    expect(store.violations()[0]).toMatchObject({ ruleId: "scope-invalid", stopped: true }); await harness.lifecycle.dispose();
  });
  it.each(["dt pr merge 17", "dt pr comment 17 -b fixture", "quick deploy ./site example-site", "security find-generic-password -s fixture -w", "vault read secret/fixture", "echo 'git push origin main' | sh", "find . -exec git push origin main \\;", "parallel gh pr merge ::: 17", "watch -n1 gh pr merge 17"])("records legacy acts in Watch without stopping the Pi member: %s", async command => {
    const { store, s } = fixture(); store.setMode("t1", "watch"); store.arm(s);
    const onViolation = vi.fn();
    const { bb, harness } = createFakePluginHost({ pluginId: "tavern", sdk: { threads: { stop: async () => ({}), events: { list: async () => [{ id: "e1", seq: 1, type: "item/completed", createdAt: Date.now(), data: { item: { type: "commandExecution", command, cwd: "/workspace" } } }] } } } });
    registerWatcher(bb, store, { onViolation });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "t1", providerId: "pi" }), sequence: 1 });
    expect(store.violations()).toHaveLength(1);
    expect(store.violations()[0]).toMatchObject({ mode: "watch", stopped: false });
    expect(harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    expect(onViolation).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });
  it("does not read unscoped events, deduplicates notifications and measures event-to-stop latency", async () => {
    const { store, s } = fixture(); s.tools.deny.push("mcp__tool_gateway__slack_post_message"); store.write("t1", s); store.arm(s);
    const start = Date.now();
    const rows = [{ id: "e1", seq: 1, type: "item/started", createdAt: start, data: { item: { type: "toolCall", tool: "mcp__tool_gateway__slack_post_message", arguments: { text: "not sent" } } } }];
    const { bb, harness } = createFakePluginHost({ pluginId: "tavern", sdk: { threads: { stop: async () => ({}), events: { list: async () => rows } } } });
    registerWatcher(bb, store, { onViolation: vi.fn() });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "unscoped" }), sequence: 1 });
    expect(harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(0);
    for (let n = 0; n < 2; n++) await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "t1", providerId: "codex" }), sequence: 1 });
    expect(store.violations()).toHaveLength(1);
    const latency = store.violations()[0].latencyMs;
    console.info("Fake-host event-to-stop latency:", latency, "ms (excludes bb's live 0–1000 ms coalescing)");
    expect(latency).toBeLessThan(500);
    await harness.lifecycle.dispose();
  });
  it("does not treat provider-denied items as executed violations", async () => {
    const { store } = fixture();
    const { bb, harness } = createFakePluginHost({ pluginId: "tavern", sdk: { threads: { events: { list: async () => [{ id: "e1", seq: 1, type: "item/started", createdAt: Date.now(), data: { item: { type: "commandExecution", command: "git push", approvalStatus: "denied" } } }] } } } });
    registerWatcher(bb, store, { onViolation: vi.fn() });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "t1", providerId: "pi" }), sequence: 1 });
    expect(store.violations()).toEqual([]); await harness.lifecycle.dispose();
  });
});
