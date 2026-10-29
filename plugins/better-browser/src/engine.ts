import type { ExperimentalDesktopBrowsersArea, PluginRpcResult, StandardSchemaV1InferInput } from "@get-bb/plugin-sdk";
import type { BrowserInfo, HostContract } from "./contract";
import type { SyncErrorCode } from "./errors";
import type { Status, SyncSummary } from "./rpc";

type HostMethod = keyof HostContract & string;
type HostInput<M extends HostMethod> = StandardSchemaV1InferInput<HostContract[M]["input"]>;
type HostOutput<M extends HostMethod> = PluginRpcResult<HostContract[M]>;

export type HostCall = <M extends HostMethod>(method: M, input: HostInput<M>, options: { hostId: string; timeoutMs?: number }) => Promise<HostOutput<M>>;

export interface EngineSettings {
  browser: string;
  profile: string;
  sync: boolean;
}

type Desktops = Pick<ExperimentalDesktopBrowsersArea, "listInstances" | "createTab" | "acquireControl" | "openConnection" | "releaseControl" | "closeTab">;

export interface EngineDeps {
  desktops: Desktops;
  listHosts(): Promise<readonly { id: string; status: string }[]>;
  host: HostCall;
  settings(): Promise<EngineSettings>;
  publish(status: Status): void;
  log: { info(message: string): void; warn(message: string): void };
  now(): number;
  setTimer(run: () => void, ms: number): () => void;
}

type Reason = SyncSummary["reason"];
type Mode = "changes" | "full";

interface Desktop {
  hostId: string;
  instanceId: string;
  generation: string;
}

/** A Browser tab whose toolbar reported in this recently counts as in use. */
export const ACTIVE_TAB_MS = 90_000;
/** Quiet period after the real browser writes its cookies before a sync, so one burst of writes costs one sync. */
export const WATCH_DEBOUNCE_MS = 1_500;
/** The longest one sync may hold its hidden tab's control lease. */
const LEASE_MS = 120_000;
/** The bb window a helper tab belongs to. */
type HelperScope = { hostId: string; instanceId: string; generation: string; threadId: string };
const BROWSER_LIST_MS = 60_000;

/** Failures only the user can fix; automatic syncs stop retrying them (and re-prompting) until the user acts. */
const NEEDS_USER: ReadonlySet<SyncErrorCode> = new Set(["keychainDenied", "keychainMissing", "noProfile", "notInstalled", "unsupportedBrowser", "unsupportedPlatform"]);

class Failure extends Error {
  constructor(readonly code: SyncErrorCode, message: string) {
    super(message);
  }
}

/**
 * Keeps bb's Browser cookies in step with the chosen real-browser profile. The host entry on the machine running the
 * bb app reads that profile; this side finds the app's Browser, leases a hidden tab in it for each write, and decides
 * when to sync: when the real browser writes its cookie file while a bb Browser tab is in use, when a tab opens after a
 * change, and when the user or a sign-in asks.
 */
