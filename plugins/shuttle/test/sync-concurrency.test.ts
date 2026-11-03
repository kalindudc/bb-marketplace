// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { holdOf, harness, pr, testConfig, type Harness } from "./helpers";

const forge = testConfig().servers[0]!;
const two = (patch: Parameters<typeof testConfig>[0] = {}) =>
  testConfig({ servers: [forge, { ...forge, id: "other", name: "Other", pattern: "^https://other\\.test/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://other.test/{repo}/pull/{number}" }], ...patch });

const whoamis = (h: Harness, server: string) => h.runner.calls.filter((c) => c.operation === "whoami" && c.env.SHUTTLE_SERVER === server).length;
const state = (h: Harness, server: string) => h.store.server(server)?.state ?? null;
const settled = (promise: Promise<unknown>) => {
  const box = { done: false };
  void promise.then(() => (box.done = true), () => (box.done = true));
  return box;
};

describe("servers sync at the same time", () => {
  it("syncs a server while another is still slow to answer", async () => {
    const h = harness(two());
    const slow = h.hold("whoami", { server: "forge" });
    const full = h.shuttle.sync();
    await slow.reached;
    await vi.waitFor(() => expect(state(h, "other")).toBe("ok"));
    expect(state(h, "forge")).toBeNull();
    expect(h.shuttle.overview().syncing).toBe(true);
    expect(h.store.kv("full_sync_at")).toBeNull();
    slow.release();
    await full;
    expect([state(h, "forge"), state(h, "other")]).toEqual(["ok", "ok"]);
    expect(h.store.kv("full_sync_at")).toBe(String(h.clock.now));
    expect(h.shuttle.overview().syncing).toBe(false);
  });

  it("answers a sync of one server with its run under way, and starts one at once when none is", async () => {
    const h = harness(two());
    const slow = h.hold("whoami", { server: "forge" });
    const other = h.hold("whoami", { server: "other" });
    const full = settled(h.shuttle.sync());
    await Promise.all([slow.reached, other.reached]);
    const joined = h.shuttle.sync(undefined, ["other"]);
    other.release();
    await joined;
    expect(whoamis(h, "other")).toBe(1);
    expect(state(h, "other")).toBe("ok");
    // The full sync still waits on forge; a new request for other does not.
    await h.shuttle.sync(undefined, ["other"]);
    expect(whoamis(h, "other")).toBe(2);
    expect(full.done).toBe(false);
    slow.release();
    await vi.waitFor(() => expect(full.done).toBe(true));
    expect(state(h, "forge")).toBe("ok");
  });

  it("joins a server's run that a sync of that server started, and starts the others", async () => {
    const h = harness(two());
    const other = h.hold("whoami", { server: "other" });
    const one = h.shuttle.sync(undefined, ["other"]);
    await other.reached;
    const full = h.shuttle.sync();
    await vi.waitFor(() => expect(state(h, "forge")).toBe("ok"));
    other.release();
    await Promise.all([one, full]);
    expect(whoamis(h, "other")).toBe(1);
    expect(whoamis(h, "forge")).toBe(1);
    expect(h.store.kv("full_sync_at")).toBe(String(h.clock.now));
  });

  it("records a full sync only when every server of it finished", async () => {
    const h = harness(two());
    const stop = new AbortController();
    const other = h.hold("whoami", { server: "other" });
    const one = h.shuttle.sync(stop.signal, ["other"]);
    await other.reached;
    const full = h.shuttle.sync();
    await vi.waitFor(() => expect(state(h, "forge")).toBe("ok"));
    stop.abort();
    other.release();
    await Promise.all([one, full]);
    expect(state(h, "other")).toBeNull();
    expect(h.store.kv("full_sync_at")).toBeNull();
  });

  it("stays within the daily limit of auto reviews when servers sync together", async () => {
    const h = harness(two({ autoReview: { enabled: true, when: ["requested"], drafts: false, preset: "", repos: [], maxPerDay: 1, rerun: "never" } }));
    await h.shuttle.sync();
    h.clock.now += 60_000;
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    expect(h.port.spawned).toHaveLength(1);
  });
});

