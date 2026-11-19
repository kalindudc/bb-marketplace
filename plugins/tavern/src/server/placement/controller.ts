import { randomUUID } from "node:crypto";
import type { PlacementRecord } from "../../shared/placement";
import type { PlacementPolicyRead } from "../../shared/placement-settings";
import { matchPlacementRule, type PlacementFacts, type PlacementMatch } from "./match";
import { resolvePlacementRoute } from "./routing";
import { readSourceIdentity } from "./source-discovery";
import { isQuiescentThread } from "./quiescence";
import { boundedData } from "../instructions";
import { placementLine, postureText, type PlacementView } from "../../shared/placement-view";
import type { Member } from "../../shared/schema";
import { isHireCancelled, releaseHire } from "../hires";
import type { HireIntent, ReviewTarget } from "../keeper/store";
import type { TavernRuntime } from "../runtime";
import { normalizeProviderPlacement } from "./normalize";
import type { PlacementRoute } from "./routing";
import type { PlacementServices } from "./services";

export class PlacementHireBlocked extends Error {
  constructor(message: string, readonly placement: PlacementView | null = null, readonly outcome: "unknown" | "hold" = "hold") {
    super(message); this.name = "PlacementHireBlocked";
  }
}

export const PLACEMENT_CLASSES = ["keeper", "ranger", "smith", "warden", "wanderer"] as const;

export function placementClassLine(classId: string, match: PlacementMatch, providerName?: string): string {
  const label = classId === "keeper" ? "Lead" : classId[0].toUpperCase() + classId.slice(1);
  if (classId === "keeper") return "Lead: where you run, unless you pick a placement with tavern_placements";
  if (match.state === "blocked") return `${label}: machine policy is invalid; repair it in Settings`;
  if (match.state !== "matched") return `${label}: where you run (no matching rule)`;
  const target = match.rule.target;
  const where = target.kind === "current" ? "where you run" : target.machine.type === "new"
    ? `a new ${providerName ?? target.environmentProviderId} machine each` : "this rule’s target is not supported in this version";
  return `${label}: ${where}, rule ${match.rule.label} (${match.rule.id})`;
}

export function placementGuidance(lines: string[], counts: { makers: number; checkers: number }, limits: { maxMakers: number; maxCheckers: number }): string {
  return boundedData(`Where your party runs:\n${lines.join("\n")}\nCall tavern_placements for a member's repo before choosing its placement.\nMaker slots: ${counts.makers} of ${limits.maxMakers} in use. Checker slots: ${counts.checkers} of ${limits.maxCheckers} in use.`,
    1800, "\nMore: call tavern_status section=placement");
}

export class PlacementController {
  private readonly providerNames = new Map<string, string>();
  private readonly hostNames = new Map<string, string>();
  private readonly ruleNames = new Map<string, string>();
  private readonly retries = new Map<string, Promise<PlacementView>>();

  constructor(private readonly runtime: TavernRuntime, private readonly services: PlacementServices) {}

  static hold(runtime: TavernRuntime, threadId: string, questId: string | null, classId: string, message: string, outcome: PlacementHireBlocked["outcome"] = "hold"): never {
    runtime.keeper.store.event(runtime.keeper.now(), threadId, questId, "hire.waiting", `Hire waiting: ${message}`,
      { classId, message }, { kind: "tavern" });
    runtime.keeper.changed(threadId, questId);
    throw new PlacementHireBlocked(message, null, outcome);
  }

  hold(threadId: string, questId: string | null, classId: string, message: string, outcome: PlacementHireBlocked["outcome"] = "hold"): never {
    return PlacementController.hold(this.runtime, threadId, questId, classId, message, outcome);
  }

