// @vitest-environment node
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { Registry } from "../../src/server/registry";
import { TavernRuntime } from "../../src/server/runtime";
import { fakePort } from "./support";
import { createFakePluginHost, makeThreadResponse } from "./host";
import { providerSdk } from "./provider-fixture";
import { worktreeProvider } from "./environment-fixture";

export function setup(sdkOverrides: Record<string, unknown> = {}) {
  let now = 1_000_000;
  const db = new Database(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  const host = createFakePluginHost({
    pluginId: "tavern",
    sdk: {
      providers: providerSdk(),
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: "env" }),
        send: async () => ({ delivery: "sent" }),
        defaultExecutionOptions: async () => null,
        queuedMessages: { list: async () => [] },
        updatePluginMetadata: async () => ({}),
        update: async ({ threadId, title }: { threadId: string; title?: string }) => makeThreadResponse({ id: threadId, title: title ?? null }),
        events: { list: async () => [] },
        archive: async () => ({}),
        spawn: async () => makeThreadResponse({ id: `child-${now++}`, parentThreadId: "lead" }),
      },
      plugins: { callRpc: async () => ({ ok: true, channels: [] }) },
      system: { config: async () => ({ primaryHostId: "host" }) },
      projects: { get: async () => ({ sources: [] }) },
      ...sdkOverrides,
      environments: {
        get: async () => ({ id: "env", hostId: "host", isGitRepo: true, environmentProviderId: "git-worktree", branchName: "main" }),
        listProviders: async () => [worktreeProvider()],
        ...(sdkOverrides.environments as Record<string, unknown> | undefined),
      },
    },
  });
  const port = fakePort();
  const k = new Keeper(
    new KeeperStore(db),
    port,
    () => now,
    (tags) => host.bb.rpc.experimental_invalidate(tags),
  );
  const runtime = new TavernRuntime(
    host.bb,
    k,
    new Registry(fileURLToPath(new URL("../../", import.meta.url)), "/nonexistent"),
  );
  k.bind("lead", "keeper", "wren", "project");
  return {
    ...host,
    k,
    runtime,
    port,
    time: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
