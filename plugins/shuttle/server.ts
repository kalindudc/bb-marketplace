// Shuttle: wiring only. Behavior lives in src/.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sleep, type Runner } from "./src/adapters/exec";
import { createBbPort } from "./src/bb-port";
import { createCli } from "./src/cli";
import { errText } from "./src/ctx";
import { MIGRATIONS } from "./src/db/schema";
import { Store } from "./src/db/store";
import type { BbPort } from "./src/ports";
import { registerRpc } from "./src/rpc";
import { SETTINGS, toSettings, type Settings } from "./src/settings";
import { Shuttle } from "./src/shuttle";
import { registerTools } from "./src/tools";

export interface PluginDeps {
  port?: (bb: BbPluginApi) => BbPort;
  runner?: Runner;
  now?: () => number;
  tickMs?: number;
}

const TICK_MS = 30_000;

/** Settles when `work` settles or `signal` aborts, whichever is first, and leaves no listener on the signal. */
function untilAborted(signal: AbortSignal, work: Promise<unknown>): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    work.then(done, done);
  });
}

export function createShuttlePlugin(deps: PluginDeps = {}) {
  return async function shuttle(bb: BbPluginApi): Promise<void> {
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const now = deps.now ?? Date.now;
    const store = new Store(db, now);
    const settingsHandle = bb.settings.define(SETTINGS);
    let settings: Settings = toSettings(await settingsHandle.get());
    const setSettings = async (patch: { autoAgent?: boolean; inboxRequests?: boolean }) => {
      settings = toSettings(await settingsHandle.experimental_set(patch));
    };
    const port = deps.port ? deps.port(bb) : createBbPort(bb, setSettings);
    const lifetime = new AbortController();
    const app = new Shuttle({ store, port, now, settings: () => settings, runner: deps.runner, lifetime: lifetime.signal });
    port.beforePublish?.(() => {
      if (!disposed) app.warmIndexes();
    });
    let disposed = false;
    let ticking: Promise<void> | null = null;
    bb.onDispose(async () => {
      disposed = true;
      lifetime.abort();
      await ticking;
    });
    settingsHandle.onChange((next, prev) => {
      settings = toSettings(next);
      // Turning auto agent on gives the PRs without one their agents now, not at the next sync.
      if (settings.autoAgent && prev.autoAgent !== true && !disposed) app.autoAgent().catch((error: unknown) => bb.log.warn(`auto agent: ${errText(error)}`));
      port.publish();
    });

    app.resumePosts();
    app.resumeMerges();
    registerRpc(bb, app);
    registerTools(bb, app);
    bb.cli.register(createCli(app));

    const safe = (name: string, fn: () => unknown) => {
      if (disposed) return;
      try {
        const result = fn();
        if (result instanceof Promise) result.catch((error: unknown) => !disposed && bb.log.warn(`${name}: ${errText(error)}`));
      } catch (error) {
        bb.log.warn(`${name}: ${errText(error)}`);
      }
    };
    bb.events.on("thread.idle", ({ thread, lastAssistantText }) => safe("thread.idle", () => app.onThreadIdle(thread.id, thread.parentThreadId, lastAssistantText)));
    bb.events.on("thread.active", ({ thread }) => safe("thread.active", () => app.onThreadActive(thread.id, thread.parentThreadId)));
    bb.events.on("interaction.pending", ({ thread }) => safe("interaction.pending", () => app.onInteractionPending(thread.id)));
    bb.events.on("thread.failed", ({ thread, error }) => safe("thread.failed", () => app.onThreadFailed(thread.id, { error, environmentId: thread.environmentId })));
    bb.events.on("thread.archived", ({ thread }) => safe("thread.archived", () => app.onThreadArchived(thread.id)));
    bb.events.on("thread.deleted", ({ thread }) => safe("thread.deleted", () => app.onThreadDeleted(thread.id)));

    // bb gives a stopping service 5 s and then loads no new version until a manual reload, so start returns as soon as bb
    // aborts it, even while a tick waits on bb; dispose, which bb runs next, waits for that tick.
    bb.background.service("sync", {
      async start(signal) {
        while (!signal.aborted) {
          const tick = app.tick(signal).catch((error: unknown) => bb.log.warn(`sync: ${errText(error)}`));
          ticking = tick;
          void tick.finally(() => {
            if (ticking === tick) ticking = null;
          });
          await untilAborted(signal, tick);
          await sleep(deps.tickMs ?? TICK_MS, signal);
        }
      },
    });
  };
}

export default createShuttlePlugin();
