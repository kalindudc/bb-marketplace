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
  const entries: EnvEntry[] = [{ name: "TAVERN_SCOPE_FILE", value: record.file, reason: "Tavern per-thread scope; fail closed if unreadable" }];
  const scope = record.scope;
  for (const [name, value] of Object.entries(scope?.env.variables ?? {})) if (name !== "PWD") entries.push({ name, value, reason: "Tavern bound scope environment" });
  entries.push({ name: "TAVERN_SCOPE_MODE", value: record.mode ?? scope?.mode ?? "enforce", reason: "Tavern scope enforcement mode" });
  if ((record.mode ?? scope?.mode ?? "enforce") === "enforce") {
    if (scope?.env.poisonGh && scope.github === "none") entries.push({ name: "GH_TOKEN", value: "tavern-scope-denied", reason: "Tavern scope disables GitHub" });
    if (scope?.env.blockGitPush) {
      const prefixes = ["https://", "http://", "ssh://", "git://", "git@", "file://", "/", "./", "../"];
      entries.push({ name: "GIT_CONFIG_COUNT", value: String(prefixes.length), reason: "Tavern push speed bump" });
      prefixes.forEach((prefix, i) => {
        entries.push({ name: `GIT_CONFIG_KEY_${i}`, value: `url.tavern-denied://${i}/.pushInsteadOf`, reason: "Tavern push speed bump" });
        entries.push({ name: `GIT_CONFIG_VALUE_${i}`, value: prefix, reason: "Tavern push speed bump" });
      });
    }
  }
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