  async reserve(route: PlacementRoute, token: string, intent: HireIntent, review: ReviewTarget | null = null): Promise<PlacementRecord> {
    if (route.match.state !== "matched" || route.match.rule.target.kind !== "provider") throw new Error("Expected a matched provider rule");
    const { rule } = route.match, target = rule.target;
    if (target.kind !== "provider") throw new Error("Expected a provider target");
    const hold = (message: string): never => this.hold(intent.owner.keeperThreadId, intent.owner.boardQuestId, intent.classId, message);
    if (target.machine.type !== "new" || target.workspace !== "dedicated-machine") hold("This rule's target isn't supported in this version.");
    const policy = this.runtime.settings?.placementPolicy();
    if (!policy || policy.state !== "valid" || policy.revision !== route.match.revision) return hold("Machine placement settings changed before reservation; retry the hire.");
    const counts = this.services.store.counts(intent.owner.keeperThreadId), checker = intent.classId === "warden";
    const maximum = checker ? policy.settings.maxCheckers : policy.settings.maxMakers;
    const used = checker ? counts.checkers : counts.makers;
    if (used >= maximum) hold(`Waiting for a ${checker ? "checker" : "maker"} slot: ${used} of ${maximum} in use`);
    try {
      const source = route.source ?? await this.services.sources.inspect(intent.owner.keeperThreadId, intent.projectId);
      if (source.state !== "known") return hold(source.message);
      const keeperRepo = this.runtime.keeper.store.runtime(intent.owner.keeperThreadId).projectId
        ?? (await this.runtime.bb.sdk.threads.get({ threadId: intent.owner.keeperThreadId })).projectId;
      if (!keeperRepo) return hold("The Keeper's repo binding is unavailable; repair it before hiring.");
      const snapshot = review?.snapshotId ? this.services.store.snapshot(review.snapshotId)
        : intent.projectId !== keeperRepo ? await this.services.capture.initial(source, undefined, { pushedBaseOnly: true })
        : await this.services.capture.initial(source);
      if (!snapshot) return hold("The pinned maker submission is unavailable; capture a new submission before review.");
      const reviewCurrent = () => {
        if (!review) return;
        const current = this.runtime.keeper.store.runtime(review.makerThreadId).submissionTarget;
        if (!checker || !review.reviewKey || !review.journalTargets?.length || !snapshot.homeCommit ||
            snapshot.tree !== review.expectedTree || snapshot.makerSubmissionId !== review.makerSubmissionId ||
            current?.reviewKey !== review.reviewKey || current.snapshotId !== snapshot.id)
          hold("The maker submission changed before Warden placement; a new review is needed.");
      };
      reviewCurrent();
      const sourceHost = await this.runtime.bb.sdk.hosts.get({ hostId: source.endpoint.hostId });
      if (sourceHost.id !== source.endpoint.hostId) return hold("The source host identity changed during placement; retry the hire.");
      this.observeHost(sourceHost);
      const config = await this.runtime.bb.sdk.system.config();
      if (!config.primaryHostId) return hold("The server has no primary host configured.");
      const normalized = await normalizeProviderPlacement(this.runtime.bb, {
        rule, projectId: intent.projectId, keeperHostId: source.endpoint.hostId, serverHostId: config.primaryHostId,
        substitutions: { "keeper.branch": source.inspection.branch, "source.commit": snapshot.sourceHead,
          "source.base": snapshot.base, "member.branch": `tavern/${token}`, "quest.id": intent.owner.boardQuestId },
      });
      await this.services.sources.revalidate(source);
      if (this.runtime.settings?.placementPolicy().revision !== policy.revision) return hold("Machine placement settings changed before reservation; retry the hire.");
      if (isHireCancelled(this.runtime.keeper, intent)) return hold("This board quest has ended or is stopping; the hire was cancelled");
      const now = this.runtime.keeper.now();
      const record: PlacementRecord = {
        id: randomUUID(), generation: 1, desiredState: "running", hireToken: token,
        keeperThreadId: intent.owner.keeperThreadId, memberThreadId: null, projectId: intent.projectId,
        questId: intent.owner.boardQuestId, classId: intent.classId, slot: checker ? "checker" : "maker",
        pullRequests: rule.pullRequests ?? { at: "member" },
        rule: { id: rule.id, settingsRevision: policy.revision, definitionDigest: route.match.definitionDigest, acceptedConsent: rule.consent },
        matchEvidence: route.match.matchEvidence, target: normalized.environment, allocationKey: token,
        ownsNewMachine: normalized.ownsNewMachine, workspaceKind: normalized.workspaceKind,
        hostId: null, environmentId: null, root: null, sourceSnapshotId: snapshot.id, submissionSnapshotId: null,
        reviewTarget: review ? { makerThreadId: review.makerThreadId, makerSubmissionId: review.makerSubmissionId!, snapshotId: snapshot.id,
          expectedTree: snapshot.tree, journal: review.journalTargets![0] } : null,
        phase: "reserved", resumePhase: null, blocked: null,
        preservation: { source: "not-needed", artifacts: "not-declared", snapshotId: null, artifactManifestId: null,
          liveOwnerThreadId: null, stopConfirmed: false, reason: null },
        posture: { aggregate: "remote-detection-only", guard: "unavailable", toolGate: "not-established", filesystem: "none",
          network: "not-enforced", checker: checker ? "detection-only-no-containment" : "not-a-checker",
          watcher: "active", ruleConsentId: rule.id, warnings: normalized.warnings },
        desiredScopeRevision: 1, acknowledgedScopeRevision: null, createdAt: now, updatedAt: now,
      };
      this.ruleNames.set(rule.id, rule.label);
      const providers = await this.runtime.bb.sdk.environments.listProviders({ projectId: intent.projectId });
      for (const provider of providers) this.providerNames.set(provider.id, provider.displayName);
      const latest = this.runtime.settings?.placementPolicy();
      if (latest?.state !== "valid" || latest.revision !== policy.revision) return hold("Machine placement settings changed before reservation; retry the hire.");
      if (isHireCancelled(this.runtime.keeper, intent)) return hold("This board quest has ended or is stopping; the hire was cancelled");
      reviewCurrent();
      return this.services.provisioner.reserve(record, { maxMakers: policy.settings.maxMakers, maxCheckers: policy.settings.maxCheckers }, intent);
    } catch (error) {
      if (error instanceof PlacementHireBlocked) throw error;
      const counts = this.services.store.counts(intent.owner.keeperThreadId), used = checker ? counts.checkers : counts.makers;
      if (used >= maximum) return hold(`Waiting for a ${checker ? "checker" : "maker"} slot: ${used} of ${maximum} in use`);
      return hold(error instanceof Error ? error.message : String(error));
    }
  }

