import type { BbPluginApi, ExperimentalPluginRpcHandlersWithContext, ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { KeeperStore } from "../keeper/store";
import { userActHandlers, requireUserAct } from "../authority";
import { z } from "zod";
import { QUEST_TUNABLE_KEYS, settingsContract, type SettingDecision, type TavernSettings } from "../../shared/settings";
import { exportToml } from "./toml";
import { SettingsConflict, type SettingsStore } from "./store";
import { importSettings, type SettingsFiles, type SettingsPreview } from "./files";
import { gitProgramProblem } from "../../shared/git-safety";

export function settingsHandlers(store: SettingsStore, files: SettingsFiles, validate?: (settings: TavernSettings) => void,
  contextualSpeech?: boolean): ExperimentalPluginRpcHandlersWithContext<typeof settingsContract> {
  if (validate) store.setValidator(validate);
  const requireClient = (context?: ExperimentalPluginRpcHandlerContext) => {
    return requireUserAct(context, "settingsUpdate");
  };
  const records = new KeeperStore(store.db);
  const view = () => {
    const snapshot = store.snapshot();
    const liveOverrides = Object.entries(store.questOverrides()).flatMap(([questId, values]) => {
      const quest = records.get("quests", questId);
      if (!quest || quest.endedAt !== null || quest.archivedAt !== null) return [];
      const keeper = records.get("members", quest.keeperThreadId);
      return QUEST_TUNABLE_KEYS.flatMap(key => {
        const value = values[key];
        return value === undefined ? [] : [{ questId, questTitle: quest.title, keeperThreadId: quest.keeperThreadId,
          keeperName: keeper?.displayName ?? "Keeper", key, value, applied: snapshot.effective.tuning.mode !== "off" && snapshot.pinned[key] === undefined }];
      });
    });
    const problem = gitProgramProblem(snapshot.effective.tavern.gitProgram);
    return { ...snapshot, ...store.placementRepair(), file: files.status(), liveOverrides, lastChangers: store.lastChangers(),
      ...(contextualSpeech === undefined ? {} : { contextualSpeech }), ...(problem ? { gitProgramProblem: problem } : {}) };
  };
  function mutate(action: () => SettingDecision | null | void) {
    try {
      const decision = action();
      return { code: "ok" as const, revision: store.snapshot().revision, problems: [], settings: view(),
        ...(decision ? { decisionId: decision.id } : {}) };
    }
    catch (error) {
      if (error instanceof SettingsConflict) return { code: "stale" as const, revision: error.revision, problems: [], settings: null };
      const problems = error instanceof z.ZodError ? error.issues.map(issue => ({ line: 0, key: issue.path.map(String).join("."), message: issue.message }))
        : [{ line: 0, key: "", message: error instanceof Error ? error.message : String(error) }];
      return { code: "invalid" as const, revision: store.snapshot().revision, problems, settings: null };
    }
  }
  function preview(action: () => SettingsPreview): SettingsPreview {
    try { return action(); }
    catch (error) { return { code: error instanceof SettingsConflict ? "stale" : "invalid", revision: store.snapshot().revision,
      applied: false, changes: [], problems: error instanceof SettingsConflict ? [] : [{ line: 0, key: "", message: String(error) }] }; }
  }
  return userActHandlers({
    settings: () => view(),
    settingsUpdate: (input, context) => { requireClient(context); return mutate(() => store.update(input)); },
    settingsUndo: (input, context) => { requireClient(context); return mutate(() => store.undo(input.id, input.why, input.revision)); },
    settingsExport: input => ({ toml: exportToml(store.snapshot(), input.withTuned) }),
    settingsImport: (input, context) => { if (input.apply) requireClient(context); return preview(() => importSettings(store, input.toml, input.apply, input.revision, input.why)); },
    settingsFile: (input, context) => {
      if (input.action === "save" || input.action === "load" && input.apply) requireClient(context);
      if (input.action === "status") return { file: files.status(), preview: null };
      if (input.action === "load") {
        const result = preview(() => files.load(input.apply, input.revision, input.expectedHash));
        return { file: files.status(), preview: result };
      }
      try {
        if (input.revision === undefined) throw new Error("Supply the current settings revision before saving.");
        return { file: files.save(input.revision, input.withTuned, input.expectedHash), preview: null };
      } catch (error) {
        return { file: files.status(), preview: { code: error instanceof SettingsConflict ? "stale" : "invalid", revision: store.snapshot().revision,
          applied: false, changes: [], problems: error instanceof SettingsConflict ? [] : [{ line: 0, key: "file", message: String(error) }] } };
      }
    },
    settingsEndOverride: input => mutate(() => store.endOverride(input.boardQuestId, input.key, input.revision)),
    settingsApplySuggestion: (input, context) => {
      requireClient(context);
      return mutate(() => {
        const snapshot = store.snapshot();
        if (snapshot.revision !== input.revision) throw new SettingsConflict(snapshot.revision);
        const suggestion = snapshot.suggestions.find(row => row.key === input.key);
        if (!suggestion) throw new Error("This tuning suggestion is no longer available.");
        if (suggestion.revision !== snapshot.revision) throw new SettingsConflict(snapshot.revision);
        store.applyTuned({ [input.key]: suggestion.value }, `Applied Tavern suggestion: ${suggestion.reason}`, suggestion.evidence, "user");
        store.saveSuggestions(snapshot.suggestions.filter(row => row.key !== input.key).map(row => ({ ...row, revision: store.snapshot().revision })));
      });
    },
  }, records, () => store.now());
}
export function registerSettingsRpc(bb: BbPluginApi, store: SettingsStore, files: SettingsFiles, validate?: (settings: TavernSettings) => void) {
  bb.rpc.register(settingsContract, settingsHandlers(store, files, validate));
}
