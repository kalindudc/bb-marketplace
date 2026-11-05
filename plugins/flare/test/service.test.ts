// @vitest-environment node
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { threadTag } from "../src/contract";
import { FlareService, MAX_NUDGES_PER_TURN, dueForNudge, type Thread } from "../src/service";
import { readSettings, type FlareSettings } from "../src/settings";
import { FlareStore, MIGRATIONS, type RunRow } from "../src/store";

interface World {
  threads?: Record<string, Partial<Thread>>;
  ancestors?: Record<string, string[]>;
  pending?: Record<string, boolean>;
  levels?: Record<string, unknown>;
  running?: string[];
  prompt?: string;
  settings?: Partial<FlareSettings>;
  push?: (input: unknown) => Promise<unknown>;
  ancestorsFail?: boolean;
  onListRunning?: () => void;
}

function setup(world: World = {}) {
  let now = 1_000_000;
  const threads = world.threads ?? {};
  const { bb, harness } = createFakePluginHost({
    pluginId: "flare",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads[threadId];
          if (thread === undefined) throw new Error(`Thread ${threadId} not found`);
          return makeThreadResponse({ id: threadId, ...thread } as never);
        },
        experimental_listAncestors: async ({ threadIds }: { threadIds: readonly string[] }) => {
          if (world.ancestorsFail) throw new Error("daemon hiccup");
          return { threads: threadIds.map((threadId) => ({ threadId, ancestorIds: world.ancestors?.[threadId] ?? [] })) };
        },
        interactions: {
          list: async ({ threadId }: { threadId: string }) => (world.pending?.[threadId] ? [{ id: "int_1", status: "pending" }] : []),
        },
        send: async () => ({ ok: true, delivery: "sent", turnRequestId: "req_1" }),
        listRunning: async () => {
          const running = (world.running ?? []).map((id) => ({ id, hostId: null }));
          world.onListRunning?.();
          return running;
        },
        events: {
          list: async () =>
            world.prompt === undefined
              ? []
              : [{ id: "ev", seq: 1, createdAt: 1, threadId: "t", scope: { kind: "thread" }, type: "client/turn/requested", data: { input: [{ type: "text", text: world.prompt }] } }],
        },
      },
      plugins: {
        callRpc: async ({ method, input }: { method: string; input?: unknown }) => {
          if (method === "threadNotifications.list") return { threads: world.levels ?? {} };
          if (world.push !== undefined) return world.push(input);
          return { ok: true, channels: ["desktop"] };
        },
      },
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new FlareStore(db);
  const settings = { ...readSettings({}), ...world.settings };
  const service = new FlareService(bb, store, async () => settings, () => now);
  return {
    bb,
    harness,
    store,
    service,
    settings,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    calls: (path: string) => harness.inspection.sdk.callsTo(path).map((args) => args[0] as Record<string, unknown>),
  };
}

const active = (id: string, extra: Partial<Thread> = {}): Thread =>
  makeThreadResponse({ id, status: "active", runtime: { displayStatus: "active" }, ...extra } as never) as Thread;

