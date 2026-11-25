import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ScopeRecord } from "./store";
import { checkedHostRecord, readHostScope, type HostScopeLookup, type HostScopeState } from "./host-env";

export interface EnvEntry { name: string; value: string; reason: string }
export interface ScopeEnvContext { hostId: string; hostScope?: HostScopeState }
export function envForScope(records: ReadonlyMap<string, ScopeRecord>, threadId: string | null, context?: ScopeEnvContext): EnvEntry[] {
  if (!threadId) return [];
  const original = records.get(threadId);
  if (!original) return [];
  const hosted = !!original.binding || context?.hostScope !== undefined;
  const record = hosted ? checkedHostRecord(original, context?.hostScope, context?.hostId) : original;
  if (!record) return [];
  const entries: EnvEntry[] = [{ name: "TAVERN_SCOPE_FILE", value: record.file, reason: "Tavern per-thread guard policy; unreadable policy cannot authorize an act" }];
  const scope = record.scope;
  for (const [name, value] of Object.entries(scope?.env.variables ?? {})) if (name !== "PWD") entries.push({ name, value, reason: "Tavern bound scope environment" });
  entries.push({ name: "TAVERN_SCOPE_MODE", value: record.mode ?? scope?.mode ?? "enforce", reason: "Tavern Act guard, Watch, or Off" });
  if (hosted && (entries.length > 32 || new Set(entries.map(entry => entry.name)).size !== entries.length)) return [];
  return entries;
}
export function registerEnv(bb: BbPluginApi, records: ReadonlyMap<string, ScopeRecord>, beforeEnv?: (threadId: string) => Promise<unknown>, onError?: (threadId: string, error: unknown) => void, hostScopeForThread?: HostScopeLookup): void {
  for (const providerId of ["pi", "claude-code", "codex"]) bb.providers.experimental_contributeEnv(providerId, async context => {
    const id = context.threadId;
    if (!id || !records.has(id)) return [];
    const hostScope = readHostScope(hostScopeForThread, id);
    if (records.get(id)?.binding || hostScope !== undefined) return envForScope(records, id, { hostId: context.hostId, hostScope });
    if (beforeEnv) {
      try { await beforeEnv(id); }
      catch (error) {
        try { onError?.(id, error); }
        catch (reportError) { console.warn("Tavern could not report deferred scope binding: " + String(reportError)); }
      }
    }
    return envForScope(records, id, { hostId: context.hostId, hostScope: readHostScope(hostScopeForThread, id) });
  });
}
