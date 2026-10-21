import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import { createFakePluginHost, type FakeSdkOverrides } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createBbPort } from "../src/bb-port";

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