  admission(record: PlacementRecord, providerId: string): NonNullable<Member["guardPosture"]> {
    const consent = record.rule?.acceptedConsent;
    if (!consent?.guardInstall || !consent.remoteDetectionOnly || !consent.linuxUncontainedChecks)
      throw new Error("This placement lacks once-per-rule remote consent.");
    return { providerId, mode: "detection-only", label: "Detection only (remote)", approvalAskId: null };
  }

  beginSpawn(record: PlacementRecord): void {
    this.services.store.assertCurrent(record.id, record.generation);
    if (record.phase !== "reserved") throw new Error("Reconcile this placement before another allocation.");
    this.services.store.update(record.id, record.generation, value => ({ ...value, phase: "provisioning" }));
  }

  async releaseModelFailure(record: PlacementRecord, reason: string): Promise<boolean> {
    const threadId = record.memberThreadId;
    if (!threadId) throw new Error("The failed model placement has no member.");
    const thread = await this.runtime.bb.sdk.threads.get({ threadId });
    if (!isQuiescentThread(thread)) return false;
    if (thread.archivedAt === null && thread.deletedAt === null) await this.runtime.bb.sdk.threads.archive({ threadId });
    this.services.store.update(record.id, record.generation, value => ({ ...value, phase: "releasing", blocked: null, resumePhase: null,
      preservation: { ...value.preservation, source: "not-needed", artifacts: "not-declared", snapshotId: null,
        liveOwnerThreadId: null, stopConfirmed: true, reason } }));
    return true;
  }

