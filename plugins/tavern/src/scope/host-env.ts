import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { scopeSchema, type Scope, type ScopeHostTarget } from "./schema";
import { scopeObservationBindingSchema, type ScopeRecord } from "./store";

export interface ScopeWriteOptions { binding: ScopeHostTarget }
export interface HostTemplate { template: Scope; templateDigest: string }
const reserved = new Set(["TAVERN_SCOPE_FILE", "TAVERN_SCOPE_MODE", "BB_THREAD_ID", "PWD"]);
export const nativeScopeVariablesSchema = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(200).refine(value => !reserved.has(value), "Native scope variables cannot replace scope routing or thread identity"), z.string().max(65536).refine(value => !value.includes("\0"))).refine(value => Object.keys(value).length <= 30 && Buffer.byteLength(JSON.stringify(value), "utf8") <= 65536, "Native scope variables must fit 30 entries and 64 KiB");
export const hostScopeStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), reason: z.string().min(1).max(16384) }).strict(),
  z.object({
    kind: z.literal("ready"), templateDigest: z.string().regex(/^[a-f0-9]{64}$/), expected: scopeObservationBindingSchema,
    acknowledged: z.object({
      binding: scopeObservationBindingSchema,
      scopeFile: z.string().min(1).max(32768).refine(value => !/[\0\r\n]/.test(value) && (posix.isAbsolute(value) || win32.isAbsolute(value)), "Use the acknowledged absolute host scope path"),
      variables: nativeScopeVariablesSchema,
    }).strict(),
  }).strict(),
]);
export type HostScopeState = z.infer<typeof hostScopeStateSchema>;
export type HostScopeLookup = (threadId: string) => HostScopeState | undefined;
export function readHostScope(lookup: HostScopeLookup | undefined, threadId: string): HostScopeState | undefined {
  try {
    const value = lookup?.(threadId);
    if (value === undefined) return;
    if (value instanceof Promise) { void value.catch(() => {}); throw new Error("Host scope lookup must be synchronous"); }
    return hostScopeStateSchema.parse(value);
  } catch { return { kind: "unavailable", reason: "The host scope acknowledgment is unavailable or invalid; reconcile the current binding before restarting this scoped session" }; }
}
export function hostTemplate(record: ScopeRecord | undefined): HostTemplate {
  if (!record?.binding || !record.scope || !record.template || record.error) throw new Error("No valid original host-bound template is available");
  const template = scopeSchema.parse(record.template);
  return { template, templateDigest: createHash("sha256").update(JSON.stringify(template), "utf8").digest("hex") };
}
export function checkedHostRecord(record: ScopeRecord, state: HostScopeState | undefined, hostId: string | undefined): ScopeRecord | null {
  try {
    if (!record.binding?.placementId || state?.kind !== "ready" || hostId !== state.expected.hostId) return null;
    const snapshot = hostTemplate(record);
    if (snapshot.templateDigest !== state.templateDigest || record.binding.placementId !== state.expected.placementId || record.binding.generation !== state.expected.generation || JSON.stringify(state.expected) !== JSON.stringify(state.acknowledged.binding)) return null;
    return { file: state.acknowledged.scopeFile, scope: { ...snapshot.template, env: { ...snapshot.template.env, variables: state.acknowledged.variables } }, mode: record.mode ?? snapshot.template.mode };
  } catch { return null; }
}
