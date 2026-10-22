import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import retitlePlugin, { AUTO_DELAY_MS } from "../server";

type Thread = ReturnType<typeof makeThreadResponse>;

const planPrompt = [
  {
    type: "text",
    text: "!plan once a loom project is archived, resume the thread section it created",
    mentions: [{ start: 0, end: 5, resource: { kind: "plugin" } }],
  },
  { type: "text", text: "Context for @plan: Load the cortex-planner skill", mentions: [], visibility: "agent-only" },
];

function setup(threads: Thread[], prompts: Record<string, unknown[]>, reply = "Resume Loom thread sections") {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const complete = vi.fn(async (_model: string, _prompt: string) => reply);
  const { bb, harness } = createFakePluginHost({
    pluginId: "retitle",
    sdk: {
      threads: {
        get: async ({ threadId }) => byId.get(threadId)!,
        list: async ({ offset = 0 } = {}) => (offset === 0 ? threads : []),
        update: async ({ threadId, title }) => {
          const updated = { ...byId.get(threadId)!, title: title ?? null };
          byId.set(threadId, updated);
          return updated;
        },
        events: {
          list: async ({ threadId }) => [{ data: { input: prompts[threadId] ?? [] } }] as never,
        },
      },
      plugins: { getSettings: async () => ({ ok: true, schema: {}, values: { model: "accounts/fireworks/models/glm-5p3-flash" } }) as never },
    },
  });
  retitlePlugin(bb, complete);
  const updates = () => harness.sdk.callsTo("threads.update").map(([args]) => args);
  return { harness, complete, byId, updates };
}

const untitled = (id: string, extra: Partial<Thread> = {}) =>
  makeThreadResponse({ id, title: null, titleFallback: "!plan once a loom project…", ...extra });

describe("automatic retitling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("titles an untitled thread after bb's own attempt has settled", async () => {
    const { harness, complete, updates } = setup([untitled("thr_a")], { thr_a: planPrompt });
    await harness.behavior.emitThreadEvent("thread.active", { thread: untitled("thr_a") });
    await vi.advanceTimersByTimeAsync(AUTO_DELAY_MS - 1);
    expect(complete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(updates()).toEqual([{ threadId: "thr_a", title: "Resume Loom thread sections" }]));
    const prompt = complete.mock.calls[0]![1];
    expect(prompt).toContain("invokes these commands or skills: !plan.");
    expect(prompt).not.toContain("cortex-planner");
  });

  it("leaves titled, hidden and already-tried threads alone", async () => {
    const hidden = untitled("thr_h", { visibility: "hidden" });
    const { harness, complete } = setup([hidden, untitled("thr_a")], { thr_a: planPrompt, thr_h: planPrompt });
    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_t", title: "Set" }) });
    await harness.behavior.emitThreadEvent("thread.active", { thread: hidden });
    await harness.behavior.emitThreadEvent("thread.active", { thread: untitled("thr_a") });
    await harness.behavior.emitThreadEvent("thread.active", { thread: untitled("thr_a") });
    await vi.advanceTimersByTimeAsync(AUTO_DELAY_MS);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  });

  it("skips prompts bb deliberately leaves untitled", async () => {
    const short = [{ type: "text", text: "hi there", mentions: [] }];
    const { harness, complete, updates } = setup([untitled("thr_s")], { thr_s: short });
    await harness.behavior.emitThreadEvent("thread.active", { thread: untitled("thr_s") });
    await vi.advanceTimersByTimeAsync(AUTO_DELAY_MS);
    expect(complete).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });

  it("keeps a title the user set while the model was answering", async () => {
    const { harness, byId, updates, complete } = setup([untitled("thr_a")], { thr_a: planPrompt });
    complete.mockImplementation(async () => {
      byId.set("thr_a", { ...byId.get("thr_a")!, title: "Mine" });
      return "Model title";
    });
    await harness.behavior.emitThreadEvent("thread.active", { thread: untitled("thr_a") });
    await vi.advanceTimersByTimeAsync(AUTO_DELAY_MS);
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    expect(updates()).toEqual([]);
  });
});

describe("bb retitle", () => {
  it("titles a named thread again even when it has a title", async () => {
    const { harness, updates } = setup([makeThreadResponse({ id: "thr_t", title: "Old" })], { thr_t: planPrompt });
    const result = await harness.behavior.runCli(["thr_t"]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "thr_t  Resume Loom thread sections" });
    expect(updates()).toEqual([{ threadId: "thr_t", title: "Resume Loom thread sections" }]);
  });

  it("defaults to the thread it runs from, and asks for one outside a thread", async () => {
    const { harness } = setup([untitled("thr_a")], { thr_a: planPrompt });
    expect((await harness.behavior.runCli([], { threadId: "thr_a" } as never)).stdout).toContain("thr_a  Resume");
    const missing = await harness.behavior.runCli([]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("bb retitle <thread-id>");
  });

  it("backfills only visible, unarchived, untitled threads, newest first", async () => {
    const threads = [
      untitled("thr_old", { createdAt: 1 }),
      untitled("thr_new", { createdAt: 3 }),
      untitled("thr_archived", { createdAt: 4, archivedAt: 5 }),
      untitled("thr_hidden", { createdAt: 6, visibility: "hidden" }),
      makeThreadResponse({ id: "thr_titled", title: "Has one", createdAt: 7 }),
    ];
    const prompts = Object.fromEntries(threads.map((thread) => [thread.id, planPrompt]));
    const { harness, updates } = setup(threads, prompts);

    const dry = await harness.behavior.runCli(["--untitled", "--dry-run", "--json"]);
    expect(JSON.parse(dry.stdout)).toEqual(["thr_new", "thr_old"]);
    expect(updates()).toEqual([]);

    const limited = await harness.behavior.runCli(["--untitled", "--limit", "1"]);
    expect(limited.stdout).toBe("thr_new  Resume Loom thread sections");
    expect(updates().map((update) => (update as { threadId: string }).threadId)).toEqual(["thr_new"]);
  });

  it("exits 1 and says why when the model fails", async () => {
    const { harness, complete } = setup([untitled("thr_a")], { thr_a: planPrompt });
    complete.mockRejectedValue(new Error("Shopify AI proxy answered 500: boom"));
    const result = await harness.behavior.runCli(["thr_a"]);
    expect(result).toMatchObject({ exitCode: 1, stdout: "thr_a  failed: Shopify AI proxy answered 500: boom" });
  });
});
