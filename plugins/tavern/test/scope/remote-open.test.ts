// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { registerScopes } from "../../src/scope";
import { scopeForClass } from "../../src/scope/presets";
import { BackendScopes } from "../../src/server/scopes";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { fakePort } from "../server/support";

const fixtures: Array<{ root: string; host: ReturnType<typeof createFakePluginHost> }> = [];
afterEach(async () => { for (const { root, host } of fixtures.splice(0)) { await host.harness.lifecycle.dispose(); rmSync(root, { recursive: true, force: true }); } });

it.each(["keeper", "lead"])("binds an open %s on its actual remote host without controller-local paths or observation", async classId => {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "scope-remote-open-"));
  const remotePath = "/not-on-this-machine/repo", localPaths = vi.fn(() => { throw new Error("Remote paths must not be resolved on the server"); });
  const host = createFakePluginHost({ pluginId: "tavern", sdk: {
    threads: { get: async () => makeThreadResponse({ id: "member", projectId: "project", environmentId: "guest-env" }),
      events: { list: async () => [{ id: "remote-call", seq: 1, threadId: "member", type: "item/completed", createdAt: 2,
        data: { item: { type: "toolCall", tool: "read", arguments: { path: remotePath + "/file" } } } }] as never },
      storageLocation: localPaths },
    system: { config: async () => ({ primaryHostId: "server" }) as never },
    environments: { get: async () => ({ id: "guest-env", hostId: "guest", path: remotePath, isWorktree: false }) as never },
  } }); fixtures.push({ root, host });
  let paths: unknown;
  const db = host.bb.storage.database(); db.exec(MIGRATIONS.join(";\n"));
  const keeper = new Keeper(new KeeperStore(db), fakePort());
  keeper.bind("member", "keeper", null, "project", classId === "lead" ? {
    keeperThreadId: "parent", boardQuestId: null, waypointId: null, errand: false, title: "Lead",
    brief: { outcome: "Lead", mode: "make-it-work", outOfScope: "", doneWhen: "Done", context: [], questions: [], timeboxMinutes: null },
  } : undefined);
  expect(keeper.member("member")?.role).toBe(classId === "lead" ? "member" : "keeper");
  const fake = { runtime: { bb: host.bb, keeper, placements: () => ({ store: { byMember: () => null } }) },
    cwd: new Map<string, string>() };
  const violations = vi.fn();
  const api = registerScopes(host.bb, { dataDir: root, installGuard: false, pathsForThread: async threadId => {
    paths = await BackendScopes.prototype.paths.call(fake as never, threadId); return paths as never;
  }, onViolation: violations });
  await api.writeScope("member", { ...scopeForClass(classId, undefined, "open"), threadId: "member", issuedAt: 1 });
  expect(paths).toMatchObject({ remoteOpen: { hostId: "guest", cwd: remotePath } });
  expect(fake.cwd.get("member")).toBe(remotePath); expect(localPaths).not.toHaveBeenCalled();
  expect(api.status().threads[0]).toMatchObject({ binding: { kind: "host" }, observation: "unavailable (remote open scope)" });
  const thread = makeThreadResponse({ id: "member", providerId: "pi" });
  expect((await host.harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 })).errors).toEqual([]);
  expect(violations).not.toHaveBeenCalled(); expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([]);
  expect(await host.harness.behavior.resolveProviderEnv("pi", { threadId: "member", hostId: "guest" } as never)).toEqual([]);
  expect(await api.protectOpenPolicy("member")).toBe(false);
  await expect(api.writeScope("member", { ...scopeForClass("ranger"), threadId: "member", issuedAt: 2 }))
    .rejects.toThrow("Only an open Keeper scope can bind remotely without a native delivery");
  let reloaded!: ReturnType<typeof registerScopes>;
  await host.harness.lifecycle.reload(bb => {
    reloaded = registerScopes(bb, { dataDir: root, installGuard: false,
      pathsForThread: localPaths, onViolation: violations });
  });
  await reloaded.rebindScope("member");
  expect((await host.harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 2 })).errors).toEqual([]);
  expect(api.observationHolds()).toEqual([]);
  expect(reloaded.observationHolds()).toEqual([]);
  expect(localPaths).not.toHaveBeenCalled();
});
