import { PluginCliError, experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import type { KeeperStore } from "./keeper/store";

const explicit = { level: "user-explicit", proof: "act and surface" } as const;
const words = { level: "user-in-words", proof: "routed user message, quoted exactly" } as const;
const keeper = { level: "keeper", proof: "recorded reversible decision" } as const;
const invariant = { level: "tavern", proof: "invariant" } as const;
export const AUTHORITY = {
  delegateQuest: explicit, preapproveQuest: explicit, revokeQuestAuthority: explicit,
  answerAsk: explicit, greenlight: explicit, conclude: explicit, closeEarly: explicit,
  resolveHandBack: explicit,
  releaseCheckerHandoff: explicit, awayClose: explicit, awayReturn: explicit,
  addRule: explicit, widenRule: explicit, confirmRule: explicit, undoDecision: explicit,
  correctRoute: explicit, stopBoardQuest: explicit, resumeAll: explicit,
  placementRetry: explicit, placementModelFailureClear: explicit,
  holdBoardQuest: explicit, resumeBoardQuest: explicit, allowReview: explicit,
  archiveBoardQuests: explicit, deleteBoardQuest: explicit, restoreDeletedQuest: explicit,
  setTaleKept: explicit, journalEdit: explicit, resumeKeeper: explicit,
  saveCharacterVoice: explicit, saveCharacterAvatar: explicit, saveClass: explicit, removeClassOverride: explicit,
  applyClassExecution: explicit, dismissClassNotice: explicit,
  settingsAgentChange: { level: "keeper", proof: "recorded user grant and calling thread", grant: "tavern.agentsMayChangeSettings" },
  settingsUpdate: explicit, settingsUndo: explicit, settingsImport: explicit,
  settingsFile: explicit, settingsApplySuggestion: explicit, settingsEndOverride: explicit, backupRestore: explicit,
  guardInstall: explicit, guardUninstall: explicit,
  voiceCheckStart: explicit, voiceCheckCancel: explicit, releaseHold: explicit,
  openQuest: words, reopenQuest: words, weakenChecks: words, steerDecision: words,
  holdQuestFromMessage: words, resumeQuestFromMessage: words,
  keepMember: keeper, releaseMember: keeper, defaultDecision: keeper, acceptWaypoint: keeper, skipWaypoint: keeper, exceedParty: keeper, exceedRangers: keeper,
  verifyOwnWork: invariant, upgradeResolution: invariant, changeClosedCredits: invariant,
} as const;
export const QUEST_LANES = {
  production: { lane: "user", delegatable: true }, merge: { lane: "user", delegatable: true },
  credential: { lane: "user", delegatable: true }, "sends-as-you": { lane: "user", delegatable: true }, destructive: { lane: "user", delegatable: true },
  greenlight: { lane: "user", delegatable: false }, conclude: { lane: "user", delegatable: false },
  "scope widenings": { lane: "keeper", delegatable: false }, replacements: { lane: "keeper", delegatable: false },
  "re-plans within the party": { lane: "keeper", delegatable: false }, "optional waypoint skips": { lane: "keeper", delegatable: false },
} as const;
export type OptionalRpcContext<T> = { [K in keyof T]: T[K] extends (input: infer I, context: infer C) => infer R ? (input: I, context?: C) => R : never };
export type Act = keyof typeof AUTHORITY;
export type AuthorityLevel = typeof AUTHORITY[Act]["level"];
export function authorize(act: Act, evidence: { level: AuthorityLevel; receipt: string }) {
  if (AUTHORITY[act].level !== evidence.level || !evidence.receipt.trim())
    throw new Error(`${act} requires ${AUTHORITY[act].level}: ${AUTHORITY[act].proof}`);
}

export function hasAgentOrCliMarker(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (!value || typeof value !== "object") return typeof value === "string" && /(?:^|[^a-z])(agent|cli)(?:$|[^a-z])/i.test(value);
  return Object.entries(value).some(([key, item]) => {
    if (key === "experimental_signal" || item === null || item === undefined || item === false || item === "") return false;
    const name = key.replaceAll(/[_-]/g, "").toLowerCase();
    return /thread|agent|^iscli|^cli(?!ent)|originplugin/.test(name) || hasAgentOrCliMarker(item, depth + 1);
  });
}
export function requireUserAct(context: ExperimentalPluginRpcHandlerContext | undefined, act: Act) {
  if (context?.experimental_caller?.kind !== "client" || hasAgentOrCliMarker(context))
    throw new experimental_PluginRpcRefusal({ code: "forbidden", message: `${act} requires an explicit client action without agent, thread or CLI markers; plugin callers are refused.` });
  const receipt = { act, surface: "client (unattested)", attribution: "answered from a client Tavern could not attribute" };
  authorize(act, { level: "user-explicit", receipt: receipt.surface });
  return receipt;
}
export type UserActReceipt = { act: Act; surface: string; attribution: string; threadId?: string; grant?: string; references?: Record<string, string> };
export function commitUserAct<T>(store: KeeperStore, now: () => number, receipt: UserActReceipt | undefined, action: () => T): T {
  return store.atomic(() => {
    const result = action();
    if (result instanceof Promise) throw new Error("A user-act transaction must be synchronous");
    if (receipt) store.event(now(), null, null, "authority.acted", `${receipt.act}: ${receipt.attribution}`, receipt, receipt.threadId ? { kind: "agent", threadId: receipt.threadId } : { kind: "user" });
    return result;
  });
}
export function settingsCliReceipt(context: { threadId?: string | null }, enabled: boolean): UserActReceipt {
  if (!context.threadId) {
    authorize("settingsUpdate", { level: "user-explicit", receipt: "terminal" });
    return { act: "settingsUpdate", surface: "terminal", attribution: "terminal" };
  }
  if (!enabled) throw new PluginCliError("Agents cannot change global Tavern settings: the user's grant is off.");
  authorize("settingsAgentChange", { level: "keeper", receipt: `${AUTHORITY.settingsAgentChange.grant}: ${context.threadId}` });
  return { act: "settingsAgentChange", surface: "agent CLI", attribution: context.threadId, threadId: context.threadId, grant: AUTHORITY.settingsAgentChange.grant };
}
export function terminalUserAct<T>(context: { threadId?: string | null }, act: Act, store: KeeperStore, now: () => number, action: (receipt: UserActReceipt) => T): T {
  if (context.threadId) throw new PluginCliError("Agents cannot change global Tavern settings or perform user-only Tavern controls. Use an ordinary terminal.");
  const receipt = { act, surface: "terminal", attribution: "terminal" };
  authorize(act, { level: "user-explicit", receipt: receipt.surface });
  let result: T;
  store.atomic(() => {
    result = action(receipt);
    if (!(result instanceof Promise)) store.event(now(), null, null, "authority.acted", `${act}: terminal`, receipt, { kind: "user" });
  });
  return result!;
}

export function userActHandlers<T extends object>(handlers: T, store: KeeperStore, now: () => number): T {
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => {
    if (!(name in AUTHORITY) || AUTHORITY[name as Act].level !== "user-explicit") return [name, handler];
    return [name, (input: unknown, context?: ExperimentalPluginRpcHandlerContext) => {
      const request = input as { apply?: boolean; action?: string };
      if ((name === "settingsImport" && !request.apply) || (name === "settingsFile" && request.action !== "save" && !(request.action === "load" && request.apply))) return handler(input, context);
      const authority = requireUserAct(context, name as Act);
      const references = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key, value]) => /^(id|askId|decisionId|ruleId|routeId|boardQuestId|threadId|windowId|characterId)$/.test(key) && typeof value === "string" && value.length <= 120)) as Record<string, string>;
      const receipt = { ...authority, references };
      let result: unknown;
      store.atomic(() => {
        result = handler(input, context, receipt);
        if (!(result instanceof Promise)) store.event(now(), null, null, "authority.acted", `${name}: ${receipt.attribution}`, receipt, { kind: "user" });
      });
      return result;
    }];
  })) as T;
}
