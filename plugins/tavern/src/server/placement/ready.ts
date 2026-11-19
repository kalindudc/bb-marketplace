import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hostContract, type Authority, type EndpointRegistration, type HostInput, type HostMethod, type HostOutput } from "../../host-contract";
import type { HostPort } from "../../host/client";
import type { HostTemplate } from "../../scope/host-env";
import { scopeDeliveryFileSchema } from "../../scope/schema";
import { postureText } from "../../shared/placement-view";
import type { BlockStage, PlacementRecord } from "../../shared/placement";
import type { PlacementCarry } from "./carry";
import type { PlacementDeliveries } from "./delivery";
import { StalePlacementError, type PlacementStore } from "./store";
import type { PlacementTransport } from "./transport";

export interface PlacementReadyDeps {
  bb: Pick<BbPluginApi, "sdk" | "onDispose">;
  host: HostPort;
  placements: PlacementStore;
  deliveries: PlacementDeliveries;
  carry: PlacementCarry;
  transport: PlacementTransport;
  scopeForThread(threadId: string): HostTemplate;
  changed?(threadId: string): void;
  observedHost?(host: { id: string; name: string | null }): void;
}
type Operation = { generation: number; promise: Promise<string> };
const operations = new WeakMap<PlacementStore, Map<string, Operation>>();
const setupState = (record: PlacementRecord) => ["bootstrapping", "binding", "carrying", "ready", "running"].includes(record.phase) ||
  record.phase === "blocked" && ["bind", "carry"].includes(record.blocked?.stage ?? "");
const unavailable = (record: PlacementRecord) => record.blocked ? `Blocked at ${record.blocked.stage}: ${record.blocked.message}` : `Readiness is not available during ${record.phase}.`;

export class PlacementReady {
  private readonly lifetime = new AbortController();
  private readonly pending: Map<string, Operation>;
  constructor(private readonly deps: PlacementReadyDeps) {
    let pending = operations.get(deps.placements);
    if (!pending) { pending = new Map(); operations.set(deps.placements, pending); }
    this.pending = pending;
    deps.bb.onDispose(() => this.lifetime.abort(new Error("Member readiness disposed")));
  }

  forThread(threadId: string, caller?: AbortSignal): Promise<string> {
    if (caller?.aborted) return Promise.reject(caller.reason);
    const record = this.deps.placements.byMember(threadId);
    if (!record) return Promise.resolve("This member was not placed by a machine rule; nothing to set up.");
    const existing = this.pending.get(record.id);
    if (existing) return existing.generation === record.generation ? existing.promise : Promise.resolve("An older ready turn is still reconciling; Retry after it finishes.");
    const promise = this.run(record, caller).finally(() => {
      if (this.pending.get(record.id)?.promise === promise) this.pending.delete(record.id);
    });
    this.pending.set(record.id, { generation: record.generation, promise });
    return promise;
  }

  reconcileForThread(threadId: string): Promise<string> {
    const record = this.deps.placements.byMember(threadId);
    const snapshotId = record?.reviewTarget?.snapshotId ?? record?.sourceSnapshotId;
    if (!record?.carries?.some(receipt => receipt.generation === record.generation && receipt.snapshotId === snapshotId && receipt.phase === "verified"))
      return Promise.resolve("Scope delivery waits for the member to finish tavern_ready setup.");
    const pending = this.pending.get(record.id);
    return pending ? pending.promise.then(() => this.forThread(threadId)) : this.forThread(threadId);
  }

  private result(record: PlacementRecord): string {
    const snapshot = this.deps.placements.snapshot(record.reviewTarget?.snapshotId ?? record.sourceSnapshotId!);
    const carry = record.carries?.find(receipt => receipt.generation === record.generation && receipt.snapshotId === snapshot?.id && receipt.phase === "verified");
    if (!snapshot || !carry || !record.root) throw new Error("Ready placement has no verified carried source tree");
    const posture = postureText(record.posture);
    const source = snapshot.uncommittedOrigin
      ? `Uncommitted Keeper changes were included from ${snapshot.uncommittedOrigin.root} on host ${snapshot.uncommittedOrigin.hostId}.`
      : "No uncommitted Keeper changes were included.";
    return `Ready. Cwd: ${record.root}\nCarried tree: ${snapshot.tree} (${snapshot.objectFormat}), snapshot ${snapshot.id}.\n${source}\n${posture.label}${posture.detail ? "; " + posture.detail : ""}. Readiness is not a guard-armed receipt.${record.posture.warnings.length ? "\nWarnings:\n" + record.posture.warnings.join("\n") : ""}`;
  }

