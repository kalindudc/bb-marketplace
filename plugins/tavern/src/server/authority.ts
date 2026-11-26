import { PluginCliError, experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import type { Ask } from "../shared/schema";
import type { KeeperStore } from "./keeper/store";

import { AUTHORITY, type Act, type AuthorityLevel } from "../shared/authority";
export { AUTHORITY, type Act, type AuthorityLevel } from "../shared/authority";

export const QUEST_LANES = {
  "cluster-write": { lane: "user", delegatable: false },
  production: { lane: "user", delegatable: true }, merge: { lane: "user", delegatable: true },
  credential: { lane: "user", delegatable: true }, "sends-as-you": { lane: "user", delegatable: false }, "drafts-as-you": { lane: "user", delegatable: true }, destructive: { lane: "user", delegatable: true },
  greenlight: { lane: "user", delegatable: false }, conclude: { lane: "user", delegatable: false },
  "scope widenings": { lane: "keeper", delegatable: false }, replacements: { lane: "keeper", delegatable: false },
  "re-plans within the party": { lane: "keeper", delegatable: false }, "optional waypoint skips": { lane: "keeper", delegatable: false },
} as const;
export type OptionalRpcContext<T> = { [K in keyof T]: T[K] extends (input: infer I, context: infer C) => infer R ? (input: I, context?: C) => R : never };
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
export function assertQuestStartAnswer(ask: Ask, receipt: UserActReceipt | undefined, by: NonNullable<Ask["answer"]>["by"], via: NonNullable<Ask["answer"]>["via"]) {
  if (by !== "user" || receipt?.act !== "answerAsk" || receipt.references?.askId !== ask.id || receipt.threadId || via === "cli" || via === "timer")
    throw new Error("Quest placement needs your explicit answer on this card.");
}
const receiptListeners = new WeakMap<KeeperStore["db"], (eventId: number) => void>();
export function onAuthorityReceipt(db: KeeperStore["db"], changed: () => void) {
  const pending: number[] = [];
  const listen = (id: number) => {
    pending.push(id);
    if (pending.length !== 1) return;
    // The surrounding transaction may still roll back after the receipt is written.
    queueMicrotask(() => {
      const ids = pending.splice(0);
      if (receiptListeners.get(db) !== listen) return;
      const exists = db.prepare("SELECT 1 FROM tavern_events WHERE id=? AND type='authority.acted'");
      if (ids.some(id => exists.get(id))) changed();
    });
  };
  receiptListeners.set(db, listen);
  return () => { receiptListeners.delete(db); };
}
function recordAuthorityReceipt(store: KeeperStore, at: number, receipt: UserActReceipt) {
  return store.event(at, null, null, "authority.acted", `${receipt.act}: ${receipt.attribution}`, receipt,
    receipt.threadId ? { kind: "agent", threadId: receipt.threadId } : { kind: "user" });
}
function notifyAuthorityReceipt(store: KeeperStore, at: number, receipt: UserActReceipt) {
  const id = recordAuthorityReceipt(store, at, receipt);
  receiptListeners.get(store.db)?.(id);
}
// A caller that already publishes a room change can cover the receipt in that same post-commit notification.
export function commitUserAct<T>(store: KeeperStore, now: () => number, receipt: UserActReceipt | undefined, action: () => T, publishRoomChange?: () => void): T {
  const result = store.atomic(() => {
    const value = action();
    if (value instanceof Promise) throw new Error("A user-act transaction must be synchronous");
    if (receipt) {
      if (publishRoomChange) recordAuthorityReceipt(store, now(), receipt);
      else notifyAuthorityReceipt(store, now(), receipt);
    }
    return value;
  });
  publishRoomChange?.();
  return result;
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
    if (!(result instanceof Promise)) notifyAuthorityReceipt(store, now(), receipt);
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
        if (!(result instanceof Promise)) notifyAuthorityReceipt(store, now(), receipt);
      });
      return result;
    }];
  })) as T;
}