describe("the steps after the servers", () => {
  it("do not hold up a new sync of a server, and never run twice at the same time", async () => {
    const h = harness(two());
    const read = h.port.threadsById.bind(h.port);
    const first = holdOf("threadsById");
    let running = 0;
    let most = 0;
    let titles = 0;
    h.port.threadsById = async (ids) => {
      titles++;
      running++;
      most = Math.max(most, running);
      if (titles === 1) {
        first.reach();
        await first.released;
      }
      running--;
      return read(ids);
    };
    const full = h.shuttle.sync();
    await first.reached;
    const again = h.shuttle.sync(undefined, ["forge"]);
    await vi.waitFor(() => expect(whoamis(h, "forge")).toBe(2));
    expect(titles).toBe(1);
    first.release();
    await Promise.all([full, again]);
    expect(titles).toBe(2);
    expect(most).toBe(1);
  });
});

describe("the loop's tick", () => {
  const due = (h: Harness) => (h.clock.now += h.settings.syncMinutes * 60_000);
  const views = (h: Harness, server: string) => h.runner.calls.filter((c) => c.operation === "view" && c.env.SHUTTLE_SERVER === server).length;

  it("starts a due full sync without waiting for it, and keeps the fast lane and delivery going while it runs", async () => {
    const h = harness(two());
    h.lists.authored = [pr(1, { author: "me", auto_merge: true })];
    h.views[1] = pr(1, { author: "me", auto_merge: true });
    await h.shuttle.sync();
    const fullSync = h.store.kv("full_sync_at");
    const deliver = vi.spyOn(h.shuttle, "deliver");
    due(h);
    const slow = h.hold("whoami", { server: "forge" });
    const first = settled(h.shuttle.tick());
    await slow.reached;
    await vi.waitFor(() => expect(first.done).toBe(true));
    await vi.waitFor(() => expect(h.shuttle.syncingServer("other")).toBe(false));
    expect(whoamis(h, "other")).toBe(2);

    // A tick while forge still syncs: the fast lane reads the server that finished, and no sync starts again.
    h.clock.now += 30_000;
    const second = settled(h.shuttle.tick());
    await vi.waitFor(() => expect(second.done).toBe(true));
    await h.shuttle.fastLaneSettled();
    expect(views(h, "other")).toBe(1);
    expect(views(h, "forge")).toBe(0);
    due(h);
    await h.shuttle.tick();
    await h.shuttle.fastLaneSettled();
    expect([whoamis(h, "forge"), whoamis(h, "other")]).toEqual([2, 2]);
    expect(views(h, "other")).toBe(2);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(h.store.kv("full_sync_at")).toBe(fullSync);

    slow.release();
    await h.shuttle.syncsSettled();
    expect(h.store.kv("full_sync_at")).toBe(String(h.clock.now));
    expect(state(h, "forge")).toBe("ok");
  });

  it("rechecks a server that failed while another is still slow to answer, and only that server", async () => {
    const h = harness(two());
    await h.shuttle.sync();
    due(h);
    const slow = h.hold("whoami", { server: "forge" });
    h.answers.whoami = new Error("HTTP 503: service unavailable");
    await h.shuttle.tick();
    await slow.reached;
    await vi.waitFor(() => expect(state(h, "other")).toBe("failed"));
    h.answers.whoami = { login: "me" };
    h.clock.now += 60_000;
    await h.shuttle.tick();
    await vi.waitFor(() => expect(state(h, "other")).toBe("ok"));
    expect(whoamis(h, "forge")).toBe(2);
    slow.release();
    await h.shuttle.syncsSettled();
  });

  it("stops cleanly when the loop stops during a sync it started", async () => {
    const h = harness(two());
    await h.shuttle.sync();
    const fullSync = h.store.kv("full_sync_at");
    due(h);
    const slow = h.hold("whoami", { server: "forge" });
    const loop = new AbortController();
    await h.shuttle.tick(loop.signal);
    await slow.reached;
    loop.abort();
    await h.shuttle.syncsSettled();
    slow.release();
    await vi.waitFor(() => expect(h.shuttle.syncingServer("forge")).toBe(false));
    expect(h.store.kv("full_sync_at")).toBe(fullSync);
    expect(h.shuttle.overview().syncing).toBe(false);
  });
});
