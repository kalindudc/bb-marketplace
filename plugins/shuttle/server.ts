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

export function createShuttlePlugin(deps: PluginDeps = {}) {
  return async function shuttle(bb: BbPluginApi): Promise<void> {
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const now = deps.now ?? Date.now;
    const store = new Store(db, now);
    const settingsHandle = bb.settings.define(SETTINGS);
    let settings: Settings = toSettings(await settingsHandle.get());
    settingsHandle.onChange((next) => {
      settings = toSettings(next);
    });
    const port = deps.port ? deps.port(bb) : createBbPort(bb);
    const app = new Shuttle({ store, port, now, settings: () => settings, runner: deps.runner });
    let disposed = false;
    bb.onDispose(() => {
      disposed = true;
    });

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
    bb.events.on("thread.idle", ({ thread }) => safe("thread.idle", () => app.onThreadIdle(thread.id)));
    bb.events.on("thread.failed", ({ thread }) => safe("thread.failed", () => app.onThreadFailed(thread.id)));
    bb.events.on("thread.archived", ({ thread }) => safe("thread.archived", () => app.onThreadArchived(thread.id)));
    bb.events.on("thread.deleted", ({ thread }) => safe("thread.deleted", () => app.onThreadDeleted(thread.id)));

    bb.background.service("sync", {
      async start(signal) {
        while (!signal.aborted) {
          await app.tick(signal).catch((error: unknown) => bb.log.warn(`sync: ${errText(error)}`));
          await sleep(deps.tickMs ?? TICK_MS, signal);
        }
      },
    });
  };
}

export default createShuttlePlugin();
