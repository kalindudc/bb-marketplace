// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createBbPort } from "../src/bb-port";

describe("bb port", () => {
  it("creates a worktree review on the machine with the project's default checkout", async () => {
    const spawned: unknown[] = [];
    const host = createFakePluginHost({
      pluginId: "shuttle",
      sdk: {
        projects: { get: async () => ({ id: "proj_1", name: "world", sources: [{ hostId: "host_other", isDefault: false }, { hostId: "host_main", isDefault: true }] }) },
        threads: { spawn: async (args: unknown) => (spawned.push(args), { id: "thr_new" }) },
      } as never,
    });
    const port = createBbPort(host.bb);
    await port.spawnThread({ projectId: "proj_1", title: "Review", prompt: "p", workspace: "worktree", metadata: {} });
    await port.spawnThread({ projectId: "proj_1", title: "Review", prompt: "p", workspace: "project-default", metadata: {} });
    expect(spawned[0]).toMatchObject({ environment: { type: "host", hostId: "host_main", workspace: { type: "managed-worktree" } } });
    expect(spawned[1]).toMatchObject({ environment: { type: "project-default" } });
  });
});
