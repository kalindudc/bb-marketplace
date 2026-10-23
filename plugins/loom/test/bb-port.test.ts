import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import { createFakePluginHost, type FakeSdkOverrides } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createBbPort } from "../src/bb-port";
import { SpawnRefusedError, type SpawnArgs } from "../src/ports";

const request: NewThreadRequest = {
  projectId: "proj_1",
  providerId: "codex",
  model: "gpt-5",
  reasoningLevel: "medium",
  permissionMode: "auto",
  executionInputSources: {},
  environment: { type: "project-default" },
  input: [{ type: "text", text: "Let people export their orders as CSV.", mentions: [] }],
};

const portWith = (sdk: FakeSdkOverrides) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "loom", sdk });
  return { port: createBbPort(bb), harness };
};

describe("spawnPlanner", () => {
  it("forwards the composer's request with the title, appends the kickoff as the last, agent-only input, and returns the thread id", async () => {
    const { port, harness } = portWith({ threads: { spawn: async () => ({ id: "thr_p1", environmentId: null }) } });
    expect(await port.spawnPlanner({ request, title: "Loom plan: Export orders", kickoff: "[loom] Plan this project." })).toBe("thr_p1");
    const calls = harness.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    const args = calls[0]![0] as NewThreadRequest & { title: string };
    const { input, ...rest } = request;
    expect(args).toMatchObject({ ...rest, title: "Loom plan: Export orders" });
    expect(args.input).toEqual([...input, { type: "text", text: "[loom] Plan this project.", mentions: [], visibility: "agent-only" }]);
  });
});

describe("spawnThread", () => {
  const args: SpawnArgs = { bbProjectId: "proj_1", hostId: "host_1", baseBranch: "main", title: "CSV-1", prompt: "Work.", sectionId: null, metadata: {} };
  const refusing = (error: unknown) => portWith({ threads: { spawn: async () => Promise.reject(error) } }).port;
  const httpError = (status: number, text: string) => Object.assign(new Error(`HTTP ${status}: ${text}`), { status });

  it("turns a 4xx refusal into a SpawnRefusedError with bb's status and message", async () => {
    const error = await refusing(httpError(400, "Provider pi only supports full permission mode.")).spawnThread(args).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpawnRefusedError);
    expect(error).toMatchObject({ status: 400, message: "HTTP 400: Provider pi only supports full permission mode." });
    await expect(refusing(httpError(404, "Project not found")).spawnThread(args)).rejects.toBeInstanceOf(SpawnRefusedError);
  });

  it("sends a prompt alone without detail, and the detail as agent-only input after the prompt with it", async () => {
    const { port, harness } = portWith({ threads: { spawn: async () => ({ id: "thr_r1", environmentId: null }) } });
    await port.spawnThread(args);
    await port.spawnThread({ ...args, detail: "The record." });
    const [plain, detailed] = harness.sdk.callsTo("threads.spawn").map((call) => call[0] as Record<string, unknown>);
    expect(plain).toMatchObject({ prompt: "Work." });
    expect(plain).not.toHaveProperty("input");
    expect(detailed).not.toHaveProperty("prompt");
    expect(detailed!.input).toEqual([
      { type: "text", text: "Work.", mentions: [] },
      { type: "text", text: "The record.", mentions: [], visibility: "agent-only" },
    ]);
  });

  it("passes on a timeout, a conflict, a rate limit, a server error and an error without a status, so they are retried", async () => {
    for (const error of [httpError(408, "timeout"), httpError(409, "machine_maintenance"), httpError(429, "slow down"), httpError(500, "boom"), new Error("socket hang up")]) {
      const caught = await refusing(error).spawnThread(args).catch((thrown: unknown) => thrown);
      expect(caught).toBe(error);
    }
  });
});

describe("providerIds", () => {
  it("lists the ids of the agent providers bb has", async () => {
    const { port, harness } = portWith({ providers: { list: async () => [{ id: "claude-code" }, { id: "codex" }, { id: "pi" }] as never } });
    expect(await port.providerIds()).toEqual(["claude-code", "codex", "pi"]);
    expect(harness.sdk.callsTo("providers.list")).toHaveLength(1);
  });
});

describe("threadOutput", () => {
  it("returns the thread's final output, or null before it has one", async () => {
    const outputs: Record<string, string | null> = { thr_a: "## Goal\nDone.", thr_b: null };
    const { port } = portWith({ threads: { output: async ({ threadId }: { threadId: string }) => ({ output: outputs[threadId] ?? null }) } });
    expect(await port.threadOutput("thr_a")).toBe("## Goal\nDone.");
    expect(await port.threadOutput("thr_b")).toBeNull();
  });
});

