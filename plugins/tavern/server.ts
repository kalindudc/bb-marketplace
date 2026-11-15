import { fileURLToPath } from "node:url";
import { registerProvider } from "./src/server/renderer/provider";
import { TaleCompanions } from "./src/server/renderer/companion";
import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MIGRATIONS } from "./src/server/migrations";
import { registerJournal } from "./src/server/journal/index";
import type { RegisterJournal } from "./src/server/ports";
import { KeeperStore } from "./src/server/keeper/store";
import { Keeper } from "./src/server/keeper/service";
import { Registry } from "./src/server/registry";
import { TavernRuntime } from "./src/server/runtime";
import { registerTools } from "./src/server/tools/index";
import { rpcHandlers } from "./src/server/rpc";
import { registerCli } from "./src/server/cli";
import { registerScopeSettings } from "./src/server/scopes";
import { SettingsStore } from "./src/server/settings/store";
import { SettingsFiles } from "./src/server/settings/files";
import { settingsHandlers } from "./src/server/settings/rpc";
import { InsightsReader } from "./src/server/insights/index";
import { BurnCosts } from "./src/server/insights/burn";
import { LIMITS } from "./src/server/limits";
import { createBackupService } from "./src/server/backup/index";
import { backupHandlers } from "./src/server/backup/rpc";
import { backupContract } from "./src/shared/backup";
import { rpcContract as coreContract } from "./src/shared/contract";
import { settingsContract } from "./src/shared/settings";
import { insightsContract } from "./src/shared/insights";
import { VoiceCheckRunner } from "./src/server/voice-check/run";
import { resolveWriter } from "./src/server/voice-check/writer";
export const rpcContract = { ...coreContract, ...settingsContract, ...insightsContract, ...backupContract };