  private async run(initial: PlacementRecord, caller?: AbortSignal): Promise<string> {
    const { bb, host, placements, deliveries } = this.deps;
    const placementId = initial.id, generation = initial.generation, memberId = initial.memberThreadId!;
    if (!setupState(initial)) return unavailable(initial);
    const snapshotId = initial.reviewTarget?.snapshotId ?? initial.sourceSnapshotId;
    if (initial.phase === "running" && !initial.carries?.some(receipt => receipt.generation === generation && receipt.snapshotId === snapshotId && receipt.phase === "verified"))
      return "A running placement has no verified setup receipt; reconcile its placement before readiness.";
    const completedPhase = initial.phase === "running" || initial.resumePhase === "running" ? "running" : "ready";
    const controller = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal, ...(caller ? [caller] : [])]);
    let active = true, stage: BlockStage = "bind";
    const unsubscribe = host.onWorkerExit(({ hostId }) => {
      if ([placements.get(placementId)?.hostId, placements.snapshot(initial.reviewTarget?.snapshotId ?? initial.sourceSnapshotId!)?.home.hostId].includes(hostId))
        controller.abort(new Error("The member readiness host worker exited; Retry after reconnecting it"));
    });
    const current = () => {
      signal.throwIfAborted();
      if (!active) throw new Error("The member's tavern_ready turn has finished");
      const record = placements.assertCurrent(placementId, generation);
      if (!setupState(record)) throw new StalePlacementError(unavailable(record));
      for (const key of ["memberThreadId", "sourceSnapshotId", "reviewTarget", "rule", "workspaceKind", "ownsNewMachine"] as const)
        if (!isDeepStrictEqual(initial[key], record[key])) throw new StalePlacementError("The member readiness assignment changed");
      return record;
    };
    const awaited = async <T>(work: () => Promise<T>): Promise<T> => { current(); const result = await work(); current(); return result; };
    const identity = async () => {
      const thread = await awaited(() => bb.sdk.threads.get({ threadId: memberId, signal }));
      if (thread.id !== memberId || thread.projectId !== initial.projectId || thread.archivedAt !== null || thread.deletedAt !== null || !thread.environmentId)
        throw new Error("The placed member has no active provisioned SDK environment");
      const environment = await awaited(() => bb.sdk.environments.get({ environmentId: thread.environmentId!, signal }));
      if (environment.id !== thread.environmentId || environment.projectId !== initial.projectId || !environment.path || !environment.branchName)
        throw new Error("The member's SDK checkout identity is unavailable");
      if (environment.status !== "ready" || environment.hostLifecycle !== "active" || environment.lifecycle.phase !== "active")
        throw new Error(`The member environment is ${environment.status}; host is ${environment.hostLifecycle} (${environment.lifecycle.phase}). Retry after it becomes active.`);
      const native = await awaited(() => bb.sdk.hosts.get({ hostId: environment.hostId, signal }));
      if (native.id !== environment.hostId || native.status !== "connected") throw new Error(`The member host is ${native.status}; Retry after reconnecting it.`);
      this.deps.observedHost?.({ id: native.id, name: native.name });
      current();
      return { thread, environment, endpoint: { hostId: environment.hostId, environmentId: environment.id, root: environment.path }, branch: environment.branchName };
    };
    try {
      current();
      if (initial.phase === "blocked") {
        if (!initial.blocked?.retryable) return `Blocked at ${initial.blocked?.stage}: ${initial.blocked?.message}. ${initial.blocked?.code === "git-unsupported" ? "Stop this placement or hire without placement; retrying will not help because it cannot add the required Git capabilities." : "Retry will not help; ask the Keeper to repair the placement."}`;
        placements.retry(placementId, generation);
      }
      if (!initial.rule || !initial.rule.acceptedConsent.remoteDetectionOnly) throw new Error("This placement has no enabled rule consent for remote detection-only work");
      if (initial.workspaceKind !== "dedicated-machine" || !initial.ownsNewMachine) throw new Error("This rule's target isn't supported in this version.");
      const sdk = await identity();
      let record = current();
      if (record.hostId !== null && (record.hostId !== sdk.endpoint.hostId || record.environmentId !== sdk.endpoint.environmentId || record.root !== sdk.endpoint.root))
        throw new StalePlacementError("The member's SDK host, environment or root changed; reconcile its placement before Retry");
      record = placements.update(placementId, generation, value => ({ ...value, phase: value.phase === "running" ? "running" : "binding", hostId: sdk.endpoint.hostId, environmentId: sdk.endpoint.environmentId, root: sdk.endpoint.root }));
      const snapshotId = record.reviewTarget?.snapshotId ?? record.sourceSnapshotId;
      if (!snapshotId) throw new Error("This member has no pinned source snapshot");
      let snapshot = placements.snapshot(snapshotId);
      if (!snapshot) throw new Error("This member's source snapshot is unavailable");
      const authority = (): Authority => ({ placementId, generation, endpointId: "carry-member", operationId: randomUUID() });
      const fence = async () => {
        const next = await identity();
        if (!isDeepStrictEqual(next.endpoint, sdk.endpoint) || next.branch !== sdk.branch) throw new StalePlacementError("The SDK member endpoint changed during setup");
      };
      const call = async <M extends HostMethod>(method: M, input: HostInput<M>): Promise<HostOutput<M>> => {
        await fence(); current();
        const reply = await awaited(() => host.call(sdk.endpoint.hostId, method, input, { signal }));
        await fence(); current();
        return hostContract[method].output.parse(reply) as HostOutput<M>;
      };
      const carried = record.carries?.find(receipt => receipt.generation === generation && receipt.snapshotId === snapshotId && receipt.phase === "verified");
      const previousDelivery = deliveries.get(placementId);
      let bindingEndpoints = previousDelivery ? scopeDeliveryFileSchema.parse(JSON.parse(previousDelivery.scopeFileJson)).bindingEndpoints : undefined;
      const endpoints: EndpointRegistration[] = [{ placementId, generation, endpointId: "carry-member", endpoint: sdk.endpoint,
        ownerThreadId: memberId, access: "member-write", git: "porcelain", workspaceKind: record.workspaceKind, objectFormat: snapshot.objectFormat,
        allowedRefs: ["refs/heads/" + sdk.branch] }];
      if (!carried) {
        const storage = await awaited(() => bb.sdk.threads.storageLocation({ threadId: memberId, signal }));
        if (storage.hostId === sdk.endpoint.hostId) endpoints.push({ placementId, generation, endpointId: "ready-storage",
          endpoint: { hostId: storage.hostId, environmentId: null, root: storage.storageRootPath }, ownerThreadId: memberId,
          access: "artifact-read", git: "porcelain", workspaceKind: null, objectFormat: null, allowedRefs: [] });
        const batch = await call("registerEndpoints", { placementId, generation, operationId: randomUUID(), endpoints });
        if (batch.generation !== generation) throw new StalePlacementError("The endpoint batch acknowledged a stale generation");
        if (batch.outcome === "waiting") throw new Error(`Waiting for transfer slots: ${batch.active} in use (limit 32)`);
        if (!isDeepStrictEqual(batch.endpointIds, endpoints.map(endpoint => endpoint.endpointId))) throw new Error("The host acknowledged a different endpoint batch");
        bindingEndpoints = endpoints.length > 1 ? { threadStorage: "ready-storage" } : undefined;
      }
      const inspected = await call("inspect", authority());
      if (inspected.root !== sdk.endpoint.root || inspected.branch !== sdk.branch) throw new Error("The native member checkout does not match its SDK root and branch");
      if (inspected.objectFormat !== snapshot.objectFormat) throw new Error("object-format-mismatch");
      if (carried && previousDelivery?.acknowledged && previousDelivery.binding.generation === generation &&
          previousDelivery.memberThreadId === memberId && previousDelivery.environmentId === sdk.endpoint.environmentId &&
          previousDelivery.binding.hostId === sdk.endpoint.hostId && previousDelivery.binding.cwd === sdk.endpoint.root &&
          previousDelivery.binding.revision === record.desiredScopeRevision && record.acknowledgedScopeRevision === record.desiredScopeRevision &&
          previousDelivery.templateDigest === this.deps.scopeForThread(memberId).templateDigest) {
        const ready = placements.update(placementId, generation, value => ({ ...value, phase: completedPhase }));
        return this.result(ready);
      }
      if (!carried) {
        stage = "carry";
        placements.update(placementId, generation, value => ({ ...value, phase: "carrying" }));
        if (!snapshot.homeCommit) snapshot = await awaited(() => this.deps.transport.bringHome(placementId, generation, snapshotId, signal));
        await awaited(() => this.deps.carry.carryIntoOwnTurn(placementId, generation, snapshotId, { threadId: memberId, toolName: "tavern_ready", assertActive: () => { current(); } }, signal));
      }
      const verifyTree = async () => {
        const state = await call("worktreeState", { ...authority(), base: snapshot!.base });
        if (state.tree !== snapshot!.tree || state.dirty || state.unfinishedMerge) throw new Error("The member checkout is not the exact clean carried snapshot tree");
      };
      if (!carried) await verifyTree();
      stage = "bind";
      placements.update(placementId, generation, value => ({ ...value, phase: value.phase === "running" ? "running" : "binding" }));
      if (current().posture.guard === "unavailable") {
        let guard: HostOutput<"prepareGuard">;
        try { guard = await call("prepareGuard", { ...authority(), ruleId: initial.rule.id, allowMarkedInstall: initial.rule.acceptedConsent.guardInstall }); }
        catch (error) { current(); guard = { state: "failed", artifactDigest: null, scopeDirectory: "", warning: error instanceof Error ? error.message : String(error) }; }
        const warning = guard.warning ?? (guard.state === "prepared" ? null : `Guard preparation ${guard.state}; this member remains detection only.`);
        placements.update(placementId, generation, value => ({ ...value, posture: { ...value.posture,
          guard: guard.state === "prepared" ? "prepared" : "failed", warnings: warning ? [...new Set([...value.posture.warnings, warning])] : value.posture.warnings } }));
      }
      const original = this.deps.scopeForThread(memberId);
      const scopeFileJson = JSON.stringify(scopeDeliveryFileSchema.parse({ ...original.template, bindingTemplate: original.template,
        workspaceBinding: { kind: initial.workspaceKind, ...sdk.endpoint, placementId, generation,
          snapshotId: snapshot.id, expectedTree: snapshot.tree },
        ...(bindingEndpoints ? { bindingEndpoints } : {}) }));
      const delivery = deliveries.prepare(placementId, generation, { endpointId: "carry-member", templateDigest: original.templateDigest, scopeFileJson });
      if (!delivery.acknowledged) {
        const reply = await call("bindScope", { ...authority(), revision: delivery.binding.revision, scopeDigest: delivery.binding.scopeDigest, scopeFileJson: delivery.scopeFileJson });
        if (!isDeepStrictEqual(this.deps.scopeForThread(memberId), original)) throw new StalePlacementError("The effective scope changed during native delivery");
        deliveries.acknowledge(placementId, generation, delivery.binding, reply);
      }
      const observed = await call("sessionStatus", { ...authority(), revision: delivery.binding.revision, scopeDigest: delivery.binding.scopeDigest });
      const piObserved = sdk.thread.providerId === "pi" && current().posture.guard === "prepared" && observed.state === "armed" && observed.revision === delivery.binding.revision && observed.scopeDigest === delivery.binding.scopeDigest;
      if (!carried) await verifyTree(); current();
      if (!isDeepStrictEqual(this.deps.scopeForThread(memberId), original) || !isDeepStrictEqual(deliveries.get(placementId)?.binding, delivery.binding))
        throw new StalePlacementError("The effective scope or delivery changed before readiness");
      const ready = placements.update(placementId, generation, value => ({ ...value, phase: completedPhase, memberBranch: sdk.branch, posture: { ...value.posture,
        aggregate: "remote-detection-only", toolGate: piObserved ? "pi-observed" : "not-established", filesystem: "none", network: "not-enforced",
        checker: original.template.preset === "checker" ? piObserved ? "pre-exec-no-containment" : "detection-only-no-containment" : "not-a-checker" } }));
      this.deps.changed?.(memberId);
      return this.result(ready);
    } catch (error) {
      if (caller?.aborted || this.lifetime.signal.aborted) throw signal.reason;
      const message = error instanceof Error ? error.message : String(error);
      const live = placements.get(placementId);
      if (live?.generation !== generation || live.desiredState !== "running") return `Readiness not published: ${message}`;
      if (!setupState(live)) return unavailable(live);
      const unsupportedGit = (error as { code?: string })?.code === "git-unsupported" || message.includes("This machine's Git can't carry Tavern's work (");
      const retryable = !unsupportedGit && (!(error instanceof StalePlacementError) || message.startsWith("The effective scope")) && !["object-format-mismatch", "This rule's target isn't supported in this version."].includes(message);
      placements.block(placementId, generation, { stage, code: unsupportedGit ? "git-unsupported" : stage === "carry" ? "carry-unavailable" : "binding-unavailable", message, retryable });
      this.deps.changed?.(memberId);
      return `Blocked at ${stage}: ${message}\n${unsupportedGit ? "Stop this placement or hire without placement; retrying will not help because it cannot add the required Git capabilities." : retryable ? "Retry after the problem is resolved." : "Retry will not help; ask the Keeper to repair the placement."}`;
    } finally { active = false; unsubscribe(); }
  }
}