describe("environmentFiles and environmentPatch", () => {
  it("reads bb's diff of the whole worktree against the base, and maps its files", async () => {
    const file = { path: "src/a.ts", previousPath: null, changeKind: "added", additions: 3, deletions: 0, binary: false, origin: "untracked", loadMode: "auto" };
    const { port, harness } = portWith({
      environments: {
        diffFiles: async () => ({ outcome: "available", files: [file], initialPatches: [], mergeBaseRef: "abc", shortstat: "", truncated: false }),
        diffPatch: async () => ({ outcome: "available", patches: [{ path: "src/a.ts", patch: "@@ -0,0 +1 @@\n+a\n", truncated: false }] }),
      } as never,
    });
    expect(await port.environmentFiles("env_1", "loom/csv")).toEqual({ outcome: "ok", truncated: false, files: [{ path: "src/a.ts", previousPath: null, status: "added", additions: 3, deletions: 0, binary: false, untracked: true }] });
    expect(harness.sdk.callsTo("environments.diffFiles")[0]![0]).toEqual({ environmentId: "env_1", target: "all", mergeBaseBranch: "loom/csv" });
    expect(await port.environmentPatch("env_1", "loom/csv", "src/a.ts")).toEqual({ outcome: "ok", patch: "@@ -0,0 +1 @@\n+a\n", truncated: false });
    expect(harness.sdk.callsTo("environments.diffPatch")[0]![0]).toEqual({ environmentId: "env_1", paths: ["src/a.ts"], target: { type: "all", mergeBaseBranch: "loom/csv" } });
  });

  it("reports a worktree bb cannot read, or an environment that is gone, as unavailable", async () => {
    const failure = { code: "path_not_found", message: "The worktree is gone.", workspacePath: "/wt/1" };
    const { port } = portWith({
      environments: {
        diffFiles: async () => ({ outcome: "unavailable", failure }),
        diffPatch: async () => Promise.reject(new Error("HTTP 404: environment not found")),
      } as never,
    });
    expect(await port.environmentFiles("env_1", "main")).toEqual({ outcome: "unavailable", message: "The worktree is gone." });
    expect(await port.environmentPatch("env_1", "main", "a")).toEqual({ outcome: "unavailable", message: "HTTP 404: environment not found" });
  });
});

describe("waitingOnUser", () => {
  const rows: Record<string, Array<{ id: string; status: string }>> = {
    thr_a: [
      { id: "int_1", status: "resolved" },
      { id: "int_2", status: "pending" },
    ],
    thr_b: [{ id: "int_3", status: "resolved" }],
  };

  it("returns the threads with a pending interaction and leaves out a thread bb does not know", async () => {
    const { port, harness } = portWith({
      threads: {
        interactions: {
          list: async ({ threadId }) => {
            if (threadId === "thr_gone") throw new Error("HTTP 404 not found");
            return rows[threadId] ?? [];
          },
        },
      },
    });
    expect(await port.waitingOnUser(["thr_a", "thr_b", "thr_gone"])).toEqual(["thr_a"]);
    expect(harness.sdk.callsTo("threads.interactions.list").map(([args]) => (args as { threadId: string }).threadId).sort()).toEqual(["thr_a", "thr_b", "thr_gone"]);
  });

  it("passes any other error on", async () => {
    const { port } = portWith({
      threads: {
        interactions: {
          list: async () => {
            throw new Error("HTTP 500 database is locked");
          },
        },
      },
    });
    await expect(port.waitingOnUser(["thr_a"])).rejects.toThrow(/database is locked/);
  });
});

