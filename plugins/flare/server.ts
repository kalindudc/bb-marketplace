import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerCli } from "./src/cli";
import { rpcContract } from "./src/contract";
import { FlareService, startsTurnWithOnlyFlareNotes } from "./src/service";
import { SETTING_DESCRIPTORS, readSettings } from "./src/settings";
import { FlareStore, MIGRATIONS } from "./src/store";
import { registerTools } from "./src/tools";

export const NUDGE_INTERVAL_MS = 30_000;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export default function flare(bb: BbPluginApi): void {
  const settings = bb.settings.define(SETTING_DESCRIPTORS);
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  // Only this plugin writes its database, so a long wait means something is wrong; a flare must never sit behind it.
  db.pragma("busy_timeout = 500");
  const flares = new FlareService(bb, new FlareStore(db), async () => readSettings(await settings.get()));

  bb.rpc.register(rpcContract, {
    banner: ({ threadId }) => flares.banner(threadId),
    feed: ({ threadId, children }) => flares.feed(threadId, children),
    dismiss: ({ threadId, through }) => {
      flares.dismiss(threadId, through);
      return { ok: true as const };
    },
  });
  registerTools(bb, flares);
  registerCli(bb, flares);

  bb.events.on("thread.active", ({ thread }) => flares.onActive(thread));
  bb.events.on("thread.idle", ({ thread }) => flares.onIdle(thread));
  bb.events.on("thread.failed", ({ thread, error }) => flares.onFailed(thread, error));
  bb.events.on("thread.deleted", ({ thread }) => flares.onDeleted(thread));

  // Reminders and a child's flares reach an agent as a steer, and a steer that finds no running turn would start
  // one, for example after it waited in the queue behind a question. Flare's notes alone never start a turn.
  bb.experimental_hooks.on("message.dispatch", (ctx) => {
    try {
      if (startsTurnWithOnlyFlareNotes(ctx, bb.pluginId)) {
        return { action: "reject", message: "Flare dropped a background note for the agent because this thread's turn had already ended." };
      }
    } catch (error) {
      bb.log.warn(`The dispatch check failed, so the message went ahead: ${String(error)}`);
    }
    return { action: "proceed" };
  });

  bb.background.service("turns", {
    async start(signal) {
      await flares.reconcile().catch((error: unknown) => bb.log.warn(`Could not match runs to running threads: ${String(error)}`));
      while (!signal.aborted) {
        await pause(NUDGE_INTERVAL_MS, signal);
        if (signal.aborted) break;
        await flares.nudge().catch((error: unknown) => bb.log.warn(`Reminders failed: ${String(error)}`));
      }
    },
  });

  bb.background.schedule("prune", "17 3 * * *", async () => {
    const removed = flares.prune((await settings.get()).keepDays);
    if (removed > 0) bb.log.info(`Deleted ${removed} old flares`);
  });

  bb.onDispose(() => flares.settled());
}
