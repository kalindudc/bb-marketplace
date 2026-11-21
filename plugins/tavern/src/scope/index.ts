import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { bindPaths, realPath, type ScopePaths } from "./paths";
import { narrowScope, scopeForClass } from "./presets";
import { scopeHostTargetSchema, scopeSchema, type ClassScope, type Scope, type ScopeNarrowing, type ScopeOverride } from "./schema";
import { ScopeStore } from "./store";
import { issueActGrant, revokeActGrant, type ActGrant } from "./act-grants";
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
  assignedBranchForThread?(threadId: string): Promise<string | undefined>;
  hostTargetForThread?(threadId: string): import("./schema").ScopeHostTarget | undefined;
  onHostTemplateChanged?(threadId: string): void;
  onScopeModeChanged?(threadId: string, mode: ScopeMode): void;
  narrowBoundScope?(scope: Scope): Scope;
  pullRequestPolicy?(threadId: string): Scope["pullRequestPolicy"];
  communicationPolicy?(threadId: string): Pick<Scope, "sendTools" | "communicationAuthority">;
  dataDir?: string;
  pathsForThread(threadId: string): ScopeThreadPaths | Promise<ScopeThreadPaths>;
  projectForThread?(threadId: string): ProjectContext;
  classScope?(classId: string): ClassScope | undefined;
  policyOptions?: PolicyOptions;
  guard?: GuardOptions;
  installGuard?: boolean;
}
export type ScopeThreadPaths = Omit<ScopePaths, "home" | "tmp" | "scopesDir"> & {
  remoteOpen?: { hostId: string; cwd: string };
};
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
  const enqueue = <T>(threadId: string, work: (check: (bindingChanged?: boolean) => void) => Promise<T>) => {
    let revision = store.revision(threadId);
    const deadlineAt = Date.now() + 2000;
    let expired = false, timer: ReturnType<typeof setTimeout>;
    const timeoutError = () => new Error("Scope binding timed out after 2000 ms");
    const check = (bindingChanged = false) => {
      if (expired || Date.now() >= deadlineAt) throw timeoutError();
      if (bindingChanged) revision = store.revision(threadId);
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
    const target = deps.hostTargetForThread?.(threadId);
    if (target) return store.markHostBinding(threadId, scopeHostTargetSchema.parse(target));
    const current = store.records.get(threadId)?.binding;
    if (current) return current;
    const state = hostStateForThread(threadId);
    if (state !== undefined) return store.markHostBinding(threadId, { kind: "host", placementId: state.kind === "ready" ? state.expected.placementId : null, generation: state.kind === "ready" ? state.expected.generation : null });
  };
  const withCommunicationPolicy = (scope: Scope, policy: Pick<Scope, "sendTools" | "communicationAuthority">): Scope => {
    const { sendTools: _oldRules, communicationAuthority: _oldAuthority, ...base } = scope;
    return { ...base, ...policy };
  };
  const bindAndWrite = async (threadId: string, input: Scope, check: (bindingChanged?: boolean) => void, preserveProvenance = false) => {
    let template = scopeSchema.parse({ ...input, threadId, issuedAt: input.issuedAt || Date.now() });
    if (template.role === "smith" && !template.assignedBranch) {
      const assignedBranch = await deps.assignedBranchForThread?.(threadId);
      if (assignedBranch) template = { ...template, assignedBranch };
    }
    const paths = prepareBinding(threadId) ? undefined : await deps.pathsForThread(threadId);
    check();
    const revision = store.revision(threadId);
    if (paths?.remoteOpen) {
      if (template.preset !== "open") throw new Error("Only an open Keeper scope can bind remotely without a native delivery");
      store.markHostBinding(threadId, { kind: "host", placementId: null, generation: null });
    } else prepareBinding(threadId);
    check(store.revision(threadId) !== revision);
    const current = store.records.get(threadId), enforceFrom = current?.scope?.enforceFrom ?? template.enforceFrom;
    template = { ...template, mode, ...(enforceFrom === undefined ? {} : { enforceFrom }) };
    if (deps.pullRequestPolicy) template.pullRequestPolicy = deps.pullRequestPolicy(threadId);
    if (deps.communicationPolicy) template = withCommunicationPolicy(template, deps.communicationPolicy(threadId));
    if (current?.binding) {
      if (current.binding.placementId === null && current.scope?.preset === "open" && template.preset !== "open") throw new Error("Only an open Keeper scope can bind remotely without a native delivery");
      if (!current.error && JSON.stringify(current.scope) === JSON.stringify(template) && JSON.stringify(current.template) === JSON.stringify(template)) return current.scope!;
      const scope = store.write(threadId, template, template, undefined, preserveProvenance);
      deps.onHostTemplateChanged?.(threadId);
      return scope;
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
    return store.write(threadId, scope, template, undefined, preserveProvenance);
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
      return bindAndWrite(threadId, record.template, check, true);
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
    refreshPresetTools: (threadId: string) => {
      const result = store.refreshPresetTools(threadId);
      if (result === "updated" && store.records.get(threadId)?.binding) deps.onHostTemplateChanged?.(threadId);
      return result;
    },
    protectOpenPolicy: (threadId: string) => {
      prepareBinding(threadId);
      return enqueue(threadId, async check => {
        const record = store.records.get(threadId), current = record?.template ?? record?.scope;
        if (!current || record?.error || current.preset !== "open") return false;
        if (record?.binding) return false;
        const deny = "~/.agents/tavern/scopes.yml";
        const bound = realPath(join(deps.policyOptions?.home ?? homedir(), ".agents/tavern/scopes.yml"));
        if (current.writes.deny.includes(deny) || current.writes.deny.includes(bound)) return false;
        await bindAndWrite(threadId, { ...current, writes: { ...current.writes, deny: [...current.writes.deny, deny] } }, check);
        return true;
      });
    },
    openKeeperScope: (threadId: string) => {
      prepareBinding(threadId);
      return enqueue(threadId, async check => {
        const record = store.records.get(threadId), current = record?.template ?? record?.scope;
        if (!current || record?.error || record?.presetProvenance || current.preset === "open") return false;
        const legacy = scopeForClass(current.role, undefined, "keeper").tools.allow;
        const known = [[], ["check_ui", "ui_examples"], ["check_ui", "ui_examples", "write", "Write", "edit", "Edit"]].some(removed => {
          const previous = legacy.filter(name => !removed.includes(name));
          return previous.length === current.tools.allow.length && previous.every((name, index) => current.tools.allow[index] === name);
        });
        if (current.preset !== "keeper" && !known) return false;
        const open = scopeForClass(current.role, undefined, "open");
        open.tools.allow = [...new Set([...open.tools.allow, ...current.tools.allow])];
        open.writes.allow = [...current.writes.allow];
        open.shell.allow = structuredClone(current.shell.allow);
        await bindAndWrite(threadId, { ...open, threadId, issuedAt: Date.now() }, check);
        return true;
      });
    },
    scopeForHire: (classId: string, narrowing?: ScopeNarrowing) => narrowScope(policy.resolve(classId, {}, {}, deps.classScope?.(classId)).scope, narrowing),
    setMode: (value: ScopeMode) => {
      if (!["enforce", "watch", "off"].includes(value)) throw new Error("Unknown Tavern scope mode: " + value);
      mode = value;
      for (const threadId of store.records.keys()) {
        const previous = store.records.get(threadId);
        if ((previous?.mode ?? previous?.scope?.mode) === mode) continue;
        store.setMode(threadId, mode);
        deps.onScopeModeChanged?.(threadId, mode);
        if (previous?.binding && previous.template?.mode !== mode) deps.onHostTemplateChanged?.(threadId);
        if (mode !== "enforce") store.saveProgress(threadId, store.progress(threadId).cursor, false);
      }
      return mode;
    },
    mode: () => mode,
    revokeClusterGrant: (threadId: string, askId: string) => revokeActGrant(store.file(threadId), askId),
    clusterGuardArmed: (threadId: string) => !store.records.get(threadId)?.error && store.isArmed(threadId, true),
    issueClusterGrant(grant: ActGrant) {
      const check = () => {
        if (store.records.get(grant.threadId)?.error || !store.isArmed(grant.threadId, true))
          throw new Error("This thread cannot be guarded. Cluster writes are not prevented.");
      };
      check();
      issueActGrant(store.file(grant.threadId), grant, check);
    },
    writeScope,
    rebindScope,
    refreshPullRequestPolicy(threadId: string) {
      const record = store.records.get(threadId);
      if (!record?.scope || record.error || !deps.pullRequestPolicy) return false;
      const pullRequestPolicy = deps.pullRequestPolicy(threadId);
      if (JSON.stringify(record.scope.pullRequestPolicy) === JSON.stringify(pullRequestPolicy)) return true;
      const bound = { ...record.scope, pullRequestPolicy };
      store.write(threadId, bound, record.template && { ...record.template, pullRequestPolicy }, undefined, true);
      if (record.binding) deps.onHostTemplateChanged?.(threadId);
      return true;
    },
    refreshCommunicationPolicy(threadId: string) {
      const record = store.records.get(threadId);
      if (!record?.scope || record.error || !deps.communicationPolicy) return;
      const policy = deps.communicationPolicy(threadId);
      if (JSON.stringify([record.scope.sendTools, record.scope.communicationAuthority]) === JSON.stringify([policy.sendTools, policy.communicationAuthority])) return;
      store.write(threadId, withCommunicationPolicy(record.scope, policy), record.template && withCommunicationPolicy(record.template, policy), undefined, true);
      if (record.binding) deps.onHostTemplateChanged?.(threadId);
    },
    sendGuardArmed: (threadId: string) => store.isArmed(threadId, false, true),
    messagePolicyProblem: (threadId: string) => store.messagePolicyProblem(threadId),
    scopeFile: (threadId: string) => store.file(threadId),
    scopeTemplate: (threadId: string) => store.records.get(threadId)?.template,
    rebuildScope(threadId: string, template: Scope, next: Scope) {
      return enqueue(threadId, async check => {
        const before = store.records.get(threadId);
        if (before?.template !== template || !before.scope || before.error) return false;
        const updated = {
          ...next, role: template.role, threadId, issuedAt: template.issuedAt, mode,
          ...(template.assignedBranch ? { assignedBranch: template.assignedBranch } : {}),
          ...(template.expectedWorktree ? { expectedWorktree: template.expectedWorktree } : {}),
          ...(template.workspaceKind ? { workspaceKind: template.workspaceKind } : {}),
          ...(template.checks ? { checks: template.checks } : {}),
        };
        if (next.preset !== "checker") delete updated.checks;
        await bindAndWrite(threadId, updated, check);
        return store.records.get(threadId) !== before;
      });
    },
    localScopeRecord: (threadId: string) => {
      const record = store.records.get(threadId);
      return record?.scope && !record.error && !record.binding ? { file: record.file, scope: record.scope } : null;
    },
    hostTemplate: (threadId: string) => originalHostTemplate(store.records.get(threadId)),
    clearScope: (threadId: string) => store.clear(threadId),
    status: () => ({ mode, installation, guard: guardStatus(guard), threads: [...store.records.entries()].map(([threadId, record]) => {
      const state = hostStateForThread(threadId), hosted = !!record.binding || state !== undefined;
      return { threadId, scope: record.scope, error: record.error, hasTemplate: !!record.template, armed: locallyArmed(threadId), ...(record.binding ? { binding: record.binding } : {}), ...(hosted ? { hostScope: state?.kind === "ready" && envForScope(store.records, threadId, { hostId: state.expected.hostId, hostScope: state }).length ? "acknowledged" as const : "unresolved" as const } : {}), ...(record.binding && !record.binding.placementId && record.scope?.preset === "open" ? { observation: "unavailable (remote open scope)" as const } : {}), ...(store.observationHold(threadId) ? { observationHold: store.observationHold(threadId) } : {}) };
    }) }),
    violations: (threadId?: string) => store.violations(threadId),
    observationHolds: (threadId?: string) => (threadId ? [threadId] : [...store.records.keys()]).flatMap(id => { const hold = store.observationHold(id); return hold ? [hold] : []; }),
    resolve: (classId: string, context: ProjectContext, override?: ScopeOverride) => policy.resolve(classId, context, override, deps.classScope?.(classId)),
    applyOverride: async (threadId: string, override: ScopeOverride, approval?: { approvedRuleIds: string[] }) => {
      prepareBinding(threadId);
      return enqueue(threadId, async check => {
        const record = store.records.get(threadId), current = record?.template ?? record?.scope;
        if (!current) throw new Error("No valid scope for thread " + threadId);
        const result = policy.apply(current, deps.projectForThread?.(threadId) ?? {}, override, approval?.approvedRuleIds, record?.scope ?? undefined);
        const scope = await bindAndWrite(threadId, result.scope, check);
        return { scope, widenings: result.widenings, problems: result.problems };
      });
    },
    resolveForRefresh: (classId: string, context: ProjectContext, definition: ClassScope | undefined, files: ReturnType<ScopePolicy["policy"]>, override?: ScopeOverride) =>
      policy.resolve(classId, context, override, definition, files),
    replayOverride: (scope: Scope, context: ProjectContext, files: ReturnType<ScopePolicy["policy"]>, override: ScopeOverride, approved?: string[]) =>
      policy.apply(scope, context, override, approved, scope, files),
    policy: (context: ProjectContext) => policy.policy(context),
    rememberWidening: (context: ProjectContext, classId: string, ruleIds: string[], target?: "project" | "global") => policy.rememberWidening(context, classId, ruleIds, target),
  };
}