describe("listProjects", () => {
  const source = (projectId: string, hostId: string, path: string, isDefault: boolean) => ({ id: `src_${hostId}`, projectId, hostId, path, isDefault, type: "local_path" as const, createdAt: 0, updatedAt: 0 });

  it("lists every bb project, personal ones included, with its id, name, kind, remote and checkouts", async () => {
    const { port, harness } = portWith({
      projects: {
        list: async () => [
          { id: "proj_web", name: "web", kind: "standard", gitRemoteUrl: "git@github.com:acme/web.git", createdAt: 0, updatedAt: 0, sources: [source("proj_web", "host_1", "/src/web", true), source("proj_web", "host_2", "/w", false)] },
          { id: "proj_personal", name: "Personal", kind: "personal", gitRemoteUrl: null, createdAt: 0, updatedAt: 0, sources: [] },
        ],
      },
    });
    expect(await port.listProjects()).toEqual([
      {
        id: "proj_web",
        name: "web",
        kind: "standard",
        gitRemoteUrl: "git@github.com:acme/web.git",
        sources: [
          { hostId: "host_1", path: "/src/web", isDefault: true },
          { hostId: "host_2", path: "/w", isDefault: false },
        ],
      },
      { id: "proj_personal", name: "Personal", kind: "personal", gitRemoteUrl: null, sources: [] },
    ]);
    expect(harness.sdk.callsTo("projects.list")).toEqual([[{ includePersonal: true }]]);
  });

  it("passes an error on", async () => {
    const { port } = portWith({
      projects: {
        list: async () => {
          throw new Error("HTTP 503 bb is restarting");
        },
      },
    });
    await expect(port.listProjects()).rejects.toThrow(/bb is restarting/);
  });
});

describe("projectKind", () => {
  it("returns the kind bb gives the project", async () => {
    const { port } = portWith({ projects: { get: async ({ projectId }) => ({ id: projectId, kind: projectId === "proj_personal" ? "personal" : "standard" }) } });
    expect(await port.projectKind("proj_1")).toBe("standard");
    expect(await port.projectKind("proj_personal")).toBe("personal");
  });

  it("is null when bb does not know the project, and passes any other error on", async () => {
    const { port } = portWith({
      projects: {
        get: async ({ projectId }) => {
          throw new Error(projectId === "proj_gone" ? "HTTP 404 project not found" : "HTTP 500 database is locked");
        },
      },
    });
    expect(await port.projectKind("proj_gone")).toBeNull();
    await expect(port.projectKind("proj_1")).rejects.toThrow(/database is locked/);
  });
});

describe("environment providers and plugins", () => {
  const args: SpawnArgs = { bbProjectId: "proj_1", hostId: "host_1", baseBranch: "origin/main", title: "CSV-1", prompt: "Work.", sectionId: null, metadata: {} };

  it("spawns into a managed worktree from baseBranch, or into the named provider on the project's machine", async () => {
    const { port, harness } = portWith({ threads: { spawn: async () => ({ id: "thr_w1", environmentId: null }) } });
    await port.spawnThread(args);
    await port.spawnThread({ ...args, environment: { providerId: "world-tree", inputs: { tree: "loom-csv" } } });
    const [managed, provider] = harness.sdk.callsTo("threads.spawn").map((call) => (call[0] as { environment: unknown }).environment);
    expect(managed).toEqual({ type: "host", hostId: "host_1", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "origin/main" } } });
    expect(provider).toEqual({ type: "provider", environmentProviderId: "world-tree", inputs: { tree: "loom-csv" }, machine: { type: "existing", hostId: "host_1" } });
  });

  it("lists providers for the project and machine with that machine's availability, and plugins with whether bb ships them", async () => {
    const listed = [
      { id: "git-worktree", displayName: "Worktree", description: null, pluginId: "environment-git-worktree", acceptsEmptyInputs: true, inputs: null, availability: null, machineAvailability: {} },
      { id: "world-tree", displayName: "World tree", description: "Trees.", pluginId: "world-tree", acceptsEmptyInputs: false, inputs: { type: "object" }, availability: { status: "available" }, machineAvailability: { host_1: { status: "unavailable", message: "No ~/world here." } } },
    ];
    const { port, harness } = portWith({
      environments: { listProviders: async () => listed },
      plugins: { list: async () => ({ plugins: [{ id: "environment-git-worktree", enabled: true, provenance: "builtin" }, { id: "world-tree", enabled: false, provenance: "catalog" }] }) },
    } as FakeSdkOverrides);
    expect(await port.environmentProviders("proj_1", "host_1")).toEqual([
      { id: "git-worktree", displayName: "Worktree", description: null, pluginId: "environment-git-worktree", acceptsEmptyInputs: true, inputs: null, available: true, unavailableReason: null },
      { id: "world-tree", displayName: "World tree", description: "Trees.", pluginId: "world-tree", acceptsEmptyInputs: false, inputs: { type: "object" }, available: false, unavailableReason: "No ~/world here." },
    ]);
    expect(harness.sdk.callsTo("environments.listProviders")).toEqual([[{ projectId: "proj_1", hostId: "host_1" }]]);
    expect(await port.plugins()).toEqual([
      { id: "environment-git-worktree", enabled: true, builtin: true },
      { id: "world-tree", enabled: false, builtin: false },
    ]);
  });
});
