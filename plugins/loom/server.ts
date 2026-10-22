// Loom: wiring only. Behavior lives in src/.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerBadge } from "./src/badge";
import { createBbPort, createHostPort } from "./src/bb-port";
import { createCli } from "./src/cli";
import { MIGRATIONS } from "./src/db/schema";
import { Store } from "./src/db/store";
import { Engine } from "./src/engine";
import type { BbPort, HostPort } from "./src/ports";
import { Projects } from "./src/projects";
import { SETTINGS } from "./src/record";
import { registerRpc, watchChanges } from "./src/rpc";
import { registerTools } from "./src/tools";

export interface PluginDeps {
  port?: (bb: BbPluginApi) => BbPort;
  host?: (bb: BbPluginApi) => HostPort;
  now?: () => number;
  /** How often the engine loop runs. */
  tickMs?: number;
}

const TICK_MS = 15_000;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createLoomPlugin(deps: PluginDeps = {}) {
  return async function loom(bb: BbPluginApi): Promise<void> {
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const now = deps.now ?? Date.now;
    const store = new Store(db, now);
    // Nothing in this process has started a run yet, so every open run belongs to an earlier one.
    store.endOpenRuns("Loom restarted before this step finished.");
    const port = deps.port ? deps.port(bb) : createBbPort(bb);
    const settings = bb.settings.define(SETTINGS);
    let done = await settings.get();
    settings.onChange((next) => {
      done = next;
    });
    const projects = new Projects({ store, bb: port, now });
    const engine = new Engine({ store, bb: port, now, host: deps.host ? deps.host(bb) : createHostPort(bb), projects, settings: () => done });
    let disposed = false;
    const stopWatching = watchChanges(bb, store);
    bb.onDispose(async () => {
      disposed = true;
      stopWatching();
      await engine.dispose();
    });

    registerTools(bb, projects, engine);
    registerRpc(bb, { projects, engine, store, now });
    registerBadge(bb, { projects, store, port, now });
    bb.cli.register(createCli(projects, engine, store, now));

    // A failing handler never throws into bb, and a handler that outlives a reload stays quiet.
    const safe = (name: string, fn: () => void | Promise<void>) => {
      if (disposed) return;
      const failed = (error: unknown) => {
        if (!disposed) bb.log.warn(`${name}: ${errText(error)}`);
      };
      try {
        const result = fn();
        if (result instanceof Promise) result.catch(failed);
      } catch (error) {
        failed(error);
      }
    };
    bb.events.on("thread.idle", ({ thread }) => safe("thread.idle", () => engine.onThreadIdle(thread.id)));
    bb.events.on("thread.failed", ({ thread }) => safe("thread.failed", () => engine.onThreadFailed(thread.id)));
    bb.events.on("thread.archived", ({ thread }) => safe("thread.archived", () => engine.onThreadGone(thread.id, "archived")));
    bb.events.on("thread.deleted", ({ thread }) => safe("thread.deleted", () => engine.onThreadGone(thread.id, "deleted")));
    bb.events.on("turn.failed", (event) => safe("turn.failed", () => engine.onTurnFailed(event)));

    // bb.sdk and host calls work from here on, so reconciliation waits for the service rather than running at load.
    bb.background.service("engine", {
      async start(signal) {
        try {
          const result = await engine.reconcile();
          bb.log.info(`reconciled: ${result.adopted} spawn(s) adopted, ${result.rolledBack} rolled back, ${result.rechecked} check run(s) restarted`);
        } catch (error) {
          bb.log.error(`reconcile failed: ${errText(error)}`);
        }
        while (!signal.aborted) {
          await engine.tick().catch((error) => safe("tick", () => Promise.reject(error)));
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, deps.tickMs ?? TICK_MS);
            signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
          });
        }
      },
    });
  };
}

export default createLoomPlugin();
