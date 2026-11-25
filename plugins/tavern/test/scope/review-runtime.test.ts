// @vitest-environment node
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ScopeStore } from "../../src/scope/store";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths } from "../../src/scope/paths";
import { registerWatcher, callsFromItem } from "../../src/scope/watch";
import { BLOCK_MARKER } from "../../src/scope/engine";
import { guardLoaderSource } from "../../src/scope/install";
import guard, { type PiGuardApi } from "../../adapters/pi/extension";
import { checkShellGrantReceipt, publishShellGrants, shellGrantTarget } from "../../src/scope/shell-grants";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(providerId = "codex", mode: "enforce" | "watch" | "off" = "enforce") {
  const root = mkdtempSync(join(tmpdir(), "tavern-review-")); roots.push(root);
  const store = new ScopeStore(root);
  const scope = bindPaths({ ...scopeForClass("ranger"), threadId: "t1", issuedAt: 1, mode }, { home: root, tmp: [tmpdir()], scopesDir: store.directory }); store.write("t1", scope);
  let rows: any[] = [], stops = 0, fail = false;
  const onViolation = vi.fn(), handlers = new Map<string, Function>();
  const bb = { events: { on: (name: string, fn: Function) => handlers.set(name, fn) }, onDispose: vi.fn(), log: { warn: vi.fn() }, sdk: { threads: { events: { list: async (args: any) => rows.filter(row => row.seq > Number(args.afterSeq) && args.types.includes(row.type)).slice(0, Number(args.limit)) }, stop: async () => { stops++; if (fail) throw new Error("stop failed"); } } } } as unknown as BbPluginApi;
  const started = { id: "started", seq: 1, type: "item/started", createdAt: Date.now(), data: { item: { id: "call1", type: "commandExecution", command: "git push origin main", cwd: root, status: "pending", approvalStatus: null } } };
  registerWatcher(bb, store, { onViolation });
  return { root, store, scope, bb, onViolation, started, handlers, setRows: (value: any[]) => { rows = value; }, failStop: () => { fail = true; }, succeedStop: () => { fail = false; }, stops: () => stops, emit: (sequence: number) => handlers.get("experimental_thread.events")!({ thread: { id: "t1", providerId }, sequence }) };
}
function mountGuard(file: string, cwd: string) {
  vi.stubEnv("TAVERN_SCOPE_FILE", file);
  vi.stubEnv("BB_THREAD_ID", "t1");
  const hooks = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
  guard({ on: (key, fn) => hooks.set(key, fn), getActiveTools: () => ["bash"], setActiveTools: () => {} });
  const ctx = { cwd };
  hooks.get("session_start")!({}, ctx);
  return {
    call: (input: { command: string }) => hooks.get("tool_call")!({ toolName: "bash", toolCallId: "call1", input }, ctx),
    result: () => hooks.get("tool_result")!({ toolName: "bash", toolCallId: "call1", content: [{ type: "text", text: "completed" }] }, ctx) as { content: { text: string }[] },
  };
}
it.each([
  ["git push origin feature", "publish"], ["gh issue create --title t --body b", "publish"], ["curl -X POST https://example.test -d a", "send"],
])("records %s after dispatch in Watch and holds it before dispatch in Act guard", async (command, kind) => {
  const f = setup("pi", "watch");
  const scope = bindPaths({ ...scopeForClass("wanderer"), threadId: "t1", issuedAt: 1, mode: "watch" }, { home: f.root, tmp: [tmpdir()], scopesDir: f.store.directory });
  f.store.write("t1", scope); f.store.arm(scope);
  const row = { ...f.started, id: "completed", seq: 2, type: "item/completed", data: { item: { ...f.started.data.item, command, cwd: f.root, status: "completed" } } };
  f.setRows([row]); await f.emit(2);
  expect(f.stops()).toBe(0);
  expect(f.store.violations()).toMatchObject([{ act: kind, mode: "watch", stopped: false }]);
  expect(f.store.acts()).toEqual([]);
  f.store.setMode("t1", "enforce");
  const installed = mountGuard(f.store.file("t1"), f.root);
  const held = installed.call({ command });
  expect(held).toMatchObject({ block: true, reason: expect.stringContaining(JSON.stringify(command)) });
  const observe = vi.fn();
  registerWatcher(f.bb, f.store, { onViolation: f.onViolation, onActObservation: observe });
  f.setRows([{ ...row, id: "held", seq: 3, createdAt: Date.now(), data: { item: { ...row.data.item, id: "call2", status: "failed", aggregatedOutput: (held as { reason: string }).reason } } }]);
  await f.emit(3);
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ act: kind, command, cwd: f.root }));
  expect(f.stops()).toBe(0);
});
it.each(["once", "quest", "forged"] as const)("handles a %s grant receipt at Enforce completion", async kind => {
  const f = setup("pi"), file = f.store.file("t1"), command = "npm publish";
  const installed = mountGuard(file, f.root);
  const target = shellGrantTarget({ kind: "bash", toolName: "bash", input: { command }, cwd: f.root })!;
  publishShellGrants(file, f.scope, [{ id: "grant-test", digest: target.digest, scope: kind === "quest" ? "quest" : "once" }]);
  const input = { command };
  expect(installed.call(input)).toBeUndefined();
  const output = installed.result().content.map(block => block.text).join("\n");
  const token = output.match(/grant-test ([a-f0-9-]{36})/)![1]!;
  const used = vi.fn();
  registerWatcher(f.bb, f.store, { onViolation: f.onViolation, onShellGrantUsed: used });
  f.setRows([{ ...f.started, id: "completed", seq: 2, type: "item/completed", data: { item: { ...f.started.data.item, command: kind === "forged" ? "npm publish elsewhere" : input.command, cwd: f.root, status: "completed", aggregatedOutput: output } } }]);
  await f.emit(2); await f.emit(2);
  expect(f.stops()).toBe(kind === "forged" ? 1 : 0);
  expect(f.store.violations()).toHaveLength(kind === "forged" ? 1 : 0);
  expect(used).toHaveBeenCalledTimes(kind === "once" ? 1 : 0);
  if (kind === "once") expect(used).toHaveBeenCalledWith("t1", "grant-test");
  if (kind === "quest") expect(checkShellGrantReceipt(file, "grant-test", token, input.command)).toBeNull();
});
it("follows bb's pi start-before-preflight, failed-completion sequence without stopping a blocked call", async () => {
  // provider-pi createPiDeltaTranslator: tool_execution_start -> item.open; tool_execution_end -> item.close with resultText/aggregatedOutput.
  const f = setup("pi"); f.store.arm(f.scope);
  f.setRows([f.started]); await f.emit(1); expect(f.stops()).toBe(0);
  f.setRows([f.started, { ...f.started, id: "completed", seq: 2, type: "item/completed", data: { item: { ...f.started.data.item, status: "failed", exitCode: 1, aggregatedOutput: BLOCK_MARKER + " Blocked git push. Report the need with tavern_report status needs-decision." } } }]);
  await f.emit(2); expect(f.stops()).toBe(0); expect(f.store.violations()).toMatchObject([{ prevented: true, stopped: false }]);
});
it("skips the external bash-guard completion captured from Vex events 47/48", async () => {
  const f = setup("pi"); f.store.arm(f.scope);
  const command = 'W=/maker/app; cd $W && tail -c 20 src/duration.js | od -c | tail -3; git diff --stat; S=$(mktemp -d); mkdir -p $S/src $S/test; cp package.json $S/; git show HEAD:src/duration.js > $S/src/duration.js; cp test/duration.test.js $S/test/; cd $S && node --test 2>&1 | grep -E "SyntaxError|does not provide|ℹ (pass|fail)"; echo "RED_EXIT=${PIPESTATUS[0]}"; rm -rf $S';
  const started = { ...f.started, data: { item: { ...f.started.data.item, command, cwd: "/warden/app" } } };
  const completed = { ...started, id: "completed", seq: 2, type: "item/completed", data: { item: { ...started.data.item, status: "failed", aggregatedOutput: "[CRITICAL] Command blocked automatically\n\nCommand:\n  " + command + "\n\nRisk: Recursive force delete (rm -rf)", exitCode: 1 } } };
  f.setRows([started]); await f.emit(1); expect(f.stops()).toBe(0);
  f.setRows([started, completed]); await f.emit(2);
  expect(f.stops()).toBe(0); expect(f.store.violations()).toEqual([]); expect(f.onViolation).not.toHaveBeenCalled(); expect(f.store.progress("t1").cursor).toBe(2);
  f.setRows([{ ...completed, id: "executed", seq: 3, data: { item: { ...f.started.data.item, status: "failed", aggregatedOutput: "fatal: remote error", exitCode: 128 } } }]);
  await f.emit(3); expect(f.stops()).toBe(1); expect(f.store.violations()).toHaveLength(1);
});
it.each(["[HIGH] Command blocked in non-interactive mode\n\nCommand:\n  git push origin main", "Blocked by user", "Tool execution was blocked"])("skips other known failed preflight results: %s", async reason => {
  const f = setup("pi"); f.store.arm(f.scope);
  f.setRows([{ ...f.started, type: "item/completed", seq: 2, data: { item: { ...f.started.data.item, status: "failed", aggregatedOutput: reason, exitCode: 1 } } }]);
  await f.emit(2); expect(f.stops()).toBe(0); expect(f.store.violations()).toEqual([]);
});
it.each([
  { status: "completed", aggregatedOutput: "[CRITICAL] Command blocked automatically\n\nCommand:\n  git push origin main" },
  { status: "completed", aggregatedOutput: BLOCK_MARKER + " Held merge. This needs a merge ask. Nothing was done." },
  { status: "failed", aggregatedOutput: "Test log:\n[CRITICAL] Command blocked automatically\n\nCommand:\n  git push origin main", exitCode: 1 },
  { status: "failed", aggregatedOutput: "Permission denied", exitCode: 1 },
])("does not confuse execution output or ordinary failure with a preflight result: %j", async result => {
  const f = setup("pi"); f.store.arm(f.scope);
  f.setRows([{ ...f.started, type: "item/completed", seq: 2, data: { item: { ...f.started.data.item, ...result } } }]);
  await f.emit(2); expect(f.stops()).toBe(1); expect(f.store.violations()).toHaveLength(1);
});
it("recognizes a failed external guard result in structured tool content", async () => {
  const f = setup("pi"); f.store.arm(f.scope);
  f.setRows([{ ...f.started, type: "item/completed", seq: 2, data: { item: { id: "call1", type: "toolCall", tool: "bash", arguments: { command: "git push origin main" }, status: "failed", result: { content: [{ type: "text", text: "[CRITICAL] Command blocked automatically\n\nCommand:\n  git push origin main" }] } } } }]);
  await f.emit(2); expect(f.stops()).toBe(0); expect(f.store.violations()).toEqual([]);
});
it("records bb host-daemon fileChange.error without stopping the preflight-blocked write again", async () => {
  const f = setup("pi"); f.store.arm(f.scope);
  f.setRows([{ ...f.started, type: "item/completed", seq: 2, data: { item: { id: "call1", type: "fileChange", status: "failed", approvalStatus: null, changes: [{ path: "/outside/file", kind: "add" }], error: BLOCK_MARKER + " Blocked write to /outside/file." } } }]);
  await f.emit(2); expect(f.stops()).toBe(0); expect(f.store.violations()).toMatchObject([{ prevented: true, stopped: false }]);
});
it("records a held act without stopping the member or opening a violation", async () => {
  const f = setup("pi"); f.store.arm(f.scope);
  const onActObservation = vi.fn();
  registerWatcher(f.bb, f.store, { onViolation: f.onViolation, onActObservation });
  f.setRows([{ ...f.started, id: "held", type: "item/completed", seq: 2, data: { item: { ...f.started.data.item, status: "failed", exitCode: 1, aggregatedOutput: BLOCK_MARKER + " Held merge. This needs a merge ask. Nothing was done. Tell your Keeper what you need it for and carry on with other work." } } }]);
  await f.emit(2);
  expect(onActObservation).toHaveBeenCalledOnce();
  expect(onActObservation).toHaveBeenCalledWith(expect.objectContaining({ eventId: "held", act: "merge", preflight: true }));
  expect(f.stops()).toBe(0);
  expect(f.onViolation).not.toHaveBeenCalled();
  expect(f.store.violations()).toEqual([]);
});
it("does evaluate an armed pi call that actually completed without a guard block", async () => {
  const f = setup("pi"); f.store.arm(f.scope);
  f.setRows([{ ...f.started, type: "item/completed", seq: 2, data: { item: { ...f.started.data.item, status: "completed", aggregatedOutput: "done" } } }]);
  await f.emit(2); expect(f.stops()).toBe(1);
});
it("keeps emergency reporting usable when the guard is unarmed", async () => {
  const f = setup("pi"); f.setRows([{ ...f.started, data: { item: { type: "toolCall", tool: "tavern_report", arguments: {} } } }]);
  await f.emit(1); expect(f.stops()).toBe(0);
});
it("does not retroactively enforce calls that began while off", async () => {
  const f = setup("pi", "off"); f.store.arm(f.scope);
  const boundary = Date.now(); f.scope.mode = "enforce"; f.scope.enforceFrom = boundary; f.store.write("t1", f.scope);
  f.setRows([{ ...f.started, createdAt: boundary - 10 }, { ...f.started, id: "completed", seq: 2, type: "item/completed", createdAt: boundary + 10, data: { item: { ...f.started.data.item, status: "completed" } } }]);
  await f.emit(2); expect(f.stops()).toBe(0); expect(f.store.violations()).toEqual([]);
});
it("persists cursors across restart and before a throwing notification", async () => {
  const f = setup(); f.onViolation.mockRejectedValue(new Error("callback failed")); f.setRows([f.started]); await f.emit(1); expect(f.stops()).toBe(1);
  const recovered = new ScopeStore(f.root); registerWatcher(f.bb, recovered, { onViolation: f.onViolation });
  await f.emit(1); expect(f.stops()).toBe(1); expect(recovered.violations()).toHaveLength(1);
});
it("retries a failed stop on the next event", async () => {
  const f = setup(); f.failStop(); f.setRows([f.started]); await f.emit(1); expect(f.stops()).toBe(1);
  f.succeedStop(); await f.emit(2); expect(f.stops()).toBe(2); expect(f.store.violations()).toHaveLength(1);
});
it("caps event replay at three pages and continues on the next notification", async () => {
  const f = setup(); const list = vi.spyOn(f.bb.sdk.threads.events, "list");
  f.setRows(Array.from({ length: 500 }, (_, i) => ({ ...f.started, id: "r" + i, seq: i + 1, data: { item: { type: "fileRead", path: "/tmp/x" } } })));
  await f.emit(500); expect(list).toHaveBeenCalledTimes(3); expect(f.store.progress("t1").cursor).toBe(300);
  await f.emit(500); expect(f.store.progress("t1").cursor).toBe(500);
});
it("archive retains the scope and deletion releases it", async () => {
  const f = setup(); await f.handlers.get("thread.archived")!({ thread: { id: "t1" } }); expect(f.store.records.has("t1")).toBe(true);
  await f.handlers.get("thread.active")!({ thread: { id: "t1" } });
  f.setRows([f.started]); await f.emit(1); expect(f.stops()).toBe(1);
  await f.handlers.get("thread.deleted")!({ thread: { id: "t1" } }); expect(f.store.records.has("t1")).toBe(false);
});
it.each(["tool_gateway", "slack"])("normalizes MCP server/tool fields: %s", server => expect(callsFromItem({ type: "toolCall", server, tool: "slack_search_public", arguments: {} }, process.cwd())[0].toolName).toBe(`mcp__${server}__slack_search_public`));
it("watch records but never stops or invokes a blocking callback; off does neither", async () => {
  const watch = setup("codex", "watch"); watch.setRows([watch.started]); await watch.emit(1); expect(watch.stops()).toBe(0); expect(watch.store.violations()).toHaveLength(1); expect(watch.onViolation).not.toHaveBeenCalled();
  const off = setup("codex", "off"); off.setRows([off.started]); await off.emit(1); expect(off.stops()).toBe(0); expect(off.store.violations()).toEqual([]);
});
it("the unscoped shim is lightweight and a missing guard stays unarmed and fails closed in Act guard", async () => {
  const fn = Function("fs", guardLoaderSource("/missing/tavern.ts").replaceAll('await import("node:fs")', "fs").replace("export default", "return"))(fs);
  const pi = { on: vi.fn(), setActiveTools: vi.fn(), getActiveTools: () => ["bash", "quest"] };
  vi.stubEnv("TAVERN_SCOPE_FILE", undefined);
  const start = performance.now(); for (let n = 0; n < 100; n++) await fn(pi);
  expect(performance.now() - start).toBeLessThan(100); expect(pi.on).not.toHaveBeenCalled();
  const f = setup("pi"), file = f.store.file("t1");
  f.store.arm(f.scope);
  vi.stubEnv("TAVERN_SCOPE_FILE", file); await fn(pi);
  expect(f.store.isArmed("t1")).toBe(false);
  const guard = pi.on.mock.calls.find(call => call[0] === "tool_call")?.[1];
  expect(guard).toBeTypeOf("function");
  expect(guard({ toolName: "bash", input: { command: "git push origin main" } })).toMatchObject({ block: true, reason: expect.stringContaining("Guard could not load") });
  expect(guard({ toolName: "journal" })).toBeUndefined();
  for (const mode of ["watch", "off"] as const) {
    f.store.setMode("t1", mode);
    expect(guard({ toolName: "bash" })).toBeUndefined();
  }
});