  releaseUnstarted(record: PlacementRecord, error: unknown): PlacementHireBlocked {
    this.runtime.keeper.store.atomic(() => {
      const current = this.services.store.get(record.id);
      if (!current || current.memberThreadId !== null) throw new Error("Reconcile this placement’s child before releasing its reservation.");
      const cancelled = current.desiredState === "running" ? this.services.store.cancel(current.id, current.generation) : current;
      this.services.store.update(cancelled.id, cancelled.generation, value => ({ ...value, phase: "releasing", blocked: null, resumePhase: null,
        preservation: { ...value.preservation, source: "not-needed", artifacts: "not-declared", stopConfirmed: true },
      }), "released");
      this.services.store.finishRelease(cancelled.id, cancelled.generation, true);
      const intent = this.runtime.keeper.store.get("hires", current.hireToken);
      if (intent) releaseHire(this.runtime.keeper, current.hireToken, intent);
    });
    const message = error instanceof Error ? error.message : String(error);
    this.runtime.keeper.store.event(this.runtime.keeper.now(), record.keeperThreadId, record.questId, "hire.waiting", `Hire waiting: ${message}`,
      { classId: record.classId, message }, { kind: "tavern" });
    this.runtime.keeper.changed(record.keeperThreadId, record.questId);
    return new PlacementHireBlocked(message);
  }

  bindChild(record: PlacementRecord, threadId: string, afterSpawn = false): PlacementRecord {
    const current = this.services.store.get(record.id);
    if (!current) throw new Error("The placement disappeared while spawning; reconcile its returned child.");
    if (current.desiredState === "released") {
      const retained = this.cancelChild(current, threadId);
      if (afterSpawn) return retained;
      throw new PlacementHireBlocked("The hire was cancelled; its pending child remains held for resource reconciliation.", this.view(retained));
    }
    return this.runtime.keeper.store.atomic(() => {
      const execution = this.runtime.keeper.store.get("hires", record.hireToken)?.placementExecution;
      if (execution) this.runtime.keeper.store.patch(threadId, { placementExecution: execution });
      const current = this.services.store.assertCurrent(record.id, record.generation);
      if (current.blocked?.code === "spawn-outcome-unknown" && current.memberThreadId === null)
        this.services.store.retry(record.id, record.generation);
      if (current.memberThreadId === threadId) return current;
      return this.services.provisioner.bindDispatchedMember(record.hireToken, threadId);
    });
  }

  cancelChild(record: PlacementRecord, threadId: string): PlacementRecord {
    const retained = this.runtime.keeper.store.atomic(() => {
      const current = this.services.store.get(record.id);
      if (!current) throw new Error("The cancelled placement disappeared; reconcile its returned child.");
      const cancelled = current.desiredState === "running" ? this.services.store.cancel(current.id, current.generation) : current;
      if (cancelled.memberThreadId === threadId && (cancelled.phase === "released" || cancelled.preservation.liveOwnerThreadId === threadId)) return cancelled;
      if (cancelled.memberThreadId !== null && cancelled.memberThreadId !== threadId)
        throw new Error("Another child already owns this cancelled placement; reconcile both before release.");
      const owner = this.services.store.update(cancelled.id, cancelled.generation, value => ({ ...value,
        memberThreadId: threadId, phase: "preserving", blocked: null, resumePhase: null,
        preservation: { ...value.preservation, source: "pending", liveOwnerThreadId: threadId, stopConfirmed: false,
          reason: "A child arrived after cancellation; preserve it before controlled release." },
      }), "released");
      const intent = this.runtime.keeper.store.get("hires", owner.hireToken);
      if (intent) {
        this.runtime.keeper.store.put("hires", owner.hireToken, { ...intent, memberThreadId: threadId, cancelledAt: intent.cancelledAt ?? this.runtime.keeper.now() });
        this.runtime.keeper.bind(threadId, intent.classId, intent.characterId, intent.projectId, intent.owner);
      }
      return owner;
    });
    this.runtime.keeper.changed(threadId, retained.questId);
    return retained;
  }

