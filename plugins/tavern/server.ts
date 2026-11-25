import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerProvider } from "./src/server/renderer/provider";
import { TaleCompanions } from "./src/server/renderer/companion";
import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MIGRATIONS } from "./src/server/migrations";
import { preparedDatabase } from "./src/server/prepared-database";
import { migrateMemberEngagement } from "./src/server/member-engagement-migration";
import { registerJournal } from "./src/server/journal/index";
import type { RegisterJournal } from "./src/server/ports";
import { KeeperStore } from "./src/server/keeper/store";
import { Keeper } from "./src/server/keeper/service";
import { loadKeeperCards } from "./src/server/keeper/cards";
import { Registry } from "./src/server/registry";
import { TavernRuntime } from "./src/server/runtime";
import { registerTools } from "./src/server/tools/index";
import { rpcHandlers } from "./src/server/rpc";
import { onAuthorityReceipt } from "./src/server/authority";
import { registerCli } from "./src/server/cli";
import { registerScopeSettings } from "./src/server/scopes";
import { SettingsStore } from "./src/server/settings/store";
import { SettingsFiles } from "./src/server/settings/files";
import { settingsHandlers } from "./src/server/settings/rpc";
import { PiSpeech } from "./src/server/pi-speech";
import { registerDialogueWatch } from "./src/server/strip-dialogue-watch";
import { readSpeechFacts } from "./src/server/strip-scene";
import { InsightsReader, insightsHandlers } from "./src/server/insights/index";
import { BurnCosts } from "./src/server/insights/burn";
import { LIMITS } from "./src/server/limits";
import { createBackupService } from "./src/server/backup/index";
import { backupHandlers } from "./src/server/backup/rpc";
import { backupContract } from "./src/shared/backup";
import { rpcContract as coreContract, tags } from "./src/shared/contract";
import { settingsContract } from "./src/shared/settings";
import { setupContract } from "./src/shared/setup";
import { SetupPreflight } from "./src/server/settings/setup-preflight";
import { SetupService } from "./src/server/settings/setup";
import { insightsContract } from "./src/shared/insights";
import { memoryContract } from "./src/shared/memory";
import { memoryHandlers } from "./src/server/memory-rpc";
import { installHostGitProgram } from "./src/host/client";
import { installServerGitProgram } from "./src/shared/git-safety";
import { studyContract } from "./src/shared/study-events";
export const rpcContract = { ...coreContract, ...settingsContract, ...setupContract, ...insightsContract, ...backupContract, ...memoryContract, ...studyContract };

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
  const pluginRoot = new URL(existsSync(new URL("./classes", import.meta.url)) ? "./" : "../", import.meta.url);
  const keeperCards = loadKeeperCards(pluginRoot);
  registerProvider(bb);
  const storage = bb.storage.database();
  bb.storage.migrate(storage, MIGRATIONS);
  const db = preparedDatabase(storage);
  const store = new KeeperStore(db);
  migrateMemberEngagement(store, Date.now());
  bb.onDispose(onAuthorityReceipt(db, () => bb.rpc.experimental_invalidate([tags.room()])));
  let applySettings = () => {};
  const settings = new SettingsStore(db, Date.now, () => {
    applySettings();
    bb.rpc.experimental_invalidate(["tavern:settings", "tavern:insights"]);
  }, message => bb.log.warn(message));
  let gitProgram = settings.read().tavern.gitProgram;
  bb.onDispose(installServerGitProgram(() => gitProgram));
  bb.onDispose(installHostGitProgram(bb, () => gitProgram));
  let keeper: Keeper;
  let runtime: TavernRuntime | undefined;
  const register: RegisterJournal = registerJournal;
  const journal = register(bb, db, {
    studyTool: (tool, threadId, input, call) => runtime ? runtime.study.tool(tool, threadId, input, call) : Promise.resolve(call(() => {})),
    verdictSubmitted: (actor, entries) => keeper.recordWardenRound(actor, entries),
    assertWritable: threadId => keeper.succession.assertMutable(threadId),
    isRetired: threadId => keeper.succession.fence(threadId)?.kind === "retired",
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
    limits: () => settings.read().limits,
    roleOf: threadId => runtime ? runtime.journalRole(threadId) : store.get("members", threadId),
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
  keeper.moveNoticeAsks();
  const registry = new Registry(fileURLToPath(pluginRoot));
  try {
    for (const { id, path } of registry.olderClassOverrides())
      bb.log.warn(`Your ${id} class copy (${path}) is older than the shipped file and differs from it. Compare the two in Settings, Classes and models. Tavern still uses your copy.`);
  } catch (error) { bb.log.warn(`Could not check class copies against the shipped files: ${String(error)}`); }
  runtime = new TavernRuntime(bb, keeper, registry, keeperCards);
  const burn = new BurnCosts(bb);
  const insights = new InsightsReader(db, settings, Date.now, (data, from, to) => burn.read(data, from, to), () => ({ characters: runtime.snapshot().characters.map(character => ({ id: character.id, classIds: character.classes })), serviceRecords: runtime.serviceRecords.read() }));
  runtime.enableSettings(settings, insights);
  const speech = new PiSpeech(bb, dirname(db.name), ({ threadId, stage }) => {
    const member = keeper.member(threadId);
    return member ? readSpeechFacts(keeper, member, stage) : null;
  });
  const refreshDialogue = registerDialogueWatch(bb, runtime, speech);
  applySettings = () => {
    gitProgram = settings.read().tavern.gitProgram;
    refreshDialogue();
    runtime.settingsChanged();
  };
  await registerScopeSettings(bb, runtime);
  runtime.spend.ledger.directory = join(dirname(db.name), "scopes");
  runtime.taleRenderer = new TaleCompanions(bb, keeper);
  bb.onDispose(() => runtime.taleRenderer?.settled());
  bb.onDispose(() => runtime.memory.cancel());
  registerTools(bb, runtime);
  const backups = createBackupService(bb, settings, runtime.registry, () => runtime.scopes?.clearGrantProjections());
  const setup = new SetupService(bb, settings, store, new SetupPreflight(bb, async (projectId, id) =>
    (projectId === null ? runtime.snapshot() : await runtime.prepareRegistry(projectId)).classes.find(role => role.id === id)));
  const handlers = rpcHandlers(runtime);
  bb.rpc.register(rpcContract, { ...handlers, ...settingsHandlers(settings, new SettingsFiles(settings), undefined, t => speech.problem(t)), ...setup.handlers(), ...backupHandlers(backups),
    ...insightsHandlers(insights), ...memoryHandlers(runtime),
    recordCardSignals: entries => { runtime.study.cards(entries); return null; },
  });
  registerCli(bb, runtime, backups, setup);
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
    search: async ctx => runtime.mentionNames(ctx.query, ctx.threadId),
    resolve: itemId => {
      const item = runtime.mentionNames("").find(item => item.id === itemId);
      if (!item) throw new Error("This Tavern name is no longer live");
      return { context: `${item.title} (${item.subtitle}) is a Tavern thread. Refer to it by name and role.` };
    },
  });
  bb.experimental_hooks.on("message.dispatch", ctx => runtime.dispatch(ctx));
  bb.onDispose(
    journal.onChange((threadId, _entryIds, boardIds) => {
      const member = keeper.member(threadId);
      // The journal sends these with its own signal: one room refetch per change.
      const stale = keeper.journalChangedTags(member, boardIds);
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
    if (!runtime.succession.state.fence(thread.id)) runtime.keeper.memory.lastReply(thread.id, lastAssistantText);
    runtime.memberEnded(thread, lastAssistantText);
    runtime.spend.refreshForThread(thread.id).catch(error => bb.log.warn(`Tavern quest spend: ${String(error)}`));
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
    ).catch(error => bb.log.warn(`Tavern failed-turn handling ${event.threadId}: ${String(error)}`)),
  );
  for (const type of [
    "thread.archived",
    "thread.unarchived",
    "thread.deleted",
  ] as const)
    bb.events.on(type, (event) => {
      bb.rpc.experimental_invalidate([tags.identity(event.thread.id)]);
      return runtime.threadLifecycle(type, event).catch((error) =>
        bb.log.warn(`Tavern lifecycle ${type}: ${String(error)}`),
      );
    });
  bb.onDispose(() => runtime.studyTurns.dispose());
  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    void runtime.studyTurns.observe(thread.id, sequence)?.catch(() => bb.log.warn("Tavern could not read local turn measurements."));
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
