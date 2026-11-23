import { memberHost } from "./member-engagement";
import { wasReleased } from "../shared/member-engagement";
import type { ActGrant } from "../scope/act-grants";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  registerScopes,
  scopeSchema,
  evaluate,
  type Scope,
  type ProjectContext,
  type ScopeOverride,
  type ScopeResolution,
  type ScopesDeps,
  type Violation,
} from "../scope";
import {
  ensureGuardInstalled,
  guardStatus,
  uninstallGuard,
} from "../scope/install";
import { gitWorktreeRoot, needsWorktree } from "../scope/worktree";
import { normalizeRemote } from "../scope/remote";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Ask, Member } from "../shared/schema";
import { publishShellGrants, readShellGrants, removeShellGrantProjection, scopeRestartReason, shellGrantCapable, shellGrantTarget, shellGrantUse } from "../scope/shell-grants";
import { actAskKind } from "../scope/act-routing";
import { withMemoryCommandPolicy } from "../scope/memory-policy";
import { prepareCall } from "../scope/prepare";
import { shellCommunication } from "../scope/shell-communication";
import { settleShellGrant } from "./shell-grants";
import { isLiveKeeper, isLiveMember } from "./liveness";
import { commitUserAct, type UserActReceipt } from "./authority";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { SCOPE_DENIAL_TEXT, WORKTREE_UNBOUND } from "../shared/text";
import type { ScopeRequest } from "./keeper/store";
import { readUndoLanes } from "./undo-record";
import { acknowledgeCommunicationHolds, readCommunicationHolds, revokeCommunicationReceipt } from "../scope/communication-holds";
import { approvedDrafts, communicationPolicy, recordCommunication } from "./communication";
import type { TavernRuntime } from "./runtime";

