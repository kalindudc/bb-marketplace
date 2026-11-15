import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { bindPaths, realPath, type ScopePaths } from "./paths";
import { narrowScope } from "./presets";
import { scopeHostTargetSchema, scopeSchema, type ClassScope, type Scope, type ScopeNarrowing, type ScopeOverride } from "./schema";
import { ScopeStore } from "./store";
import { envForScope, registerEnv } from "./env";
import { hostTemplate as originalHostTemplate, readHostScope, type HostScopeLookup, type HostScopeState, type ScopeWriteOptions } from "./host-env";
import { registerWatcher, type WatchDeps } from "./watch";
import { bindWorktree, needsWorktree } from "./worktree";
import { ensureGuardInstalled, guardStatus, type GuardOptions } from "./install";
import { ScopePolicy, type PolicyOptions, type ProjectContext } from "./policy";
import { bindChecks } from "./checker";

export * from "./schema";
export { evaluate } from "./engine";
export { ScopePolicy } from "./policy";
export type { ScopeCall, Decision } from "./engine";
export type { Violation, ScopeObservationBinding, ScopeObservationHold } from "./store";
export type { RemoteScopeObservation, WatchDeps } from "./watch";
export { nativeScopeVariablesSchema, hostScopeStateSchema } from "./host-env";
export type { HostScopeState, HostScopeLookup, HostTemplate, ScopeWriteOptions } from "./host-env";
export type { ProjectContext, ScopeResolution } from "./policy";
export type ScopeMode = Scope["mode"];
export function shouldScope(classId: string | null | undefined, origin: "direct" | "hire"): boolean {
  return !!classId && classId !== "untyped" && !(classId === "wanderer" && origin === "direct");
}
export interface ScopesDeps extends WatchDeps {
  mode?: ScopeMode;
  hostScopeForThread?: HostScopeLookup;
  narrowBoundScope?(scope: Scope): Scope;
  dataDir?: string;
  pathsForThread(threadId: string): Omit<ScopePaths, "home" | "tmp" | "scopesDir"> | Promise<Omit<ScopePaths, "home" | "tmp" | "scopesDir">>;
  projectForThread?(threadId: string): ProjectContext;
  classScope?(classId: string): ClassScope | undefined;
  policyOptions?: PolicyOptions;
  guard?: GuardOptions;
  installGuard?: boolean;
}
export function registerScopes(bb: BbPluginApi, deps: ScopesDeps) {
  const dataDir = deps.dataDir ?? dirname(bb.storage.database().name);
  const store = new ScopeStore(dataDir);
  let mode: ScopeMode = deps.mode ?? "enforce";
  for (const [threadId, record] of store.records) if ((record.mode ?? record.scope?.mode) !== mode) store.setMode(threadId, mode);
  const policy = new ScopePolicy(deps.policyOptions);
  const extensionCandidates = ["../../adapters/pi/extension.ts", "../adapters/pi/extension.ts", "./adapters/pi/extension.ts"].map(path => fileURLToPath(new URL(path, import.meta.url)));
  const guard = { entryPath: extensionCandidates.find(path => existsSync(path)) ?? extensionCandidates[0], ...deps.guard };
  const installation = deps.installGuard === false ? "disabled" : ensureGuardInstalled(guard);
  const updates = new Map<string, Promise<unknown>>();
  const enqueue = <T>(threadId: string, work: (check: () => void) => Promise<T>) => {
    const revision = store.revision(threadId), deadlineAt = Date.now() + 2000;
    let expired = false, timer: ReturnType<typeof setTimeout>;
    const timeoutError = () => new Error("Scope binding timed out after 2000 ms");
    const check = () => {
      if (expired || Date.now() >= deadlineAt) throw timeoutError();
      if (store.revision(threadId) !== revision) throw new Error("Scope was released while binding " + threadId);
    };
    const run = () => { check(); return work(check); };
    const workPending = (updates.get(threadId) ?? Promise.resolve()).then(run, run);
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(timeoutError()); }, 2000); });
    const pending = Promise.race([workPending, deadline]);
    updates.set(threadId, pending);
    return pending.finally(() => { clearTimeout(timer); if (updates.get(threadId) === pending) updates.delete(threadId); });
  };
  const hostStateForThread = (threadId: string): HostScopeState | undefined => {
    const state = readHostScope(deps.hostScopeForThread, threadId);
    if (state !== undefined) return state;
    try {
      if (deps.remoteForThread?.(threadId) !== undefined) return { kind: "unavailable", reason: "A host-local scope acknowledgment is not available for this remote member" };
    } catch { return { kind: "unavailable", reason: "The remote binding lookup is unavailable; do not use controller-local scope paths" }; }
  };
  const prepareBinding = (threadId: string, options?: ScopeWriteOptions) => {
    if (options) return store.markHostBinding(threadId, scopeHostTargetSchema.parse(options.binding));
    const current = store.records.get(threadId)?.binding;
    if (current) return current;
    const state = hostStateForThread(threadId);
    if (state !== undefined) return store.markHostBinding(threadId, { kind: "host", placementId: state.kind === "ready" ? state.expected.placementId : null, generation: state.kind === "ready" ? state.expected.generation : null });
  };
  const bindAndWrite = async (threadId: string, input: Scope, check: () => void) => {
    let template = scopeSchema.parse({ ...input, threadId, issuedAt: input.issuedAt || Date.now() });
    const paths = prepareBinding(threadId) ? undefined : await deps.pathsForThread(threadId);
    prepareBinding(threadId);
    check();
    const current = store.records.get(threadId), enforceFrom = current?.scope?.enforceFrom ?? template.enforceFrom;
    template = { ...template, mode, ...(enforceFrom === undefined ? {} : { enforceFrom }) };
    if (current?.binding) {
      if (!current.error && JSON.stringify(current.scope) === JSON.stringify(template) && JSON.stringify(current.template) === JSON.stringify(template)) return current.scope!;
      return store.write(threadId, template, template);
    }
    if (!paths) throw new Error("Local scope paths are unavailable");
    const prepared = paths.worktree && (needsWorktree(template) || template.writes.mode === "worktree") ? bindWorktree(template, paths.worktree) : template;
    let scope = bindChecks(bindPaths(prepared, {
      home: deps.policyOptions?.home ?? homedir(),
      tmp: process.platform === "darwin" ? [...new Set(["/private/tmp", realPath(tmpdir())])] : [tmpdir()],
      scopesDir: store.directory, ...paths,
    }, realPath));
    if (scope.checks) template = { ...template, checks: scope.checks };
    if (scope.expectedWorktree) template = { ...template, expectedWorktree: scope.expectedWorktree };
    if (deps.narrowBoundScope) {
      const bound = scopeSchema.parse(scope), narrowed = scopeSchema.parse(deps.narrowBoundScope(scopeSchema.parse(bound)));
      const originalFields = { ...narrowed, tools: { ...narrowed.tools, deny: bound.tools.deny }, shell: { ...narrowed.shell, deny: bound.shell.deny } };
      if (JSON.stringify(bound) !== JSON.stringify(originalFields) || !bound.tools.deny.every(rule => narrowed.tools.deny.includes(rule)) || !bound.shell.deny.every(rule => narrowed.shell.deny.some(candidate => JSON.stringify(rule) === JSON.stringify(candidate)))) throw new Error("Temporary scope narrowing may only add tool and shell denies");
      scope = narrowed;
      check();
    }
    if (current?.scope && !current.error && JSON.stringify(current.scope) === JSON.stringify(scope) && JSON.stringify(current.template) === JSON.stringify(template)) return current.scope;
    return store.write(threadId, scope, template);
  };
  const writeScope = async (threadId: string, input: Scope, options?: ScopeWriteOptions) => {
    const template = scopeSchema.parse({ ...input, threadId });
    prepareBinding(threadId, options);
    return enqueue(threadId, check => bindAndWrite(threadId, template, check));
  };
  const rebindScope = async (threadId: string): Promise<Scope> => {
    prepareBinding(threadId);
    return enqueue(threadId, async check => {
      const record = store.records.get(threadId);
      if (!record?.scope) throw new Error("No valid scope for thread " + threadId);
      if (!record.template) {
        if (record.binding) throw new Error("No original host-bound template for thread " + threadId);
        return record.scope;
      }
      return bindAndWrite(threadId, record.template, check);
    });
  };
  registerEnv(bb, store.records, rebindScope, (threadId, error) => {
    try { if (!store.records.get(threadId)?.binding) store.failBinding(threadId, error); }
    finally { bb.log?.warn("Tavern scope binding deferred for " + threadId + ": " + String(error)); }
  }, hostStateForThread);
  registerWatcher(bb, store, deps);
  const locallyArmed = (threadId: string) => {
    if (store.records.get(threadId)?.binding || hostStateForThread(threadId) !== undefined) return false;
    return store.isArmed(threadId);
  };
  return {
    shouldScope,
    scopeForHire: (classId: string, narrowing?: ScopeNarrowing) => narrowScope(policy.resolve(classId, {}, {}, deps.classScope?.(classId)).scope, narrowing),
    setMode: (value: ScopeMode) => {
      if (!["enforce", "watch", "off"].includes(value)) throw new Error("Unknown Tavern scope mode: " + value);
      mode = value;
      for (const threadId of store.records.keys()) {
        store.setMode(threadId, mode);
        if (mode !== "enforce") store.saveProgress(threadId, store.progress(threadId).cursor, false);
      }
      return mode;
    },
    mode: () => mode,
    writeScope,
    rebindScope,
    hostTemplate: (threadId: string) => originalHostTemplate(store.records.get(threadId)),
    clearScope: (threadId: string) => store.clear(threadId),
    status: () => ({ mode, installation, guard: guardStatus(guard), threads: [...store.records.entries()].map(([threadId, record]) => {
      const state = hostStateForThread(threadId), hosted = !!record.binding || state !== undefined;
      return { threadId, scope: record.scope, error: record.error, hasTemplate: !!record.template, armed: locallyArmed(threadId), ...(record.binding ? { binding: record.binding } : {}), ...(hosted ? { hostScope: state?.kind === "ready" && envForScope(store.records, threadId, { hostId: state.expected.hostId, hostScope: state }).length ? "acknowledged" as const : "unresolved" as const } : {}) };
    }) }),
    violations: (threadId?: string) => store.violations(threadId),
    observationHolds: (threadId?: string) => (threadId ? [threadId] : [...store.records.keys()]).flatMap(id => { const hold = store.observationHold(id); return hold ? [hold] : []; }),
    resolve: (classId: string, context: ProjectContext, override?: ScopeOverride) => policy.resolve(classId, context, override, deps.classScope?.(classId)),
    applyOverride: async (threadId: string, override: ScopeOverride, approval?: { approvedRuleIds: string[] }) => {
      prepareBinding(threadId);
      return enqueue(threadId, async check => {
        const record = store.records.get(threadId), current = record?.template ?? record?.scope;
        if (!current) throw new Error("No valid scope for thread " + threadId);
        const result = policy.apply(current, deps.projectForThread?.(threadId) ?? {}, override, approval?.approvedRuleIds);
        const scope = await bindAndWrite(threadId, result.scope, check);
        return { scope, widenings: result.widenings, problems: result.problems };
      });
    },
    policy: (context: ProjectContext) => policy.policy(context),
    rememberWidening: (context: ProjectContext, classId: string, ruleIds: string[], target?: "project" | "global") => policy.rememberWidening(context, classId, ruleIds, target),
  };
}