export function pause(ms: number, signal: AbortSignal): Promise<void> {
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
export default async function tavern(bb: BbPluginApi) {
  registerProvider(bb);
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new KeeperStore(db);
  let applySettings = () => {};
  const settings = new SettingsStore(db, Date.now, () => {
    applySettings();
    bb.rpc.experimental_invalidate(["tavern:settings", "tavern:insights"]);
  }, message => bb.log.warn(message));
  let keeper: Keeper;
  let runtime: TavernRuntime | undefined;
  const register: RegisterJournal = registerJournal;
  const journal = register(bb, db, {
    reviewed: review => {
      if (!runtime) throw new Error("Tavern is still starting");
      runtime.serviceRecords.reviewed(review);
    },
    // Never throws: a re-brief reopening a verified entry must not fail on the service record.
    superseded: input => {
      if (!runtime) { bb.log.warn(`Service record not ready; ${input.entry.threadId}'s superseded verdict for [${input.entry.id}] was not marked`); return; }
      runtime.serviceRecords.superseded(input);
    },
    settings: () => settings.read().journal,
    roleOf: (threadId) => {
      const member = store.get("members", threadId);
      return member
        ? {
            ...member,
            ...(member.classId === "warden"
              ? { checkerWaypointIds: keeper?.checkerWaypoints(threadId) ?? [] }
              : {}),
          }
        : null;
    },
    boardQuestsOf: (threadId) =>
      store.query("quests", "keeperThreadId", threadId, 5000),
    invalidate: (tags) => bb.rpc.experimental_invalidate(tags),
    // A delegated journal entry names its owner by the member's character, as the rest of Tavern does.
    nameOf: (threadId) => {
      const member = store.get("members", threadId);
      if (!member) return null;
      try {
        return member.displayName ?? runtime?.snapshot().characters.find((c) => c.id === member.characterId)?.name ?? null;
      } catch { return null; }
    },
  });
  keeper = new Keeper(store, journal, Date.now, (tags) =>
    bb.rpc.experimental_invalidate(tags),
  );
  runtime = new TavernRuntime(
    bb,
    keeper,
    new Registry(
      fileURLToPath(
        new URL(
          existsSync(new URL("./classes", import.meta.url)) ? "./" : "../",
          import.meta.url,
        ),
      ),
    ),
  );
  const burn = new BurnCosts(bb);
  const insights = new InsightsReader(db, settings, Date.now, (data, from, to) => burn.read(data, from, to), () => ({ characters: runtime.snapshot().characters.map(character => ({ id: character.id, classIds: character.classes })), serviceRecords: runtime.serviceRecords.read() }));
  runtime.enableSettings(settings, insights);
  applySettings = () => runtime.settingsChanged();
  await registerScopeSettings(bb, runtime);
  const voiceChecks = new VoiceCheckRunner({
    bb, store, pluginId: bb.pluginId, now: Date.now, sleep: pause,
    log: (level, message) => bb.log[level](message), invalidate: (tags) => bb.rpc.experimental_invalidate(tags),
    writer: async (characterId) => {
      const personal = (await bb.sdk.projects.list({ includePersonal: true })).find((p) => p.kind === "personal");
      if (!personal) throw new Error("no personal project");
      return resolveWriter(bb, runtime.snapshot().classes, characterId, personal.id);
    },
    character: (characterId) => runtime.snapshot().characters.find((c) => c.id === characterId),
  });
  runtime.voiceChecks = voiceChecks;
  void voiceChecks.recover().catch((error) => bb.log.warn(`Tavern voice check recovery failed: ${String(error)}`));
  runtime.taleRenderer = new TaleCompanions(bb, keeper);
  bb.onDispose(() => runtime.taleRenderer?.settled());
  registerTools(bb, runtime);
  const backups = createBackupService(bb, settings, runtime.registry);
  bb.rpc.register(rpcContract, { ...rpcHandlers(runtime), ...settingsHandlers(settings, new SettingsFiles(settings)), ...backupHandlers(backups),
    insights: input => insights.view(input.range) });
  registerCli(bb, runtime, backups);
  bb.agents.configure((ctx) => runtime.configure(ctx));
  bb.ui.registerMentionProvider({
    id: "classes",
    label: "Tavern classes",
    triggers: ["!"],
    search: async (ctx) =>
      (ctx.projectId
        ? await runtime.prepareRegistry(ctx.projectId)
        : runtime.snapshot()
      ).classes
        .filter(
          (c) =>
            c.startable &&
            `${c.label} ${c.plain}`
              .toLowerCase()
              .includes(ctx.query.toLowerCase()),
        )
        .map((c) => ({
          id: c.id,
          title: c.label,
          subtitle: `${c.plain}: ${c.description}`,
          icon: "tavern/tavern",
        })),
    resolve: (itemId) => {
      const role = runtime.mentionClass(itemId);
      if (!role) throw new Error(`Unknown startable class: ${itemId}`);
      return {
        context: `You are a ${role.label} thread. Your role and journal instructions are supplied by Tavern in your instructions.`,
      };
    },
  });
  bb.ui.registerMentionProvider({
    id: "names",
    label: "Tavern names",
    triggers: ["@"],
    search: async ctx => runtime.mentionNames(ctx.query),
    resolve: itemId => {
      const item = runtime.mentionNames("").find(item => item.id === itemId);
      if (!item) throw new Error("This Tavern name is no longer live");
      return { context: `${item.title} (${item.subtitle}) is a Tavern thread. Refer to it by name and role.` };
    },
  });
  bb.experimental_hooks.on("message.dispatch", (ctx) => runtime.dispatch(ctx));
  bb.onDispose(
    journal.onChange((threadId) => {
      const member = keeper.member(threadId);
      if (member?.boardQuestId) keeper.refreshPhase(member.boardQuestId);
      // The journal sends these with its own signal: one room refetch per change.
      const stale = keeper.changedTags(threadId, member?.boardQuestId);
      if (member?.keeperThreadId)
        store.event(
          Date.now(),
          member.keeperThreadId,
          member.boardQuestId,
          "journal.changed",
          `${member.characterId}'s linked journal changed`,
        );
      return stale;
    }),
  );
  bb.events.on("thread.active", ({ thread }) =>
    runtime
      .threadStarted(thread)
      .catch((error) =>
        bb.log.warn(`Tavern active scope ${thread.id}: ${String(error)}`),
      ),
  );
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    runtime.taleRenderer?.idle(thread.id, lastAssistantText);
    runtime.updateThread(thread);
    runtime.keeper.memory.lastReply(thread.id, lastAssistantText);
    runtime.memberEnded(thread, lastAssistantText);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    runtime.taleRenderer?.failed(thread.id);
    runtime.updateThread(thread);
  });
  bb.events.on("turn.failed", (event) =>
    runtime.failed(
      event.threadId,
      event.errorInfo
        ? `${event.errorInfo.category}; HTTP ${event.errorInfo.httpStatusCode ?? "unknown"}; provider code ${event.errorInfo.providerCode ?? "unknown"}`
        : "Provider turn failed",
      event.requestId,
    ),
  );
  for (const type of [
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
  ] as const)
    bb.events.on(type, (event) =>
      runtime
        .threadLifecycle(type, event)
        .catch((error) =>
          bb.log.warn(`Tavern lifecycle ${type}: ${String(error)}`),
        ),
    );
  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    void runtime
      .observe(thread, sequence)
      .catch((error) =>
        bb.log.warn(`Tavern event observation failed: ${String(error)}`),
      );
  });
  bb.events.on("message.queued", ({ entry }) => runtime.queued(entry));
  bb.events.on("message.dispatched", ({ entry }) => runtime.dispatched(entry));
  bb.events.on("message.cancelled", ({ entry }) => runtime.cancelled(entry));
  bb.background.service("keeper", {
    async start(signal) {
      await runtime.reconcile();
      while (!signal.aborted) {
        try {
          await runtime.sweep();
        } catch (error) {
          bb.log.warn(`Tavern tick service: ${String(error)}`);
        }
        await pause(LIMITS.sweepMs, signal);
      }
    },
  });
}