function scopeChanges(before: Scope, after: Scope) {
  const added = (next: string[], prior: string[]) => next.filter(value => !prior.includes(value));
  const labels = (prefix: string, values: string[]) => values.map(value => `${prefix} ${value}`);
  const allowed = [...labels("tool", added(after.tools.allow, before.tools.allow)), ...labels("tool", added(before.tools.deny, after.tools.deny)), ...labels("write to", added(after.writes.allow, before.writes.allow))];
  const denied = [...labels("tool", added(after.tools.deny, before.tools.deny)), ...labels("tool", added(before.tools.allow, after.tools.allow)), ...labels("write to", added(after.writes.deny, before.writes.deny)), ...labels("write to", added(before.writes.allow, after.writes.allow))];
  const phrases: string[] = [];
  const list = (heading: string, items: string[]) => {
    const values = [...new Set(items)];
    if (values.length) phrases.push(`${heading}: ${values.slice(0, 4).join(", ")}${values.length > 4 ? ` and ${values.length - 4} more` : ""}`);
  };
  list("now allowed", allowed);
  list("now denied", denied);
  if (!isDeepStrictEqual(before.shell, after.shell)) phrases.push("shell rules changed");
  if (before.preset !== after.preset) phrases.push(`class baseline is now ${after.preset}`);
  if (before.network !== after.network) phrases.push(after.network === "none" ? "network access is now denied" : "network access is now allowed");
  if (before.writes.mode !== after.writes.mode) phrases.push(`write access changed to ${after.writes.mode}`);
  const github = before.env.poisonGh && !after.env.poisonGh;
  const push = before.env.blockGitPush && !after.env.blockGitPush;
  if (github || push) phrases.push(`no longer set: the ${github && push ? "GitHub and push environment overrides" : github ? "GitHub environment override" : "push environment override"}`);
  const text = phrases.join("; ") || "Refreshed the saved scope binding";
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

export type BackendScopeOptions = Pick<
  ScopesDeps,
  "dataDir" | "installGuard" | "policyOptions" | "guard" | "mode"
>;
export class BackendScopes {
  readonly api: ReturnType<typeof registerScopes>;
  private resolvingProject: string | undefined;
  private resolvingClass: import("../shared/schema").ClassDef | undefined;
  private readonly cwd = new Map<string, string>();
  private readonly answering = new Map<string, Promise<void>>();
  private refreshingScopes = false;
  private readonly hostSendGuard = new Map<string, { at: number; status: "armed" | "restart" | "not-prevented"; problem?: string }>();
  constructor(
    readonly runtime: TavernRuntime,
    private readonly options: BackendScopeOptions = {},
  ) {
    this.api = registerScopes(runtime.bb, {
      ...options,
      pathsForThread: (threadId) => this.paths(threadId),
      assignedBranchForThread: threadId => this.assignedBranch(threadId),
      hostTargetForThread: threadId => {
        const record = runtime.placements().store.byMember(threadId);
        return record ? { kind: "host", placementId: record.id, generation: record.generation } : undefined;
      },
      hostScopeForThread: threadId => {
        const state = runtime.placements().deliveries.forThread(threadId);
        return state?.kind === "ready" && state.templateDigest !== this.api.hostTemplate(threadId).templateDigest
          ? { kind: "unavailable", reason: "Scope update pending; detection paused until the host acknowledges the effective scope." } : state;
      },
      onHostTemplateChanged: threadId => {
        this.hostSendGuard.delete(threadId);
        void runtime.placements().ready.reconcileForThread(threadId).catch(error => runtime.bb.log.warn(`Tavern scope delivery ${threadId}: ${String(error)}`));
        runtime.keeper.changed(threadId);
      },
      remoteForThread: threadId => {
        const services = runtime.placements();
        const placed = services.store.byMember(threadId) ? services.deliveries.observationForThread(threadId, services.host) : undefined;
        if (placed !== undefined) {
          if (placed.kind === "ready" && services.deliveries.get(placed.binding.placementId)?.templateDigest !== this.api.hostTemplate(threadId).templateDigest)
            return { kind: "unavailable", reason: "Scope update pending; detection paused until the host acknowledges the effective scope." };
          return placed;
        }
        return undefined;
      },
      narrowBoundScope: scope => runtime.away.narrowScope(scope),
      memoryCommandPaths: () => runtime.memory.commandPaths(),
      onScopeModeChanged: (threadId, mode) => this.scopeRefreshed(threadId, `Scope mode is now ${mode}.`),
      pullRequestPolicy: threadId => this.pullRequestPolicy(threadId),
      cwdForThread: (threadId) => this.cwd.get(threadId),
      projectForThread: (threadId) => this.context(threadId),
      classScope: (classId) => this.resolvingClass?.id === classId ? this.resolvingClass.scope :
        runtime
          .snapshot(this.resolvingProject)
          .classes.find((role) => role.id === classId)?.scope,
      onViolation: (violation) => this.violation(violation),
      communicationPolicy: threadId => communicationPolicy(runtime.keeper, threadId, runtime.config().scopes.sendTools, this.api?.localScopeRecord(threadId)?.file, runtime.away.store.snapshot().status.closed),
      drainCommunication: (threadId, idle) => this.drainCommunication(threadId, idle),
      onActObservation: (observation) => this.observeAct(observation),
      onShellGrantUsed: (threadId, id) => { this.recordGrantUse(threadId, id); this.syncGrants(threadId); },
    });
  }
  refreshMemoryGuards() {
    for (const row of this.api.status().threads) this.api.refreshMemoryPolicy(row.threadId);
  }
  refreshCommunication(threadId?: string, keeperId?: string) {
    if (threadId) { this.api.refreshCommunicationPolicy(threadId); return; }
    for (const row of this.api.status().threads) {
      const member = keeperId && this.runtime.keeper.member(row.threadId);
      if (!keeperId || row.threadId === keeperId || member && member.keeperThreadId === keeperId) this.api.refreshCommunicationPolicy(row.threadId);
    }
  }
  async drainCommunication(threadId: string, idle = false) {
    const local = this.api.localScopeRecord(threadId), remote = local ? null : this.clusterHost(threadId);
    if (!local && !remote) { this.hostSendGuard.delete(threadId); return; }
    let holds;
    if (local) holds = readCommunicationHolds(local.file);
    else {
      if (!idle && Date.now() - (this.hostSendGuard.get(threadId)?.at ?? 0) < 3000) return;
      const result = await remote!.host.call(remote!.hostId, "communicationHolds", { ...remote!.input, acknowledge: [] });
      this.hostSendGuard.set(threadId, { at: Date.now(), status: result.guard, problem: result.problem });
      holds = result.holds;
    }
    if (!holds.length) return;
    for (const hold of holds) if (hold.threadId === threadId && (!local || hold.scopeIssuedAt === local.scope.issuedAt)) recordCommunication(this.runtime.keeper, hold);
    const ids = holds.map(hold => hold.id);
    if (local) acknowledgeCommunicationHolds(local.file, ids);
    else await remote!.host.call(remote!.hostId, "communicationHolds", { ...remote!.input, operationId: randomUUID(), acknowledge: ids });
  }
  async revokeDraftReceipts(questId: string, delegationId: string) {
    const k = this.runtime.keeper;
    await this.fenceDraftReceipts(approvedDrafts(k, questId).filter(({ id }) => k.store.get("asks", id)?.answer?.draftDelegationId === delegationId));
  }
  async fenceDraftReceipts(rows: ReturnType<typeof approvedDrafts>) {
    const batches = new Map<string, string[]>();
    for (const row of rows) batches.set(row.threadId, [...(batches.get(row.threadId) ?? []), row.id]);
    await Promise.all([...batches].map(async ([threadId, askIds]) => {
      const local = this.api.localScopeRecord(threadId);
      if (local) { for (const askId of askIds) revokeCommunicationReceipt(local.file, askId); return; }
      const { store, host, deliveries } = this.runtime.placements(), placement = store.byMember(threadId);
      const record = placement && deliveries.get(placement.id);
      if (!record || record.memberThreadId !== threadId) return;
      const { placementId, endpointId, generation, hostId } = record.binding;
      for (let i = 0; i < askIds.length; i += 100) await host.call(hostId, "revokeDraftReceipts", {
        operationId: randomUUID(), placementId, endpointId, generation, askIds: askIds.slice(i, i + 100),
      });
    }));
  }
  private clusterHost(threadId: string) {
    const { deliveries, host } = this.runtime.placements();
    const row = this.api.status().threads.find(row => row.threadId === threadId);
    if (row?.hostScope !== "acknowledged") return null;
    const state = deliveries.forThread(threadId);
    if (state?.kind !== "ready") return null;
    const { hostId, cwd: _cwd, ...binding } = state.expected;
    return { host, hostId, input: { ...binding, operationId: randomUUID() } };
  }
  async clusterGuardArmed(threadId: string) {
    if (this.api.clusterGuardArmed(threadId)) return true;
    const remote = this.clusterHost(threadId);
    if (!remote) return false;
    try { return (await remote.host.call(remote.hostId, "sessionStatus", remote.input)).clusterWrites === true; }
    catch { return false; }
  }
  async revokeClusterGrant(threadId: string, askId: string) {
    const { store, deliveries, host } = this.runtime.placements();
    const placement = store.byMember(threadId);
    if (!placement) return this.api.revokeClusterGrant(threadId, askId);
    const record = deliveries.get(placement.id);
    if (!record || record.memberThreadId !== threadId) return;
    const { hostId, placementId, generation, endpointId } = record.binding;
    await host.call(hostId, "revokeClusterGrant", { placementId, generation, endpointId, operationId: randomUUID(), askId });
  }
  async issueClusterGrant(grant: ActGrant) {
    const remote = this.clusterHost(grant.threadId);
    if (!remote) return this.api.issueClusterGrant(grant);
    await remote.host.call(remote.hostId, "issueClusterGrant", { ...remote.input, grant });
  }
  private pullRequestPolicy(threadId: string) {
    const k = this.runtime.keeper, member = k.member(threadId);
    const keeper = member?.role === "keeper";
    const owned = keeper || member?.classId === "wanderer" ? k.store.all("pullRequests").filter(pr =>
      ["draft", "ready"].includes(pr.state) && pr.owner !== "user" && (keeper ? pr.keeperThreadId === threadId && !!pr.boardQuestId : pr.owner === threadId)
    ).map(pr => pr.url).slice(-1000) : [];
    const grants = keeper ? k.store.query("decisions", "keeperThreadId", threadId, 500).flatMap(decision => {
      if (!decision.pullRequestGrant || decision.undone || !decision.askId) return [];
      const ask = k.store.get("asks", decision.askId);
      return ask?.state === "answered" && ask.answer?.by === "keeper" && k.authority.lane(ask) === "keeper" ? [{ id: decision.id, digest: decision.pullRequestGrant.digest }] : [];
    }).slice(0, 100) : [];
    const alwaysAsk = this.runtime.config().keepers.alwaysAsk.includes("sends-as-you") ||
      (keeper && readUndoLanes(k.store, threadId).some(lane => lane.kind === "sends-as-you"));
    return { alwaysAsk, owned, grants };
  }
  refreshPullRequestPolicy(threadId: string) { return this.api.refreshPullRequestPolicy(threadId); }
  refreshPullRequestPolicies() {
    for (const { threadId } of this.api.status().threads) this.refreshPullRequestPolicy(threadId);
  }
  async refreshPresets() {
    const runtime = this.runtime;
    for (const row of this.api.status().threads) {
      const member = runtime.keeper.member(row.threadId), state = runtime.keeper.store.runtime(row.threadId);
      try {
        this.refreshPullRequestPolicy(row.threadId);
        this.syncGrants(row.threadId);
        if (await this.api.protectOpenPolicy(row.threadId)) {
          runtime.keeper.store.event(runtime.keeper.now(), member?.keeperThreadId ?? row.threadId, member?.boardQuestId ?? null,
            "scope.refreshed", "Protected the trusted scope policy in an open scope",
            { memberThreadId: row.threadId, deny: "~/.agents/tavern/scopes.yml" }, { kind: "tavern" });
          runtime.bb.log.info(`Tavern scope policy protection added ${row.threadId}: ~/.agents/tavern/scopes.yml`);
          if (member) runtime.keeper.changed(row.threadId, member.boardQuestId);
        }
        if (!member || memberHost(this.runtime.keeper.store, member).archivedAt !== null || memberHost(this.runtime.keeper.store, member).deletedAt !== null || wasReleased(member) || (member.role === "keeper" && row.scope?.preset === "open")) continue;
        const result = member.role === "keeper"
          ? await this.api.openKeeperScope(row.threadId) ? "updated" : "skipped"
          : this.api.refreshPresetTools(row.threadId);
        if (result === "skipped") runtime.bb.log.info(`Tavern scope preset refresh skipped ${row.threadId}: allowlist is not an exact legacy preset`);
        if (result !== "updated") continue;
        runtime.keeper.store.event(runtime.keeper.now(), member.keeperThreadId ?? member.threadId, member.boardQuestId,
          "scope.refreshed", member.role === "keeper" ? "Keeper scope widened to open by Tavern 0.1.2" : "Added read-only renderer helpers from the current preset",
          { memberThreadId: row.threadId, ...(member.role === "keeper" ? { preset: "open" } : { tools: ["check_ui", "ui_examples"] }) }, { kind: "tavern" });
        runtime.keeper.changed(row.threadId, member.boardQuestId);
      } catch (error) { runtime.bb.log.warn(`Tavern scope preset refresh ${row.threadId}: ${String(error)}`); }
    }
  }
  private scopeRefreshed(threadId: string, text: string, policyVersion?: string) {
    const k = this.runtime.keeper, member = k.member(threadId);
    if (!member) return;
    if (!isLiveKeeper(k.store, member, "present") && !isLiveMember(k.store, member, "brief")) return;
    k.store.event(k.now(), member.keeperThreadId ?? threadId, member.boardQuestId, "scope.refreshed", text, { memberThreadId: threadId, ...(policyVersion ? { policyVersion } : {}) }, { kind: "tavern" });
    k.changed(threadId, member.boardQuestId);
  }
  async refreshLiveScopes() {
    if (this.refreshingScopes) return;
    this.refreshingScopes = true;
    const runtime = this.runtime, k = runtime.keeper;
    const projects = new Map<string, { snapshot: ReturnType<TavernRuntime["snapshot"]>; context: ProjectContext; files: ReturnType<BackendScopes["api"]["policy"]> }>();
    try {
      for (const row of this.api.status().threads) {
        const member = k.member(row.threadId);
        if (!row.scope || row.error || !member || !isLiveKeeper(k.store, member, "present") && !isLiveMember(k.store, member, "brief")) continue;
        try {
          const template = this.api.scopeTemplate(row.threadId);
          if (!template) continue;
          const state = k.store.runtime(row.threadId), projectId = state.projectId;
          if (!projectId || state.builtinKeeperFallback) continue;
          let project = projects.get(projectId);
          if (!project) {
            await runtime.prepareRegistry(projectId);
            const context = this.context(row.threadId);
            project = { snapshot: runtime.snapshot(projectId), context, files: this.api.policy(context) };
            projects.set(projectId, project);
          }
          const definition = project.snapshot.classes.find(role => role.id === member.classId);
          if (!definition) continue;
          const input = k.store.get("scopeInputs", row.threadId);
          const { context, files } = project;
          const resolved = this.api.resolveForRefresh(member.classId, context, definition.scope, files, input?.initial);
          if (!input) {
            const { threadId: _id, issuedAt: _issued, mode: _mode, checks: _checks, expectedWorktree: _root, assignedBranch: _branch, pullRequestPolicy: _prs, sendTools: _send, communicationAuthority: _communication, workspaceKind: _kind, enforceFrom: _from, env: priorEnv, ...prior } = withMemoryCommandPolicy(template, []);
            const { threadId: _nextId, issuedAt: _nextIssued, mode: _nextMode, checks: _nextChecks, expectedWorktree: _nextRoot, assignedBranch: _nextBranch, pullRequestPolicy: _nextPrs, sendTools: _nextSend, communicationAuthority: _nextCommunication, workspaceKind: _nextKind, enforceFrom: _nextFrom, env: nextEnv, ...next } = resolved.scope;
            if (!isDeepStrictEqual({ ...prior, variables: priorEnv.variables }, { ...next, variables: nextEnv.variables })) continue;
            k.store.put("scopeInputs", row.threadId, { changes: [] });
          }
          let scope = resolved.scope;
          for (const change of input?.changes ?? []) scope = this.api.replayOverride(scope, context, files, change.override, change.approved).scope;
          const version = createHash("sha256").update(JSON.stringify(files.sources)).digest("hex");
          const fingerprint = createHash("sha256").update(JSON.stringify([scope, version, this.api.mode()])).digest("hex");
          if (fingerprint !== input?.fingerprint) {
            const updated = await this.api.rebuildScope(row.threadId, template, scope);
            if (updated) this.scopeRefreshed(row.threadId, scopeChanges(template, this.api.scopeTemplate(row.threadId) ?? scope), version);
            if ((updated || this.api.scopeTemplate(row.threadId) === template) && k.store.get("scopeInputs", row.threadId)?.changes.length === (input?.changes.length ?? 0))
              k.store.put("scopeInputs", row.threadId, { ...(input?.initial ? { initial: input.initial } : {}), changes: input?.changes ?? [], fingerprint });
          }
          this.syncGrants(row.threadId);
        } catch (error) { runtime.bb.log.warn(`Tavern scope refresh ${row.threadId}: ${String(error)}`); }
      }
    } finally { this.refreshingScopes = false; }
  }
  private storeScopeOverride(threadId: string, override: ScopeOverride, approved?: string[]) {
    const store = this.runtime.keeper.store, inputs = store.get("scopeInputs", threadId);
    if (inputs) store.put("scopeInputs", threadId, { ...inputs, fingerprint: undefined, changes: [...inputs.changes, { override, ...(approved ? { approved } : {}) }] });
  }
  context(threadId: string): ProjectContext {
    if (this.runtime.keeper.member(threadId)?.role === "keeper" && this.runtime.keeper.store.runtime(threadId).builtinKeeperFallback) return {};
    const projectId = this.runtime.keeper.store.runtime(threadId).projectId;
    if (!projectId)
      throw new Error("A scoped thread needs a trusted project binding");
    return this.runtime.scopeProjectContext(projectId);
  }
  async prepare(threadId: string) {
    const thread = await this.runtime.bb.sdk.threads.get({ threadId });
    await this.runtime.prepareRegistry(thread.projectId);
    return thread;
  }
  async assignedBranch(threadId: string): Promise<string | undefined> {
    const member = this.runtime.keeper.member(threadId);
    if (member?.classId !== "smith") return;
    const pinned = this.runtime.keeper.store.runtime(threadId).scopeAssignedBranch;
    if (pinned) return pinned.branch;
    const thread = await this.runtime.bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return;
    const placement = this.runtime.placements().store.byMember(threadId);
    const carry = placement?.carries?.find(receipt => receipt.generation === placement.generation && receipt.phase === "verified");
    const existing = this.api.status().threads.find(row => row.threadId === threadId)?.scope;
    if (!carry && existing?.expectedWorktree && !existing.assignedBranch) return;
    const environment = await this.runtime.bb.sdk.environments.get({ environmentId: thread.environmentId });
    const branch = carry?.branch ?? environment.branchName;
    if (!branch) return;
    this.runtime.keeper.store.patch(threadId, { scopeAssignedBranch: { environmentId: thread.environmentId, branch } });
    return branch;
  }
  async paths(threadId: string) {
    const bb = this.runtime.bb;
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) {
      // Admission runs before provisioning; the session env contribution binds real paths later.
      this.cwd.delete(threadId);
      return {};
    }
    const config = await bb.sdk.system.config();
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    const placed = this.runtime.placements().store.byMember(threadId);
    if (placed) {
      if (placed.root) this.cwd.set(threadId, placed.root);
      else this.cwd.delete(threadId);
      return {};
    }
    if (environment && environment.hostId !== config.primaryHostId) {
      if (!environment.path)
        throw new Error("An unplaced scoped member on another host needs a machine rule; no controller-local scope paths can be used");
      const remoteOpen = { hostId: environment.hostId, cwd: environment.path };
      this.cwd.set(threadId, environment.path);
      return { remoteOpen };
    }
    const storage = await bb.sdk.threads.storageLocation({ threadId });
    if (storage.hostId !== config.primaryHostId)
      throw new Error("Tavern scopes require server-local thread storage");
    if (environment?.path) this.cwd.set(threadId, environment.path);
    else this.cwd.delete(threadId);
    return {
      worktree:
        environment?.isWorktree && environment.path
          ? environment.path
          : undefined,
      threadStorage: storage.storageRootPath,
    };
  }
  async resolve(classId: string, projectId?: string, override?: ScopeOverride, definition?: import("../shared/schema").ClassDef) {
    if (projectId) await this.runtime.prepareRegistry(projectId);
    // The scope callback has only a class id; resolution itself is synchronous and project-specific.
    this.resolvingProject = projectId;
    this.resolvingClass = definition;
    try {
      const result = this.api.resolve(classId, projectId ? this.runtime.scopeProjectContext(projectId) : {}, override);
      if (override) this.validateTools(override, result.scope);
      return result;
    } finally {
      this.resolvingProject = undefined;
      this.resolvingClass = undefined;
    }
  }
  async checkerChecks(environmentId: string | null, commands: string[]) {
    const checks: NonNullable<Scope["checks"]> = { commands };
    try {
      if (!environmentId) throw new Error("The maker has no ready environment");
      const environment = await this.runtime.bb.sdk.environments.get({ environmentId });
      if (!environment.isWorktree || !environment.path)
        throw new Error("The maker environment is not a linked Git worktree");
      const config = await this.runtime.bb.sdk.system.config();
      if (environment.hostId !== config.primaryHostId)
        throw new Error("The maker worktree is not on the server host");
      checks.worktree = gitWorktreeRoot(environment.path);
      return { checks, problems: [] as string[] };
    } catch (error) {
      const problem = `Maker worktree unavailable; checks are closed, ordinary reads remain available: ${String(error)}`;
      this.runtime.bb.log.warn(`Tavern checker binding: ${problem}`);
      return { checks, problems: [problem] };
    }
  }
  private validateTools(override: ScopeOverride, scope: Scope) {
    const commands = new Set(["npm", "npx", "node", "pnpm", "yarn", "bun", "git", "gh", "cargo", "go", "python", "python3", "ruby", "bundle", "make"]);
    for (const name of Object.values(override.tools ?? {}).flatMap(names => names ?? [])) {
      if (/\s|[|;&<>`$]/.test(name) || commands.has(name)) {
        const cwd = scope.preset === "checker" ? scope.checks?.worktree : this.cwd.get(scope.threadId) ?? scope.expectedWorktree;
        const decision = cwd ? evaluate(scope, { kind: "bash", toolName: "bash", input: { command: name }, cwd }) : null;
        const label = this.runtime.snapshot(this.resolvingProject).classes.find(role => role.id === scope.role)?.label ?? scope.role;
        if (decision?.allow)
          throw new Error(`${name} is a shell command; the ${label} preset already allows it. No tool grant or scope ask is needed.`);
        throw new Error(`${name} is a shell command, not a tool name; ${decision && !decision.allow ? `blocked by ${decision.ruleId}: ${decision.reason}` : "commands are governed by the preset and shell rules, not tools.allow"}. No tool-name grant can authorize a shell command.`);
      }
    }
  }
  async pinWorktree(threadId: string) {
    const member = this.runtime.keeper.member(threadId);
    if (
      !this.api.shouldScope(
        member?.classId,
        member?.role === "member" ? "hire" : "direct",
      )
    )
      return;
    const row = this.api.status().threads.find(row => row.threadId === threadId);
    const scope = row?.scope;
    if (row?.binding) return;
    if (!scope || (!needsWorktree(scope) && scope.writes.mode !== "worktree" && !scope.expectedWorktree)) return;
    if (scope.expectedWorktree) {
      if (this.clearWorktreeProblem(threadId)) this.runtime.keeper.changed(threadId, member?.boardQuestId);
      return;
    }
    const paths = await this.paths(threadId);
    if (!paths.worktree) {
      if (!this.runtime.keeper.store.runtime(threadId).scopeProblems?.includes(WORKTREE_UNBOUND)) {
        this.recordProblems(threadId, [...this.runtime.keeper.store.runtime(threadId).scopeProblems ?? [], WORKTREE_UNBOUND]);
        this.runtime.keeper.store.event(this.runtime.keeper.now(), member?.keeperThreadId ?? threadId, member?.boardQuestId ?? null,
          "scope.reader", WORKTREE_UNBOUND, { memberThreadId: threadId }, { kind: "tavern" });
        this.runtime.keeper.changed(threadId, member?.boardQuestId);
      }
      return;
    }
    const bound = await this.api.rebindScope(threadId);
    if (!bound.expectedWorktree) return;
    if (this.clearWorktreeProblem(threadId)) {
      this.runtime.keeper.store.event(this.runtime.keeper.now(), member?.keeperThreadId ?? threadId, member?.boardQuestId ?? null,
        "scope.bound", "The Smith’s worktree is bound; its worktree scope is active.", { memberThreadId: threadId }, { kind: "tavern" });
    }
    this.runtime.keeper.changed(threadId, member?.boardQuestId);
  }

  private clearWorktreeProblem(threadId: string) {
    const store = this.runtime.keeper.store;
    const problems = store.runtime(threadId).scopeProblems ?? [];
    if (!problems.includes(WORKTREE_UNBOUND)) return false;
    store.patch(threadId, { scopeProblems: problems.filter(problem => problem !== WORKTREE_UNBOUND) });
    return true;
  }
  private recordProblems(threadId: string, problems: string[]) {
    const bounded = problems.slice(0, 30);
    if (problems.length > bounded.length)
      bounded.push(`${problems.length - bounded.length} more policy problems`);
    this.runtime.keeper.store.patch(threadId, { scopeProblems: bounded });
    for (const problem of bounded)
      this.runtime.bb.log.warn(`Tavern scope policy ${threadId}: ${problem}`);
  }
  async ensure(member: Member) {
    if (
      !this.api.shouldScope(
        member.classId,
        member.role === "member" ? "hire" : "direct",
      )
    )
      return;
    const current = this.api
      .status()
      .threads.find((row) => row.threadId === member.threadId);
    const state = this.runtime.keeper.store.runtime(member.threadId);
    if (current?.scope && !(state.scopeKeeperFallback && !state.builtinKeeperFallback)) return this.pinWorktree(member.threadId);
    if (current?.error) throw new Error(current.error);
    const projectId = this.runtime.keeper.store.runtime(
      member.threadId,
    ).projectId;
    if (!projectId) throw new Error("Missing trusted project for scope");
    let resolution: ScopeResolution;
    if (state.builtinKeeperFallback) {
      if (member.role !== "keeper") throw new Error("Only a Keeper can use the built-in fallback scope");
      this.resolvingClass = this.runtime.builtinSnapshot().classes.find(role => role.id === "keeper");
      if (!this.resolvingClass) throw new Error("The built-in Keeper class is missing");
      try { resolution = this.api.resolve("keeper", {}); }
      finally { this.resolvingClass = undefined; }
    } else resolution = await this.resolve(member.classId, projectId);
    const checks = this.runtime.keeper.store.runtime(member.threadId).reviewTarget?.checks;
    if (resolution.scope.preset === "checker" && checks) resolution.scope.checks = checks;
    this.recordProblems(member.threadId, resolution.problems);
    await this.api.writeScope(member.threadId, resolution.scope);
    this.runtime.keeper.store.put("scopeInputs", member.threadId, { changes: [] });
    this.runtime.keeper.store.patch(member.threadId, { scopeKeeperFallback: !!state.builtinKeeperFallback });
    this.runtime.keeper.changed(member.threadId, member.boardQuestId);
  }
  pending(threadId: string) {
    const id = this.runtime.keeper.store.runtime(threadId).scopePending;
    return id ? this.runtime.keeper.store.get("scopeRequests", id) : null;
  }
  async hired(
    member: Member,
    resolution: ScopeResolution,
    override: ScopeOverride | undefined,
    brief: string,
    spawnInput = false,
  ) {
    const pending = this.pending(member.threadId);
    if (pending) return this.runtime.keeper.store.runtime(member.threadId).scopePending!;
    this.recordProblems(member.threadId, resolution.problems);
    await this.api.writeScope(member.threadId, resolution.scope);
    this.runtime.keeper.store.put("scopeInputs", member.threadId, { ...(override ? { initial: override } : {}), changes: [] });
    if (resolution.widenings.length) {
      const ask = this.request(
        member,
        override!,
        resolution.widenings,
        "The hired task requests a wider scope",
        brief,
        spawnInput,
      );
      return ask.id;
    }
    if (!spawnInput) await this.sendBrief(member.threadId, brief);
    return null;
  }
  private async sendBrief(threadId: string, text: string) {
    await this.runtime.sendInitialBrief(threadId, text);
  }
  async override(
    keeperThreadId: string,
    memberThreadId: string,
    override: ScopeOverride,
    reason: string,
  ) {
    const k = this.runtime.keeper;
    k.require(keeperThreadId, "keeper");
    memberThreadId = k.resolvePartyMember(keeperThreadId, memberThreadId).threadId;
    const member = k.member(memberThreadId);
    if (
      !member ||
      member.role !== "member" ||
      member.keeperThreadId !== keeperThreadId
    )
      throw new Error("Only change the scope of a member of your own party");
    if (member.boardQuestId) k.guard(keeperThreadId, member.boardQuestId);
    if (this.pending(memberThreadId))
      throw new Error("A scope request is already awaiting the user's answer");
    if (wasReleased(k.member(memberThreadId)))
      throw new Error("This member has been released");
    await this.prepare(memberThreadId);
    await this.ensure(member);
    const current = this.api.status().threads.find(row => row.threadId === memberThreadId)?.scope;
    if (!current) throw new Error("No valid scope for this member");
    this.validateTools(override, current);
    const result = await this.api.applyOverride(memberThreadId, override);
    this.storeScopeOverride(memberThreadId, override);
    this.recordProblems(memberThreadId, result.problems);
    const ask = result.widenings.length
      ? this.request(member, override, result.widenings, reason, null)
      : null;
    k.store.event(
      k.now(),
      keeperThreadId,
      member.boardQuestId,
      "scope.changed",
      reason,
      {
        memberThreadId,
        override,
        widenings: result.widenings,
        askId: ask?.id ?? null,
      },
      { kind: "agent", threadId: keeperThreadId },
    );
    k.changed(memberThreadId, member.boardQuestId);
    return ask
      ? `Safe narrowing applied; awaiting scope approval.\n::tavern-ask{id="${ask.id}"}`
      : JSON.stringify(current) === JSON.stringify(result.scope) ? "No change: these are already in effect; no scope ask is needed." : "Scope updated within the user's policy.";
  }
  private request(
    member: Member,
    override: ScopeOverride,
    widenings: string[],
    reason: string,
    initialBrief: string | null,
    spawnInput = false,
  ) {
    const k = this.runtime.keeper;
    const context = this.context(member.threadId);
    const remotes = [...new Set((context.remotes ?? []).map(normalizeRemote))];
    const candidates = context.pushRemote
      ? remotes.filter(
          (remote) => remote === normalizeRemote(context.pushRemote!),
        )
      : remotes;
    const remember =
      widenings.every((id) => !id.includes(":")) &&
      candidates.length > 0 &&
      candidates.length <= 3;
    const rememberRemotes = remember
      ? Object.fromEntries(
          candidates.map((remote, index) => [
            candidates.length === 1
              ? "remember-repo"
              : `remember-repo-${index + 1}`,
            remote,
          ]),
        )
      : {};
    const ask = k.ask(
      member.keeperThreadId!,
      { effect: { type: "grant-scope", memberThreadId: member.threadId },
        boardQuestId: member.boardQuestId,
        kind: "scope",
        question: `Widen ${this.runtime.keeper.name(member)}'s scope?`,
        why: `${reason.slice(0, 90)}. Review the full grant request. This changes a guardrail, not approval to merge, deploy, delete, send or write to production.`.slice(
          0,
          200,
        ),
        scopeChange: {
          memberThreadId: member.threadId,
          override,
          widenings,
          reason,
          ...context,
        },
        options: [
          {
            id: "approve",
            label: "Allow once for this member",
            detail: "Apply only these exact grants",
            recommended: false,
          },
          ...Object.entries(rememberRemotes).map(([id, remote]) => ({
            id,
            label:
              candidates.length === 1
                ? "Allow and remember for this repo"
                : `Remember for ${remote}`.slice(0, 160),
            detail:
              `Save only these Git push grants in your global policy for ${remote}`.slice(
                0,
                300,
              ),
            recommended: false,
          })),
          {
            id: "deny",
            label: "No widening; keep the existing scope",
            detail: SCOPE_DENIAL_TEXT,
            recommended: true,
          },
        ],
        meanwhile:
          "Continue unrelated work. This task must not rely on an unapproved grant.",
        holds: member.waypointId ? [member.waypointId] : [],
      },
      { memberThreadId: member.threadId, override, widenings },
    );
    k.store.put("scopeRequests", ask.id, {
      keeperThreadId: member.keeperThreadId!,
      boardQuestId: member.boardQuestId,
      memberThreadId: member.threadId,
      classId: member.classId,
      context,
      override,
      widenings,
      reason,
      initialBrief,
      spawnInput,
      rememberRemotes,
      state: "pending",
    });
    k.store.patch(member.threadId, { scopePending: ask.id });
    k.changed(member.threadId, member.boardQuestId);
    return ask;
  }
  async answer(ask: Ask) {
    const previous = this.answering.get(ask.id);
    if (previous) return previous;
    const work = this.applyAnswer(ask);
    this.answering.set(ask.id, work);
    try {
      await work;
    } finally {
      this.answering.delete(ask.id);
    }
  }
  private async applyAnswer(ask: Ask) {
    const k = this.runtime.keeper;
    const request = k.store.get("scopeRequests", ask.id);
    if (
      !request ||
      request.state !== "pending" ||
      ask.state !== "answered" ||
      ask.answer?.by !== "user"
    )
      return;
    const member = k.member(request.memberThreadId);
    if (
      !member ||
      member.keeperThreadId !== request.keeperThreadId ||
      wasReleased(member)
    )
      throw new Error(
        "The scope request no longer belongs to an active member",
      );
    if (ask.answer.optionId === "deny") {
      if (request.initialBrief)
        await this.runtime.release(
          request.keeperThreadId,
          member.threadId,
          "The user declined the task's required scope",
          { kind: "ask-answer", id: ask.id },
        );
      this.finish(ask, request, "declined");
      return;
    }
    const remembering = ask.answer.optionId.startsWith("remember-repo");
    const legacyRemote =
      request.context.pushRemote ??
      (request.context.remotes?.length === 1
        ? request.context.remotes[0]
        : undefined);
    const pushRemote =
      request.rememberRemotes?.[ask.answer.optionId] ??
      (ask.answer.optionId === "remember-repo" ? legacyRemote : undefined);
    if (ask.answer.optionId !== "approve" && (!remembering || !pushRemote))
      throw new Error(
        "Choose an offered trusted push destination or allow once",
      );
    await this.prepare(member.threadId);
    if (
      JSON.stringify(this.context(member.threadId)) !==
      JSON.stringify(request.context)
    )
      throw new Error(
        "The scope request's repository changed; request fresh approval",
      );
    const current = this.api.status().threads.find(row => row.threadId === member.threadId)?.scope;
    if (!current) throw new Error("No valid scope for this member");
    this.validateTools(request.override, current);
    await this.api.applyOverride(member.threadId, request.override, {
      approvedRuleIds: request.widenings,
    });
    this.storeScopeOverride(member.threadId, request.override, request.widenings);
    if (remembering) {
      if (!request.widenings.every((id) => !id.includes(":")))
        throw new Error(
          "Tool and path grants cannot be remembered automatically",
        );
      this.api.rememberWidening(
        { ...request.context, pushRemote },
        request.classId,
        request.widenings,
      );
    }
    // Spawn input is already durable in core; approval only releases its queued row.
    if (request.initialBrief && !request.spawnInput)
      await this.sendBrief(member.threadId, request.initialBrief);
    this.finish(ask, request, "applied");
    if (request.initialBrief && !request.spawnInput)
      await this.sendBrief(member.threadId, request.initialBrief);
  }
  private finish(
    ask: Ask,
    request: ScopeRequest,
    state: "applied" | "declined",
  ) {
    const k = this.runtime.keeper;
    k.store.atomic(() => {
      k.store.put("scopeRequests", ask.id, { ...request, state });
      k.store.patch(request.memberThreadId, { scopePending: null });
      k.store.event(
        k.now(),
        ask.keeperThreadId,
        ask.boardQuestId,
        `scope.${state}`,
        state === "declined" ? `${SCOPE_DENIAL_TEXT} Member: ${request.memberThreadId}.` : `Applied scope grants for ${request.memberThreadId}: ${request.widenings.join(", ")}`,
        { askId: ask.id, ...request },
        { kind: "user" },
      );
    });
    k.changed(request.memberThreadId, request.boardQuestId);
    void this.runtime.bb.experimental_hooks
      .recheck("message.dispatch")
      .catch((error) =>
        this.runtime.bb.log.warn(`Tavern scope recheck: ${String(error)}`),
      );
  }
  async resume(keeperThreadId: string) {
    const k = this.runtime.keeper;
    for (const request of k.store.pendingScopeRequests(keeperThreadId)) {
      const ask = k.store.get("asks", request.id);
      if (ask?.state === "answered") {
        try {
          await this.answer(ask);
        } catch (error) {
          this.runtime.bb.log.warn(
            `Tavern scope approval ${ask.id}: ${String(error)}`,
          );
        }
      }
    }
  }
  clearGrantProjections() {
    for (const { threadId } of this.api.status().threads) removeShellGrantProjection(this.api.scopeFile(threadId));
  }
  syncGrants(threadId: string) {
    const record = this.api.localScopeRecord(threadId);
    if (!record) return;
    const k = this.runtime.keeper;
    const grants = k.store.issuedShellGrants("memberThreadId", threadId);
    if (!grants.length && !existsSync(record.file + ".grants")) return;
    const active = grants.flatMap(grant => {
      if (grant.scope === "once" && shellGrantUse(record.file, grant.id) !== null) {
        this.recordGrantUse(threadId, grant.id);
        return [];
      }
      const member = k.member(threadId);
      if (!isLiveMember(k.store, member) || member.boardQuestId !== grant.boardQuestId || member.keeperThreadId !== grant.keeperThreadId) {
        settleShellGrant(k.store, grant.id, "expired", k.now(), "The member or quest ended.");
        return [];
      }
      return [{ id: grant.id, digest: grant.target.digest, scope: grant.scope }];
    });
    if (publishShellGrants(record.file, record.scope, active)) this.scopeRefreshed(threadId, "Updated the member’s shell grants.");
  }
  revokeGrant(threadId: string, id: string, receipt: UserActReceipt | undefined) {
    const k = this.runtime.keeper;
    const grant = k.store.get("shellGrants", id);
    if (!grant || grant.memberThreadId !== threadId || receipt?.act !== "revokeShellGrant") throw new Error("Revoking this grant requires your explicit action.");
    commitUserAct(k.store, k.now, receipt, () => {
      const record = this.api.localScopeRecord(threadId);
      if (record && grant.scope === "once" && shellGrantUse(record.file, id) !== null) this.recordGrantUse(threadId, id);
      settleShellGrant(k.store, id, "revoked", k.now(), "You revoked the shell grant.");
      this.syncGrants(threadId);
    });
    k.changed(threadId, grant.boardQuestId);
  }
  expireQuestGrants(questId: string) {
    const k = this.runtime.keeper;
    const active = k.store.issuedShellGrants("boardQuestId", questId);
    for (const grant of active) {
      const record = this.api.localScopeRecord(grant.memberThreadId);
      if (grant.scope === "once" && record && shellGrantUse(record.file, grant.id) !== null) this.recordGrantUse(grant.memberThreadId, grant.id);
      else settleShellGrant(k.store, grant.id, "expired", k.now(), "The quest ended.");
    }
    for (const threadId of new Set(active.map(grant => grant.memberThreadId))) this.syncGrants(threadId);
  }
  private recordGrantUse(threadId: string, id: string) {
    const k = this.runtime.keeper, grant = k.store.get("shellGrants", id);
    if (grant?.memberThreadId !== threadId || grant.state !== "issued") return;
    settleShellGrant(k.store, id, "used", k.now(), "The guard used this once grant.");
    k.changed(threadId, grant.boardQuestId);
  }
  askAct(keeperThreadId: string, input: ({ memberThreadId: string; command: string } | { heldEventId: string }) & { why: string; unsure?: boolean; draft?: Ask["draft"] }) {
    const k = this.runtime.keeper;
    k.require(keeperThreadId, "keeper");
    const heldEventId = "heldEventId" in input ? input.heldEventId : undefined;
    const held = heldEventId === undefined ? null : k.store.get("scopeActObservations", heldEventId);
    if (heldEventId !== undefined && (!held?.preflight || held.resolvedAt !== undefined || held.keeperThreadId !== keeperThreadId || !held.command || !held.cwd))
      throw new Error("Choose an open held shell act from this Keeper’s tick.");
    const member = k.member("memberThreadId" in input ? input.memberThreadId : held!.threadId);
    if (!isLiveMember(k.store, member) || member.keeperThreadId !== keeperThreadId || !member.boardQuestId)
      throw new Error("Shell grants are for an active member of this Keeper's quest.");
    const status = this.api.status().threads.find(row => row.threadId === member.threadId);
    if (held && held.boardQuestId !== member.boardQuestId) throw new Error("That held shell act belongs to another quest.");
    if (heldEventId) {
      const existing = k.store.openAsks(keeperThreadId, member.boardQuestId).find(ask => ask.effect?.type === "grant-shell-act" && ask.effect.heldEventId === heldEventId);
      if (existing) return existing;
    }
    const command = "command" in input ? input.command : held!.command!;
    const cwd = held?.cwd ?? this.cwd.get(member.threadId) ?? status?.scope?.expectedWorktree;
    if (status?.binding || !cwd || !status?.scope || status.error || member.guardPosture?.mode === "detection-only") throw new Error("The member needs a local pre-execution scope for shell grants.");
    if (/^\s*(?:kubectl|terraform|helm|kapp)\s/.test(command)) throw new Error("Cluster writes use a separate user-only ask; ordinary shell grants cannot cover them.");
    const call = prepareCall({ kind: "bash", toolName: "bash", cwd, input: { command } }, { scope: status.scope });
    if (shellCommunication(status.scope, call)) throw new Error("Members do not send as you. Draft the message for the user to post instead.");
    const target = shellGrantTarget(call);
    const kind = target && actAskKind(target.act);
    if (!target || !kind || held && target.act !== held.act) throw new Error("Give one literal shell act with its exact target, no wrappers or redirects.");
    return k.ask(keeperThreadId, {
      kind, boardQuestId: member.boardQuestId, unsure: input.unsure,
      effect: { type: "grant-shell-act", memberThreadId: member.threadId, target, ...(heldEventId ? { heldEventId } : {}) },
      target: { command: target.command },
      question: `Grant ${k.name(member)} this ${target.act}?`, why: input.why,
      draft: input.draft,
      options: [
        { id: "once", label: "Once", detail: "Allow this exact command one time.", recommended: true },
        { id: "quest", label: "For this quest", detail: "Allow this exact command until the member or quest ends.", recommended: false },
        { id: "deny", label: "Decline", detail: "The member keeps its current scope.", recommended: false },
      ],
      meanwhile: "The member can continue other work.",
      holds: member.waypointId ? [member.waypointId] : [],
    });
  }
  observeAct(observation: import("../scope/watch").ActObservation) {
    const k = this.runtime.keeper, member = k.member(observation.threadId);
    const keeperThreadId = member?.role === "keeper" ? member.threadId : member?.keeperThreadId;
    if (!member || !keeperThreadId) return;
    const key = `${member.threadId}:${observation.eventId}`;
    const saved = k.store.atomic(() => {
      if (k.store.get("scopeActObservations", key)) return false;
      const record = { ...observation, keeperThreadId, boardQuestId: member.boardQuestId };
      k.store.put("scopeActObservations", key, record);
      if (record.preflight) k.store.event(k.now(), keeperThreadId, member.boardQuestId, "scope.act-held",
        `${k.name(member)}: held ${record.act}`, record, { kind: "tavern" });
      return true;
    });
    if (saved) k.changed(member.threadId, member.boardQuestId);
  }
  violation(violation: Violation) {
    const k = this.runtime.keeper;
    const member = k.member(violation.threadId);
    if (!member) return;
    const key = `${member.threadId}:${violation.eventId}`;
    const keeperThreadId = member.role === "keeper" ? member.threadId : member.keeperThreadId;
    const saved = k.store.atomic(() => {
      if (k.store.get("scopeViolations", key)) return false;
      k.store.put("scopeViolations", key, violation);
      const memberName = k.name(member);
      k.store.event(k.now(), keeperThreadId, member.boardQuestId, "scope.violation",
        `${memberName}: ${violation.reason}${violation.stopError ? `; STOP FAILED: ${violation.stopError}` : ""}`,
        { ...violation, memberName }, { kind: "tavern" });
      if (member.role === "member" && keeperThreadId && violation.mode !== "watch" && isLiveMember(k.store, member, "brief")) {
        const refusalClass = ["write-path", "shell-write", "shell-location"].includes(violation.ruleId) ? "write" : violation.ruleId;
        const counts = k.store.runtime(member.threadId).scopeRefusalCounts ?? {};
        const count = Object.hasOwn(counts, refusalClass) ? counts[refusalClass]! : 0;
        if (count < 3) {
          k.store.patch(member.threadId, { scopeRefusalCounts: { ...counts, [refusalClass]: count + 1 } });
          if (count === 2)
            k.store.event(k.now(), keeperThreadId, member.boardQuestId, "scope.repeated-refusal",
              `${memberName} (${member.threadId}) hit three ${refusalClass} scope refusals. Review the block, then re-scope with tavern_scope or use tavern_release with memberThreadId "${member.threadId}", a reason and replace:true if the member needs replacing.`,
              { memberThreadId: member.threadId, refusalClass, eventId: violation.eventId }, { kind: "tavern" });
        }
      }
      return true;
    });
    if (!saved) return;
    if (!violation.prevented && violation.mode !== "watch")
      k.activity(member.threadId, member.role !== "keeper" && violation.stopped ? "idle" : "waiting");
    this.runtime.bb.log.warn(
      `Tavern scope violation ${member.threadId}: ${violation.ruleId}; stopped=${violation.stopped}${violation.stopError ? `; ${violation.stopError}` : ""}`,
    );
    k.changed(member.threadId, member.boardQuestId);
  }
  requestGuardRepair(keeperThreadId: string, memberRef: string) {
    const k = this.runtime.keeper;
    k.require(keeperThreadId, "keeper");
    const member = memberRef === keeperThreadId ? k.member(keeperThreadId)! : k.resolvePartyMember(keeperThreadId, memberRef);
    const memberThreadId = member.threadId;
    const lastBlock = k.store.scopeViolations([memberThreadId]).reverse().find(event => event.mode !== "watch" && !event.prevented);
    if (lastBlock?.ruleId !== "guard-not-loaded" || lastBlock.providerId !== "pi" || this.api.localScopeRecord(memberThreadId)?.scope.mode !== "enforce")
      throw new Error("No missing local Pi guard was recorded for this thread.");
    if (this.api.locallyArmed(memberThreadId)) throw new Error("The guard is already armed; no repair ask is needed.");
    const existing = k.store.openAsks(keeperThreadId).find(a => a.effect?.type === "repair-guard" && a.effect.memberThreadId === memberThreadId);
    if (existing) return existing;
    return k.ask(keeperThreadId, {
      boardQuestId: member.boardQuestId, kind: "blocker", effect: { type: "repair-guard", memberThreadId },
      question: `Restart ${k.name(member)}’s Pi session on this machine`,
      why: "Tavern’s guard did not load. Restart the session, then select Done so Tavern can check it.",
      options: [{ id: "done", label: "Done", detail: "Check that the guard loaded without changing scope or rerunning the blocked call.", recommended: true }],
      meanwhile: "The blocked call stays refused. Unrelated work can continue.", holds: member.waypointId ? [member.waypointId] : [],
    }, { memberThreadId }, true);
  }
  clearScope(threadId: string) {
    const k = this.runtime.keeper;
    const member = k.member(threadId);
    if (member) {
      const keeperThreadId = member.keeperThreadId ?? threadId;
      const repair = k.store.openAsks(keeperThreadId).find(ask => ask.effect?.type === "repair-guard" && ask.effect.memberThreadId === threadId);
      if (repair && k.withdrawAsk(repair.id, "scope-cleared")) k.changed(keeperThreadId, member.boardQuestId);
    }
    const record = this.api.localScopeRecord(threadId);
    removeShellGrantProjection(this.api.scopeFile(threadId));
    this.api.clearScope(threadId);
    for (const grant of k.store.issuedShellGrants("memberThreadId", threadId)) {
      if (record && grant.scope === "once" && shellGrantUse(record.file, grant.id) !== null) this.recordGrantUse(threadId, grant.id);
      else settleShellGrant(k.store, grant.id, "expired", k.now(), "The member's scope ended.");
    }
    const request = this.pending(threadId);
    if (!request) return;
    const askId = k.store.runtime(threadId).scopePending!;
    k.store.atomic(() => {
      k.store.put("scopeRequests", askId, { ...request, state: "declined" });
      const ask = k.store.get("asks", askId);
      if (ask?.state === "open")
        k.withdrawAsk(askId, "scope-cleared");
      k.store.patch(threadId, { scopePending: null });
    });
    k.changed(threadId, request.boardQuestId);
  }
  view(threadId: string) {
    const status = this.api.status();
    const row = status.threads.find((row) => row.threadId === threadId);
    if (!row) return null;
    const problems = [
      ...(this.runtime.keeper.store.runtime(threadId).scopeProblems ?? []),
    ];
    try {
      problems.push(...this.api.policy(this.context(threadId)).problems);
    } catch (error) {
      problems.push(`Policy read failed: ${String(error)}`);
    }
    const { keeper } = this.runtime;
    const store = keeper.store, member = keeper.member(threadId);
    const pending = store.runtime(threadId).scopePending;
    const pendingAsk = pending ? store.get("asks", pending) : null;
    const guardPosture = member?.guardPosture;
    const host = member ? memberHost(store, member) : null;
    const live = !!member && host?.archivedAt == null && host?.deletedAt == null &&
      (member.role === "keeper" ? isLiveKeeper(store, member, "present") : isLiveMember(store, member, "brief"));
    if (row.scope && (isLiveMember(store, member, "brief") || isLiveKeeper(store, member, "present")) &&
        !store.runtime(threadId).builtinKeeperFallback && !store.get("scopeInputs", threadId))
      problems.push("This older scope was kept as saved. Tavern cannot refresh it without its original inputs.");
    const local = this.api.localScopeRecord(threadId);
    const lastBlock = live && !row.armed && local?.scope.mode === "enforce" && status.mode === "enforce"
      ? store.scopeViolations([threadId]).reverse().find(event => event.mode !== "watch" && !event.prevented) : undefined;
    // An unstarted session has no arm receipt. The watcher records an actual failure on the first guarded call.
    const guardCheckFailed = lastBlock?.ruleId === "guard-not-loaded" && lastBlock.providerId === "pi";
    const repairAskId = guardCheckFailed ? store.openAsks(member?.keeperThreadId ?? threadId).find(ask => ask.effect?.type === "repair-guard" && ask.effect.memberThreadId === threadId)?.id : undefined;
    const messagePolicyProblem = this.api.messagePolicyProblem(threadId);
    if (messagePolicyProblem) problems.unshift(messagePolicyProblem);
    const latestGrants = store.query("shellGrants", "memberThreadId", threadId, 100);
    const grants = [...new Map([...store.issuedShellGrants("memberThreadId", threadId), ...latestGrants].map(grant => [grant.id, grant])).values()];
    const available = grants.some(grant => grant.state === "issued") && status.mode === "enforce" && local && shellGrantCapable(local.file, local.scope)
      ? new Set(readShellGrants(local.file, local.scope).map(grant => grant.id)) : null;
    const placement = row.binding?.placementId && this.runtime.placements().store.get(row.binding.placementId);
    const guarded = !row.error && (this.api.clusterGuardArmed(threadId) || placement && placement.posture.clusterWrites && row.hostScope === "acknowledged");
    const legacy = !row.error && (row.armed || placement && placement.posture.toolGate === "pi-observed");
    const prepared = !row.error && member?.role === "member" && guardPosture?.mode !== "detection-only" &&
      this.runtime.keeper.store.runtime(threadId).clusterSessionPending === true &&
      (status.guard.installed && !status.guard.stale && !row.binding || placement && placement.posture.guard === "prepared");
    const clusterGuard = guarded ? "armed" as const : legacy ? "restart" as const : prepared ? "ready" as const : "not-prevented" as const;
    const stamp = row.hostScope === "acknowledged" && this.hostSendGuard.get(threadId);
    const sendStamp = stamp && Date.now() - stamp.at < 30_000 ? stamp : null;
    if (sendStamp?.problem) problems.unshift(sendStamp.problem);
    const sendGuard = messagePolicyProblem ? "not-prevented" as const : !row.error && this.api.sendGuardArmed(threadId) ? "armed" as const
      : sendStamp ? sendStamp.status : legacy ? "restart" as const : "not-prevented" as const;
    return row
      ? {
          threadId,
          mode: status.mode,
          guard: status.guard,
          problems: [...new Set(problems)].filter(problem => problem !== WORKTREE_UNBOUND || (!row.scope?.expectedWorktree && !row.binding)).slice(0, 30),
          scope: row.scope,
          live,
          guardCheckFailed,
          ...(repairAskId ? { repairAskId } : {}),
          restartNeeded: local ? scopeRestartReason(local.file, local.scope) : null,
          shellGrants: grants.map(grant => ({
            ...grant, usable: grant.state === "issued" && (available?.has(grant.id) ?? false),
          })),
          ...(guardPosture ? { guardPosture: { ...guardPosture, label: clusterGuard === "armed" ? guardPosture.label : `${guardPosture.label}; ${clusterGuard === "ready" ? "Ready for the member's next session" : clusterGuard === "restart" ? "restart needed: cluster writes not prevented" : "cluster writes not prevented"}` } } : {}),
          error: row.error ?? null,
          armed: row.armed,
          clusterGuard,
          sendGuard,
          pendingAskId: pendingAsk?.state === "open" ? pendingAsk.id : null,
        }
      : null;
  }
  views(threadIds: string[]) {
    return [...new Set(threadIds)].flatMap((threadId) => {
      const row = this.view(threadId);
      return row ? [row] : [];
    });
  }
  violations(threadIds: string[]) {
    if (!threadIds.length) return [];
    const ids = new Set(threadIds);
    const observations = this.api
      .violations(threadIds.length === 1 ? threadIds[0] : undefined)
      .filter((row) => ids.has(row.threadId));
    const rows = new Map(
      [
        ...this.runtime.keeper.store.scopeViolations(threadIds),
        ...observations,
      ].map((row) => [`${row.threadId}:${row.eventId}`, row]),
    );
    return [...rows.values()].sort((a, b) => a.at - b.at).slice(-100);
  }
  guard(action: "status" | "install" | "uninstall") {
    const candidates = [
      "../../adapters/pi/extension.ts",
      "../adapters/pi/extension.ts",
      "./adapters/pi/extension.ts",
    ].map((path) => fileURLToPath(new URL(path, import.meta.url)));
    const options = {
      entryPath: candidates.find((path) => existsSync(path)) ?? candidates[0],
      ...this.options.guard,
    };
    if (action === "install")
      return ensureGuardInstalled({
        ...options,
        entryPath: options.entryPath!,
      });
    if (action === "uninstall") uninstallGuard(options);
    return { ...guardStatus(options), mode: this.api.mode() };
  }
}

export async function registerScopeSettings(
  bb: BbPluginApi,
  runtime: TavernRuntime,
  options: BackendScopeOptions = {},
) {
  const settings = bb.settings.define({
    scopes: {
      type: "select",
      label: "Scopes",
      options: ["enforce", "watch", "off"],
      default: DEFAULT_SETTINGS.scopes.mode,
      experimental_optionLabels: {
        enforce: "Enforce guardrails",
        watch: "Watch only (no blocking)",
        off: "Off (retain scopes)",
      },
    },
  });
  const legacy = scopeSchema.shape.mode.parse((await settings.get()).scopes);
  if (runtime.settings && !runtime.settings.hasUser("scopes.mode") && legacy !== DEFAULT_SETTINGS.scopes.mode)
    runtime.settings.update({ revision: runtime.settings.snapshot().revision, patch: { scopes: { mode: legacy } }, why: "Preserved the existing bb scope setting" });
  runtime.enableScopes({ ...options, mode: runtime.settings ? runtime.config().scopes.mode : legacy });
  if (runtime.settings) {
    runtime.syncLegacyScopes = async mode => {
      if ((await settings.get()).scopes !== mode) await settings.experimental_set({ scopes: mode });
    };
    await runtime.syncLegacyScopes(runtime.config().scopes.mode);
  }
  settings.onChange((next, previous) => {
    if (next.scopes === previous.scopes) return;
    const mode = scopeSchema.shape.mode.parse(next.scopes);
    if (runtime.settings) {
      if (runtime.config().scopes.mode === mode) return;
      runtime.settings.update({ revision: runtime.settings.snapshot().revision, patch: { scopes: { mode } }, why: "Changed the legacy bb scope control" });
      runtime.settingsChanged();
    } else {
      runtime.scopes!.api.setMode(mode);
      runtime.keeper.invalidateAll(false);
    }
    bb.log.info(
      `Tavern scopes mode=${mode}; restart provider sessions to refresh environment speed bumps`,
    );
  });
}
