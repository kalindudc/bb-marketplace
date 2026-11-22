import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { homedir } from "node:os";
import { z } from "zod";
import { MIGRATIONS, PressStore } from "./src/store";
import { PressService } from "./src/service";
import { rpcContract } from "./src/contract";
import { registerCli } from "./src/cli";
import { normalizeSettings, pressSettings } from "./src/settings";
import { composerPaths, ensureComposerInstalled } from "./src/installer";

/**
 * Press, the compaction governor. It decides when a thread should compact, from a policy of
 * compaction points (phase, agent hint, volume, turns, idle, thrash) and vetoes (mid-turn,
 * cooldown, minimum turns, floor, previous failure); it records every decision in its database and
 * the workspace ledger; and it asks the provider to compact (pi: `/compact` with instructions,
 * others: the explicit request). It never writes summaries — the Press composer extension does
 * that, reading the same ledger.
 *
 * The settings page owns everything the UI can express; the resolved composer config is published
 * into the workspace ledger so the composer (a pi extension) sees it, and the composer itself is
 * kept installed at `~/.pi/agent/extensions/press-composer/` from this plugin's own `composer/`
 * directory.
 */
export default async function press(bb: BbPluginApi): Promise<void> {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  // Only this plugin writes its database, so a long wait means something is wrong.
  db.pragma("busy_timeout = 500");

  const store = new PressStore(db);
  const settingsHandle = bb.settings.define(pressSettings);
  const readSettings = async (): Promise<Record<string, unknown>> => settingsHandle.get();
  const service = new PressService(bb, store, Date.now, readSettings);

  registerCli(bb, store, service);

  bb.rpc.register(rpcContract, {
    status: ({ threadId }) => service.buildThreadStatus(threadId),
    summary: ({ threadId, at }) => service.summary(threadId, at),
    compactNow: ({ threadId }) => service.compactNow(threadId),
    setThreadMode: ({ threadId, mode }) => service.setThreadMode(threadId, mode),
    setThreadPoint: ({ threadId, point, enabled }) => service.setThreadPoint(threadId, point, enabled),
  });

  service.register();

  const installComposer = async (): Promise<void> => {
    const paths = composerPaths(import.meta.url, homedir());
    await ensureComposerInstalled({ ...paths, log: bb.log });
  };

  // The UI settings are part of the policy resolution: when they change, republish the composer
  // config into the ledgers the service knows about, and refresh the installed composer.
  settingsHandle.onChange((next) => {
    bb.rpc.experimental_invalidateAll();
    const settings = normalizeSettings(next);
    if (settings.autoInstallComposer) {
      void installComposer().catch(() => undefined);
    }
    void service.republishComposerConfigs().catch(() => undefined);
  });

  try {
    if (normalizeSettings(await settingsHandle.get()).autoInstallComposer) await installComposer();
  } catch (error) {
    bb.log.warn(`press composer: startup install failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  bb.agents.registerTool({
    name: "compaction_point",
    description:
      "Tell Press, the compaction governor, that now is a good moment to compact this thread — for example right after a phase of the work finished. Press applies the policy and the vetoes, so it may record a proposal instead of compacting. The call returns at once.",
    instructions:
      "Call compaction_point when a coherent phase of your work just finished (plan approved, tests green, PR opened). Do not retry in a loop: a declined point is final for that moment.",
    presentation: {
      label: {
        pending: "Noting a compaction point",
        completed: "Noted a compaction point",
      },
    },
    parameters: z.object({ note: z.string().describe("One line on what just finished").default("") }),
    async execute(_input, { threadId }) {
      return service.compactionPoint(threadId);
    },
  });

  bb.background.service("sweep", {
    async start(signal) {
      await service.sweepLoop(signal);
    },
  });
}
