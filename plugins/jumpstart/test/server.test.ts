import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { failureTag } from "../src/contract";
import plugin from "../server";

type Row = { type: string; createdAt: number; data: Record<string, unknown> };

const connectionError: Row[] = [
  { type: "provider/error", createdAt: 5_000, data: { message: "Provider error", detail: "Connection error." } },
  { type: "client/turn/requested", createdAt: 4_000, data: {} },
];
const badModel: Row[] = [
  { type: "system/error", createdAt: 3_000, data: { message: "Command thread.start failed", detail: "Ambiguous Pi model" } },
];

class HttpError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

async function load(
  logs: Record<string, Row[]> = {},
  retry?: (args: { threadId: string }) => Promise<unknown>,
  stop: (args: { threadId: string }) => Promise<unknown> = async ({ threadId }) => ({ ok: true, threadId }),
) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "jumpstart",
    sdk: {
      threads: {
        events: {
          list: async ({ threadId }: { threadId: string }) => {
            const rows = logs[threadId];
            if (rows === undefined) throw new HttpError(`Thread ${threadId} not found`, "not_found");
            return rows;
          },
        },
        retry: retry ?? (async ({ threadId }) => ({ ok: true, delivery: "sent", turnRequestId: `req_${threadId}`, attempt: 2 })),
        stop,
      },
    },
  });
  await plugin(bb);
  return harness;
}

describe("failures", () => {
  it("reads the error that stopped each thread, newest first and only error events", async () => {
    const harness = await load({ thr_a: connectionError, thr_b: badModel });
    const failures = await harness.behavior.callRpc("failures", { keys: ["thr_a", "thr_b"] });
    expect(failures).toEqual({
      thr_a: { reason: "Connection error.", failedAt: 5_000, network: true, restart: false },
      thr_b: { reason: "Ambiguous Pi model", failedAt: 3_000, network: false, restart: false },
    });
    expect(harness.inspection.sdk.callsTo("threads.events.list")[0]?.[0]).toMatchObject({
      threadId: "thr_a",
      order: "desc",
      types: ["client/turn/requested", "provider/error", "system/error"],
    });
  });

  it("says when it could not read a thread's log instead of dropping the thread", async () => {
    const harness = await load({});
    const failures = await harness.behavior.callRpc("failures", { keys: ["thr_gone"] });
    expect(failures).toEqual({
      thr_gone: { reason: "Could not read this thread's log: Thread thr_gone not found", failedAt: null, network: false, restart: false },
    });
  });

  it("marks a thread's failure stale when it fails again", async () => {
    const harness = await load();
    await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_a", status: "error" }), error: null });
    expect(harness.inspection.experimental_rpcInvalidations).toContainEqual([failureTag("thr_a")]);
  });
});

describe("kick", () => {
  it("retries each thread's failed turn once, and reports what happened to each", async () => {
    const retry = async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_queued") {
        return {
          ok: true,
          delivery: "queued",
          turnRequestId: "req",
          attempt: 2,
          queuedMessageId: "qm_1",
          sendAt: null,
          waitingOn: { kind: "host-offline", hostName: "aquifer-1" },
        };
      }
      if (threadId === "thr_idle") throw new HttpError("Thread thr_idle has no failed turn to retry: it is idle.", "no_failed_turn");
      return { ok: true, delivery: "sent", turnRequestId: "req", attempt: 2 };
    };
    const logs = { thr_sent: connectionError, thr_queued: connectionError, thr_idle: connectionError };
    const harness = await load(logs, retry);
    const { results } = (await harness.behavior.callRpc("kick", {
      threadIds: ["thr_sent", "thr_queued", "thr_idle", "thr_sent"],
    })) as { results: unknown[] };

    expect(results).toEqual([
      { threadId: "thr_sent", outcome: "sent" },
      { threadId: "thr_queued", outcome: "queued", waitingOn: "waiting for aquifer-1 to come online" },
      { threadId: "thr_idle", outcome: "failed", message: "Thread thr_idle has no failed turn to retry: it is idle." },
    ]);
    const retried = harness.inspection.sdk.callsTo("threads.retry").map((args) => args[0]);
    expect(retried).toEqual([
      { threadId: "thr_sent", reason: "Resumed with Jumpstart" },
      { threadId: "thr_queued", reason: "Resumed with Jumpstart" },
      { threadId: "thr_idle", reason: "Resumed with Jumpstart" },
    ]);
  });

  it("restarts an agent that stopped answering before retrying, and leaves a running one alone", async () => {
    const hung: Row[] = [{ type: "system/error", createdAt: 1, data: { message: "Command turn.submit failed", detail: "JSON-RPC request timed out: turn/start" } }];
    const harness = await load({ thr_hung: hung, thr_net: connectionError });
    const { results } = (await harness.behavior.callRpc("kick", { threadIds: ["thr_hung", "thr_net"] })) as { results: unknown[] };

    expect(results).toEqual([
      { threadId: "thr_hung", outcome: "sent", restarted: true },
      { threadId: "thr_net", outcome: "sent" },
    ]);
    const callsFor = (threadId: string) =>
      harness.inspection.sdk.calls
        .filter((call) => call.path !== "threads.events.list" && (call.args[0] as { threadId: string }).threadId === threadId)
        .map((call) => call.path);
    expect(callsFor("thr_hung")).toEqual(["threads.stop", "threads.retry"]);
    expect(callsFor("thr_net")).toEqual(["threads.retry"]);
  });

  it("does not retry when it could not restart the agent", async () => {
    const hung: Row[] = [{ type: "provider/error", createdAt: 1, data: { message: "Provider error", detail: "pi did not answer prompt in time" } }];
    const harness = await load({ thr_hung: hung }, undefined, async () => {
      throw new HttpError("Host is not connected", "host_unavailable");
    });
    const { results } = (await harness.behavior.callRpc("kick", { threadIds: ["thr_hung"] })) as { results: unknown[] };
    expect(results).toEqual([{ threadId: "thr_hung", outcome: "failed", message: "Could not restart the agent: Host is not connected" }]);
    expect(harness.inspection.sdk.callsTo("threads.retry")).toEqual([]);
  });

  it("refuses an empty list", async () => {
    const harness = await load();
    await expect(harness.behavior.callRpc("kick", { threadIds: [] })).rejects.toThrow();
  });
});