  spawnFailed(record: PlacementRecord, error: unknown): PlacementHireBlocked | PlacementRecord {
    const current = this.services.store.get(record.id);
    if (!current || current.generation !== record.generation || current.desiredState !== "running")
      return new PlacementHireBlocked(error instanceof Error ? error.message : String(error));
    if (current.memberThreadId !== null) return current;
    const blocked = this.services.store.block(record.id, record.generation, { stage: "provision", code: "spawn-outcome-unknown",
      message: error instanceof Error ? error.message : String(error), retryable: true });
    return new PlacementHireBlocked(`Hire outcome unknown; placement ${blocked.id} keeps its slot and no second machine will be allocated. Do not hire again; the user can press Retry on the placement.\n${blocked.blocked!.message}`, this.view(blocked), "unknown");
  }

  view(record: PlacementRecord): PlacementView {
    const target = record.target as { environmentProviderId?: string };
    const rule = this.runtime.config().machines.rules.find(rule => rule.id === record.rule?.id);
    const snapshot = record.sourceSnapshotId ? this.services.store.snapshot(record.sourceSnapshotId) : null;
    const code = record.blocked?.code;
    const holdKind = code === "transfer-slots" ? "transfer-slots" : code === "maker-busy" ? "maker-busy"
      : code === "maker-slot" ? "maker-slot" : code === "checker-slot" ? "checker-slot" : null;
    let scopePending = record.acknowledgedScopeRevision !== record.desiredScopeRevision;
    if (record.memberThreadId && record.carries?.some(receipt => receipt.generation === record.generation && receipt.phase === "verified") && this.runtime.scopes) {
      try { scopePending ||= this.services.deliveries.get(record.id)?.templateDigest !== this.runtime.scopes.api.hostTemplate(record.memberThreadId).templateDigest; }
      catch { scopePending = true; }
    }
    const posture = postureText(record.posture);
    const pending = `${record.desiredScopeRevision === 1 ? "Scope not yet delivered" : "Scope update pending"}; detection paused until the host acknowledges the effective scope`;
    return {
      placementId: record.id, generation: record.generation,
      where: record.hostId ? { kind: "host", hostId: record.hostId, label: this.hostNames.get(record.hostId) ?? record.hostId }
        : { kind: "pending", label: `${this.providerNames.get(target.environmentProviderId ?? "") ?? target.environmentProviderId ?? "Machine provider"}${["reserved", "provisioning", "bootstrapping", "binding", "carrying"].includes(record.phase) ? ", starting" : `, ${record.phase}`}` },
      rule: record.rule ? { id: record.rule.id, label: this.ruleNames.get(record.rule.id) ?? rule?.label ?? record.rule.id } : null,
      phase: record.phase, hold: holdKind && record.blocked ? { kind: holdKind, message: record.blocked.message } : null,
      blocker: holdKind ? null : record.blocked ? { stage: record.blocked.stage, message: record.blocked.message, retryable: record.blocked.retryable }
        : scopePending && record.carries?.length ? { stage: "bind", message: pending, retryable: true } : null,
      posture: scopePending ? { ...posture, detail: [posture.detail, pending].filter(Boolean).join("; ") } : posture,
      source: snapshot ? { includesUncommitted: snapshot.includesUncommitted === true,
        from: `${snapshot.uncommittedOrigin?.root ?? snapshot.source.root} on ${this.hostNames.get(snapshot.source.hostId) ?? snapshot.source.hostId}` } : null,
      preservation: record.preservation.source, preservationReason: record.preservation.reason,
    };
  }