describe("sending a flare", () => {
  it("writes the flare and answers at once, before any notification finishes", async () => {
    let release: () => void = () => undefined;
    const world = setup({
      threads: { thr_a: { title: "Fix the flaky test" } },
      push: () => new Promise((resolve) => (release = () => resolve({ ok: true, channels: ["mobile"] }))),
    });
    const result = world.service.send({
      threadId: "thr_a",
      projectId: "proj",
      fields: { title: "Staging refuses connections", kind: "blocker" },
      source: "tool",
    });
    expect(result.status).toBe("sent");
    expect(world.service.banner("thr_a").flare).toMatchObject({ title: "Staging refuses connections", kind: "blocker", pushed: false });
    expect(world.harness.inspection.experimental_rpcInvalidations).toContainEqual([threadTag("thr_a")]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await world.service.settled();
    expect(world.calls("plugins.callRpc").find((call) => call.method === "notifications.send")).toMatchObject({
      pluginId: "push-notifications",
      input: { title: "Staging refuses connections", body: "Blocker in Fix the flaky test", threadId: "thr_a" },
    });
    expect(world.service.banner("thr_a").flare).toMatchObject({ pushed: true });
  });

  it("sends a repeat of the same flare only once", () => {
    const world = setup();
    const first = world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Same" }, source: "tool" });
    world.advance(30_000);
    const second = world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Same" }, source: "tool" });
    expect(first.status).toBe("sent");
    expect(second.status).toBe("duplicate");
    expect(world.service.list("thr_a", { limit: 10, children: false })).toHaveLength(1);
  });

  it("sends the same words again when the kind, the urgency or the turn changed", () => {
    const world = setup();
    world.service.onActive(active("thr_a"));
    const send = (fields: Record<string, unknown>) => world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Prod is down", ...fields }, source: "tool" }).status;
    expect(send({})).toBe("sent");
    expect(send({ kind: "blocker" })).toBe("sent");
    expect(send({ kind: "blocker", notify: true })).toBe("sent");
    expect(send({ kind: "blocker", notify: true })).toBe("duplicate");
    world.service.onIdle(active("thr_a"));
    world.advance(1000);
    world.service.onActive(active("thr_a"));
    expect(send({})).toBe("sent");
  });

  it("still answers sent when the database fails after the flare was saved", () => {
    const world = setup();
    world.service.onActive(active("thr_a"));
    world.store.countInRun = () => {
      throw new Error("SQLITE_BUSY");
    };
    const result = world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Saved anyway" }, source: "tool" });
    expect(result).toMatchObject({ status: "sent", flare: { title: "Saved anyway" } });
  });

  it("reports a database failure as a result to retry, not a thrown error", () => {
    const world = setup();
    world.bb.storage.database().exec("DROP TABLE flares");
    const result = world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Lost" }, source: "tool" });
    expect(result).toMatchObject({ status: "failed" });
  });

  it("does not push a finding by default, and pushes every flare when the setting says so", async () => {
    const quiet = setup({ threads: { thr_a: {} } });
    quiet.service.send({ threadId: "thr_a", projectId: null, fields: { title: "A finding" }, source: "tool" });
    await quiet.service.settled();
    expect(quiet.calls("plugins.callRpc").filter((call) => call.method === "notifications.send")).toEqual([]);

    const loud = setup({ threads: { thr_a: {} }, settings: { notify: "all" } });
    loud.service.send({ threadId: "thr_a", projectId: null, fields: { title: "A finding", body: "\nFirst line\nSecond" }, source: "tool" });
    await loud.service.settled();
    expect(loud.calls("plugins.callRpc").find((call) => call.method === "notifications.send")).toMatchObject({
      input: { title: "A finding", body: "Finding in Untitled thread: First line" },
    });
  });

  it("pushes a finding the agent marked urgent, and never pushes when notifications are off or the thread is muted", async () => {
    const urgent = setup({ threads: { thr_a: {} } });
    urgent.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Look now", notify: true }, source: "tool" });
    await urgent.service.settled();
    expect(urgent.calls("plugins.callRpc").some((call) => call.method === "notifications.send")).toBe(true);

    const off = setup({ threads: { thr_a: {} }, settings: { notify: "off" } });
    off.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Blocked", kind: "blocker" }, source: "tool" });
    await off.service.settled();
    expect(off.calls("plugins.callRpc")).toEqual([]);

    const muted = setup({ threads: { thr_a: {} }, levels: { thr_a: { level: "muted" } } });
    muted.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Blocked", kind: "blocker" }, source: "tool" });
    await muted.service.settled();
    expect(muted.calls("plugins.callRpc").map((call) => call.method)).toEqual(["threadNotifications.list"]);
  });

  it("keeps flares past the per-turn limit but stops them notifying", async () => {
    const world = setup({ threads: { thr_a: {} }, settings: { notify: "all" } });
    world.service.onActive(active("thr_a"));
    let last;
    for (let index = 0; index < 21; index++) {
      last = world.service.send({ threadId: "thr_a", projectId: null, fields: { title: `Flare ${index}` }, source: "tool" });
    }
    await world.service.settled();
    expect(last).toMatchObject({ status: "sent", notes: [expect.stringContaining("did not notify anyone")] });
    expect(world.calls("plugins.callRpc").filter((call) => call.method === "notifications.send")).toHaveLength(20);
  });
});

describe("child threads", () => {
  const family = {
    threads: {
      thr_child: { title: "Check the logs", parentThreadId: "thr_parent" },
      thr_parent: { title: "Orchestrate", status: "active", runtime: { displayStatus: "active" } },
    } as Record<string, Partial<Thread>>,
    ancestors: { thr_child: ["thr_parent", "thr_root"] },
  };

  it("shows a child's flare in its parent's banner and tab, named after the child", async () => {
    const world = setup(family);
    world.service.send({ threadId: "thr_child", projectId: null, fields: { title: "Found the bad deploy" }, source: "tool" });
    await world.service.settled();
    expect(world.service.banner("thr_parent")).toMatchObject({
      flare: { title: "Found the bad deploy", fromChild: { threadId: "thr_child", title: "Check the logs" } },
      count: 1,
      childCount: 1,
    });
    expect(world.service.feed("thr_root", true).flares).toHaveLength(1);
    expect(world.service.feed("thr_parent", false).flares).toHaveLength(0);
    expect(world.harness.inspection.experimental_rpcInvalidations).toContainEqual([
      threadTag("thr_child"),
      threadTag("thr_parent"),
      threadTag("thr_root"),
    ]);
  });

  it("tells a working parent agent about a child's blocker, as a note that only joins its turn", async () => {
    const world = setup(family);
    world.service.send({ threadId: "thr_child", projectId: null, fields: { title: "No access to prod", body: "403 from the API", kind: "blocker" }, source: "tool" });
    await world.service.settled();
    const [send] = world.calls("threads.send");
    expect(send).toMatchObject({ threadId: "thr_parent", mode: "steer", senderThreadId: "thr_child" });
    const text = (send!.input as { text: string; visibility: string }[])[0]!;
    expect(text.visibility).toBe("agent-only");
    expect(text.text).toContain('[Flare from a child thread] "Check the logs" (@thread:thr_child) sent a blocker: No access to prod');
    expect(text.text).toContain("403 from the API");
    expect(world.service.feed("thr_child", false).flares[0]).toMatchObject({ forwarded: true });
  });

  it("does not push a child's blocker when its parent is muted", async () => {
    const world = setup({ ...family, levels: { thr_parent: "muted" } });
    world.service.send({ threadId: "thr_child", projectId: null, fields: { title: "Blocked", kind: "blocker" }, source: "tool" });
    await world.service.settled();
    expect(world.calls("plugins.callRpc").find((call) => call.method === "threadNotifications.list")).toMatchObject({
      input: { threadIds: ["thr_child", "thr_parent", "thr_root"] },
    });
    expect(world.calls("plugins.callRpc").some((call) => call.method === "notifications.send")).toBe(false);
  });

  it("still shows a child's flare to its parent when the chain of ancestors cannot be read", async () => {
    const world = setup({ ...family, ancestorsFail: true });
    world.service.send({ threadId: "thr_child", projectId: null, fields: { title: "Found it" }, source: "tool" });
    await world.service.settled();
    expect(world.service.banner("thr_parent").flare).toMatchObject({ title: "Found it", fromChild: { threadId: "thr_child" } });
  });

  it("leaves an idle or waiting parent alone, and does not forward findings by default", async () => {
    const idle = setup({ ...family, threads: { ...family.threads, thr_parent: { status: "idle", runtime: { displayStatus: "idle" } } } });
    idle.service.send({ threadId: "thr_child", projectId: null, fields: { title: "Blocked", kind: "blocker" }, source: "tool" });
    await idle.service.settled();
    expect(idle.calls("threads.send")).toEqual([]);

    const asking = setup({ ...family, pending: { thr_parent: true } });
    asking.service.send({ threadId: "thr_child", projectId: null, fields: { title: "Blocked", kind: "blocker" }, source: "tool" });
    await asking.service.settled();
    expect(asking.calls("threads.send")).toEqual([]);

    const finding = setup(family);
    finding.service.send({ threadId: "thr_child", projectId: null, fields: { title: "Interesting" }, source: "tool" });
    await finding.service.settled();
    expect(finding.calls("threads.send")).toEqual([]);
  });
});

describe("turns", () => {
  it("groups flares under the turn they arrived in and labels it with the message that started it", async () => {
    const world = setup({ prompt: "Find out why checkout is slow" });
    world.service.onActive(active("thr_a"));
    await world.service.settled();
    world.advance(1000);
    const sent = world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Slow query found" }, source: "tool" });
    world.advance(1000);
    world.service.onIdle(active("thr_a", { status: "idle" }));

    const feed = world.service.feed("thr_a", true);
    expect(feed.runs).toEqual([
      expect.objectContaining({ outcome: "done", prompt: "Find out why checkout is slow", startedAt: 1_000_000, endedAt: 1_002_000 }),
    ]);
    expect(sent.status === "sent" && sent.flare.runId).toBe(feed.runs[0]!.id);
  });

  it("starts the banner over when a new turn starts", () => {
    const world = setup();
    world.service.onActive(active("thr_a"));
    world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Old news" }, source: "tool" });
    world.service.onIdle(active("thr_a"));
    expect(world.service.banner("thr_a").flare?.title).toBe("Old news");
    world.advance(5000);
    world.service.onActive(active("thr_a"));
    expect(world.service.banner("thr_a")).toMatchObject({ flare: null, count: 0, run: { outcome: "running" } });
  });

  it("marks a failed turn and, when asked, pushes the last flare of that turn", async () => {
    const world = setup({ settings: { notifyOnFailure: true } });
    world.service.onActive(active("thr_a", { title: "Migrate the schema" }));
    world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Half the tables are done" }, source: "tool" });
    await world.service.settled();
    world.service.onFailed(active("thr_a", { title: "Migrate the schema", status: "error" }), "Connection error.");
    // A retry's flare lands before the failure notice is sent; the notice still names the failed turn's flare.
    world.advance(1000);
    world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "From the retry" }, source: "cli" });
    await world.service.settled();
    expect(world.service.banner("thr_a").run).toMatchObject({ outcome: "failed", error: "Connection error." });
    expect(world.calls("plugins.callRpc").find((call) => call.method === "notifications.send")).toMatchObject({
      input: { title: "Turn failed in Migrate the schema", body: "Last flare: Half the tables are done", threadId: "thr_a" },
    });
  });

  it("hides the banner's flares once dismissed, until a newer one arrives", () => {
    const world = setup();
    const sent = world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "First" }, source: "tool" });
    if (sent.status !== "sent") throw new Error("expected a flare");
    world.service.dismiss("thr_a", sent.flare.createdAt);
    expect(world.service.banner("thr_a").flare).toBeNull();
    world.advance(1000);
    world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Second" }, source: "tool" });
    expect(world.service.banner("thr_a")).toMatchObject({ flare: { title: "Second" }, count: 1 });
  });

  it("matches open turns to the threads really running after a restart", async () => {
    const world = setup({ threads: { thr_new: { parentThreadId: "thr_p" } }, running: ["thr_new"], prompt: "Keep going" });
    world.service.onActive(active("thr_gone"));
    await world.service.reconcile();
    expect(world.store.latestRun("thr_gone")).toMatchObject({ outcome: "unknown" });
    // The fake event says the turn started at 1, long before Flare loaded.
    expect(world.store.openRun("thr_new")).toMatchObject({ isChild: true, startedAt: 1, prompt: "Keep going" });
  });

  it("keeps a run a thread event opened or closed while it was reading", async () => {
    const scene: World = { threads: { thr_late: {}, thr_new: {} }, running: ["thr_new"] };
    const world = setup(scene);
    scene.onListRunning = () => {
      world.service.onActive(active("thr_late"));
      world.service.onIdle(active("thr_new"));
    };
    await world.service.reconcile();
    expect(world.store.openRun("thr_late")).toMatchObject({ outcome: "running" });
    expect(world.store.openRun("thr_new")).toBeNull();
  });

  it("returns the runs every flare in the feed belongs to, however many turns came after", () => {
    const world = setup();
    world.service.onActive(active("thr_a"));
    world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Early" }, source: "tool" });
    for (let turn = 0; turn < 120; turn++) {
      world.advance(1000);
      world.service.onIdle(active("thr_a"));
      world.advance(1000);
      world.service.onActive(active("thr_a"));
    }
    const feed = world.service.feed("thr_a", true);
    expect(feed.runs.some((run) => run.id === feed.flares[0]!.runId)).toBe(true);
  });

  it("forgets a deleted thread", () => {
    const world = setup();
    world.service.onActive(active("thr_a"));
    world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "x" }, source: "tool" });
    world.service.onDeleted(active("thr_a"));
    expect(world.service.feed("thr_a", true)).toEqual({ flares: [], runs: [], truncated: false });
  });

  it("prunes flares older than the setting", () => {
    const world = setup();
    world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "Old" }, source: "tool" });
    world.advance(31 * 86_400_000);
    world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "New" }, source: "tool" });
    expect(world.service.prune(30)).toBe(1);
    expect(world.service.list("thr_a", { limit: 10, children: false }).map((row) => row.title)).toEqual(["New"]);
  });
});

