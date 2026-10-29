// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ACTIVE_TAB_MS, WATCH_DEBOUNCE_MS, createEngine, type EngineDeps, type EngineSettings } from "../src/engine";

const browsers = {
  supported: true,
  defaultBrowserId: "chrome",
  browsers: [
    { id: "chrome", name: "Google Chrome", engine: "chromium" as const, installed: true, syncable: true, profiles: [{ directory: "Default", name: "Me" }], lastUsedProfile: "Default" },
    { id: "safari", name: "Safari", engine: "safari" as const, installed: true, syncable: false, profiles: [] },
  ],
};

function setup(options: { changed?: boolean; settings?: Partial<EngineSettings>; apply?: unknown } = {}) {
  const calls: string[] = [];
  let now = 1_000_000;
  const timers: { at: number; run: () => void }[] = [];
  const settings: EngineSettings = { browser: "", profile: "", sync: true, ...options.settings };
  const scope = { hostId: "host_1", instanceId: "inst", generation: "gen" };
  const deps: EngineDeps = {
    desktops: {
      listInstances: vi.fn(async () => ({ instances: [{ ...scope, label: "BB window" }] })),
      createTab: vi.fn(async (input) => {
        calls.push(`createTab ${input.threadId} ${input.presentation}`);
        return { tab: { tabId: "tab_hidden", threadId: input.threadId, url: "about:blank", title: "", presentation: "hidden" as const, control: null } };
      }),
      acquireControl: vi.fn(async (input) => {
        calls.push(`acquire ${input.tabIds.join(",")}`);
        return { ...scope, threadId: input.threadId, leaseId: "lease_1", tabIds: input.tabIds, controllerLabel: input.controllerLabel, expiresAt: now + 60_000 };
      }),
      openConnection: vi.fn(async () => {
        calls.push("connect");
        return { hostId: "host_1", wsEndpoint: "ws://127.0.0.1:1/x", expiresAt: now + 60_000 };
      }),
      releaseControl: vi.fn(async () => {
        calls.push("release");
        return { ok: true as const };
      }),
      closeTab: vi.fn(async () => {
        calls.push("close");
        return { ok: true as const };
      }),
    },
    listHosts: async () => [{ id: "host_off", status: "disconnected" }, { id: "host_1", status: "connected" }],
    host: vi.fn(async (method: string, input: unknown) => {
      calls.push(`host.${method}${method === "apply" ? ` ${(input as { mode: string }).mode}` : ""}`);
      if (method === "browsers") return browsers;
      if (method === "watch") return { ok: true, profile: "Default" };
      if (method === "openUrl") return { ok: true };
      if (method === "inspect") return { ok: true, changed: options.changed ?? true, profile: "Default", cookies: 10, undecryptable: 0, partitioned: 1 };
      if (method === "apply") return options.apply ?? { ok: true, set: 3, removed: 1, rejected: 0, hosts: ["example.com"], profile: "Default", cookies: 10, undecryptable: 0, partitioned: 1 };
      throw new Error(`unexpected ${method}`);
    }) as unknown as EngineDeps["host"],
    settings: async () => settings,
    publish: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  };
  const engine = createEngine(deps);
  return {
    engine, deps, calls,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((entry) => entry.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the sync engine", () => {
  it("writes through a hidden helper tab and closes it when the thread has no open tab", async () => {
    const { engine, calls } = setup();
    const status = await engine.syncNow("changes", "manual", "thr_1");
    expect(calls.filter((call) => !call.startsWith("host.browsers"))).toEqual([
      "host.watch", "host.inspect", "createTab thr_1 hidden", "acquire tab_hidden", "connect", "host.apply changes", "release", "close",
    ]);
    expect(status).toMatchObject({ browser: { id: "chrome" }, profile: "Default", error: null, lastSync: { status: "synced", set: 3, removed: 1, hosts: ["example.com"], reason: "manual" } });
  });

  it("leases nothing when the real browser has not changed", async () => {
    const { engine, calls } = setup({ changed: false });
    const status = await engine.syncNow("changes", "manual", "thr_1");
    expect(calls).not.toContain("createTab thr_1 hidden");
    expect(status.lastSync).toMatchObject({ status: "unchanged" });
  });

  it("skips the check on a full sync", async () => {
    const { engine, calls } = setup({ changed: false });
    await engine.syncNow("full", "sign-in", "thr_1");
    expect(calls).not.toContain("host.inspect");
    expect(calls).toContain("host.apply full");
  });

  it("releases the tab and reports the host's reason when the write fails", async () => {
    const { engine, calls } = setup({ apply: { ok: false, code: "keychainDenied", message: "Keychain access was refused" } });
    const status = await engine.syncNow("full", "manual", "thr_1");
    expect(calls.slice(-2)).toEqual(["release", "close"]);
    expect(status.error).toMatchObject({ code: "keychainDenied", message: "Keychain access was refused" });
  });

  it("writes through the thread's open Browser tab without creating or closing any tab", async () => {
    const { engine, deps, calls } = setup();
    await engine.heartbeat("thr_1", "tab_open");
    await settle();
    calls.length = 0;
    await engine.syncNow("changes", "watch", "thr_1");
    expect(deps.desktops.createTab).not.toHaveBeenCalled();
    expect(deps.desktops.acquireControl).toHaveBeenLastCalledWith(expect.objectContaining({ tabIds: ["tab_open"] }));
    expect(calls).not.toContain("close");
  });

  it("opens and closes a hidden helper tab only when the thread has no open tab", async () => {
    const { engine, deps, calls } = setup();
    await engine.syncNow("full", "manual", "thr_1");
    expect(deps.desktops.createTab).toHaveBeenCalledTimes(1);
    expect(deps.desktops.closeTab).toHaveBeenCalledTimes(1);
    expect(calls).toContain("close");
  });

  it("falls back to a helper tab when the open tab has closed since its heartbeat", async () => {
    const { engine, deps } = setup();
    await engine.heartbeat("thr_1", "tab_gone");
    await settle();
    vi.mocked(deps.desktops.acquireControl).mockRejectedValueOnce(new Error("Tab is outside this lease"));
    await engine.syncNow("full", "manual", "thr_1");
    expect(deps.desktops.createTab).toHaveBeenCalledTimes(1);
    expect(deps.desktops.closeTab).toHaveBeenCalledTimes(1);
  });

  it("finds the bb window again when the one it knew has gone", async () => {
    const { engine, deps } = setup();
    vi.mocked(deps.desktops.createTab).mockRejectedValueOnce(new Error("Desktop instance is unavailable or has reconnected"));
    const status = await engine.syncNow("full", "manual", "thr_1");
    expect(status.error).toBeNull();
    expect(deps.desktops.createTab).toHaveBeenCalledTimes(2);
    expect(deps.desktops.listInstances).toHaveBeenCalledTimes(2);
  });

  it("stops syncing on its own after a refused Keychain prompt until the user asks again", async () => {
    const { engine, deps, calls, advance } = setup({ apply: { ok: false, code: "keychainDenied", message: "refused" } });
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    await settle();
    const applies = () => calls.filter((call) => call.startsWith("host.apply")).length;
    expect(applies()).toBe(1);
    engine.sourceChanged();
    advance(WATCH_DEBOUNCE_MS);
    await settle();
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    expect(applies()).toBe(1);
    vi.mocked(deps.host).mockClear();
    await engine.syncNow("full", "manual", "thr_1");
    expect(applies()).toBe(2);
  });

  it("needs a Browser tab to run through", async () => {
    const { engine } = setup();
    const status = await engine.syncNow("full", "manual");
    expect(status.error?.code).toBe("noBrowserTab");
  });

  it("leaves a background sync alone while the user is not on the Browser tab", async () => {
    const { engine, calls, advance } = setup();
    await engine.heartbeat("thr_1", "tab_1", false);
    await settle();
    calls.length = 0;
    engine.sourceChanged();
    advance(WATCH_DEBOUNCE_MS);
    await settle();
    expect(calls.filter((call) => call.startsWith("host.apply"))).toHaveLength(0);
    await engine.heartbeat("thr_1", "tab_1", true);
    await settle();
    await settle();
    expect(calls.filter((call) => call.startsWith("host.apply"))).toHaveLength(1);
  });

  it("syncs a change the real browser saved only while a bb Browser tab is in use", async () => {
    const idle = setup();
    idle.engine.sourceChanged();
    idle.advance(WATCH_DEBOUNCE_MS);
    await settle();
    expect(idle.calls).not.toContain("host.inspect");

    const busy = setup({ changed: false });
    await busy.engine.heartbeat("thr_2", "tab_1");
    await settle();
    busy.calls.length = 0;
    busy.engine.sourceChanged();
    busy.engine.sourceChanged();
    busy.advance(WATCH_DEBOUNCE_MS);
    await settle();
    await settle();
    expect(busy.calls.filter((call) => call === "host.inspect")).toHaveLength(1);

    busy.advance(ACTIVE_TAB_MS + 1);
    busy.calls.length = 0;
    busy.engine.sourceChanged();
    busy.advance(WATCH_DEBOUNCE_MS);
    await settle();
    expect(busy.calls).not.toContain("host.inspect");
  });

  it("folds requests made during a sync into one follow-up", async () => {
    const { engine, calls } = setup();
    const first = engine.syncNow("changes", "manual", "thr_1");
    const second = engine.syncNow("changes", "manual", "thr_1");
    const third = engine.syncNow("full", "manual", "thr_1");
    await Promise.all([first, second, third]);
    expect(calls.filter((call) => call.startsWith("host.apply"))).toEqual(["host.apply changes", "host.apply full"]);
  });

  it("opens links in the default browser's last profile unless the settings name another browser", async () => {
    const defaults = setup();
    expect(await defaults.engine.openExternal("https://example.com/")).toEqual({ ok: true, browser: "Google Chrome" });
    expect(defaults.deps.host).toHaveBeenCalledWith("openUrl", { url: "https://example.com/", browserId: "chrome", profile: "Default" }, { hostId: "host_1" });

    const safari = setup({ settings: { browser: "safari" } });
    expect(await safari.engine.openExternal("https://example.com/")).toEqual({ ok: true, browser: "Safari" });
    expect(safari.deps.host).toHaveBeenCalledWith("openUrl", { url: "https://example.com/", browserId: "safari" }, { hostId: "host_1" });
    expect((await safari.engine.syncNow("full", "manual", "thr_1")).error?.code).toBe("unsupportedBrowser");
  });
});