  observeHost(host: { id: string; name: string | null }): void {
    this.hostNames.set(host.id, host.name ?? host.id);
  }

  async status(keeperThreadId: string, questId: string | null = null) {
    this.runtime.keeper.require(keeperThreadId, "keeper");
    if (questId) this.runtime.keeper.owned(keeperThreadId, questId);
    const projectId = this.runtime.keeper.store.runtime(keeperThreadId).projectId;
    if (!projectId) throw new Error("This Keeper has no trusted project binding.");
    const policy: PlacementPolicyRead = this.runtime.settings?.placementPolicy() ?? { state: "valid", revision: 0, settings: this.runtime.config().machines };
    if (policy.state === "valid" && policy.settings.rules.some(rule => rule.enabled && rule.target.kind === "provider")) {
      const [providers, hosts] = await Promise.allSettled([
        Promise.resolve().then(() => this.runtime.bb.sdk.environments.listProviders({ projectId })),
        Promise.resolve().then(() => this.runtime.bb.sdk.hosts.list()),
      ]);
      this.providerNames.clear(); this.hostNames.clear();
      if (providers.status === "fulfilled") for (const provider of providers.value) this.providerNames.set(provider.id, provider.displayName);
      if (hosts.status === "fulfilled") for (const host of hosts.value) this.observeHost(host);
      const errors = [providers, hosts].flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
      if (errors.length) this.runtime.bb.log.warn(`Tavern placement display names unavailable; showing raw ids: ${errors.join("; ")}`);
    }
    let source: ReturnType<PlacementServices["sources"]["inspect"]> | undefined;
    let identity: ReturnType<typeof readSourceIdentity> | undefined;
    const classes = [];
    for (const classId of PLACEMENT_CLASSES) {
      if (classId === "keeper") {
        classes.push({ classId, rule: null, line: placementClassLine(classId, { state: "compatibility", revision: policy.revision }), matchEvidence: [], warnings: [] });
        continue;
      }
      const route = await resolvePlacementRoute(policy, { keeperThreadId, projectId, classId, questId }, {
        readIdentity: () => identity ??= readSourceIdentity(this.runtime.bb, keeperThreadId, projectId),
        inspectSource: () => source ??= this.services.sources.inspect(keeperThreadId, projectId),
      });
      const match = route.match;
      const target = match.state === "matched" ? match.rule.target : null;
      classes.push({ classId, rule: match.state === "matched" ? { id: match.rule.id, label: match.rule.label } : null,
        line: placementClassLine(classId, match, target?.kind === "provider" ? this.providerNames.get(target.environmentProviderId) : undefined),
        matchEvidence: match.state === "matched" ? match.matchEvidence : [], warnings: route.warnings });
    }
    if ((this.runtime.settings?.placementPolicy().revision ?? 0) !== policy.revision) throw new Error("Machine placement settings changed while reading status; retry.");
    const counts = this.services.store.counts(keeperThreadId), limits = this.runtime.config().machines;
    const members = [];
    for (let after: string | null = null; ;) {
      const page = this.services.store.activePage(after, 1000);
      for (const record of page) if (record.keeperThreadId === keeperThreadId && (!questId || record.questId === questId))
        members.push({ memberThreadId: record.memberThreadId, placement: this.view(record), line: this.line(record) });
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
    const text = placementGuidance(classes.map(row => row.line), counts, limits);
    return { classes, slots: { makers: { inUse: counts.makers, limit: limits.maxMakers }, checkers: { inUse: counts.checkers, limit: limits.maxCheckers } },
      members, text };
  }

  forMember(threadId: string): PlacementView | null {
    const record = this.services.store.byMember(threadId);
    return record ? this.view(record) : null;
  }

  line(record: PlacementRecord): string {
    const view = this.view(record), facts = record.matchEvidence.map(item => `${item.field}=${item.value}`).join(", ") || "explicit catch-all";
    return placementLine(view, facts);
  }

  retry(placementId: string, generation: number): Promise<PlacementView> {
    const key = `${placementId}:${generation}`, pending = this.retries.get(key);
    if (pending) return pending;
    const operation = this.retryOnce(placementId, generation);
    this.retries.set(key, operation);
    void operation.then(() => this.retries.delete(key), () => this.retries.delete(key));
    return operation;
  }

  private async retryOnce(placementId: string, generation: number): Promise<PlacementView> {
    const candidate = this.services.store.get(placementId);
    if (!candidate) throw new Error("Unknown placement.");
    let record = this.services.store.assertCurrent(placementId, generation, candidate.desiredState);
    if (record.memberThreadId && this.runtime.keeper.store.runtime(record.memberThreadId).placementModelFailureRelease) {
      if (!await this.runtime.retryModelFailureRelease(record.memberThreadId))
        throw new Error(this.runtime.keeper.store.runtime(record.memberThreadId).archiveError ?? "Model-failure release is still pending.");
      return this.view(this.services.store.get(record.id)!);
    }
    if (record.memberThreadId && (record.desiredState === "released" || record.blocked?.stage === "preserve" || record.blocked?.stage === "release")) {
      const result = await this.services.preserve.beforeRelease(record.memberThreadId, record.preservation.reason ?? "Retry preservation");
      if (result.state === "waiting" || result.state === "blocked") throw new Error(result.message);
      const current = this.services.store.get(placementId);
      if (!current) throw new Error("The placement disappeared during preservation; reconcile its resources.");
      return this.view(current);
    }
    if (["provisioning", "blocked"].includes(record.phase) && record.memberThreadId === null) {
      const matches = new Set<string>();
      for (const archived of [false, true]) {
        for (let offset = 0; ; offset += 200) {
          if (offset >= 2000) throw new Error("Child scan limit reached; reservation retained");
          const children = await this.runtime.bb.sdk.threads.list({ parentThreadId: record.keeperThreadId, projectId: record.projectId,
            originPluginId: this.runtime.bb.pluginId, includeHidden: true, archived, limit: 200, offset });
          this.services.store.assertCurrent(placementId, generation);
          for (const child of children) {
            const metadata = await this.runtime.bb.sdk.threads.getPluginMetadata({ threadId: child.id });
            this.services.store.assertCurrent(placementId, generation);
            if (metadata.hireToken === record.hireToken) matches.add(child.id);
          }
          if (children.length < 200) break;
        }
      }
      if (matches.size !== 1) throw new Error(matches.size ? "More than one child has this hire token; reconcile them before retrying."
        : "The spawn outcome is not confirmed; no matching child was found. The reservation remains held; no second machine was allocated.");
      const intent = this.runtime.keeper.store.get("hires", record.hireToken);
      if (!intent || isHireCancelled(this.runtime.keeper, intent)) throw new Error("This placement hire is cancelled or its private intent is missing; reconcile it before retrying.");
      if (record.phase === "blocked") record = this.services.store.retry(placementId, generation);
      const threadId = [...matches][0];
      record = this.services.provisioner.bindDispatchedMember(record.hireToken, threadId);
      this.runtime.keeper.bind(threadId, intent.classId, intent.characterId, intent.projectId, intent.owner);
      this.runtime.keeper.changed(threadId, record.questId);
      return this.view(record);
    }
    if (!record.blocked) return this.view(record);
    const member = record.memberThreadId && this.runtime.keeper.member(record.memberThreadId);
    if (!member) throw new Error("This placement has no live member to retry setup.");
    record = this.services.store.retry(placementId, generation);
    if (!record.memberThreadId) throw new Error("This placement has no dispatched member; retry the original hire rather than allocating again.");
    await this.runtime.tell(record.keeperThreadId, record.memberThreadId, "Setup can continue: call tavern_ready {} again before other work.");
    this.services.store.assertCurrent(placementId, generation);
    return this.view(record);
  }
}
