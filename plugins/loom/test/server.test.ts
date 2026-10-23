import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse, makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createLoomPlugin } from "../server";
import type { HostMethod } from "../src/host-contract";
import { FakeHost, FakePort, sdkStubs, specToml, type SdkState } from "./helpers";

let state: SdkState;

beforeEach(() => {
  state = { sections: [], takenNames: new Set(), environmentId: "env_1", environmentHost: "host_env", primaryHostId: "host_primary" };
});

async function load(deps?: Parameters<typeof createLoomPlugin>[0]) {
  const fakeHost = new FakeHost();
  const host = createFakePluginHost({
    pluginId: "loom",
    agentSkillIds: ["loom-plan", "loom"],
    experimental_callHostRpc: (call) => fakeHost.call(call.hostId, call.method as HostMethod, call.input as never),
    sdk: sdkStubs(state),
  });
  await createLoomPlugin(deps)(host.bb);
  return host;
}

interface SdkThread {
  id: string;
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
  environmentId: string | null;
  metadata: Record<string, unknown>;
}

// Every sdk call on the engine's path, over scripted state: plan 01's stubs plus the worker lifecycle.
async function loadEngine(over: { tickMs?: number } = {}) {
  const threads = new Map<string, SdkThread>();
  const fakeHost = new FakeHost();
  let n = 0;
  let specs = 0;
  const base = sdkStubs(state);
  const host = createFakePluginHost({
    pluginId: "loom",
    agentSkillIds: ["loom-plan", "loom"],
    experimental_callHostRpc: (call) => fakeHost.call(call.hostId, call.method as HostMethod, call.input as never),
    sdk: {
      ...base,
      projects: { get: async () => ({ id: "proj_1", sources: [{ hostId: "host_env", path: "/repo", isDefault: true }] }) },
      environments: { ...base.environments, get: async ({ environmentId }) => ({ id: environmentId, hostId: "host_env", path: `/wt/${environmentId}`, branchName: `wt-${environmentId}` }) },
      threads: {
        ...base.threads,
        get: async ({ threadId }) => threads.get(threadId) ?? (threadId === "thr_plan" ? { id: threadId, environmentId: state.environmentId, status: "idle", archivedAt: null, deletedAt: null } : Promise.reject(new Error("404 not found"))),
        list: async () => [...threads.values()],
        getPluginMetadata: async ({ threadId }) => threads.get(threadId)?.metadata ?? {},
        // A spec reviewer is thr_spec<n>, so the workers keep their own numbering.
        spawn: async (args) => {
          const spec = (args.pluginMetadata as Record<string, unknown> | undefined)?.role === "spec-review";
          const id = spec ? `thr_spec${++specs}` : `thr_w${++n}`;
          const thread = { id, status: "active", archivedAt: null, deletedAt: null, environmentId: `env_${id.slice(4)}`, metadata: (args.pluginMetadata ?? {}) as Record<string, unknown> };
          threads.set(thread.id, thread);
          return thread;
        },
        send: async () => ({}),
        stop: async ({ threadId }) => void (threads.get(threadId)!.status = "idle"),
        archive: async ({ threadId }) => void (threads.get(threadId)!.archivedAt = 1),
        events: { list: async () => [] },
      },
    },
  });
  await createLoomPlugin({ now: Date.now, ...over })(host.bb);
  return { ...host, threads, fakeHost };
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

type Harness = Awaited<ReturnType<typeof load>>["harness"];

const callPropose = (harness: Harness, threadId = "thr_plan") => harness.callAgentTool("loom_propose", { spec_toml: specToml() }, { threadId, projectId: "proj_1" });

/** Proposes, and has the spec reviewer bb started pass the draft, so the human can approve it. */
const proposeReviewed = async (harness: Harness) => {
  await callPropose(harness);
  await harness.callAgentTool("loom_spec_approve", { summary: "Fits the request." }, { threadId: "thr_spec1", projectId: "proj_1" });
};
const workerSpawns = (harness: Harness) => harness.sdk.callsTo("threads.spawn").filter(([args]) => (args as { pluginMetadata?: Record<string, string> }).pluginMetadata?.role === "worker");
const sendsTo = (harness: Harness, threadId: string) => harness.sdk.callsTo("threads.send").filter(([args]) => (args as { threadId: string }).threadId === threadId);

describe("Loom plugin", () => {
  it("proposes by tool call, waits for the spec review, then approves and starts from the CLI", async () => {
    const { harness } = await loadEngine();
    const proposed = await callPropose(harness);
    expect(typeof proposed === "string" ? proposed : "").toContain("Draft ready: `csv`");
    expect(harness.sdk.callsTo("threads.spawn")[0]![0]).toMatchObject({ title: "CSV · spec review v1", pluginMetadata: { project: "csv", role: "spec-review", version: "1" } });
    expect((await harness.behavior.runCli(["approve", "csv"])).exitCode).toBe(1);

    const verdict = await harness.callAgentTool("loom_spec_approve", { summary: "Fits the request." }, { threadId: "thr_spec1", projectId: "proj_1" });
    expect(verdict).toBe("Your verdict on spec v1 is recorded and goes to the planner. End your turn.");
    expect(sendsTo(harness, "thr_plan")).toHaveLength(1);
    const approve = await harness.behavior.runCli(["approve", "csv"]);
    expect(approve).toMatchObject({ exitCode: 0 });
    expect(approve.stdout).toContain("CSV-1, CSV-2");
    const start = await harness.behavior.runCli(["start", "csv"]);
    expect(start.exitCode).toBe(0);

    const show = JSON.parse((await harness.behavior.runCli(["show", "csv", "--json"])).stdout) as { state: string; ticketCount: number };
    expect(show).toMatchObject({ state: "running", ticketCount: 2 });
    expect(harness.sdk.callsTo("threadSections.create")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.update")).toEqual([[{ threadId: "thr_plan", sectionId: "sec_1" }]]);
  });

  it("registers the tool and the CLI command", async () => {
    const { harness } = await load();
    expect((await harness.behavior.runCli(["list"])).stdout).toContain("No Loom projects yet");
    const config = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    expect(config.tools.map((tool) => tool.name)).toEqual(["loom_propose", "loom_discover"]);
    expect(config.skills).toEqual(["loom-plan", "loom"]);
  });

  it("serves the page's RPC and publishes loom:changed after a project's events", async () => {
    const { harness } = await load();
    expect(await harness.behavior.callRpc("projects", null)).toEqual([]);
    await callPropose(harness);
    expect(await harness.behavior.callRpc("projects", null)).toMatchObject([{ slug: "csv", state: "draft" }]);
    await until(() => harness.realtimeSignals.some((signal) => signal.channel === "loom:changed"));
    expect(harness.realtimeSignals.filter((signal) => signal.channel === "loom:changed")).toEqual([{ channel: "loom:changed", payload: { slug: "csv" } }]);
  });

  it("registers its RPC again after a reload and keeps publishing", async () => {
    const first = await load();
    await callPropose(first.harness);
    const reloaded = await first.harness.reload(createLoomPlugin());
    expect(await reloaded.harness.behavior.callRpc("projects", null)).toMatchObject([{ slug: "csv" }]);
    await reloaded.harness.behavior.callRpc("control", { slug: "csv", action: "archive", confirm: true });
    await until(() => reloaded.harness.realtimeSignals.some((signal) => signal.channel === "loom:changed"));
  });

  it("keeps its data across a reload, and the database refuses to change events", async () => {
    const first = await load();
    await callPropose(first.harness);
    const reloaded = await first.harness.reload(createLoomPlugin());
    expect(JSON.parse((await reloaded.harness.behavior.runCli(["list", "--json"])).stdout)).toMatchObject([{ slug: "csv" }]);
    const db = reloaded.bb.storage.database();
    expect(() => db.prepare("UPDATE events SET kind = 'x'").run()).toThrow("events is append-only");
    expect(() => db.prepare("DELETE FROM events").run()).toThrow("events is append-only");
  });

  it("ends the planner row when its thread is deleted", async () => {
    const { bb, harness } = await load();
    await callPropose(harness);
    const emitted = await harness.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_plan" }) });
    expect(emitted.errors).toEqual([]);
    const row = bb.storage.database().prepare("SELECT state, end_reason FROM threads WHERE thread_id = 'thr_plan'").get();
    expect(row).toEqual({ state: "ended", end_reason: "deleted" });
  });

  it("logs a warning instead of throwing into bb when a handler fails", async () => {
    const { bb, harness } = await load();
    await callPropose(harness);
    bb.storage.database().exec("DROP TABLE threads");
    const emitted = await harness.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_plan" }) });
    expect(emitted.errors).toEqual([]);
    expect(harness.logEntries.some((entry) => entry.level === "warn" && entry.message.startsWith("thread.deleted:"))).toBe(true);
  });

  it("takes an injected bb port and clock", async () => {
    const port = new FakePort();
    const { harness } = await load({ port: () => port, now: () => 1_900_000_000_000 });
    await callPropose(harness);
    expect(port.callsTo("ensureSection")).toEqual([[null, "Loom · CSV export (csv)"]]);
    expect(harness.sdk.calls).toEqual([]);
    const show = JSON.parse((await harness.behavior.runCli(["show", "csv", "--json"])).stdout) as { createdAt: number };
    expect(show.createdAt).toBe(1_900_000_000_000);
  });

  it("runs a project end to end through the sdk: the service spawns a worker, two idles end it and requeue its ticket", async () => {
    const { bb, harness, threads, fakeHost } = await loadEngine({ tickMs: 20 });
    await proposeReviewed(harness);
    await harness.behavior.runCli(["approve", "csv"]);
    const started = await harness.behavior.runCli(["start", "csv"]);
    expect(started).toMatchObject({ exitCode: 0 });
    expect(started.stdout).not.toContain("does not run workers");
    expect(harness.experimental_hostRpcCalls.filter((call) => call.method === "ensureBranch")).toHaveLength(1);
    // One lookup by loom_propose, which checks how the repo is reached, and one by start.
    expect(harness.sdk.callsTo("projects.get")).toHaveLength(2);

    const service = harness.runService("engine");
    await until(() => workerSpawns(harness).length === 1);
    const spawn = workerSpawns(harness)[0]![0] as { title: string; sectionId: string; pluginMetadata: Record<string, string>; environment: { workspace: { baseBranch: { name: string } } } };
    expect(spawn).toMatchObject({ title: "CSV-1 · Order rows", sectionId: "sec_1", pluginMetadata: { project: "csv", role: "worker", ticket: "CSV-1" } });
    expect(spawn.environment.workspace.baseBranch.name).toBe("loom/csv");
    const row = () => bb.storage.database().prepare("SELECT state, end_reason FROM threads WHERE thread_id = 'thr_w1'").get();
    const ticket = () => bb.storage.database().prepare("SELECT state, failures, branch FROM tickets WHERE key = 'CSV-1'").get() as { state: string; failures: number; branch: string | null };
    expect(row()).toEqual({ state: "active", end_reason: null });

    fakeHost.worktree("/wt/env_w1").dirty = true;
    const idle = () => harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_w1" }), lastAssistantText: null });
    await idle();
    await until(() => sendsTo(harness, "thr_w1").length === 1);
    await idle();
    await until(() => row() !== undefined && (row() as { state: string }).state === "ended");
    expect(row()).toEqual({ state: "ended", end_reason: "abandoned" });
    expect(threads.get("thr_w1")).toMatchObject({ status: "idle", archivedAt: 1 });
    expect(harness.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_w1" }]]);
    expect(harness.sdk.callsTo("threads.archive")).toEqual([[{ threadId: "thr_w1" }]]);
    expect(harness.experimental_hostRpcCalls.some((call) => call.method === "commitAll")).toBe(true);
    expect(ticket()).toMatchObject({ failures: 1, branch: "wt-env_w1" });

    service.controller.abort();
    await service.done;
  });

  it("routes archived, failed-turn and rate-limit events to the engine, and stops on dispose", async () => {
    const { bb, harness, threads } = await loadEngine({ tickMs: 20 });
    await proposeReviewed(harness);
    await harness.behavior.runCli(["approve", "csv"]);
    await harness.behavior.runCli(["start", "csv"]);
    const service = harness.runService("engine");
    await until(() => workerSpawns(harness).length === 1);
    service.controller.abort();
    await service.done;

    const errors = (await harness.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_w1" }), error: "boom" })).errors;
    expect(errors).toEqual([]);
    await harness.emitThreadEvent("turn.failed", makeTurnFailedEvent({ threadId: "thr_w1", requestId: "req_1", errorInfo: { category: "rate-limit", httpStatusCode: 429, providerCode: null } }));
    await until(() => harness.sdk.callsTo("threads.retry").length === 1);

    threads.get("thr_w1")!.archivedAt = 5;
    await harness.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_w1" }) });
    const row = () => bb.storage.database().prepare("SELECT state, end_reason FROM threads WHERE thread_id = 'thr_w1'").get();
    await until(() => (row() as { state: string }).state === "ended");
    expect(row()).toEqual({ state: "ended", end_reason: "gone" });
    expect(harness.logEntries.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("reconciles at service start: a worker row whose thread vanished while the plugin was down is ended", async () => {
    const first = await loadEngine({ tickMs: 20 });
    await proposeReviewed(first.harness);
    await first.harness.behavior.runCli(["approve", "csv"]);
    await first.harness.behavior.runCli(["start", "csv"]);
    const running = first.harness.runService("engine");
    await until(() => workerSpawns(first.harness).length === 1);
    running.controller.abort();
    await running.done;

    first.threads.delete("thr_w1");
    const reloaded = await first.harness.reload(createLoomPlugin({ tickMs: 20 }));
    const again = reloaded.harness.runService("engine");
    const db = reloaded.bb.storage.database();
    await until(() => (db.prepare("SELECT state FROM threads WHERE thread_id = 'thr_w1'").get() as { state: string } | undefined)?.state === "ended");
    expect(db.prepare("SELECT end_reason FROM threads WHERE thread_id = 'thr_w1'").get()).toEqual({ end_reason: "gone" });
    again.controller.abort();
    await again.done;
  });
});