describe("reminders", () => {
  const run = (overrides: Partial<RunRow> = {}): RunRow => ({
    id: "run",
    threadId: "thr_a",
    startedAt: 0,
    endedAt: null,
    outcome: "running",
    error: null,
    prompt: null,
    isChild: false,
    nudges: 0,
    lastNudgeAt: null,
    ...overrides,
  });
  const on = { ...readSettings({}), nudgeMinutes: 10 };

  it("is due only after the configured quiet time since the start, the last flare or the last reminder", () => {
    expect(dueForNudge(run(), null, on, 9 * 60_000)).toBe(false);
    expect(dueForNudge(run(), null, on, 10 * 60_000)).toBe(true);
    expect(dueForNudge(run(), 5 * 60_000, on, 12 * 60_000)).toBe(false);
    expect(dueForNudge(run({ lastNudgeAt: 8 * 60_000 }), null, on, 12 * 60_000)).toBe(false);
  });

  it("is never due when off, after the limit, for a finished turn or for a child thread unless asked", () => {
    expect(dueForNudge(run(), null, readSettings({}), 60 * 60_000)).toBe(false);
    expect(dueForNudge(run({ nudges: MAX_NUDGES_PER_TURN }), null, on, 60 * 60_000)).toBe(false);
    expect(dueForNudge(run({ endedAt: 1 }), null, on, 60 * 60_000)).toBe(false);
    expect(dueForNudge(run({ isChild: true }), null, on, 60 * 60_000)).toBe(false);
    expect(dueForNudge(run({ isChild: true }), null, { ...on, nudgeChildThreads: true }, 60 * 60_000)).toBe(true);
  });

  it("adds one reminder to a quiet running turn and none to a turn waiting on the user", async () => {
    const working = { status: "active", runtime: { displayStatus: "active" } } as Partial<Thread>;
    const world = setup({ threads: { thr_a: working, thr_b: working }, pending: { thr_b: true }, settings: { nudgeMinutes: 10 } });
    world.service.onActive(active("thr_a"));
    world.service.onActive(active("thr_b"));
    world.advance(11 * 60_000);
    await world.service.nudge();
    await world.service.nudge();
    const sends = world.calls("threads.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ threadId: "thr_a", mode: "steer" });
    expect((sends[0]!.input as { text: string }[])[0]!.text).toMatch(/^\[Flare reminder\] This turn has run for 11 minutes without a flare\./);
    expect(world.store.openRun("thr_a")).toMatchObject({ nudges: 1 });

    // A flare from an earlier turn does not make this turn's reminder say "since its last flare".
    world.advance(11 * 60_000);
    await world.service.nudge();
    expect((world.calls("threads.send")[1]!.input as { text: string }[])[0]!.text).toMatch(
      /^\[Flare reminder\] This turn has gone 11 minutes since its last flare or reminder\./,
    );
  });

  it("counts a reminder's quiet time from the turn's start when the last flare came in an earlier turn", async () => {
    const working = { status: "active", runtime: { displayStatus: "active" } } as Partial<Thread>;
    const world = setup({ threads: { thr_a: working }, settings: { nudgeMinutes: 10 } });
    world.service.send({ threadId: "thr_a", projectId: null, fields: { title: "From an earlier turn" }, source: "tool" });
    world.advance(60_000);
    world.service.onActive(active("thr_a"));
    world.advance(12 * 60_000);
    await world.service.nudge();
    expect((world.calls("threads.send")[0]!.input as { text: string }[])[0]!.text).toMatch(/^\[Flare reminder\] This turn has run for 12 minutes without a flare\./);
  });
});