export function createEngine(deps: EngineDeps) {
  const tabs = new Map<string, { threadId: string; seenAt: number; focused: boolean }>();
  let desktop: Desktop | null = null;
  let watching: string | null = null;
  let dirty = true;
  let running: Promise<void> | null = null;
  let queued: { mode: Mode; reason: Reason; threadId?: string } | null = null;
  let cancelWatchTimer: (() => void) | null = null;
  let blocked = false;
  let browserList: { at: number; value: PluginRpcResult<HostContract["browsers"]> } | null = null;
  const state: Status = {
    supported: true, browser: null, profile: null, syncing: false, lastSync: null, error: null,
  };

  const snapshot = (): Status => ({ ...state });
  const publish = () => deps.publish(snapshot());

  /**
   * The thread whose Browser tab the user is in. Only a focused tab counts: writing cookies leases a tab, and leasing
   * one that is not on screen makes bb switch the side panel to it, which interrupts a terminal or a diff.
   */
  function activeThread(): string | undefined {
    let best: { threadId: string; seenAt: number } | undefined;
    const cutoff = deps.now() - ACTIVE_TAB_MS;
    for (const [key, tab] of tabs) {
      if (tab.seenAt < cutoff) tabs.delete(key);
      else if (tab.focused && (!best || tab.seenAt > best.seenAt)) best = tab;
    }
    return best?.threadId;
  }

  async function findDesktop(): Promise<Desktop> {
    if (desktop) return desktop;
    const hosts = await deps.listHosts();
    for (const host of hosts) {
      if (host.status !== "connected") continue;
      try {
        const { instances } = await deps.desktops.listInstances({ hostId: host.id });
        const first = instances[0];
        if (first) {
          desktop = { hostId: host.id, instanceId: first.instanceId, generation: first.generation };
          return desktop;
        }
      } catch {
        // A host without the bb app open has no Browser to list.
      }
    }
    throw new Failure("noDesktop", "Open the bb app: sessions sync into its Browser");
  }

  async function browsers(hostId: string): Promise<PluginRpcResult<HostContract["browsers"]>> {
    if (browserList && deps.now() - browserList.at < BROWSER_LIST_MS) return browserList.value;
    const value = await deps.host("browsers", {}, { hostId });
    browserList = { at: deps.now(), value };
    return value;
  }

  /**
   * The browser and profile to follow: the chosen browser, else the system default, else Chrome. A chosen browser that
   * is not installed is reported rather than silently swapped for another one.
   */
  async function choice(hostId: string): Promise<{ browser: BrowserInfo | null; browserId: string; profile?: string; sync: boolean }> {
    const settings = await deps.settings();
    const list = await browsers(hostId);
    state.supported = list.supported;
    const installed = list.browsers.filter((browser) => browser.installed);
    const pick = (id: string | null | undefined) => (id ? installed.find((browser) => browser.id === id) : undefined);
    const chosen = pick(settings.browser);
    if (settings.browser && chosen === undefined) {
      const name = list.browsers.find((browser) => browser.id === settings.browser)?.name ?? settings.browser;
      throw new Failure("notInstalled", `${name} is not installed on this computer. Choose another browser, or follow the system default, in Better Browser settings.`);
    }
    const browser = chosen ?? pick(list.defaultBrowserId) ?? pick("chrome") ?? installed.find((entry) => entry.syncable) ?? null;
    const browserId = browser?.id ?? (settings.browser || "chrome");
    state.browser = browser ? { id: browser.id, name: browser.name, syncable: browser.syncable } : null;
    const profile = settings.profile || browser?.lastUsedProfile;
    state.profile = profile ?? null;
    return { browser, browserId, ...(settings.profile ? { profile: settings.profile } : {}), sync: settings.sync };
  }

  async function ensureWatch(hostId: string, browserId: string, profile: string | undefined): Promise<void> {
    const key = `${hostId}\u0000${browserId}\u0000${profile ?? ""}`;
    if (watching === key) return;
    const result = await deps.host("watch", { browserId, ...(profile ? { profile } : {}) }, { hostId });
    if (result.ok) watching = key;
    else deps.log.warn(`watch: ${result.message}`);
  }

  async function runSync(mode: Mode, reason: Reason, threadId: string | undefined): Promise<void> {
    const found = await findDesktop();
    const chosen = await choice(found.hostId);
    if (!chosen.browser?.syncable && chosen.browser) throw new Failure("unsupportedBrowser", `${chosen.browser.name} sessions cannot sync yet`);
    const source = { browserId: chosen.browserId, ...(chosen.profile ? { profile: chosen.profile } : {}) };
    await ensureWatch(found.hostId, chosen.browserId, chosen.profile);
    if (mode === "changes") {
      const inspected = await deps.host("inspect", source, { hostId: found.hostId, timeoutMs: 60_000 });
      if (!inspected.ok) throw new Failure(inspected.code, inspected.message);
      state.profile = inspected.profile;
      if (!inspected.changed) {
        dirty = false;
        state.lastSync = {
          at: deps.now(), status: "unchanged", set: 0, removed: 0, rejected: 0, cookies: inspected.cookies, undecryptable: inspected.undecryptable,
          hosts: [], reason,
        };
        state.error = null;
        return;
      }
    }
    const owner = threadId ?? activeThread();
    if (!owner) throw new Failure("noBrowserTab", "Open a bb Browser tab: the sync runs through it");
    const { scope, tabId } = openTarget(owner, found);
    let lease;
    try {
      lease = await deps.desktops.acquireControl({ ...scope, tabIds: [tabId], controllerLabel: "Better Browser", ttlMs: LEASE_MS });
    } catch (error) {
      // The cached window or tab went stale; rediscover it instead of failing every later sync for this generation.
      desktop = null;
      throw error;
    }
    try {
      const connection = await deps.desktops.openConnection({ ...scope, leaseId: lease.leaseId });
      const applied = await deps.host("apply", { ...source, wsEndpoint: connection.wsEndpoint, mode }, { hostId: connection.hostId, timeoutMs: LEASE_MS });
      if (!applied.ok) {
        dirty = true;
        throw new Failure(applied.code, applied.message);
      }
      state.profile = applied.profile;
      state.lastSync = {
        at: deps.now(), status: "synced", set: applied.set, removed: applied.removed, rejected: applied.rejected,
        cookies: applied.cookies, undecryptable: applied.undecryptable, hosts: applied.hosts, reason,
      };
      state.error = null;
      dirty = false;
      deps.log.info(`sync (${reason}, ${mode}): set ${applied.set}, removed ${applied.removed}, rejected ${applied.rejected} of ${applied.cookies}`);
    } catch (error) {
      dirty = true;
      throw error;
    } finally {
      await deps.desktops.releaseControl({ ...scope, leaseId: lease.leaseId }).catch(() => undefined);
    }
  }

  /** The Browser tab this thread reported most recently, if it is still in use. */
  function openTabFor(owner: string): string | undefined {
    const cutoff = deps.now() - ACTIVE_TAB_MS;
    let best: { tabId: string; seenAt: number } | undefined;
    for (const [key, tab] of tabs) {
      if (tab.threadId !== owner || tab.seenAt < cutoff) continue;
      const tabId = key.slice(key.indexOf("\u0000") + 1);
      if (!best || tab.seenAt > best.seenAt) best = { tabId, seenAt: tab.seenAt };
    }
    return best?.tabId;
  }

  /** The thread's own open tab is the only write target: opening one would make bb rebuild the side panel. */
  function openTarget(owner: string, found: Desktop): { scope: HelperScope; tabId: string } {
    const tabId = openTabFor(owner);
    if (tabId === undefined) throw new Failure("noBrowserTab", "Open a bb Browser tab: the sync runs through it");
    return { scope: { hostId: found.hostId, instanceId: found.instanceId, generation: found.generation, threadId: owner }, tabId };
  }

  function record(error: unknown): void {
    const code = error instanceof Failure ? error.code : "writeFailed";
    const message = error instanceof Error ? error.message : String(error);
    state.error = { code, message, at: deps.now() };
    if (NEEDS_USER.has(code)) blocked = true;
    deps.log.warn(`sync failed (${code}): ${message}`);
  }

  const automatic = (reason: Reason) => reason === "tab" || reason === "watch" || reason === "settings";

  /** Run one sync at a time; a request made while one runs is folded into a single follow-up. */
  function sync(mode: Mode, reason: Reason, threadId?: string): Promise<void> {
    if (automatic(reason) && (blocked || openTabFor(threadId ?? activeThread() ?? "") === undefined)) return Promise.resolve();
    if (!automatic(reason)) blocked = false;
    if (running) {
      queued = { mode: queued?.mode === "full" || mode === "full" ? "full" : "changes", reason, ...(threadId ? { threadId } : queued?.threadId ? { threadId: queued.threadId } : {}) };
      return running;
    }
    state.syncing = true;
    publish();
    running = (async () => {
      let next: { mode: Mode; reason: Reason; threadId?: string } | null = { mode, reason, ...(threadId ? { threadId } : {}) };
      while (next) {
        const current: { mode: Mode; reason: Reason; threadId?: string } = next;
        queued = null;
        try {
          await runSync(current.mode, current.reason, current.threadId);
        } catch (error) {
          record(error);
        }
        next = queued;
      }
    })().finally(() => {
      running = null;
      state.syncing = false;
      publish();
    });
    return running;
  }

  return {
    status: snapshot,

    async refreshStatus(): Promise<Status> {
      try {
        const found = await findDesktop();
        await choice(found.hostId);
      } catch (error) {
        if (!state.error) record(error);
      }
      return snapshot();
    },

    async browsers() {
      const found = await findDesktop();
      browserList = null;
      const list = await browsers(found.hostId);
      const settings = await deps.settings();
      return { ...list, chosen: { browser: settings.browser, profile: settings.profile } };
    },

    /** A toolbar says its tab is showing. A change the real browser made while no tab was open syncs now. */
    async heartbeat(threadId: string, tabId: string, focused = true): Promise<Status> {
      tabs.set(`${threadId}\u0000${tabId}`, { threadId, seenAt: deps.now(), focused });
      const settings = await deps.settings();
      if (settings.sync && focused && dirty && !running) void sync("changes", "tab", threadId);
      else if (!running) await this.refreshStatus();
      return snapshot();
    },

    async syncNow(mode: Mode, reason: Reason, threadId?: string): Promise<Status> {
      await sync(mode, reason, threadId);
      return snapshot();
    },

    /** The real browser wrote its cookie file. */
    sourceChanged(): void {
      dirty = true;
      cancelWatchTimer?.();
      cancelWatchTimer = deps.setTimer(() => {
        cancelWatchTimer = null;
        void deps.settings().then((settings) => {
          if (settings.sync && activeThread()) void sync("changes", "watch");
        });
      }, WATCH_DEBOUNCE_MS);
    },

    /** The host worker restarted, so its file watch is gone. */
    workerExited(): void {
      watching = null;
      dirty = true;
    },

    settingsChanged(): void {
      watching = null;
      browserList = null;
      dirty = true;
      blocked = false;
      state.error = null;
      void deps.settings().then((settings) => {
        if (settings.sync && activeThread()) void sync("changes", "settings");
      });
    },

    async openExternal(url: string): Promise<{ ok: true; browser: string } | { ok: false; message: string }> {
      try {
        const found = await findDesktop();
        const chosen = await choice(found.hostId);
        const profile = chosen.profile ?? chosen.browser?.lastUsedProfile;
        const opened = await deps.host("openUrl", { url, browserId: chosen.browserId, ...(profile ? { profile } : {}) }, { hostId: found.hostId });
        return opened.ok ? { ok: true, browser: chosen.browser?.name ?? chosen.browserId } : { ok: false, message: opened.message };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },

    dispose(): void {
      cancelWatchTimer?.();
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
