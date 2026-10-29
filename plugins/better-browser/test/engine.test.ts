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
  it("writes through the thread's tab and releases it", async () => {
    const { engine, calls } = setup();
    await engine.heartbeat("thr_1", "tab_open");
    await settle();
    calls.length = 0;
    const status = await engine.syncNow("changes", "manual", "thr_1");
    expect(calls.filter((call) => !call.startsWith("host.browsers"))).toEqual([
      "host.inspect", "acquire tab_open", "connect", "host.apply changes", "release",
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
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    await settle();
    calls.length = 0;
    await engine.syncNow("full", "sign-in", "thr_1");
    expect(calls).not.toContain("host.inspect");
    expect(calls).toContain("host.apply full");
  });

  it("releases the tab and reports the host's reason when the write fails", async () => {
    const { engine, calls } = setup({ apply: { ok: false, code: "keychainDenied", message: "Keychain access was refused" } });
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    calls.length = 0;
    const status = await engine.syncNow("full", "manual", "thr_1");
    expect(calls.slice(-1)).toEqual(["release"]);
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

  it("never opens a tab of its own, even with no Browser tab open", async () => {
    const { engine, deps } = setup();
    const status = await engine.syncNow("full", "manual", "thr_1");
    expect(status.error?.code).toBe("noBrowserTab");
    expect(deps.desktops.createTab).not.toHaveBeenCalled();
    expect(deps.desktops.closeTab).not.toHaveBeenCalled();
  });

  it("skips a background sync quietly when the tab closed since its heartbeat", async () => {
    const { engine, deps, calls } = setup();
    await engine.heartbeat("thr_1", "tab_gone");
    await settle();
    calls.length = 0;
    vi.mocked(deps.desktops.acquireControl).mockRejectedValueOnce(new Error("Tab is outside this lease"));
    await engine.syncNow("changes", "watch", "thr_1");
    expect(deps.desktops.createTab).not.toHaveBeenCalled();
    expect(deps.desktops.closeTab).not.toHaveBeenCalled();
  });

  it("watches the last-used profile again when it changes", async () => {
    const { engine, deps, advance } = setup();
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    await settle();
    advance(61_000);
    const watches = () => vi.mocked(deps.host).mock.calls.filter(([method]) => method === "watch");
    expect(watches()).toHaveLength(1);
    vi.mocked(deps.host).mockImplementation(async (method: string) => {
      if (method === "browsers") return { ...browsers, browsers: browsers.browsers.map((browser) => browser.id === "chrome" ? { ...browser, lastUsedProfile: "Profile 1", profiles: [...browser.profiles, { directory: "Profile 1", name: "Work" }] } : browser) };
      if (method === "watch") return { ok: true, profile: "Profile 1" };
      if (method === "inspect") return { ok: true, changed: true, profile: "Profile 1", cookies: 10, undecryptable: 0, partitioned: 0 };
      if (method === "apply") return { ok: true, set: 1, removed: 0, rejected: 0, hosts: ["example.com"], profile: "Profile 1", cookies: 10, undecryptable: 0, partitioned: 0 };
      return { ok: true };
    });
    await engine.syncNow("full", "settings", "thr_1");
    expect(watches().at(-1)?.[1]).toMatchObject({ browserId: "chrome", profile: "Profile 1" });
    expect(watches()).toHaveLength(2);
  });

  it("does not create a tab when the bb window it knew has gone", async () => {
    const { engine, deps } = setup();
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    vi.mocked(deps.desktops.acquireControl).mockRejectedValueOnce(new Error("Desktop instance is unavailable or has reconnected"));
    const status = await engine.syncNow("full", "manual", "thr_1");
    expect(status.error?.code).toBe("writeFailed");
    expect(deps.desktops.createTab).not.toHaveBeenCalled();
  });

  it("retries the same change on the next focused heartbeat after a failed write", async () => {
    const { engine, deps, calls } = setup({ apply: { ok: false, code: "readFailed", message: "could not read" } });
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    await settle();
    const applies = () => calls.filter((call) => call.startsWith("host.apply")).length;
    expect(applies()).toBe(1);
    vi.mocked(deps.host).mockClear();
    vi.mocked(deps.desktops.acquireControl).mockClear();
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    await settle();
    expect(vi.mocked(deps.desktops.acquireControl)).toHaveBeenCalled();
    expect(vi.mocked(deps.host).mock.calls.filter(([method]) => method === "apply")).toHaveLength(1);
  });

  it("forgets the cached window when acquiring its tab fails, so the next sync rediscovers it", async () => {
    const { engine, deps } = setup();
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    vi.mocked(deps.desktops.acquireControl).mockRejectedValueOnce(new Error("Desktop instance is unavailable"));
    await engine.syncNow("full", "manual", "thr_1");
    const before = vi.mocked(deps.desktops.listInstances).mock.calls.length;
    await engine.syncNow("full", "manual", "thr_1");
    expect(vi.mocked(deps.desktops.listInstances).mock.calls.length).toBeGreaterThan(before);
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
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    await settle();
    calls.length = 0;
    const first = engine.syncNow("changes", "manual", "thr_1");
    const second = engine.syncNow("changes", "manual", "thr_1");
    const third = engine.syncNow("full", "manual", "thr_1");
    await Promise.all([first, second, third]);
    expect(calls.filter((call) => call.startsWith("host.apply"))).toEqual(["host.apply changes", "host.apply full"]);
  });

  it("reports a chosen browser that is not installed instead of using another one", async () => {
    const { engine, deps } = setup({ settings: { browser: "arc" } });
    await engine.heartbeat("thr_1", "tab_1");
    await settle();
    const status = await engine.syncNow("full", "manual", "thr_1");
    expect(status.error).toMatchObject({ code: "notInstalled" });
    expect(status.error?.message).toMatch(/arc is not installed/i);
    expect(deps.host).not.toHaveBeenCalledWith("apply", expect.anything(), expect.anything());
    expect(await engine.openExternal("https://example.com/")).toEqual({
      ok: false,
      message: expect.stringMatching(/arc is not installed/i),
    });
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
