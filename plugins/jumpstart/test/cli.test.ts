import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";

const at = (iso: string) => Date.parse(iso);

// threads.list rows carry queuedWork, which the single-thread response does not.
const listItem = (overrides: Parameters<typeof makeThreadResponse>[0], queuedWork = "none") => ({ ...makeThreadResponse(overrides), queuedWork });

const threads = [
  listItem({ id: "thr_net", title: "Fix the flaky test", status: "error" }),
  listItem({ id: "thr_model", title: null, titleFallback: "Pick a model", status: "error" }),
  listItem({ id: "thr_waiting", title: "Already queued", status: "error" }, "waiting"),
  listItem({ id: "thr_idle", title: "Done already", status: "idle" }),
  listItem({ id: "thr_hidden", title: "Worker", status: "error", visibility: "hidden" }),
  listItem({ id: "thr_archived", title: "Old", status: "error", archivedAt: at("2026-11-01T00:00:00Z") }),
];

const logs: Record<string, unknown[]> = {
  thr_net: [{ type: "provider/error", createdAt: at("2026-11-05T10:00:00Z"), data: { message: "Provider error", detail: "Connection error." } }],
  thr_model: [{ type: "system/error", createdAt: at("2026-11-05T09:00:00Z"), data: { message: "Command thread.start failed", detail: "Ambiguous Pi model" } }],
  thr_waiting: [{ type: "provider/error", createdAt: at("2026-11-05T08:00:00Z"), data: { message: "Provider error", detail: "Request timed out." } }],
};

async function load() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "jumpstart",
    sdk: {
      threads: {
        list: async (args?: { offset?: number }) => ((args?.offset ?? 0) === 0 ? threads : []),
        events: { list: async ({ threadId }: { threadId: string }) => logs[threadId] ?? [] },
        retry: async () => ({ ok: true, delivery: "sent", turnRequestId: "req", attempt: 2 }),
      },
    },
  });
  await plugin(bb);
  return harness;
}

const retried = (harness: Awaited<ReturnType<typeof load>>) =>
  harness.inspection.sdk.callsTo("threads.retry").map((args) => (args[0] as { threadId: string }).threadId);

describe("bb jumpstart list", () => {
  it("lists visible, unarchived failed threads, newest failure first, with why each failed", async () => {
    const harness = await load();
    const result = await harness.behavior.runCli(["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "thr_net  network  Fix the flaky test",
        "  Connection error. (2026-11-05T10:00:00Z)",
        "thr_model  other  Pick a model",
        "  Ambiguous Pi model (2026-11-05T09:00:00Z)",
        "thr_waiting  network  Already queued [a message is already queued]",
        "  Request timed out. (2026-11-05T08:00:00Z)",
        "",
      ].join("\n"),
    );
    expect(harness.inspection.sdk.callsTo("threads.list")[0]?.[0]).toMatchObject({ archived: false });
  });

  it("prints JSON with --json", async () => {
    const harness = await load();
    const result = await harness.behavior.runCli(["list", "--json"]);
    expect(JSON.parse(result.stdout).threads.map((thread: { id: string; network: boolean }) => [thread.id, thread.network])).toEqual([
      ["thr_net", true],
      ["thr_model", false],
      ["thr_waiting", true],
    ]);
  });
});

describe("bb jumpstart kick", () => {
  it("retries only the network failures with --network, leaving threads that already have a message queued", async () => {
    const harness = await load();
    const result = await harness.behavior.runCli(["kick", "--network"]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "thr_net  resuming\n" });
    expect(retried(harness)).toEqual(["thr_net"]);
  });

  it("retries every failed thread with nothing queued with --all", async () => {
    const harness = await load();
    await harness.behavior.runCli(["kick", "--all"]);
    expect(retried(harness)).toEqual(["thr_net", "thr_model"]);
  });

  it("retries the threads it is given, queued or not", async () => {
    const harness = await load();
    await harness.behavior.runCli(["kick", "thr_model", "thr_waiting"]);
    expect(retried(harness)).toEqual(["thr_model", "thr_waiting"]);
  });

  it("needs thread ids, --network or --all, and only one of them", async () => {
    const harness = await load();
    expect((await harness.behavior.runCli(["kick"])).exitCode).not.toBe(0);
    expect((await harness.behavior.runCli(["kick", "--all", "thr_net"])).exitCode).not.toBe(0);
    expect(retried(harness)).toEqual([]);
  });
});
