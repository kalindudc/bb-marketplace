import { randomUUID } from "node:crypto";
import { isLiveKeeper, isLiveMember, isOpenQuest } from "./liveness";
import { AwayRuntime } from "./away/runtime";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  BbPluginApi,
  MessageDispatchHookContext,
  PluginAgentConfigurationContext,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import { actorSchema, type Actor, type Brief, type Member } from "../shared/schema";
import { TICK_PREFIX } from "../shared/text";
import { tags } from "../shared/contract";
import { Keeper, partyCounts, type PlanInput } from "./keeper/service";
import { checkerAssignments, validatePartyCharacters, validateCheckerMakers, makerForWaypoint } from "./assignments";
import { Registry, type RegistrySnapshot } from "./registry";
import { TickLoop } from "./tick";
import { isNotFound } from "./host-errors";
import { loopCall } from "./loop-call";
import { classSelectionOnly, inputText, isUser, tickId, userInputText } from "./dispatch";
import {
  instructions,
  utf8Limit,
  dataFence,
  ledgerHeading,
} from "./instructions";
import { reserveStaffing, settleStaffing } from "./staffing";
import type { HireIntent, PendingBrief, ReviewTarget } from "./keeper/store";
import { resolveHireExecution } from "./execution";
import { ServiceRecords } from "./service-record";
import { classExecutionFacts, classLimits } from "./class-execution";
import { classStartRefusal } from "../shared/class-execution-contract";
import { CLASS_BODY_LIMIT } from "../shared/class-rules";
import { memberName } from "../shared/member-name";
import { reviewLimitation } from "../shared/check-posture";
import { resolveHireEnvironment } from "./environments";
import { authorizeGuardedHire } from "./guard-hire";
import { doneWhenCommands } from "./check-commands";
import { memberTitle, uniqueMemberName } from "./titles";
import { captureRequestSources, requestSourcePacket } from "./request-sources";
import { isHireCancelled, recoverHires, rejectedSpawn, releaseHire, settleCancelledHire } from "./hires";
import { BackendScopes, type BackendScopeOptions } from "./scopes";
import type { ProjectContext, ScopeOverride } from "../scope";
import type { Ask } from "../shared/schema";
import { DEFAULT_SETTINGS, type TavernSettings, type SparseTunables } from "../shared/settings";
import type { SettingsStore } from "./settings/store";
import type { InsightsReader } from "./insights/index";
import { runTuner } from "./settings/tuner";
import { LIMITS } from "./limits";
import { createHostPort } from "../host/client";
import { DiscoveryStore, StaleDiscoveryError } from "./placement/discovery-store";
import { SourceDiscovery, readSourceIdentity } from "./placement/source-discovery";
import { resolvePlacementRoute } from "./placement/routing";
import { isVoiceCheckThread, type VoiceCheckRunner } from "./voice-check/run";

export const KEEPER_TOOLS = [
  "tavern_route",
  "tavern_note",
  "tavern_gate",
  "tavern_quest",
  "tavern_hire",
  "tavern_release",
  "tavern_scope",
  "tavern_tell",
  "tavern_plan",
  "tavern_ask",
  "tavern_decide",
  "tavern_rule",
  "tavern_status",
  "tavern_wrap",
  "tavern_tune",
];
const pushResultSchema = z.object({
  ok: z.literal(true),
  channels: z.array(z.string()),
});
const submissionSchema = z.object({
  classId: z.string().optional(),
  route: z.enum(["aside", "new-quest"]).optional(),
  hireToken: z.string().optional(),
});
type Hire = {
  classId: string;
  brief: Brief;
  boardQuestId?: string | null;
  waypointId?: string | null;
  errand?: boolean;
  characterId?: string | null;
  title: string;
  scope?: ScopeOverride;
  requestDetectionOnly?: boolean;
  detectionOnlyAskId?: string;
};
type Thread = PluginThreadEventPayloads["thread.active"]["thread"];
type QueuedMessage = PluginThreadEventPayloads["message.queued"]["entry"];

export class TavernRuntime {
  readonly serviceRecords: ServiceRecords;
  readonly toolNames = [...KEEPER_TOOLS, "tavern_report", "tavern_request_sources"];
  private readonly loop = new TickLoop(this);
  private sourceInspection: SourceDiscovery | null = null;
  private awayState: AwayRuntime | null = null;
  get away(): AwayRuntime { return this.awayState ??= new AwayRuntime(this); }
  private reviewCache: ReturnType<TavernRuntime["review"]> | null = null;
  private stopFlights = new Map<string, Promise<void>>();
  private projectPaths = new Map<string, string>();
  private registryProblems = new Map<string, string>();
  private registryLoadedAt = new Map<string, number>();
  private registryFlights = new Map<string, Promise<RegistrySnapshot>>();
  private serverHostId: string | null = null;
  private projectContexts = new Map<string, ProjectContext>();
  scopes: BackendScopes | null = null;
  syncLegacyScopes: ((mode: TavernSettings["scopes"]["mode"]) => Promise<void>) | null = null;
  settings: SettingsStore | null = null;
  private insights: InsightsReader | null = null;
  /** Set by server.ts once the store is ready; the voice check RPCs refuse until then. */
  voiceChecks?: VoiceCheckRunner;
  private previousSettings: TavernSettings | null = null;
  private maintenanceAt: number | null = null;
  private initialBriefs = new Map<string, Promise<{ briefPending: boolean }>>();
  private notifiedAsks = new Set<string>();
  private queueResets = new Map<string, Promise<void>>();
  private memberObservations = new Map<string, Promise<void>>();
  private maintenance = new Map<string, { work: Promise<void>; startedAt: number }>();
  placementSources(): SourceDiscovery {
    if (this.sourceInspection === null)
      this.sourceInspection = new SourceDiscovery(this.bb, createHostPort(this.bb), new DiscoveryStore(this.keeper.store.db, () => this.keeper.now()));
    return this.sourceInspection;
  }
  config(questId?: string | null): TavernSettings {
    return this.settings ? this.settings.read(questId) : DEFAULT_SETTINGS;
  }
  enableSettings(settings: SettingsStore, insights: InsightsReader) {
    if (this.settings) throw new Error("Tavern settings are already registered");
    this.settings = settings;
    this.insights = insights;
    this.previousSettings = settings.read();
    this.keeper.settings = questId => settings.read(questId);
    this.keeper.askOpened = ask => {
      if (this.config().attention.notify === "all") void this.push(ask.keeperThreadId, ask.question, ask.why, ask.id);
    };
  }
  settingsChanged() {
    const next = this.config(), previous = this.previousSettings;
    this.previousSettings = next;
    this.reviewCache = null;
    if (this.scopes && this.scopes.api.mode() !== next.scopes.mode)
      this.scopes.api.setMode(next.scopes.mode);
    if (this.syncLegacyScopes && previous?.scopes.mode !== next.scopes.mode)
      void this.syncLegacyScopes(next.scopes.mode).catch(error => this.bb.log.warn(`Tavern legacy scope control: ${String(error)}`));
    if (previous?.tavern.paused && !next.tavern.paused) {
      for (const member of this.keeper.store.all("members").filter(m => isLiveKeeper(this.keeper.store, m))) {
        const state = this.keeper.store.runtime(member.threadId);
        if (state.failureAskId) this.keeper.withdrawAsk(state.failureAskId, "turn-recovered");
        this.keeper.store.patch(member.threadId, { failureCount: 0, tickRefusalCount: 0, tickRetryAt: null, failureAskId: null });
        this.keeper.reanchor(member.threadId, "Tavern unpaused");
        this.keeper.store.patch(member.threadId, { queuedTickResetId: randomUUID() });
        void this.tick(member.threadId).then(() => this.recheckDispatch()).catch(error => this.bb.log.warn(`Tavern unpause: ${String(error)}`));
      }
    }
    this.keeper.invalidateAll(false);
  }
  async recheckDispatch() {
    try { await this.bb.experimental_hooks.recheck("message.dispatch"); }
    catch (error) { this.bb.log.warn(`Tavern dispatch recheck: ${String(error)}`); }
  }
  record(kind: string, data: Record<string, unknown>, keeperId: string | null = null, questId: string | null = null, id?: string, at?: number) {
    try { this.insights?.record(kind, data, keeperId, questId, id, at); }
    catch (error) { this.bb.log.warn(`Tavern optional Insights sample ${kind}: ${String(error)}`); }
  }
  reportBatchHeld(threadId: string) {
    const rt = this.keeper.store.runtime(threadId);
    if (rt.reanchor || rt.pending.length) return false;
    const events = this.keeper.store.unreadEvents(threadId, rt.cursor, 100, true)
      .filter(event => !["journal.changed", "questlog.changed"].includes(event.type));
    if (!events.length || events.some(event => event.type !== "report.filed")) return false;
    const reports = this.keeper.store.query("reports", "keeperThreadId", threadId, 500);
    return events.every(event => {
      const report = reports.find(row => row.id === event.data.reportId);
      if (!report || report.status === "blocked" || report.status === "needs-decision") return false;
      const prior = reports.filter(row => row.boardQuestId === report.boardQuestId && row.deliveredAt !== null);
      if (!prior.length) return false;
      const last = Math.max(...prior.map(row => row.deliveredAt!));
      return this.keeper.now() - last < this.config(report.boardQuestId).knobs.reportBatchSeconds * 1000;
    });
  }
  tune(threadId: string, questId: string, values: SparseTunables, why: string) {
    if (!this.settings) throw new Error("Tavern settings are not registered");
    const quest = this.keeper.owned(threadId, questId);
    if (!isOpenQuest(quest)) throw new Error("This board quest is stopping or has ended");
    return this.settings.override(questId, threadId, values, why);
  }
  settingsMaintenance() {
    if (!this.settings || !this.insights) return;
    const now = this.keeper.now();
    if (this.maintenanceAt !== null && now - this.maintenanceAt < LIMITS.retryMs) return;
    this.maintenanceAt = now;
    const config = this.config(), ended = this.keeper.store.all("quests").filter(q => ["done", "stopped"].includes(q.phase));
    for (const quest of ended) this.settings.expire(quest.id);
    if (config.tuning.mode !== "off") {
      const signals = this.insights.signals();
      runTuner(this.settings, `daily:${new Date(now).toISOString().slice(0, 10)}`, signals);
      for (const quest of ended.filter(q => q.phase === "done" && q.endedAt !== null && q.endedAt >= this.settings!.collectingSince()))
        runTuner(this.settings, `returned:${quest.id}`, signals);
    }
    this.insights.prune();
    if (!config.tavern.paused && config.data.autoArchiveDays > 0) {
      const cutoff = now - config.data.autoArchiveDays * LIMITS.dayMs;
      const ids = ended.filter(q => q.archivedAt === null && q.endedAt !== null && q.endedAt <= cutoff).map(q => q.id);
      if (ids.length) this.keeper.archiveQuests(ids, true, { kind: "tavern" });
    }
  }
  async undoDecision(id: string) {
    const approval = this.keeper.store.get("autoGreenlights", id), decision = this.keeper.store.get("decisions", id);
    if (!approval || !decision) { this.keeper.undoDecision(id); return; }
    const release = this.keeper.store.atomic(() => {
      const before = this.keeper.quest(approval.boardQuestId);
      this.keeper.undoDecision(id);
      const after = this.keeper.quest(approval.boardQuestId);
      let resetVersion = approval.undonePlanVersion;
      if (!decision.undone && before.greenlitVersion === approval.planVersion && after.greenlitVersion === null && after.phase === "greenlight") {
        resetVersion = after.planVersion;
        this.keeper.store.put("autoGreenlights", id, { ...approval, undonePlanVersion: resetVersion });
      }
      return resetVersion === after.planVersion && after.phase === "greenlight" && after.greenlitVersion === null;
    });
    if (!release) return;
    for (const member of this.keeper.store.query("members", "boardQuestId", approval.boardQuestId, 500)) {
      if (member.createdAt < decision.createdAt || member.lastReportAt !== null || this.keeper.store.runtime(member.threadId).released) continue;
      await this.release(approval.keeperThreadId, member.threadId, "Automatic greenlight was undone before a report");
    }
  }
  spawnBriefDelivered(threadId: string): void {
    const member = this.keeper.member(threadId);
    if (member?.role !== "member") throw new Error("Spawn briefs require a bound party member");
    if (this.keeper.checkerHandoffProblem(member.classId, member.boardQuestId)) return;
    this.finishInitialBrief(threadId, null);
  }
  private requireBriefableMember(threadId: string): Member {
    const member = this.keeper.member(threadId);
    if (member?.role !== "member") throw new Error("Briefs require a bound party member");
    const state = this.keeper.store.runtime(threadId);
    const unavailable = state.released ? "released"
      : state.releasePending ? "being released"
      : state.archivePending ? "being archived"
      : member.state === "stopped" ? "stopped"
      : state.archivedAt != null || state.deletedAt != null ? "archived or deleted"
      : !isLiveMember(this.keeper.store, member, "brief") ? "on a board quest that has ended" : null;
    if (unavailable) {
      const reason = `${this.keeper.name(member)} is ${unavailable} and can't take new work; hire a replacement or re-plan.`;
      if (state.pendingBrief) {
        this.keeper.store.patch(threadId, { pendingBrief: null });
        this.keeper.store.event(this.keeper.now(), member.keeperThreadId, member.boardQuestId,
          "member.brief-refused", reason, { memberThreadId: threadId, briefId: state.pendingBrief.id });
        this.keeper.changed(threadId, member.boardQuestId);
      }
      throw new Error(reason);
    }
    return member;
  }
  async sendRebrief(threadId: string, text: string): Promise<{ briefPending: boolean }> {
    const member = this.requireBriefableMember(threadId);
    if (this.config().tavern.paused) throw new Error("Tavern is paused; no new brief was queued. Resume it before sending new work.");
    if (this.scopes?.pending(threadId)) throw new Error("The member is waiting for a scope decision; no new brief was queued.");
    if (!text.trim()) throw new Error("A brief cannot be empty");
    const state = this.keeper.store.runtime(threadId);
    if (state.pendingBrief && (state.pendingBrief.assignmentText ?? state.pendingBrief.text) !== text) throw new Error("A different brief is already pending; do not overwrite an uncertain delivery.");
    if (!state.pendingBrief) {
      const requestSources = captureRequestSources(this.keeper, member.keeperThreadId!, member.boardQuestId);
      this.keeper.store.patch(threadId, { pendingBrief: { id: `brief_${randomUUID()}`, text: `${text}\n\n${requestSourcePacket(this.keeper, requestSources)}`, assignmentText: text, requestSources, attempts: 0, nextAttemptAt: this.keeper.now(), attemptedAt: null, hostAfterSeq: null, error: null } });
    }
    return this.sendInitialBrief(threadId, this.keeper.store.runtime(threadId).pendingBrief!.text);
  }
  async sendInitialBrief(threadId: string, text: string): Promise<{ briefPending: boolean }> {
    const running = this.initialBriefs.get(threadId);
    if (running) return running;
    const result = this.deliverPendingBrief(threadId, text);
    this.initialBriefs.set(threadId, result);
    try { return await result; }
    finally { this.initialBriefs.delete(threadId); }
  }
  private finishInitialBrief(threadId: string, id: string | null) {
    this.keeper.store.atomic(() => {
      const state = this.keeper.store.runtime(threadId);
      if (id === null ? state.initialBriefAt !== undefined : state.pendingBrief?.id !== id) return;
      this.requireBriefableMember(threadId);
      this.keeper.store.patch(threadId, { pendingBrief: null, initialBriefAt: state.initialBriefAt ?? this.keeper.now(),
        ...(id !== null && state.pendingBrief ? { assignmentText: state.pendingBrief.assignmentText ?? state.pendingBrief.text, requestSources: state.pendingBrief.requestSources ?? state.requestSources ?? null } : {}),
        ...(id !== null && state.pendingBrief && state.brief && state.initialBriefAt !== undefined ? { brief: { ...state.brief, context: [...state.brief.context, `Follow-up v${(state.briefVersion ?? 0) + 1}: ${state.pendingBrief.assignmentText ?? state.pendingBrief.text}`] } } : {}),
      });
      this.briefed(threadId);
      const member = this.keeper.member(threadId)!;
      if (id !== null && state.pendingBrief) {
        if (!state.released && !state.releasePending && !state.archivePending && member.state !== "stopped") {
          this.keeper.activity(threadId, "working");
          this.keeper.store.put("members", threadId, {
            ...this.keeper.member(threadId)!, doing: (state.pendingBrief.assignmentText ?? state.pendingBrief.text).slice(0, 300),
          });
        }
        this.keeper.store.event(this.keeper.now(), member.keeperThreadId, member.boardQuestId,
          "member.told", state.pendingBrief.assignmentText ?? state.pendingBrief.text,
          { memberThreadId: threadId, briefId: id, briefPending: false, delivery: "delivered", attempts: state.pendingBrief.attempts },
          { kind: "agent", threadId: member.keeperThreadId! });
        // Acceptance, the new brief version and the journal's reopen and supersession share this transaction.
        if (member.boardQuestId) this.keeper.journal.rebriefed(threadId, member.boardQuestId, this.keeper.store.runtime(threadId).briefVersion ?? 0);
      }
      this.keeper.store.event(this.keeper.now(), member.keeperThreadId, member.boardQuestId,
        "member.briefed", `${this.keeper.name(member)}'s brief was accepted`, { memberThreadId: threadId });
    });
    this.keeper.changed(threadId);
  }
  private ensureBriefBlocker(threadId: string) {
    const pending = this.keeper.store.runtime(threadId).pendingBrief;
    if (!pending || pending.attempts < LIMITS.briefRetryAttempts || this.config().tavern.paused) return;
    if (pending.blockerAskId && this.keeper.store.get("asks", pending.blockerAskId)?.state === "open") return;
    const member = this.keeper.member(threadId);
    if (!member?.keeperThreadId) throw new Error("An unbriefed member needs its owning Keeper");
    this.keeper.store.atomic(() => {
      const ask = this.keeper.ask(member.keeperThreadId!, {
        boardQuestId: member.boardQuestId, kind: "blocker",
        question: `${this.keeper.name(member)}'s brief needs help`,
        why: `Delivery or confirmation failed after ${LIMITS.briefRetryAttempts} attempts. The member and its slot are retained. ${pending.error ?? "No acceptance receipt was found."}`,
        options: [{ id: "retry", label: "Retry the brief", detail: "Allow another bounded delivery attempt", recommended: true },
          { id: "release", label: "Release the member", detail: "Stop it and free its slot after confirmation", recommended: false }],
        holds: member.waypointId ? [member.waypointId] : [], meanwhile: "Do not hire a duplicate for this slot; other work may continue.",
      }, undefined, true);
      this.keeper.store.put("askMeta", ask.id, { ...this.keeper.store.get("askMeta", ask.id), briefDelivery: { threadId, briefId: pending.id } });
      this.keeper.store.patch(threadId, { pendingBrief: { ...pending, blockerAskId: ask.id } });
      void this.push(member.keeperThreadId!, ask.question, ask.why);
    });
  }
  private async briefReceipt(threadId: string, pending: PendingBrief): Promise<"accepted" | "queued" | "absent"> {
    const queued = await this.bb.sdk.threads.queuedMessages.list({ threadId });
    const row = queued.find(row => row.originPluginId === this.bb.pluginId && JSON.stringify(row.content).includes(pending.id));
    if (row) {
      if (row.failureReason) throw new Error(`Queued brief failed: ${row.failureReason}; inspect the failed queue row before retrying.`);
      return "queued";
    }
    let cursor = pending.hostAfterSeq ?? 0;
    for (let page = 0; page < LIMITS.briefEvidencePages; page++) {
      const events = await this.bb.sdk.threads.events.list({ threadId, afterSeq: String(cursor), types: ["client/turn/requested"], limit: "100", order: "asc" });
      if (events.some(event => {
        const request = z.object({ originPluginId: z.literal(this.bb.pluginId), input: z.array(z.unknown()) }).safeParse(event.data);
        return request.success && JSON.stringify(request.data.input).includes(pending.id);
      })) return "accepted";
      if (events.length < 100) return "absent";
      cursor = events.at(-1)!.seq;
    }
    throw new Error("Brief acceptance history is incomplete; no duplicate brief was sent.");
  }
  private async deliverPendingBrief(threadId: string, text: string): Promise<{ briefPending: boolean }> {
    const member = this.requireBriefableMember(threadId);
    if (this.keeper.checkerHandoffProblem(member.classId, member.boardQuestId)) return { briefPending: true };
    if (this.away.blocked(threadId)) return { briefPending: true };
    const state = this.keeper.store.runtime(threadId);
    if (!state.pendingBrief && state.lastBriefAt !== undefined) return { briefPending: false };
    const pending: PendingBrief = state.pendingBrief ?? { id: `brief_${randomUUID()}`, text, ...(state.initialBriefAt === undefined && state.requestSources ? { assignmentText: state.assignmentText ?? state.brief?.outcome ?? text, requestSources: state.requestSources } : {}), attempts: 0, nextAttemptAt: this.keeper.now(), attemptedAt: null, hostAfterSeq: null, error: null };
    if (pending.text !== text) throw new Error("A different initial brief is already pending; do not overwrite an uncertain delivery.");
    if (!state.pendingBrief) this.keeper.store.patch(threadId, { pendingBrief: pending });
    if (this.config().tavern.paused || this.scopes?.pending(threadId)) return { briefPending: true };
    if (this.keeper.now() < pending.nextAttemptAt) return { briefPending: true };
    const attempt: PendingBrief = { ...pending, attempts: pending.attempts + 1,
      nextAttemptAt: this.keeper.now() + Math.min(LIMITS.briefRetryMaxMs, LIMITS.briefRetryMs * 2 ** pending.attempts), error: null };
    try {
      if (pending.attemptedAt !== null) {
        const receipt = await this.briefReceipt(threadId, pending);
        if (receipt === "accepted") { this.finishInitialBrief(threadId, pending.id); return { briefPending: false }; }
        if (receipt === "queued") {
          this.keeper.store.patch(threadId, { pendingBrief: { ...pending, nextAttemptAt: this.keeper.now() + LIMITS.briefRetryMs } });
          return { briefPending: true };
        }
      }
      if (pending.attempts >= LIMITS.briefRetryAttempts) {
        this.keeper.store.patch(threadId, { pendingBrief: { ...pending, nextAttemptAt: this.keeper.now() + LIMITS.briefRetryMaxMs } });
        this.ensureBriefBlocker(threadId);
        return { briefPending: true };
      }
      if (this.scopes) await this.scopes.ensure(member);
      const latest = await this.bb.sdk.threads.events.list({ threadId, limit: "1", order: "desc" });
      this.requireBriefableMember(threadId);
      try { this.updateThread(await this.bb.sdk.threads.get({ threadId })); }
      catch (error) {
        if (!isNotFound(error)) throw error;
        this.keeper.store.patch(threadId, { deletedAt: this.keeper.now(), archivedAt: this.keeper.now() });
      }
      this.requireBriefableMember(threadId);
      if (this.away.blocked(threadId) || this.keeper.checkerHandoffProblem(member.classId, member.boardQuestId)) return { briefPending: true };
      attempt.hostAfterSeq = latest[0]?.seq ?? 0;
      attempt.attemptedAt = this.keeper.now();
      this.keeper.store.patch(threadId, { pendingBrief: attempt });
      const result = await this.bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: `[Tavern brief] id=${pending.id}\n${text}`, mentions: [], visibility: "agent-only" }] });
      if (result.delivery === "sent") { this.finishInitialBrief(threadId, pending.id); return { briefPending: false }; }
      return { briefPending: true };
    } catch (error) {
      this.requireBriefableMember(threadId);
      attempt.attempts = Math.min(attempt.attempts, LIMITS.briefRetryAttempts);
      attempt.error = String(error).slice(0, 1000);
      this.keeper.store.atomic(() => {
        this.keeper.store.patch(threadId, { pendingBrief: attempt });
        this.keeper.store.event(this.keeper.now(), member.keeperThreadId, member.boardQuestId, "member.unbriefed",
          `${this.keeper.name(member)}'s brief delivery failed on attempt ${attempt.attempts}: ${attempt.error}`,
          { memberThreadId: threadId, attempts: attempt.attempts, nextAttemptAt: attempt.nextAttemptAt, exhausted: attempt.attempts >= LIMITS.briefRetryAttempts });
      });
      this.keeper.changed(threadId, member.boardQuestId);
      this.ensureBriefBlocker(threadId);
      return { briefPending: true };
    }
  }
  async retryInitialBriefs(keeperId: string) {
    if (this.config().tavern.paused || !isLiveKeeper(this.keeper.store, this.keeper.member(keeperId))) return;
    const host = await this.bb.sdk.threads.get({ threadId: keeperId });
    this.updateThread(host);
    if (!isLiveKeeper(this.keeper.store, this.keeper.member(keeperId))) return;
    for (const member of this.keeper.store.query("members", "keeperThreadId", keeperId, 500)) {
      const state = this.keeper.store.runtime(member.threadId);
      if (member.role !== "member" || !state.pendingBrief) continue;
      try {
        this.requireBriefableMember(member.threadId);
        if (this.scopes?.pending(member.threadId)) continue;
        await this.sendInitialBrief(member.threadId, state.pendingBrief.text);
      } catch (error) { this.bb.log.warn(`Tavern brief ${member.threadId}: ${String(error)}`); }
    }
  }
  enableScopes(options: BackendScopeOptions = {}) {
    if (this.scopes) throw new Error("Tavern scopes are already registered");
    this.scopes = new BackendScopes(this, options);
  }
  scopeProjectContext(projectId: string) {
    const context = this.projectContexts.get(projectId);
    if (!context) throw new Error("Project scope policy was not prepared");
    return context;
  }
  async answerAsk(
    askId: string,
    optionId: string,
    note: string | null,
    via: NonNullable<Ask["answer"]>["via"],
    clientAction = false,
  ) {
    if (this.away.store.snapshot().status.closed && !clientAction) throw new Error("An away ask answer needs an explicit client action.");
    const previousAsk = this.keeper.store.get("asks", askId);
    if (previousAsk?.releaseHoldId && !clientAction) throw new Error("Releasing a checker-handoff hold requires an explicit client action; the Keeper cannot answer it.");
    const previousState = previousAsk?.state;
    const metadata = this.keeper.store.get("askMeta", askId);
    const brief = metadata?.briefDelivery;
    this.keeper.answerAsk(askId, optionId, note, via);
    const ask = this.keeper.store.get("asks", askId)!;
    if (clientAction && previousState === "open" && ask.state === "answered")
      await this.away.return({ kind: "ask-answer", threadId: ask.keeperThreadId, refId: ask.id });
    const state = this.keeper.store.runtime(ask.keeperThreadId);
    if (
      previousState === "open" &&
      state.failureAskId === askId &&
      optionId === "retry"
    ) {
      this.keeper.store.patch(ask.keeperThreadId, {
        failureCount: 0,
        tickRefusalCount: 0,
        tickRetryAt: null,
        failureAskId: null,
      });
      this.keeper.reanchor(
        ask.keeperThreadId,
        "explicit retry after provider failures",
      );
    }
    if (previousState === "open" && brief) {
      const pending = this.keeper.store.runtime(brief.threadId).pendingBrief;
      if (pending?.id === brief.briefId) {
        if (optionId === "retry") {
          this.keeper.store.patch(brief.threadId, { pendingBrief: { ...pending, attempts: 0, nextAttemptAt: this.keeper.now(), error: null, blockerAskId: null } });
          await this.sendInitialBrief(brief.threadId, pending.text);
        } else if (optionId === "release") await this.release(ask.keeperThreadId, brief.threadId, "User released an unbriefed member");
      }
    }
    if (previousState === "open" && metadata?.stopHireTokens && ask.boardQuestId && optionId === "retry") {
      try { await loopCall(recoverHires(this.bb, this.keeper, ask.keeperThreadId), "retry stopping hires"); }
      catch (error) { this.bb.log.warn(`Tavern stopping hire recovery: ${String(error)}`); }
    }
    if (previousState === "open" && (metadata?.stopMemberThreadId || metadata?.stopHireTokens) && ask.boardQuestId && optionId === "retry")
      await this.retryStops(ask.keeperThreadId, ask.boardQuestId, true);
    if (this.scopes) await this.scopes.answer(ask);
    if (previousState === "open" && state.tickDeliveryAskId === askId && optionId === "retry") {
      await this.resetQuietQueue(ask.keeperThreadId);
      await this.loop.recover(ask.keeperThreadId, true);
    }
    void this.resetQuietQueue(ask.keeperThreadId).then(() => this.recheckDispatch()).catch(error => this.bb.log.warn(`Tavern resume: ${String(error)}`));
  }
  constructor(
    readonly bb: BbPluginApi,
    readonly keeper: Keeper,
    readonly registry: Registry,
  ) {
    this.serviceRecords = new ServiceRecords(keeper, stale => bb.rpc.experimental_invalidate(stale));
    keeper.store.log = (level, message) => this.bb.log[level](message);
    keeper.memory.review = () => this.review("automatic");
    keeper.resolveMemberName = member => memberName(member, this.snapshot(keeper.store.runtime(member.threadId).projectId ?? undefined));
  }
  projectPath(projectId: string) {
    return this.projectPaths.get(projectId) ?? null;
  }
  async prepareRegistry(projectId: string): Promise<RegistrySnapshot> {
    const loadedAt = this.registryLoadedAt.get(projectId), now = this.keeper.now();
    if (loadedAt !== undefined && now >= loadedAt && now - loadedAt < LIMITS.projectSourceCacheMs && this.projectContexts.has(projectId)) return this.snapshot(projectId);
    const active = this.registryFlights.get(projectId);
    if (active) return active;
    const work = this.loadRegistry(projectId);
    this.registryFlights.set(projectId, work);
    try { return await work; }
    finally { if (this.registryFlights.get(projectId) === work) this.registryFlights.delete(projectId); }
  }
  private async loadRegistry(projectId: string): Promise<RegistrySnapshot> {
    try {
    return await loopCall((async () => {
    const config = await this.bb.sdk.system.config();
    this.serverHostId = config.primaryHostId ?? null;
    const project = await this.bb.sdk.projects.get({ projectId });
    const local = project.sources.filter(
      (source) => source.hostId === this.serverHostId,
    );
    const source = local.find((source) => source.isDefault) ?? local[0];
    if (source) this.projectPaths.set(projectId, source.path);
    else this.projectPaths.delete(projectId);
    this.projectContexts.set(projectId, {
      ...(source ? { projectRoot: source.path } : {}),
      remotes: project.gitRemoteUrl ? [project.gitRemoteUrl] : [],
    });
    const snapshot = this.snapshot(projectId);
    this.registryProblems.delete(projectId);
    this.registryLoadedAt.set(projectId, this.keeper.now());
    return source || project.sources.length === 0
      ? snapshot
      : {
          ...snapshot,
          problems: [
            ...snapshot.problems,
            {
              path: `.agents/tavern (project ${projectId})`,
              message:
                "Project overrides are available only from a server-local checkout in this version; remote paths were not read on the server.",
            },
          ],
        };
    })(), "project registry lookup");
    } catch (error) {
      this.projectContexts.delete(projectId);
      this.projectPaths.delete(projectId);
      this.registryLoadedAt.delete(projectId);
      this.registryProblems.set(projectId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  builtinSnapshot() {
    const builtin = this.registry.directories().builtin;
    return new Registry(builtin, builtin).read();
  }
  mentionClass(id: string) {
    return [
      this.snapshot(),
      ...[...this.projectPaths.keys()].map((projectId) =>
        this.snapshot(projectId),
      ),
    ]
      .flatMap((s) => s.classes)
      .find((c) => c.id === id && c.startable);
  }
  snapshot(projectId?: string) {
    const snapshot = this.registry.read(projectId ? this.projectPath(projectId) : null), overrides = this.config().classes;
    return { ...snapshot, classes: snapshot.classes.map(role => overrides[role.id] ? { ...role, ...overrides[role.id] } : role) };
  }
  busyCharacters(projectId: string) {
    return this.keeper.store
      .all("members")
      .filter(m => {
        const state = this.keeper.store.runtime(m.threadId);
        return state.projectId === projectId && (m.role === "keeper" ? isLiveKeeper(this.keeper.store, m, "present") : isLiveMember(this.keeper.store, m, "occupy"));
      })
      .map((m) => m.characterId);
  }
  private recordRegistryFailure(threadId: string, problem: string) {
    if (this.keeper.member(threadId)?.role !== "keeper") return;
    this.keeper.store.patch(threadId, { classRootProblem: problem, classNotice: { message: `${problem} Using the built-in Keeper; hires are unavailable until the files load.`, settings: true, switchExecution: null } });
    this.bb.rpc.experimental_invalidate([tags.thread(threadId)]);
  }
  private clearRegistryFailure(threadId: string) {
    const state = this.keeper.store.runtime(threadId);
    if (!state.classRootProblem && state.registryWaitSince == null && !state.registryFailureAskId && !state.builtinKeeperFallback) return;
    if (state.registryFailureAskId) this.keeper.withdrawAsk(state.registryFailureAskId, "turn-recovered");
    this.keeper.store.patch(threadId, { classRootProblem: null, ...(state.classRootProblem ? { classNotice: null } : {}), registryWaitSince: null, registryFailureAskId: null, builtinKeeperFallback: false });
    this.bb.rpc.experimental_invalidate([tags.thread(threadId)]);
  }
  private registryFailureBlocker(threadId: string, member: Member | null, hire: HireIntent | null | undefined, problem: string, since: number) {
    if (this.keeper.now() - since < LIMITS.registryBlockerMs || this.config().tavern.paused) return;
    const keeperId = member?.keeperThreadId ?? hire?.owner.keeperThreadId;
    if (!keeperId || this.keeper.member(keeperId)?.role !== "keeper") return;
    const state = this.keeper.store.runtime(threadId);
    if (state.registryFailureAskId && this.keeper.store.get("asks", state.registryFailureAskId)?.state === "open") return;
    const name = member ? this.keeper.name(member) : hire?.owner.displayName ?? "The hired member";
    const ask = this.keeper.ask(keeperId, { kind: "blocker", question: `${name} is waiting for its project class files`, why: problem.slice(0, 200), options: [{ id: "retry", label: "Retry", detail: "Repair the project lookup or class files; admission retries without running unscoped.", recommended: true }], meanwhile: "This member remains held. Other admitted work may continue.", holds: [] }, undefined, true);
    this.keeper.store.patch(threadId, { registryFailureAskId: ask.id });
  }
  private projectClassNotice(threadId: string, classId: string, projectId: string) {
    const projectPath = this.projectPath(projectId);
    if (!projectPath) return;
    const file = this.registry.file("class", classId, projectPath);
    if (file.source !== "project") return;
    const revision = this.registry.classLayers(classId, this.projectPath(projectId)).revision;
    const state = this.keeper.store.runtime(threadId);
    if (state.projectClassRevision === revision) return;
    const message = `Project class override: ${file.path} supplies this class execution, prompt, hire policy and limits. Effective limits cannot exceed your Tavern settings.`;
    this.keeper.store.patch(threadId, { projectClassRevision: revision, classNotice: { message: state.classNotice ? `${state.classNotice.message} ${message}` : message, settings: true, switchExecution: state.classNotice?.switchExecution ?? null } });
    this.bb.rpc.experimental_invalidate([tags.thread(threadId)]);
  }
  private configureUnavailable(ctx: PluginAgentConfigurationContext, member: Member) {
    const problem = `The project class files could not be loaded: ${this.registryProblems.get(ctx.project.id) ?? "the project registry has not warmed yet"}.`;
    if (member.role === "keeper") {
      this.recordRegistryFailure(member.threadId, problem);
      const snapshot = this.builtinSnapshot();
      snapshot.classes = snapshot.classes.map(role => role.id === "keeper" ? { ...role, body: `${problem} You can still talk with the user; hires are unavailable until the files load.\n\n${role.body}` } : role);
      return this.configureChecked(ctx, snapshot);
    }
    return { tools: member.role === "member" ? ["tavern_report"] : [], skills: [] as string[], instructions: `${problem} Do no work. ${member.role === "member" ? "Use tavern_report with status blocked, naming this problem and the affected project. Resume only after its class files load." : "Explain the problem plainly to the user; class-specific work is unavailable until its files load."}` };
  }
  configure(ctx: PluginAgentConfigurationContext) {
    if (isVoiceCheckThread(ctx.pluginMetadata)) return { tools: [] as string[], skills: [] as string[], instructions: "" };
    try {
      const member = this.keeper.member(ctx.thread.id);
      if (member && (!this.projectContexts.has(ctx.project.id) || this.keeper.store.runtime(member.threadId).builtinKeeperFallback)) return this.configureUnavailable(ctx, member);
      this.clearRegistryFailure(ctx.thread.id);
      return this.configureChecked(ctx);
    } catch (error) {
      this.bb.log.warn(`Tavern configuration failed: ${String(error)}`);
      let member: Member | null = null;
      try {
        member = this.keeper.member(ctx.thread.id);
      } catch (identityError) {
        this.bb.log.warn(
          `Tavern identity unavailable: ${String(identityError)}`,
        );
      }
      return {
        tools: [
          "journal",
          ...(member?.role === "keeper"
            ? KEEPER_TOOLS
            : member?.role === "member"
              ? ["tavern_report"]
              : []),
        ],
        skills: [
          "journal",
          "quest-management",
          ...(member?.role === "keeper" ? ["tavern-keeper"] : []),
        ],
        instructions:
          "Tavern could not assemble the ledger or journal. Do not infer missing state. Read tavern_status if available, report the problem plainly, and do not change board quests until the ledger is restored.",
      };
    }
  }
  private configureChecked(ctx: PluginAgentConfigurationContext, fallback?: RegistrySnapshot) {
    // Tavern's hidden voice-check threads answer from their prompt alone: no tools, skills, journal or ledger.
    if (isVoiceCheckThread(ctx.pluginMetadata)) return { tools: [] as string[], skills: [] as string[], instructions: "" };
    const m = this.keeper.member(ctx.thread.id);
    const common = {
      tools: ["journal"],
      skills: ["journal", "quest-management"],
    };
    const journal = this.keeper.journal.instructions(ctx.thread.id);
    if (!m) return { ...common, instructions: utf8Limit(journal, LIMITS.configureBytes) };
    const registry = fallback ?? this.snapshot(ctx.project.id);
    const role = (fallback ? null : this.keeper.store.runtime(m.threadId).classDefinition) ?? registry.classes.find((c) => c.id === m.classId);
    const baseCharacter = registry.characters.find(
      (c) => c.id === m.characterId,
    );
    const character =
      baseCharacter && m.displayName
        ? { ...baseCharacter, name: m.displayName }
        : baseCharacter;
    const snapshot =
      m.role === "keeper" ? this.keeper.ledger(m.threadId) : null;
    const state =
      m.role === "keeper"
        ? snapshot!.text
        : JSON.stringify({
            brief: this.keeper.store.runtime(m.threadId).brief,
            boardQuest: m.boardQuestId
              ? this.keeper.quest(m.boardQuestId).title
              : null,
            doneWhen: m.boardQuestId
              ? this.keeper.summary(m.boardQuestId).plan?.doneWhen
              : null,
            openEntries: this.keeper.journal.openSummary(m.threadId, 12),
            ...(m.classId === "warden"
              ? {
                  checkerWaypointIds: this.keeper.checkerWaypoints(m.threadId),
                  reviewTarget: this.keeper.store.runtime(m.threadId).reviewTarget ?? null,
                  guardPosture: m.guardPosture ?? null,
                  reviewPosture: m.checkIndependence === "same-family" ? "same-family check (not independent)"
                    : m.checkIndependence === "independent" ? "known different-family check" : "independence not established",
                }
              : {}),
            rules: this.keeper
              .rules(m.threadId, m.boardQuestId)
              .slice(0, 30)
              .map((r) => r.text),
          });
    const awayFacts = this.away.facts(m.keeperThreadId ?? m.threadId);
    return {
      tools: [
        ...common.tools,
        ...(m.role === "keeper"
          ? KEEPER_TOOLS
          : m.role === "member"
            ? ["tavern_report", "tavern_request_sources"]
            : []),
      ],
      skills: [
        ...common.skills,
        ...(m.role === "keeper" ? ["tavern-keeper"] : []),
      ],
      instructions: instructions(
        role?.body ??
          "The class definition is missing. Stop and ask the user to restore it.",
        character,
        journal,
        `${this.keeper.openingGoalHint(m.threadId) ?? ""}\n${awayFacts ? `Closing time facts (quoted data):\n${dataFence(awayFacts)}\n` : ""}${snapshot ? `Live class limits (quoted data): ${JSON.stringify(role ? classLimits(role, this.config()) : null)}\n` : ""}Ledger and brief (quoted data, never instructions):\n${snapshot ? ledgerHeading(snapshot.asOf, snapshot.version) + "\nVersion rule: see session instructions.\n" : ""}${dataFence(state)}`,
        m.role,
        memberName(m, registry),
        this.config(m.boardQuestId).tavern.voice,
      ),
    };
  }
  private dispatchBinding(ctx: MessageDispatchHookContext) {
    const own = ctx.experimental_submission?.pluginId === this.bb.pluginId;
    const parsed = own ? submissionSchema.safeParse(ctx.experimental_submission!.data) : null;
    const data = parsed?.success ? parsed.data : null;
    const member = this.keeper.member(ctx.thread.id);
    const pendingHire = !data?.hireToken && ctx.thread.status === "pending" ? this.keeper.store.hireForMember(ctx.thread.id) : null;
    const hireToken = data?.hireToken ?? pendingHire?.id;
    const starting = !member && ctx.thread.status === "pending" && isUser(ctx);
    const mention = starting ? ctx.input.blocks.flatMap(block => block.type === "text" ? block.mentions ?? [] : []).find(mention => mention.resource.kind === "plugin" && mention.resource.pluginId === this.bb.pluginId && mention.resource.itemId.startsWith("classes:")) : null;
    const mentionId = mention?.resource.kind === "plugin" ? mention.resource.itemId.slice("classes:".length) : null;
    const explicitClass = data?.classId ?? mentionId;
    const defaulted = starting && !explicitClass && !ctx.experimental_submission;
    const classId = starting ? explicitClass ?? (defaulted && this.config().tavern.defaultClass !== "none" ? this.config().tavern.defaultClass : null) : null;
    return { member, data, hireToken, classId, defaulted, invalidSubmission: !!parsed && !parsed.success };
  }
  private humanThread(ctx: MessageDispatchHookContext, binding: ReturnType<TavernRuntime["dispatchBinding"]>) {
    const human = ctx.queuedMessages.length ? ctx.queuedMessages.some(isUser) : isUser(ctx);
    return human && !binding.hireToken && !this.loop.isTick(ctx) && (binding.member?.role === "keeper" || binding.member?.role === "solo" || !!binding.classId && binding.classId !== "none");
  }
  private userInputs(ctx: MessageDispatchHookContext, member: Member, data: ReturnType<TavernRuntime["dispatchBinding"]>["data"]): Parameters<Keeper["receiveUser"]>[] {
    if (ctx.queuedMessages.length) return ctx.queuedMessages.filter(isUser).map((row): Parameters<Keeper["receiveUser"]> => [
      member.threadId, userInputText(row.content), null, row.id, row.createdAt, true, ctx.thread.status === "pending", classSelectionOnly(row.content, member.classId),
    ]);
    return isUser(ctx) ? [[
      member.threadId, ctx.input.blocks.length ? userInputText(ctx.input.blocks) : ctx.input.text, data?.route ?? null, undefined,
      this.keeper.now(), ctx.thread.status !== "active" || ctx.attempt === "join-turn", ctx.thread.status === "pending", classSelectionOnly(ctx.input.blocks, member.classId),
    ]] : [];
  }
  private async admitHumanFallback(ctx: MessageDispatchHookContext, binding: ReturnType<TavernRuntime["dispatchBinding"]>, reason: string) {
    const member = this.keeper.member(ctx.thread.id);
    const classId = member?.classId ?? binding.classId ?? "keeper";
    const label = classId === "keeper" ? "Keeper" : memberName({ classId, characterId: null }, this.builtinSnapshot());
    const requiredScope = this.scopes?.api.mode() === "enforce" && (classId === "keeper" || this.scopes.api.shouldScope(classId, "direct"));
    if (!member || requiredScope && !this.scopes!.api.status().threads.some(row => row.threadId === ctx.thread.id && row.scope && !row.error)) {
      const message = `Tavern couldn't set up this ${label}'s scope: ${reason}. Send again, or start it as a plain thread.`;
      this.keeper.store.patch(ctx.thread.id, { classNotice: { message, settings: true, switchExecution: null } });
      this.bb.rpc.experimental_invalidate([tags.thread(ctx.thread.id)]);
      return { action: "reject" as const, message };
    }
    const issues = new Set<string>();
    try { await this.away.detectReturn(ctx); }
    catch (error) {
      const message = `Tavern couldn't check Closing time return: ${error instanceof Error ? error.message : String(error)}`;
      this.bb.log.warn(message);
      issues.add(message);
    }
    for (const input of this.userInputs(ctx, member, binding.data)) {
      try { this.keeper.receiveUser(...input); }
      catch (error) {
        const message = `Tavern couldn't record this message: ${error instanceof Error ? error.message : String(error)}`;
        this.bb.log.warn(message);
        issues.add(message);
      }
    }
    const scopeNote = requiredScope ? `the ${label}'s existing scope still applies` : "the current scope settings are unchanged";
    this.keeper.store.patch(ctx.thread.id, { classNotice: { message: `Tavern's checks failed: ${reason}. Your message was allowed through after 30 seconds; ${scopeNote}.${issues.size ? " " + [...issues].join(". ") : ""}`, settings: true, switchExecution: null } });
    this.bb.rpc.experimental_invalidate([tags.thread(ctx.thread.id)]);
    return { action: "proceed" as const };
  }
  async dispatch(ctx: MessageDispatchHookContext) {
    const startedAt = this.keeper.now();
    let protectedThread = true;
    let binding: ReturnType<TavernRuntime["dispatchBinding"]> | undefined;
    try {
      binding = this.dispatchBinding(ctx);
      protectedThread = !!binding.member || !!binding.hireToken || !!binding.classId && binding.classId !== "none";
      const result = await this.dispatchChecked(ctx, binding);
      if (result.action === "proceed" && ctx.attempt === "start-turn" && binding.member?.role === "member" && binding.member.boardQuestId) {
        const choice = this.keeper.store.runtime(ctx.thread.id).classExecutionChoice, recordedAt = this.keeper.now();
        try {
          if (choice?.providerId !== ctx.requestedExecution.providerId || choice.model !== ctx.requestedExecution.model)
            this.keeper.store.patch(ctx.thread.id, { classExecutionChoice: { providerId: ctx.requestedExecution.providerId, model: ctx.requestedExecution.model, recordedAt, reasoningLevel: ctx.requestedExecution.reasoningLevel, modelSource: ctx.executionSources.model, reasoningSource: ctx.executionSources.reasoningLevel } });
          this.serviceRecords.executionRecordingSucceeded(ctx.thread.id, recordedAt);
        } catch (error) {
          this.serviceRecords.executionRecordingFailed(ctx.thread.id, recordedAt);
          this.bb.log.warn(`Tavern could not record execution for ${ctx.thread.id}; its model family is unknown: ${String(error)}`);
        }
      }
      if (this.keeper.store.runtime(ctx.thread.id).dispatchFailureSince != null)
        this.keeper.store.patch(ctx.thread.id, { dispatchFailureSince: null });
      return result;
    } catch (error) {
      this.bb.log.warn(`Tavern dispatch check failed: ${String(error)}`);
      if (binding && this.humanThread(ctx, binding)) {
        const since = this.keeper.store.runtime(ctx.thread.id).dispatchFailureSince ?? startedAt;
        this.keeper.store.patch(ctx.thread.id, { dispatchFailureSince: since });
        const remaining = LIMITS.registryKeeperWaitMs - (this.keeper.now() - since);
        if (remaining <= 0) return this.admitHumanFallback(ctx, binding, (error instanceof Error ? error.message : String(error)).slice(0, 1000));
        return { action: "wait" as const, reason: "Tavern could not safely admit this message", sendAt: this.keeper.now() + Math.min(LIMITS.registryKeeperRetryMs, remaining) };
      }
      return protectedThread || this.loop.isTick(ctx)
        ? { action: "wait" as const, reason: "Tavern could not safely admit this message", sendAt: this.keeper.now() + LIMITS.retryMs }
        : { action: "proceed" as const };
    }
  }
  private async dispatchChecked(ctx: MessageDispatchHookContext, binding: ReturnType<TavernRuntime["dispatchBinding"]>) {
    if (this.loop.isTick(ctx)) {
      const state = this.keeper.store.runtime(ctx.thread.id);
      if (state.archivedAt != null || state.deletedAt != null || ctx.thread.archivedAt !== null || ctx.thread.deletedAt !== null)
        return { action: "reject" as const, message: "Tavern dropped a tick for an archived or deleted Keeper." };
    }
    const noteCheck = this.keeper.journal.dispatchCheck(ctx);
    if (noteCheck) return { action: "reject" as const, message: noteCheck };
    const { data, hireToken, classId, defaulted } = binding;
    let { member } = binding;
    if (binding.invalidSubmission) this.bb.log.warn("Tavern ignored an unrecognized composer submission");
    if (member?.role === "keeper") {
      try { await this.observe(ctx.thread); }
      catch (error) {
        this.keeper.store.patch(ctx.thread.id, { turnBoundaryUnknown: true });
        this.bb.log.warn(`Tavern turn boundary read ${ctx.thread.id}: ${String(error)}`);
      }
    }
    if (!member && !hireToken && (!classId || classId === "none")) return this.loop.admit(ctx) ?? { action: "proceed" as const };
    const hire = hireToken ? this.keeper.store.get("hires", hireToken) : null;
    if (hireToken && (!hire || hire.projectId !== ctx.project.id || hire.owner.keeperThreadId !== ctx.thread.parentThreadId)) throw new Error("Unknown Tavern hire reservation");
    const checkerHold = member?.role === "member"
      ? this.keeper.checkerHandoffProblem(member.classId, member.boardQuestId)
      : hire ? this.keeper.checkerHandoffProblem(hire.classId, hire.owner.boardQuestId) : null;
    if (checkerHold) return { action: "wait" as const, reason: checkerHold };
    const keeperStart = !hireToken && (member?.role === "keeper" || classId === "keeper");
    const soloStart = !keeperStart && this.humanThread(ctx, binding);
    const boundedRegistry = keeperStart || soloStart;
    const since = this.keeper.store.runtime(ctx.thread.id).registryWaitSince ?? this.keeper.now();
    const lookupMs = boundedRegistry ? Math.max(0, Math.min(20_000, LIMITS.registryKeeperWaitMs - (this.keeper.now() - since))) : 20_000;
    let registryProblem: string | null = null;
    let fallbackRegistry: RegistrySnapshot | null = null;
    try { await loopCall(this.prepareRegistry(ctx.project.id), "dispatch project class lookup", lookupMs); }
    catch (error) {
      registryProblem = `The project class files could not be loaded: ${error instanceof Error ? error.message : String(error)}.`;
      this.bb.log.warn(registryProblem);
      this.keeper.store.patch(ctx.thread.id, { registryWaitSince: since });
      if (member?.role === "keeper") this.recordRegistryFailure(member.threadId, registryProblem);
      const remaining = LIMITS.registryKeeperWaitMs - (this.keeper.now() - since);
      if (soloStart) {
        this.keeper.store.patch(ctx.thread.id, { classRootProblem: registryProblem, classNotice: { message: `${registryProblem} Retrying for up to 30 seconds.`, settings: true, switchExecution: null } });
        this.bb.rpc.experimental_invalidate([tags.thread(ctx.thread.id)]);
        if (remaining <= 0) return this.admitHumanFallback(ctx, binding, registryProblem);
      }
      if (!boundedRegistry || remaining > 0) {
        this.registryFailureBlocker(ctx.thread.id, member, hire, registryProblem, since);
        return { action: "wait" as const, reason: registryProblem, sendAt: this.keeper.now() + (boundedRegistry ? Math.min(LIMITS.registryKeeperRetryMs, remaining) : LIMITS.retryMs) };
      }
      fallbackRegistry = this.builtinSnapshot();
      this.keeper.store.patch(ctx.thread.id, { builtinKeeperFallback: true });
    }
    if (hireToken) {
      if (
        !hire ||
        hire.projectId !== ctx.project.id ||
        hire.owner.keeperThreadId !== ctx.thread.parentThreadId
      )
        throw new Error("Unknown Tavern hire reservation");
      member = this.keeper.bind(
        ctx.thread.id, hire.classId, hire.characterId, hire.projectId, hire.owner,
      );
      if (hire.classDefinition) this.keeper.store.patch(member.threadId, { classDefinition: hire.classDefinition });
      this.keeper.store.put("hires", hireToken, {
        ...hire, memberThreadId: member.threadId,
      });
    }
    if (!member && ctx.thread.status === "pending" && isUser(ctx)) {
      if (classId && classId !== "none") {
        const registry = fallbackRegistry ?? this.snapshot(ctx.project.id);
        const role = registry.classes.find(c => c.id === classId);
        const invalidCharacters = role?.characters.filter(id => !registry.characters.some(character => character.id === id && character.classes.includes(classId))) ?? [];
        const invalid = registryProblem && classId !== "keeper" ? registryProblem : !role ? `the class ${classId} is missing` : !role.startable ? "this class is not startable" : invalidCharacters.length ? `unknown or incompatible character: ${invalidCharacters.join(", ")}` : Buffer.byteLength(role.body) > CLASS_BODY_LIMIT ? `the class body exceeds ${CLASS_BODY_LIMIT} UTF-8 bytes` : null;
        if (invalid) {
          if (!defaulted) return { action: "reject" as const, message: `Cannot start ${role?.label ?? classId}: ${invalid}. Fix it in Tavern Classes or start a plain thread.` };
          this.keeper.store.patch(ctx.thread.id, { classNotice: { message: `Started as a plain thread: the default class ${role?.label ?? classId} can’t start here (${invalid}).`, settings: true, switchExecution: null } });
          this.bb.rpc.experimental_invalidate([tags.thread(ctx.thread.id)]);
        } else if (role) {
          if (registryProblem) {
            const refusal = classStartRefusal({ providerId: role.provider ?? ctx.requestedExecution.providerId, ...(role.permission ? { permissionMode: role.permission } : {}) }, ctx.requestedExecution, !!this.scopes && this.config().scopes.mode === "enforce");
            if (refusal) return { action: "reject" as const, message: refusal };
          }
          if (!registryProblem) {
          const facts = await classExecutionFacts(this, { classId, projectId: ctx.project.id, providerId: ctx.requestedExecution.providerId, environmentId: ctx.environment?.id ?? null, mode: "start" }, registry);
          const expected = facts.execution ?? { providerId: role.provider ?? ctx.requestedExecution.providerId, ...(role.permission ? { permissionMode: role.permission } : {}), ...(role.model ? { model: role.model } : {}), ...(role.reasoning ? { reasoningLevel: role.reasoning } : {}) };
          const refusal = classStartRefusal(expected, ctx.requestedExecution, facts.requiresPi);
          if (refusal) return { action: "reject" as const, message: refusal };
          const previousChoice = this.keeper.store.runtime(ctx.thread.id).classExecutionChoice;
          const recordedAt = previousChoice?.providerId === ctx.requestedExecution.providerId && previousChoice.model === ctx.requestedExecution.model ? previousChoice.recordedAt ?? this.keeper.now() : this.keeper.now();
          this.keeper.store.patch(ctx.thread.id, { classExecutionChoice: { providerId: ctx.requestedExecution.providerId, recordedAt, model: ctx.requestedExecution.model, reasoningLevel: ctx.requestedExecution.reasoningLevel, modelSource: ctx.executionSources.model, reasoningSource: ctx.executionSources.reasoningLevel } });
          const differences = [
            ...(expected.model && expected.model !== ctx.requestedExecution.model ? [`model ${expected.model}`] : []),
            ...(expected.reasoningLevel && expected.reasoningLevel !== ctx.requestedExecution.reasoningLevel ? [`reasoning ${expected.reasoningLevel}`] : []),
          ];
          if (differences.length || facts.errors.length) {
            this.keeper.store.patch(ctx.thread.id, { classNotice: { message: `Running on ${ctx.requestedExecution.model ?? "the provider default"} (${ctx.requestedExecution.reasoningLevel ?? "default reasoning"}); the ${role.label} class says ${differences.join(", ") || "its configured execution"}.${facts.errors.length ? ` ${facts.errors.join(" ")}` : ""}`, settings: true, switchExecution: facts.execution ? { ...(expected.model ? { model: expected.model } : {}), ...(expected.reasoningLevel ? { reasoningLevel: expected.reasoningLevel } : {}) } : null } });
            this.bb.rpc.experimental_invalidate([tags.thread(ctx.thread.id)]);
          }
          }
          let character;
          try { character = registryProblem ? undefined : this.registry.character(classId, this.busyCharacters(ctx.project.id), this.projectPath(ctx.project.id)); }
          catch (error) { return { action: "reject" as const, message: `Cannot start ${role.label}: ${String(error)}. Fix the class’s character pool.` }; }
          member = this.keeper.bind(ctx.thread.id, classId, character?.id ?? null, ctx.project.id);
          const usedNames = this.keeper.store.all("members").filter(other => other.threadId !== member!.threadId && this.keeper.store.runtime(other.threadId).projectId === ctx.project.id).map(other => memberName(other, registry));
          const displayName = uniqueMemberName(character?.name ?? role.label, usedNames);
          member = { ...member, displayName, title: ctx.thread.title };
          this.keeper.store.put("members", member.threadId, member);
          if (!registryProblem) this.projectClassNotice(member.threadId, classId, ctx.project.id);
        }
      }
    }
    if (registryProblem && member?.role === "keeper") this.recordRegistryFailure(member.threadId, registryProblem);
    if (!registryProblem) this.clearRegistryFailure(ctx.thread.id);
    await this.away.detectReturn(ctx);
    if (member) {
      if (this.scopes) {
        try {
          if (hire && hireToken) await this.prepareHiredScope(member, hireToken, hire);
          await this.scopes.ensure(member);
          if (this.scopes.pending(member.threadId)?.initialBrief)
            return {
              action: "wait" as const,
              reason: "Awaiting the user's scope decision",
            };
        } catch (error) {
          this.bb.log.warn(
            `Tavern scope admission ${member.threadId}: ${String(error)}`,
          );
          return {
            action: "wait" as const,
            reason: `Tavern scope is not ready: ${String(error).slice(0, 300)}`,
            sendAt: this.keeper.now() + LIMITS.retryMs,
          };
        }
      }
      const awayAdmission = await this.away.dispatch(ctx);
      if (awayAdmission) return awayAdmission;
      const lateCheckerHold = member.role === "member" ? this.keeper.checkerHandoffProblem(member.classId, member.boardQuestId) : null;
      if (lateCheckerHold) return { action: "wait" as const, reason: lateCheckerHold };
      const admission = this.loop.admit(ctx);
      if (admission) return admission;
      if (hire?.initialInput) this.spawnBriefDelivered(member.threadId);
      for (const input of this.userInputs(ctx, member, data)) this.keeper.receiveUser(...input);
      // Identity is already durable before SDK I/O, so the first configure pass cannot race the mirror.
      if (!ctx.queuedMessages.length)
        void this.mirror(member).catch((error) =>
          this.bb.log.warn(`Tavern metadata mirror: ${String(error)}`),
        );
    }
    return { action: "proceed" as const };
  }
  private async prepareHiredScope(member: Member, token: string, intent: HireIntent) {
    if (intent.scopePrepared) return;
    if (this.scopes && intent.scopeResolution) {
      if (!intent.initialInput) throw new Error("A scoped hire needs its recorded spawn input");
      await this.scopes.hired(
        member, intent.scopeResolution, intent.scopeOverride, intent.initialInput, true,
      );
    }
    this.keeper.store.put("hires", token, {
      ...intent,
      ...this.keeper.store.get("hires", token),
      memberThreadId: member.threadId,
      scopePrepared: true,
    });
  }
  async mirror(member: Member) {
    await this.bb.sdk.threads.updatePluginMetadata({
      threadId: member.threadId,
      set: { classId: member.classId, characterId: member.characterId },
    });
  }
  async plan(threadId: string, input: PlanInput) {
    const q = this.keeper.owned(threadId, input.boardQuestId);
    this.keeper.guard(threadId, q.id);
    const links = input.waypoints.flatMap((waypoint) => {
      if (waypoint.actor !== "agent" || !waypoint.owner) return [];
      const member = this.keeper.member(waypoint.owner);
      if (!member) {
        if (waypoint.owner.startsWith("thr_"))
          throw new Error("Unknown waypoint member");
        return [];
      }
      if (
        member.keeperThreadId !== threadId ||
        member.boardQuestId !== q.id ||
        member.errand ||
        member.classId === "warden" ||
        this.keeper.store.runtime(member.threadId).released
      )
        throw new Error(
          "A waypoint owner must be an unreleased maker in this board quest, not its checker",
        );
      return [{ waypoint, member }];
    });
    validatePartyCharacters(input, await this.prepareRegistry(this.keeper.store.runtime(threadId).projectId ?? ""));
    validateCheckerMakers(input, this.keeper.store.all("members").filter(member => member.boardQuestId === q.id));
    const ids = new Set(input.waypoints.map((waypoint) => waypoint.id));
    if (input.party.some((slot) => slot.waypointIds.some((id) => !ids.has(id))))
      throw new Error("Party assignments must name waypoints in this plan");
    for (const memberId of new Set(links.map((link) => link.member.threadId)))
      await this.keeper.journal.prepare(memberId);
    return this.keeper.store.atomic(() => {
      const plan = this.keeper.plan(threadId, input);
      for (const { waypoint, member } of links) {
        this.keeper.journal.linkWaypoint(
          member.threadId,
          { boardQuestId: q.id, waypointId: waypoint.id },
          waypoint.title,
          member.threadId,
          { kind: "agent", threadId },
        );
        if (!member.waypointId)
          this.keeper.store.put("members", member.threadId, {
            ...this.keeper.member(member.threadId)!,
            waypointId: waypoint.id,
          });
      }
      const members = this.keeper.store
        .query("members", "boardQuestId", q.id, 500)
        .filter(
          (member) => !this.keeper.store.runtime(member.threadId).released,
        );
      const assignments = checkerAssignments(plan, members);
      for (const member of members.filter(
        (member) => member.classId === "warden",
      )) {
        const assignment = assignments.find(
          (assignment) => assignment.memberThreadId === member.threadId,
        );
        this.keeper.store.put("members", member.threadId, {
          ...member,
          checkerWaypointId: assignment?.waypointIds[0] ?? null,
          checkerMakerThreadId: member.checkerMakerThreadId ?? (assignment?.waypointIds[0] ? makerForWaypoint(plan, members, assignment.waypointIds[0]) : null),
        });
      }
      this.keeper.refreshPhase(q.id);
      this.keeper.changed(threadId, q.id);
      return plan;
    });
  }
  async hire(threadId: string, projectId: string, input: Hire) {
    if (this.config().tavern.paused) throw new Error("Tavern is paused; resume it before hiring.");
    const leader = this.keeper.require(threadId, "keeper");
    if (input.boardQuestId) this.keeper.owned(threadId, input.boardQuestId);
    this.keeper.assertCheckerHandoff(input.classId, input.boardQuestId);
    const snapshot = await loopCall(this.prepareRegistry(projectId), "hire project class lookup"),
      lead = snapshot.classes.find((c) => c.id === leader.classId);
    const role = snapshot.classes.find((c) => c.id === input.classId);
    if (!lead || !role?.hireable || !lead.hires.includes(role.id))
      throw new Error("This class is not in the Keeper's hire policy");
    this.projectClassNotice(threadId, leader.classId, projectId);
    const placementPolicy = this.settings?.placementPolicy();
    if (placementPolicy?.state === "invalid") {
      const problems = placementPolicy.problems.slice(0, 3).map(problem => `${problem.path}: ${problem.message}`).join("; ");
      throw new Error(`Machine placement policy is invalid: ${problems}. Repair it in Settings before hiring.`);
    }
    const questId = input.boardQuestId ?? null;
    const legacyPlacement = !placementPolicy || placementPolicy.state === "valid" && !placementPolicy.settings.rules.some(rule => rule.enabled);
    this.away.assertHire(questId, this.away.store.snapshot().status.closed && legacyPlacement && this.away.canPrepareLocalHire());
    const q = questId ? this.keeper.owned(threadId, questId) : null;
    this.keeper.assertCheckerHandoff(role.id, questId);
    if (q && !isOpenQuest(q))
      throw new Error("This board quest has ended");
    const errand = input.errand ?? false;
    if (errand && (questId || input.waypointId))
      throw new Error("An errand must not link a board quest or waypoint");
    if (!errand && !q) throw new Error("A party member needs a board quest");
    if (errand && !["ranger", "wanderer"].includes(role.id))
      throw new Error("Only Ranger and Wanderer helpers run errands");
    if (q) this.keeper.guard(threadId, q.id);
    if (role.id !== "ranger" && !errand && q?.greenlitVersion === null)
      throw new Error("The party needs the user's explicit greenlight");
    const config = this.config(questId);
    const { partyMax: partyLimit, rangerMinutes: rangerLimit } = classLimits(lead, config);
    const party = this.keeper.store.activeStaffing(threadId);
    const reserved = this.keeper.store
      .all("hires")
      .filter((i) => !i.memberThreadId && i.owner.keeperThreadId === threadId && !isHireCancelled(this.keeper, i));
    if (party.length + reserved.length >= partyLimit)
      throw new Error("The live party budget is full");
    if (
      role.id === "ranger" &&
      party.filter((m) => m.classId === "ranger").length +
        reserved.filter((i) => i.classId === "ranger").length >=
        (lead.budget?.rangers ?? LIMITS.rangerCapacity)
    )
      throw new Error("The Ranger budget is full");
    if (
      role.id === "ranger" &&
      (input.brief.timeboxMinutes === null ||
        input.brief.timeboxMinutes > rangerLimit ||
        !input.brief.questions.length)
    )
      throw new Error(
        `Rangers need numbered questions and a time box of at most ${rangerLimit} minutes`,
      );
    const review = this.review("automatic");
    const reviewDecisionId =
      role.id === "smith" && review.waiting >= review.budget
        ? this.keeper.memory.reviewPermit(threadId, questId)
        : null;
    if (
      role.id === "smith" &&
      review.waiting >= review.budget &&
      !reviewDecisionId
    ) {
      this.record("review-budget.held", { waiting: review.waiting, budget: review.budget, classId: role.id }, threadId, questId);
      throw new Error(
        `The review budget is full: ${review.waiting} of ${review.budget}; wait, or record a decision to exceed it with reversible: true and reviewBudgetOverride: true`,
      );
    }
    const waypoint =
      input.waypointId && q
        ? this.keeper
            .summary(q.id)
            .plan?.waypoints.find((w) => w.id === input.waypointId)
        : null;
    if (input.waypointId && !waypoint) throw new Error("Unknown waypoint");
    if (waypoint && waypoint.actor !== "agent")
      throw new Error("A human or outside gate cannot be assigned to an agent");
    let reviewTarget: ReviewTarget | null = null;
    if (role.id === "warden" && !waypoint) throw new Error("A Warden hire needs exactly one planned waypoint to pin its maker and review posture.");
    if (role.id === "warden" && q && waypoint) {
      const maker = this.keeper.summary(q.id).waypoints.find(item => item.id === waypoint.id)?.ownerMember;
      if (!maker || !["smith", "ranger", "wanderer"].includes(maker.classId))
        throw new Error(`Cannot hire a Warden for ${waypoint.id}: the maker and its journal entries are unknown. Assign the maker and link its entry first.`);
      await this.keeper.journal.prepare(maker.threadId);
      const entries = this.keeper.journal.get(maker.threadId).entries.filter(entry =>
        entry.link?.boardQuestId === q.id && entry.link.waypointId === waypoint.id,
      );
      if (!entries.length)
        throw new Error(`Cannot hire a Warden for ${waypoint.id}: maker ${maker.threadId} has no known journal entry for this waypoint. Link the maker entry first.`);
      reviewTarget = { boardQuestId: q.id, waypointId: waypoint.id, makerThreadId: maker.threadId, entryIds: entries.map(entry => entry.id) };
    }
    let staffingCapacity: number | null = null;
    const scouting =
      q?.greenlitVersion != null && ["ranger", "wanderer"].includes(role.id);
    if (
      q?.greenlitVersion !== null &&
      q?.greenlitVersion !== undefined &&
      !scouting
    ) {
      const approved = this.keeper.store.get(
        "plans",
        `${q.id}:${q.greenlitVersion}`,
      );
      if (!approved) throw new Error("The greenlit plan is missing");
      const capacity = partyCounts(approved).get(role.id) ?? 0;
      staffingCapacity = capacity;
      const allocated = this.keeper.store.allocated(q.id, role.id);
      const pending = reserved.filter(
        (i) => i.owner.boardQuestId === q.id && i.classId === role.id,
      ).length;
      if (allocated + pending >= capacity && party.some(member => member.boardQuestId === q.id && member.classId === role.id && this.keeper.store.runtime(member.threadId).pendingBrief))
        throw new Error(`An initial ${role.id} brief is still pending for this party slot. Retry or release that member before hiring a replacement.`);
      if (allocated + pending >= capacity)
        throw new Error(
          `The greenlit party already allocates all ${capacity} ${role.id} member(s). Propose and greenlight a new plan version before hiring beyond it.`,
        );
    }
    if (
      input.waypointId &&
      (party.some(
        (m) =>
          m.boardQuestId === questId &&
          m.waypointId === input.waypointId &&
          m.classId === role.id,
      ) ||
        reserved.some(
          (i) =>
            i.owner.boardQuestId === questId &&
            i.owner.waypointId === input.waypointId &&
            i.classId === role.id,
        ))
    )
      throw new Error("This waypoint already has a live member of that class");
    const placementRoute = placementPolicy?.state === "valid" && placementPolicy.settings.rules.some(rule => rule.enabled)
      ? await resolvePlacementRoute(placementPolicy, { keeperThreadId: threadId, projectId, classId: role.id, questId }, {
          readIdentity: () => readSourceIdentity(this.bb, threadId, projectId),
          inspectSource: () => this.placementSources().inspect(threadId, projectId),
        })
      : null;
    if (placementRoute?.match.state === "matched" && placementRoute.match.rule.target.kind === "provider") {
      const rule = placementRoute.match.rule;
      throw new Error(`Machine placement is not ready in this build; rule "${rule.label}" (${rule.id}) cannot be applied. Wait for setup to finish, or disable machine rules in Settings.`);
    }
    const hirePlan = q ? this.keeper.summary(q.id).plan : null;
    if (hirePlan) { validatePartyCharacters(hirePlan, snapshot); validateCheckerMakers(hirePlan, this.keeper.store.all("members").filter(member => member.boardQuestId === q?.id)); }
    const occupied = [...party.filter(member => member.boardQuestId === questId), ...reserved.filter(intent => intent.owner.boardQuestId === questId).map(intent => ({ classId: intent.classId, characterId: intent.characterId, waypointId: intent.owner.waypointId }))];
    const slot = hirePlan?.party.find(slot => slot.classId === role!.id &&
      (!input.waypointId || slot.waypointIds.includes(input.waypointId) || role.id === "warden" && slot.waypointIds.length === 0) &&
      !occupied.some(member => member.classId === slot.classId && (slot.characterId ? member.characterId === slot.characterId : !!member.waypointId && slot.waypointIds.includes(member.waypointId))));
    if (role.id === "warden" && slot && reviewTarget && hirePlan && slot.waypointIds.some(id => makerForWaypoint(hirePlan, this.keeper.store.all("members").filter(member => member.boardQuestId === q?.id), id) !== reviewTarget.makerThreadId))
      throw new Error("Every waypoint in this Warden slot must name the same maker as its review target. Assign those maker threads first; a different maker needs its own Warden.");
    if (slot?.characterId && input.characterId && slot.characterId !== input.characterId)
      throw new Error(`This plan slot requires character ${slot.characterId}; propose a new plan to change it.`);
    const executionRole = slot?.model ? { ...role, model: slot.model } : role;
    const character = this.registry.character(
      role.id,
      [
        ...this.busyCharacters(projectId),
        ...reserved.map((i) => i.characterId),
      ],
      this.projectPath(projectId),
      input.characterId ?? slot?.characterId ?? (input.detectionOnlyAskId ? this.keeper.store.get("askMeta", input.detectionOnlyAskId)?.guardHire?.characterId : undefined),
    );
    const checkerPlan = role.id === "warden" && q ? this.keeper.summary(q.id).plan : null;
    const checkedWaypoints = new Set(checkerPlan?.party
      .filter(slot => slot.classId === "warden" && (!slot.characterId || slot.characterId === character?.id))
      .flatMap(slot => slot.waypointIds));
    const checkerCommands = doneWhenCommands([
      checkerPlan?.doneWhen, waypoint?.doneWhen,
      ...checkerPlan?.waypoints.filter(item => checkedWaypoints.has(item.id)).map(item => item.doneWhen) ?? [],
    ]);
    const scopeResolution = this.scopes?.api.shouldScope(role.id, "hire")
      ? await this.scopes.resolve(role.id, projectId, input.scope, role)
      : null;
    const liveNames = this.keeper.store.all("members")
      .filter(member => member.keeperThreadId === threadId)
      .concat(leader)
      .map(member => memberName(member, snapshot));
    const reservedNames = reserved
      .filter((intent) => intent.owner.keeperThreadId === threadId)
      .map(
        intent => memberName({ classId: intent.classId, characterId: intent.characterId, displayName: intent.owner.displayName }, snapshot),
      );
    const displayName = uniqueMemberName(character?.name ?? role.label, [
      ...liveNames,
      ...reservedNames,
    ]);
    const token = randomUUID();
    const requestSources = captureRequestSources(this.keeper, threadId, questId);
    const owner: HireIntent["owner"] = {
      keeperThreadId: threadId,
      boardQuestId: questId,
      waypointId: input.waypointId ?? null,
      errand,
      title: input.title,
      displayName,
      ...(reviewTarget ? { reviewTarget } : {}),
      requestSources,
      brief: input.brief,
    };
    let brief = `Your brief:\n${JSON.stringify(input.brief, null, 2)}\nReport through tavern_report; do not message the Keeper directly.`;
    if (reviewTarget)
      brief += `\nTrusted journal review target:\n${JSON.stringify(reviewTarget, null, 2)}\nVerify or reject these entry ids in the maker's thread, not in your own journal. Keep the waypoint and maker thread identifiers with your evidence.`;
    owner.assignmentText = brief;
    brief += `\n\n${requestSourcePacket(this.keeper, requestSources)}`;
    const intent: HireIntent = {
      initialInput: brief,
      scopeResolution,
      scopeOverride: input.scope,
      classId: role.id,
      classDefinition: executionRole,
      characterId: character?.id ?? null,
      projectId,
      owner,
      createdAt: this.keeper.now(),
      ...(reviewDecisionId ? { reviewDecisionId } : {}),
    };
    if (placementRoute !== null) {
      if (placementRoute.source !== null) await this.placementSources().revalidate(placementRoute.source);
      else if (placementRoute.identity !== null &&
          !isDeepStrictEqual(await readSourceIdentity(this.bb, threadId, projectId), placementRoute.identity))
        throw new StaleDiscoveryError("The source identity changed before this hire was reserved; retry.");
      const currentPolicy = this.settings?.placementPolicy();
      if (currentPolicy?.state !== "valid" || currentPolicy.revision !== placementRoute.match.revision)
        throw new Error("Machine placement settings changed before this hire was reserved; retry.");
    }
    this.keeper.assertCheckerHandoff(role.id, questId);
    this.keeper.store.atomic(() => {
      if (reviewDecisionId)
        this.keeper.memory.claimReview(
          threadId,
          questId,
          reviewDecisionId,
          token,
        );
      if (q && staffingCapacity !== null) {
        intent.staffing = reserveStaffing(
          this.keeper,
          q,
          role.id,
          staffingCapacity,
          token,
        );
      }
      this.keeper.store.put("hires", token, intent);
    });
    let attempted = false;
    let childCreated = false;
    let completed = false;
    let selectedExecution: { providerId: string; model?: string } | undefined;
    try {
      const parent = await this.bb.sdk.threads.get({ threadId });
      const environment = await resolveHireEnvironment(
        this.bb,
        projectId,
        parent.environmentId,
        role.environment === "worktree",
      );
      let maker: { providerId: string | null; model: string | null; environmentId: string | null } | undefined;
      if (reviewTarget) {
        maker = { providerId: null, model: null, environmentId: null };
        try {
          const thread = await this.bb.sdk.threads.get({ threadId: reviewTarget.makerThreadId });
          maker.providerId = thread.providerId;
          maker.environmentId = thread.environmentId;
        } catch (error) {
          this.bb.log.warn(`Tavern checker maker provider ${reviewTarget.makerThreadId}: ${String(error)}`);
        }
        try {
          maker.model = (await this.bb.sdk.threads.defaultExecutionOptions({ threadId: reviewTarget.makerThreadId }))?.model ?? null;
        } catch (error) {
          this.bb.log.warn(`Tavern checker maker model ${reviewTarget.makerThreadId}: ${String(error)}`);
        }
      }
      if (scopeResolution?.scope.preset === "checker" && this.scopes) {
        if (checkerCommands.length > 100)
          throw new Error(`This plan records ${checkerCommands.length} check commands; a checker scope supports at most 100. Simplify its explicit done-when commands before hiring.`);
        const checking = await this.scopes.checkerChecks(maker?.environmentId ?? null, checkerCommands);
        scopeResolution.scope.checks = checking.checks;
        scopeResolution.problems.push(...checking.problems);
        if (reviewTarget) reviewTarget.checks = checking.checks;
        brief += `\nTrusted checker execution:\n${JSON.stringify(checking.checks, null, 2)}\nDefault test/check/lint/typecheck runners accepted by the checker preset need no tool-name widening or user-run workaround. Additional commands above are verbatim from this plan, not the brief. Run checks inside the exact maker worktree (or change to it first), never the Warden/Keeper checkout. Tracked files, Git metadata, publishing and network writes remain protected.`;
        if (!checking.checks.worktree) brief += `\n${checking.problems.join("\n")} Do not run checks until the trusted maker binding is repaired.`;
        this.keeper.store.put("hires", token, { ...this.keeper.store.get("hires", token)!, owner, initialInput: brief, scopeResolution });
      }
      const { notes, checkIndependence, ...execution } = await resolveHireExecution(
        this.bb,
        this.scopes ? { ...executionRole, permission: "full" } : executionRole,
        {
          providerId: parent.providerId,
          environmentId: parent.environmentId,
          projectId,
          scoped: !!scopeResolution && scopeResolution.scope.preset !== "open",
          maker,
        },
      );
      if (placementRoute?.match.state === "matched")
        notes.push(`Rule ${placementRoute.match.rule.id} matched: kept where its Keeper is.`);
      for (const warning of placementRoute?.warnings ?? []) notes.push(`Placement fact unavailable: ${warning}`);
      selectedExecution = execution;
      if (checkIndependence) {
        owner.checkIndependence = checkIndependence;
        const limitation = reviewLimitation(checkIndependence);
        brief += limitation
          ? `\nReview posture: ${limitation}. Say this limitation in your verdict; never describe this check as independent.`
          : "\nReview posture: a known different-family model was selected that is not the checked maker's family.";
        this.keeper.store.put("hires", token, {
          ...this.keeper.store.get("hires", token)!, owner, initialInput: brief,
        });
      }
      if (scopeResolution && scopeResolution.scope.preset !== "open") {
        owner.guardPosture = authorizeGuardedHire(
          this.keeper, token, intent, execution.providerId, execution.model,
          { projectId, keeperThreadId: threadId, classId: role.id, characterId: input.characterId ?? null,
            boardQuestId: questId, waypointId: owner.waypointId, errand, title: input.title, brief: input.brief,
            scope: input.scope ?? null, effectiveScope: scopeResolution.scope, planVersion: q?.planVersion ?? null, reviewTarget, execution },
          input.requestDetectionOnly === true, input.detectionOnlyAskId,
        );
        notes.push(`Guard posture: ${owner.guardPosture.label}. This never grants consent for a push, merge or other consequential action.`);
        brief += `\nGuard posture: ${owner.guardPosture.label}. A watcher can stop a turn only after an observed action. Existing user approval requirements still apply.`;
        this.keeper.store.put("hires", token, { ...this.keeper.store.get("hires", token)!, owner, initialInput: brief });
      }
      if (reviewDecisionId)
        notes.push(
          `Review-budget exception used once: ${reviewDecisionId} (${review.waiting} of ${review.budget}).`,
        );
      for (const problem of scopeResolution?.problems ?? [])
        notes.push(`Scope policy: ${problem}`);
      let guardedLocal = false;
      if (this.away.store.snapshot().status.closed && this.away.canPrepareLocalHire() && execution.providerId === "pi" && scopeResolution && scopeResolution.scope.preset !== "open") {
        const primary = (await this.bb.sdk.system.config()).primaryHostId;
        guardedLocal = environment.type === "provider" && environment.environmentProviderId === "git-worktree" && environment.machine?.type === "existing" && environment.machine.hostId === primary;
        if (environment.type === "reuse") guardedLocal = (await this.bb.sdk.environments.get({ environmentId: environment.environmentId })).hostId === primary;
      }
      this.away.assertHire(questId, guardedLocal);
      this.keeper.assertCheckerHandoff(role.id, questId);
      if (isHireCancelled(this.keeper, this.keeper.store.get("hires", token) ?? intent)) throw new Error("This board quest has ended or is stopping; the hire was cancelled");
      attempted = true;
      const child = await this.bb.sdk.threads.spawn({
        projectId,
        parentThreadId: threadId,
        parentNotifications: "off",
        title: memberTitle(displayName, input.title, snapshot.classes),
        input: [{ type: "text", text: brief, mentions: [], visibility: "agent-only" }],
        environment,
        pluginSubmission: {
          pluginId: this.bb.pluginId,
          data: { hireToken: token },
        },
        pluginMetadata: {
          classId: role.id,
          characterId: character?.id ?? null,
          hireToken: token,
        },
        ...execution,
      });
      childCreated = true;
      const member = this.keeper.bind(
        child.id,
        role.id,
        character?.id ?? null,
        projectId,
        owner,
      );
      this.keeper.store.put("hires", token, {
        ...intent,
        ...this.keeper.store.get("hires", token),
        memberThreadId: child.id,
      });
      if (isHireCancelled(this.keeper, this.keeper.store.get("hires", token)!)) {
        await settleCancelledHire(this.bb, this.keeper, token, this.keeper.store.get("hires", token)!, child.id);
        throw new Error("This board quest has ended or is stopping; the hire was cancelled");
      }
      this.keeper.store.patch(child.id, { executionNotes: notes, classDefinition: executionRole });
      await this.prepareHiredScope(member, token, this.keeper.store.get("hires", token)!);
      settleStaffing(this.keeper, intent.staffing, token, member.threadId);
      if (role.id === "warden") {
        if (q && waypoint && slot && !slot.waypointIds.includes(waypoint.id)) {
          const plan = this.keeper.store.get("plans", `${q.id}:${q.planVersion}`)!;
          const slotIndex = hirePlan!.party.indexOf(slot);
          this.keeper.store.put("plans", `${q.id}:${q.planVersion}`, { ...plan, party: plan.party.map((item, index) => index === slotIndex ? { ...item, waypointIds: [...item.waypointIds, waypoint.id] } : item) });
        }
        this.keeper.store.put("members", member.threadId, {
          ...member,
          checkerWaypointId: waypoint!.id,
          checkerMakerThreadId: reviewTarget!.makerThreadId,
        });
      }
      if (waypoint && q && role.id !== "warden") {
        await this.keeper.journal.prepare(member.threadId);
        this.keeper.journal.linkWaypoint(
          member.threadId,
          { boardQuestId: q.id, waypointId: waypoint.id },
          waypoint.title,
          member.threadId,
          { kind: "agent", threadId },
        );
      }
      this.keeper.store.event(
        this.keeper.now(),
        threadId,
        questId,
        "member.hired",
        `${displayName} (${role.label}): ${input.title}`,
        {
          memberThreadId: child.id,
          waypointId: owner.waypointId,
          execution,
          ...(checkIndependence ? { checkIndependence } : {}),
          adjustments: notes,
        },
        { kind: "agent", threadId },
      );
      if (scouting && q)
        this.keeper.decide(threadId, {
          boardQuestId: q.id,
          text: `Hire ${role.label} for reversible scouting: ${input.title}`,
          why: "Scouting stays within the class and live party budgets; it does not expand the greenlit implementation party.",
          reversible: true,
          source: "keeper",
        });
      if (isHireCancelled(this.keeper, this.keeper.store.get("hires", token)!)) {
        await settleCancelledHire(this.bb, this.keeper, token, this.keeper.store.get("hires", token)!, child.id);
        throw new Error("This board quest has ended or is stopping; the hire was cancelled");
      }
      this.spawnBriefDelivered(member.threadId);
      const pendingScopeAsk = this.scopes?.pending(member.threadId)
        ? this.keeper.store.runtime(member.threadId).scopePending ?? null
        : null;
      this.keeper.changed(child.id, questId);
      completed = true;
      return {
        ...this.keeper.member(member.threadId)!,
        executionNotes: notes,
        pendingScopeAsk,
        briefPending: pendingScopeAsk !== null || this.keeper.store.runtime(member.threadId).pendingBrief != null || this.keeper.checkerHandoffProblem(role.id, questId) !== null,
      };
    } catch (error) {
      this.bb.log.warn(
        `Tavern hire.failed keeper=${threadId} class=${role.id} token=${token}: ${String(error)}`,
      );
      if (attempted && !childCreated) this.record(rejectedSpawn(error) ? "spawn.failed" : "spawn.uncertain", { classId: role.id, error: String(error).slice(0, 2000), token }, threadId, questId, `spawn:${token}`);
      if (!childCreated && rejectedSpawn(error))
        releaseHire(this.keeper, token, intent);
      if (attempted && !childCreated && rejectedSpawn(error) && /model/i.test(String(error)))
        throw new Error(`Cannot hire ${role.id}: model ${selectedExecution?.model ?? role.model ?? "provider default"} was refused by ${selectedExecution?.providerId ?? role.provider ?? "the provider"}. Change classes.${role.id}.model in Tavern settings. No alternate model was hired. ${String(error)}`);
      throw error;
    } finally {
      if (!attempted) releaseHire(this.keeper, token, intent);
      else if (completed && !this.keeper.checkerHandoffProblem(role.id, questId)) this.keeper.store.remove("hires", token);
    }
  }
  async release(threadId: string, memberThreadId: string, reason: string) {
    this.keeper.require(threadId, "keeper");
    const member = this.keeper.member(memberThreadId);
    if (
      !member ||
      member.role !== "member" ||
      member.keeperThreadId !== threadId
    )
      throw new Error("Only release a member of your own party");
    if (!reason.trim()) throw new Error("Release needs a reason");
    if (member.boardQuestId) this.keeper.liveQuest(threadId, member.boardQuestId);
    this.away.assertWork(member.boardQuestId, memberThreadId);
    if (member.boardQuestId) this.keeper.guard(threadId, member.boardQuestId);
    if (this.keeper.store.runtime(memberThreadId).released) return true;
    let current: Thread | null;
    try { current = await this.bb.sdk.threads.get({ threadId: memberThreadId }); }
    catch (error) { if (!isNotFound(error)) throw error; current = null; this.threadGone(memberThreadId); }
    if (current && current.archivedAt === null && current.deletedAt === null) await this.bb.sdk.threads.stop({ threadId: memberThreadId });
    this.keeper.store.patch(memberThreadId, { releasePending: reason });
    return this.finishRelease(member);
  }
  private async finishRelease(member: Member) {
    const reason = this.keeper.store.runtime(member.threadId).releasePending;
    if (!reason || this.away.cleanupHeld() && this.keeper.store.runtime(member.threadId).archivePending) return false;
    let thread: Thread | null;
    try { thread = await this.bb.sdk.threads.get({ threadId: member.threadId }); }
    catch (error) { if (!isNotFound(error)) throw error; thread = null; this.threadGone(member.threadId); }
    if (thread &&
      !["idle", "error"].includes(thread.status) &&
      thread.archivedAt === null &&
      thread.deletedAt === null
    )
      return false;
    this.keeper.store.atomic(() => {
      const decision = this.keeper.decide(member.keeperThreadId!, {
        boardQuestId: member.boardQuestId && isOpenQuest(this.keeper.store.get("quests", member.boardQuestId)) ? member.boardQuestId : null,
        text: `Release ${this.keeper.name(member)}: ${reason}`,
        why: "Stopping this member frees its allocation. Undo asks the Keeper to reconcile and resume or replace the work.",
        reversible: true,
        source: "keeper",
      });
      this.keeper.store.patch(member.threadId, {
        releasePending: null,
        released: { reason, decisionId: decision.id },
      });
      this.keeper.activity(member.threadId, "stopped");
      this.keeper.store.event(this.keeper.now(), member.keeperThreadId, member.boardQuestId, "member.released", reason, { memberThreadId: member.threadId, decisionId: decision.id });
    });
    this.scopes?.clearScope(member.threadId);
    return true;
  }
  private async archiveMembers(members: Member[]) {
    const pending: string[] = [];
    for (const member of members) {
      const rt = this.keeper.store.runtime(member.threadId);
      if (!rt.archivePending) continue;
      if (this.away.cleanupHeld()) { pending.push(member.threadId); continue; }
      try {
        const current = await this.bb.sdk.threads.get({ threadId: member.threadId });
        if (current.archivedAt === null && current.deletedAt === null) await this.bb.sdk.threads.archive({ threadId: member.threadId });
        this.keeper.store.patch(member.threadId, {
          archivePending: false,
          archiveError: null,
        });
      } catch (error) {
        if (isNotFound(error)) {
          try { this.updateThread(await this.bb.sdk.threads.get({ threadId: member.threadId })); }
          catch (confirmation) {
            if (isNotFound(confirmation)) {
              this.threadGone(member.threadId);
              this.keeper.store.patch(member.threadId, { archivePending: false, archiveError: null });
              continue;
            }
          }
        }
        const message = String(error);
        pending.push(member.threadId);
        this.keeper.store.patch(member.threadId, { archiveError: message });
        if (rt.archiveError !== message)
          this.keeper.store.event(
            this.keeper.now(),
            member.keeperThreadId,
            member.boardQuestId,
            "quest.archive-failed",
            `Wrapped; archive cleanup remains pending for ${this.keeper.name(member)}: ${message}`,
            { memberThreadId: member.threadId },
          );
        this.bb.log.warn(
          `Tavern archive cleanup ${member.threadId}: ${message}`,
        );
      }
    }
    return pending;
  }
  private async finishMemberCleanup(keeperId: string) {
    const members = this.keeper.store.query(
      "members",
      "keeperThreadId",
      keeperId,
      500,
    );
    for (const member of members) {
      if (!this.keeper.store.runtime(member.threadId).releasePending) continue;
      try {
        await this.finishRelease(member);
      } catch (error) {
        this.bb.log.warn(
          `Tavern release cleanup ${member.threadId}: ${String(error)}`,
        );
      }
    }
    await this.archiveMembers(members);
  }
  briefed(threadId: string) {
    const state = this.keeper.store.runtime(threadId);
    this.keeper.store.patch(threadId, {
      lastBriefAt: this.keeper.now(),
      briefVersion: (state.briefVersion ?? 0) + 1,
    });
  }
  memberEnded(thread: Thread, finalText?: string | null) {
    const member = this.keeper.member(thread.id);
    if (member?.role !== "member" || !member.keeperThreadId) return;
    if (this.away.blocked(thread.id)) return;
    const state = this.keeper.store.runtime(thread.id);
    if (
      state.released ||
      state.releasePending ||
      state.archivePending ||
      state.pendingBrief ||
      ["done", "stopped"].includes(member.state)
    )
      return;
    const version = state.briefVersion ?? 0;
    if (
      version > 0
        ? (state.reportedBriefVersion ?? 0) >= version
        : member.lastReportAt !== null &&
          member.lastReportAt >= (state.lastBriefAt ?? member.createdAt)
    )
      return;
    const turn = `${version}:${state.lastBriefAt ?? member.createdAt}`;
    if (state.lastUnreportedTurn === turn) return;
    const excerpt = finalText?.slice(0, 500) ?? "";
    this.keeper.store.atomic(() => {
      this.keeper.store.patch(thread.id, { lastUnreportedTurn: turn });
      this.keeper.store.put("members", thread.id, {
        ...member,
        strikes: member.strikes + 1,
        doing: excerpt.slice(0, 300) || member.doing,
      });
      this.keeper.store.event(
        this.keeper.now(),
        member.keeperThreadId!,
        member.boardQuestId,
        "member.unreported",
        `${this.keeper.name(member)} ended a turn without tavern_report: ${excerpt || "No final message available"}`,
        { memberThreadId: thread.id, excerpt, strikes: member.strikes + 1 },
      );
    });
    this.keeper.changed(thread.id, member.boardQuestId);
  }
  async tell(threadId: string, memberThreadId: string, text: string) {
    this.keeper.require(threadId, "keeper");
    const member = this.keeper.member(memberThreadId);
    if (member?.keeperThreadId !== threadId)
      throw new Error("Only tell members of your own party");
    this.requireBriefableMember(memberThreadId);
    this.keeper.assertCheckerHandoff(member.classId, member.boardQuestId);
    if (member.boardQuestId) this.keeper.guard(threadId, member.boardQuestId);
    if (this.scopes?.pending(memberThreadId))
      throw new Error(
        "The member is waiting for a scope decision; do not send a brief requiring unapproved grants",
      );
    if (!text.trim()) throw new Error("A brief cannot be empty");
    if (this.config().tavern.paused) throw new Error("Tavern is paused; no new brief was queued.");
    if (this.away.blocked(memberThreadId) && this.initialBriefs.has(memberThreadId)) throw new Error("The old brief delivery is still in flight; retry after it settles. No fresh brief was queued.");
    await this.away.beforeTell(memberThreadId);
    this.keeper.assertCheckerHandoff(member.classId, member.boardQuestId);
    const delivery = await this.sendRebrief(memberThreadId, text);
    const pending = this.keeper.store.runtime(memberThreadId).pendingBrief;
    const status = !delivery.briefPending ? "delivered"
      : pending!.error && pending!.attempts >= LIMITS.briefRetryAttempts ? "blocked"
      : pending!.error ? "retrying" : "queued";
    if (delivery.briefPending) {
      this.keeper.store.event(
        this.keeper.now(), threadId, member.boardQuestId, "member.told", text,
        { memberThreadId, briefId: pending!.id, briefPending: true, delivery: status, attempts: pending!.attempts },
        { kind: "agent", threadId },
      );
    }
    this.keeper.changed(memberThreadId, member.boardQuestId);
    return { ...delivery, status, attempts: pending?.attempts ?? null, memberName: this.keeper.name(member) };
  }
  review(purpose: "present" | "automatic" = "present"): {
    waiting: number;
    budget: number;
    items: { title: string; url: string | null; boardQuestId: string | null }[];
  } {
    return purpose === "present" ? this.reviewCache ?? this.readReview(purpose) : this.readReview(purpose);
  }
  private readReview(purpose: "present" | "automatic" = "present") {
    const items: {
      title: string;
      url: string | null;
      boardQuestId: string | null;
    }[] = [];
    for (const quest of this.keeper.store.activeQuests()) {
      if (!isOpenQuest(quest) || !isLiveKeeper(this.keeper.store, this.keeper.member(quest.keeperThreadId), purpose)) continue;
      try {
        const summary = this.keeper.summary(quest.id);
        const reports = this.keeper.store.query(
          "reports",
          "boardQuestId",
          quest.id,
          100,
        );
        for (const waypoint of summary.waypoints.filter(
          (w) => w.state === "reported",
        )) {
          const report = [...reports]
            .reverse()
            .find((r) => r.waypointId === waypoint.id && r.status === "done");
          items.push({
            title: report?.outcome.slice(0, 160) ?? waypoint.title,
            url: report?.artifacts.find((a) => /^https?:/.test(a)) ?? null,
            boardQuestId: quest.id,
          });
        }
      } catch (error) {
        this.bb.log.warn(
          `Tavern review queue for ${quest.id}: ${String(error)}`,
        );
      }
    }
    return { waiting: items.length, budget: this.config().attention.reviewBudget, items };
  }
  held(threadId: string) {
    const rt = this.keeper.store.runtime(threadId),
      now = this.keeper.now();
    return (
      rt.archivedAt == null && (
        (rt.typingAt !== null && now - rt.typingAt < this.config().knobs.typingHoldSeconds * 1000) ||
        (rt.userAt !== null && now - rt.userAt < this.config().knobs.afterMessageHoldSeconds * 1000)
      )
    );
  }
  private expireHoldingDisplay(threadId: string) {
    const state = this.keeper.store.runtime(threadId);
    const knobs = this.config().knobs;
    const deadline = Math.max(
      state.typingAt === null ? 0 : state.typingAt + knobs.typingHoldSeconds * 1000,
      state.userAt === null ? 0 : state.userAt + knobs.afterMessageHoldSeconds * 1000,
    );
    if (!deadline || deadline > this.keeper.now() || state.holdExpiredAt === deadline) return;
    // userAt also orders delayed Stop events; expire the display, not that receipt.
    this.keeper.store.patch(threadId, {
      holdExpiredAt: deadline,
      ...(this.keeper.member(threadId)?.state !== "working" ? { heldAt: null } : {}),
    });
    this.bb.rpc.experimental_invalidate([tags.room(), tags.thread(threadId)]);
  }
  private resetQuietQueue(threadId: string): Promise<void> {
    const existing = this.queueResets.get(threadId);
    if (existing) return existing;
    const id = this.keeper.store.runtime(threadId).queuedTickResetId;
    if (!id) return Promise.resolve();
    let reset: Promise<void>;
    reset = this.loop.discardQueued(threadId).then(() => {
      if (this.keeper.store.runtime(threadId).queuedTickResetId === id)
        this.keeper.store.patch(threadId, { queuedTickResetId: null, tickAt: null, heldAt: null });
    }).finally(() => { if (this.queueResets.get(threadId) === reset) this.queueResets.delete(threadId); });
    this.queueResets.set(threadId, reset);
    return reset;
  }
  async tick(threadId: string) {
    if (this.config().tavern.paused || !isLiveKeeper(this.keeper.store, this.keeper.member(threadId))) return;
    while (this.keeper.store.runtime(threadId).queuedTickResetId) await this.resetQuietQueue(threadId);
    await this.loop.tick(threadId);
  }
  acknowledgeTick(id: string) {
    this.loop.acknowledge(id);
  }
  cancelTick(text: string) {
    this.loop.cancelled(text);
  }
  private async maintain(key: string, threadId: string | null, steps: { name: string; run: () => unknown }[]) {
    const previous = this.maintenance.get(key);
    if (previous && this.keeper.now() - previous.startedAt < 3 * LIMITS.retryMs) return;
    if (previous) this.bb.log.warn(`Tavern expired stale maintenance flight ${key}`);
    let active = true;
    let work: Promise<void>;
    work = Promise.resolve().then(async () => {
      for (const step of steps) {
        if (!active) return;
        try { await step.run(); }
        catch (error) {
          if (threadId) await this.confirmMissingThread(threadId, error);
          this.bb.log.warn(`Tavern ${key} ${step.name}: ${String(error)}`);
        }
      }
    }).finally(() => { if (this.maintenance.get(key)?.work === work) this.maintenance.delete(key); });
    this.maintenance.set(key, { work, startedAt: this.keeper.now() });
    try { await loopCall(work, key); }
    catch (error) { this.bb.log.warn(String(error)); }
    finally { active = false; }
  }
  async sweep() {
    try { this.settingsMaintenance(); }
    catch (error) { this.bb.log.warn(`Tavern settings maintenance: ${String(error)}`); }
    await this.maintain("Closing time maintenance", null, [{ name: "sweep", run: () => this.away.sweep() }]);
    const keepers = this.keeper.store.all("members").filter(m => m.role === "keeper");
    try { this.reviewCache = this.readReview(); }
    catch (error) { this.bb.log.warn(`Tavern review cache: ${String(error)}`); }
    try {
      await Promise.all(keepers.map(async member => {
        const id = member.threadId;
        const automatic = (run: () => unknown) => () => !this.config().tavern.paused && isLiveKeeper(this.keeper.store, this.keeper.member(id)) ? run() : undefined;
        await this.maintain(`Keeper ${id}`, id, [
          { name: "stops", run: () => this.retryStops(id) },
          { name: "hires", run: () => recoverHires(this.bb, this.keeper, id, child => this.spawnBriefDelivered(child)) },
          { name: "cleanup", run: () => this.finishMemberCleanup(id) },
          { name: "thread", run: automatic(async () => this.updateThread(await loopCall(this.bb.sdk.threads.get({ threadId: id }), `Keeper thread ${id}`))) },
          { name: "hold display", run: automatic(() => this.expireHoldingDisplay(id)) },
          { name: "scopes", run: automatic(() => this.scopes?.resume(id)) },
          { name: "briefs", run: automatic(() => this.retryInitialBriefs(id)) },
          { name: "failure blocker", run: automatic(() => this.ensureFailureBlocker(id)) },
          { name: "defaults", run: automatic(() => this.keeper.defaults(id, error => this.bb.log.warn(String(error)))) },
          { name: "stale", run: automatic(() => this.keeper.stale(id, child => this.away.blocked(child))) },
        ]);
        try { await this.tick(id); }
        catch (error) {
          await this.confirmMissingThread(id, error);
          this.bb.log.warn(`Tavern Keeper ${id} tick: ${String(error)}`);
        }
      }));
    } finally {
      this.reviewCache = null;
    }
  }
  async stop(id: string, reason: string | null = null) {
    const q = this.keeper.recordStop(id, reason);
    await this.retryStops(q.keeperThreadId, id, true);
    const current = this.keeper.summary(id);
    return { phase: current.phase as "stopping" | "stopped", unconfirmed: current.stopUnconfirmed ?? 0 };
  }
  async retryStops(keeperId: string, questId?: string, force = false) {
    const quests = this.keeper.store.query("quests", "keeperThreadId", keeperId, 500)
      .filter(q => q.phase === "stopping" && (!questId || q.id === questId));
    for (const q of quests) {
      const running = this.stopFlights.get(q.id);
      if (running) { await running; continue; }
      const work = this.retryQuestStop(keeperId, q.id, force);
      this.stopFlights.set(q.id, work);
      try { await work; }
      finally { if (this.stopFlights.get(q.id) === work) this.stopFlights.delete(q.id); }
    }
  }
  private async retryQuestStop(keeperId: string, questId: string, force: boolean) {
    const q = this.keeper.quest(questId);
    if (q.phase !== "stopping") return;
    const members = this.keeper.store.query("members", "boardQuestId", q.id, 500);
    for (const member of members) {
      let state = this.keeper.store.runtime(member.threadId);
      let lookupFailure: { error: unknown } | null = null;
      if (!member.stopPending && member.state === "done" && !state.released) {
        try {
          const thread = await loopCall(this.bb.sdk.threads.get({ threadId: member.threadId }), `check finished member ${member.threadId}`);
          this.updateThread(thread);
          if (thread.archivedAt !== null || thread.deletedAt !== null ||
            ["idle", "error"].includes(thread.status) && !this.initialBriefs.has(member.threadId)) continue;
        } catch (error) {
          if (isNotFound(error)) {
            this.keeper.store.patch(member.threadId, { deletedAt: this.keeper.now(), archivedAt: this.keeper.now() });
            continue;
          }
          lookupFailure = { error };
        }
        this.keeper.store.put("members", member.threadId, { ...this.keeper.member(member.threadId)!, stopPending: true, stopError: null });
      }
      if (!this.keeper.member(member.threadId)?.stopPending) continue;
      if (force || this.keeper.now() >= (state.stopNextAttemptAt ?? 0)) {
        const attempts = (state.stopAttempts ?? 0) + 1;
        this.keeper.store.patch(member.threadId, { stopAttempts: attempts,
          stopNextAttemptAt: this.keeper.now() + ([5000, 15000, 60000][attempts - 1] ?? 300000) });
        this.keeper.store.put("members", member.threadId, { ...this.keeper.member(member.threadId)!, lastStopAttemptAt: this.keeper.now() });
        try {
          if (lookupFailure) throw lookupFailure.error;
          let thread: Thread | null;
          try { thread = await loopCall(this.bb.sdk.threads.get({ threadId: member.threadId }), `stop thread ${member.threadId}`); }
          catch (error) { if (!isNotFound(error)) throw error; thread = null; }
          if (thread && thread.archivedAt === null && thread.deletedAt === null &&
            (attempts === 1 || !["idle", "error"].includes(thread.status))) {
            try { await loopCall(this.bb.sdk.threads.stop({ threadId: member.threadId }), `stop ${member.threadId}`); }
            catch (error) { if (!isNotFound(error)) throw error; }
            try { thread = await loopCall(this.bb.sdk.threads.get({ threadId: member.threadId }), `confirm stop ${member.threadId}`); }
            catch (error) { if (!isNotFound(error)) throw error; thread = null; }
          }
          if (this.initialBriefs.has(member.threadId))
            throw new Error(`Brief delivery is still in flight for ${member.threadId}; Stop will check again`);
          if (thread && thread.archivedAt === null && thread.deletedAt === null && !["idle", "error"].includes(thread.status))
            throw new Error(`Stop not yet confirmed for ${member.threadId}: ${thread.status}`);
          if (thread) this.updateThread(thread);
          else this.keeper.store.patch(member.threadId, { deletedAt: this.keeper.now(), archivedAt: this.keeper.now() });
          this.keeper.activity(member.threadId, "stopped");
          this.keeper.store.put("members", member.threadId, { ...this.keeper.member(member.threadId)!, stopPending: false, stopError: null });
          this.scopes?.clearScope(member.threadId);
          if (state.stopAskId) this.keeper.withdrawAsk(state.stopAskId, "turn-recovered");
          this.keeper.store.patch(member.threadId, { stopAskId: null });
        } catch (error) {
          this.keeper.store.put("members", member.threadId, { ...this.keeper.member(member.threadId)!, stopError: String(error) });
        }
      }
      state = this.keeper.store.runtime(member.threadId);
      if (this.keeper.member(member.threadId)?.stopPending && this.keeper.now() - (q.stoppingSince ?? q.updatedAt) >= 120000 &&
        !state.stopAskId) {
        const ask = this.keeper.ask(keeperId, {
          boardQuestId: q.id, kind: "blocker", question: `Stop is not confirmed for ${this.keeper.name(member)}`,
          why: `Tavern keeps retrying. Inspect @thread:${member.threadId} or retry now.`,
          options: [{ id: "retry", label: "Retry now", detail: "Ask Tavern to retry this stop immediately", recommended: true }],
          meanwhile: "This quest accepts no new work while it is stopping.", holds: [],
        }, { stopMemberThreadId: member.threadId }, true);
        this.keeper.store.put("askMeta", ask.id, { stopMemberThreadId: member.threadId });
        this.keeper.store.patch(member.threadId, { stopAskId: ask.id });
      }
    }
    const pendingHires = this.keeper.pendingStopHires(q.id);
    const current = this.keeper.quest(q.id);
    if (current.phase !== "stopping") return;
    if (pendingHires.length && this.keeper.now() - (q.stoppingSince ?? q.updatedAt) >= 120000 && !current.stopHireAskId) {
      const stopHireTokens = pendingHires.map(hire => hire.token);
      const ask = this.keeper.ask(keeperId, {
        boardQuestId: q.id, kind: "blocker", question: `Stop is waiting for ${pendingHires.length} unconfirmed hire(s)`,
        why: `A hire may have started a thread Tavern cannot find yet: ${pendingHires.map(hire => hire.title).join(", ").slice(0, 80)}. Retry checks again.`,
        options: [{ id: "retry", label: "Retry now", detail: "Check again for the thread this hire may have started; retain the reservation until it is identified", recommended: true }],
        meanwhile: "Tavern keeps the quest stopping and its reservation intact until recovery confirms the child or that no child exists.", holds: [],
      }, { stopHireTokens }, true);
      this.keeper.store.put("askMeta", ask.id, { stopHireTokens });
      this.keeper.store.put("quests", q.id, { ...this.keeper.quest(q.id), stopHireAskId: ask.id });
    } else if (!pendingHires.length && current.stopHireAskId) {
      this.keeper.withdrawAsk(current.stopHireAskId, "turn-recovered");
      this.keeper.store.put("quests", q.id, { ...current, stopHireAskId: null });
    }
    if (!this.keeper.store.query("members", "boardQuestId", q.id, 500).some(member => member.stopPending) && !pendingHires.length) {
      this.keeper.store.atomic(() => {
        this.keeper.store.put("quests", q.id, { ...this.keeper.quest(q.id), phase: "stopped", endedAt: this.keeper.now(), updatedAt: this.keeper.now() });
        this.serviceRecords.record(q.id);
        const request = this.keeper.store.db.prepare("SELECT data FROM tavern_events WHERE board_quest_id=? AND type='quest.stopping' ORDER BY id LIMIT 1").get(q.id) as { data: string } | undefined;
        this.keeper.store.event(this.keeper.now(), keeperId, q.id, "quest.stopped", "Every party member is confirmed stopped or gone", request ? JSON.parse(request.data) : { reason: q.stopReason ?? null }, { kind: "user" });
      });
      this.bb.rpc.experimental_invalidate([tags.registry()]);
    }
    this.keeper.changed(keeperId, q.id);
  }
  async wrap(
    threadId: string,
    id: string,
    outcome: string,
    left: string,
    skipped: { waypointId: string; reason: string }[] = [],
  ) {
    const q = this.keeper.owned(threadId, id);
    if (q.phase === "stopped" || q.phase === "stopping") throw new Error("This board quest was stopped or is stopping");
    const awayWindow = this.away.wrapWindow(id);
    this.keeper.guard(threadId, id);
    if (q.phase === "done")
      return {
        pendingArchives: await this.archiveMembers(
          this.keeper.summary(id).members,
        ),
      };
    const before = this.keeper.summary(id);
    for (const skip of skipped) {
      const waypoint = before.waypoints.find((w) => w.id === skip.waypointId);
      if (!waypoint?.optional || !skip.reason.trim())
        throw new Error(
          "Only optional waypoints may be explicitly skipped, with a reason",
        );
    }
    const summary = before;
    const proposed = new Set(skipped.map((skip) => skip.waypointId));
    if (
      !summary.plan ||
      summary.waypoints.some(
        (w) =>
          !["verified", "skipped"].includes(w.state) && !proposed.has(w.id),
      )
    )
      throw new Error(
        "Every waypoint must be verified or explicitly skipped before wrapping",
      );
    const verifiedEntries = this.keeper.journal
      .linkedEntries(id)
      .filter(
        (entry) =>
          entry.status === "verified" &&
          summary.waypoints.some(
            (waypoint) => waypoint.id === entry.link?.waypointId,
          ),
      );
    this.keeper.store.atomic(() => {
      this.keeper.store.db.prepare("UPDATE tavern_records SET data=json_set(data,\'$.cancelledAt\',?) WHERE kind=\'hires\' AND json_extract(data,\'$.owner.boardQuestId\')=?").run(this.keeper.now(), id);
      for (const m of summary.members) {
        if (this.keeper.store.runtime(m.threadId).released || ["failed", "stopped"].includes(m.state)) continue;
        const wins =
          m.classId === "warden"
            ? 0
            : new Set(
                verifiedEntries
                  .filter((entry) => entry.threadId === m.threadId)
                  .map((entry) => entry.link?.waypointId),
              ).size;
        this.keeper.store.put("members", m.threadId, {
          ...m,
          state: "done",
          place: "rest",
          verifiedWins: wins,
        });
        this.keeper.store.patch(m.threadId, { archivePending: true });
      }
      for (const skip of skipped) {
        const value = {
          boardQuestId: id,
          version: q.planVersion,
          waypointId: skip.waypointId,
        };
        this.keeper.store.put(
          "skips",
          `${id}:${q.planVersion}:${skip.waypointId}`,
          value,
        );
        this.keeper.store.event(
          this.keeper.now(),
          threadId,
          id,
          "waypoint.skipped",
          `Skipped ${skip.waypointId}: ${skip.reason}`,
          { ...value, reason: skip.reason },
          { kind: "agent", threadId },
        );
      }
      this.keeper.store.put("quests", id, {
        ...q,
        phase: "done",
        endedAt: this.keeper.now(),
        updatedAt: this.keeper.now(),
      });
      this.serviceRecords.record(id);
      this.keeper.memory.closeQuest(threadId, id);
      const withdrawnAskIds: string[] = [];
      {
        const open = this.keeper.store.db.prepare("SELECT id FROM tavern_records WHERE kind='asks' AND json_extract(data,'$.boardQuestId')=? AND json_extract(data,'$.state')='open'").all(id) as { id: string }[];
        for (const ask of open) {
          const withdrawn = this.keeper.withdrawAsk(ask.id, "quest-returned");
          if (withdrawn) withdrawnAskIds.push(withdrawn.id);
        }
      }
      this.keeper.store.event(
        this.keeper.now(),
        threadId,
        id,
        "quest.wrapped",
        outcome,
        {
          outcome,
          left,
          skipped,
          ...(awayWindow ? { awayWindowId: awayWindow.id, deferredMemberThreadIds: summary.members.map(member => member.threadId), withdrawnAskIds } : {}),
        },
      );
    });
    this.bb.rpc.experimental_invalidate([tags.registry()]);
    this.keeper.changed(threadId, id);
    return { pendingArchives: await this.archiveMembers(summary.members) };
  }
  async push(threadId: string, title: string, body: string, askId?: string) {
    const attention = this.config().attention;
    if (attention.notify === "none") return;
    if (attention.quietHours) {
      const quiet = attention.quietHours;
      const parts = new Intl.DateTimeFormat("en", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(this.keeper.now()));
      const minute = Number(parts.find(part => part.type === "hour")!.value) * 60 + Number(parts.find(part => part.type === "minute")!.value);
      const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
      const start = minutes(quiet.start), end = minutes(quiet.end);
      if (start < end ? minute >= start && minute < end : minute >= start || minute < end) return;
    }
    const id = askId ?? this.keeper.store.openAsks(threadId).find(ask => ask.question === title && ask.why === body)?.id;
    const ask = id ? this.keeper.store.get("asks", id) : null;
    if (this.away.store.snapshot().status.closed && (!ask || !this.away.shouldNotify(ask.kind, ask.createdAt))) return;
    const notificationId = id ? this.away.notificationKey(id) : null;
    if (notificationId) {
      if (this.away.notified(notificationId) || this.notifiedAsks.has(notificationId)) return;
      this.notifiedAsks.add(notificationId);
      if (this.notifiedAsks.size > LIMITS.notificationDedupe) this.notifiedAsks.delete(this.notifiedAsks.values().next().value!);
    }
    try {
      await this.bb.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "notifications.send",
        input: {
          title: title.slice(0, 80),
          body: body.slice(0, 180),
          threadId,
        },
        outputSchema: pushResultSchema as unknown as Parameters<
          BbPluginApi["sdk"]["plugins"]["callRpc"]
        >[0]["outputSchema"],
      });
      if (notificationId) this.away.markNotified(notificationId);
    } catch (error) {
      this.bb.log.info(`Tavern blocker push unavailable: ${String(error)}`);
    }
  }
  queued(entry: QueuedMessage) {
    if (isUser(entry))
      this.keeper.receiveUser(
        entry.threadId,
        userInputText(entry.content),
        null,
        entry.id,
        entry.createdAt,
        false,
        false,
        classSelectionOnly(entry.content, this.keeper.member(entry.threadId)?.classId ?? ""),
      );
  }
  dispatched(entry: QueuedMessage) {
    if (entry.originPluginId === this.bb.pluginId) {
      const id = tickId(inputText(entry.content));
      if (id) this.loop.acknowledge(id);
      const pending = this.keeper.store.runtime(entry.threadId).pendingBrief;
      if (pending && inputText(entry.content).startsWith(`[Tavern brief] id=${pending.id}\n`))
        this.finishInitialBrief(entry.threadId, pending.id);
    } else if (isUser(entry)) {
      this.keeper.receiveUser(
        entry.threadId,
        userInputText(entry.content),
        null,
        entry.id,
        entry.createdAt,
        true,
        false,
        classSelectionOnly(entry.content, this.keeper.member(entry.threadId)?.classId ?? ""),
      );
    }
  }
  cancelled(entry: QueuedMessage) {
    if (this.away.blocked(entry.threadId) && entry.originPluginId === this.bb.pluginId) return;
    if (entry.originPluginId === this.bb.pluginId) {
      const text = inputText(entry.content);
      this.cancelTick(text);
      const pending = this.keeper.store.runtime(entry.threadId).pendingBrief;
      if (pending && text.startsWith(`[Tavern brief] id=${pending.id}\n`)) {
        this.keeper.store.patch(entry.threadId, { pendingBrief: { ...pending, attempts: LIMITS.briefRetryAttempts, nextAttemptAt: this.keeper.now(), error: "The queued brief was cancelled. It will not be sent again without an explicit retry." } });
        this.ensureBriefBlocker(entry.threadId);
      }
    } else if (isUser(entry)) this.keeper.cancelUser(entry.threadId, entry.id);
  }
  private ensureFailureBlocker(threadId: string) {
    const state = this.keeper.store.runtime(threadId);
    if (this.config().tavern.paused || Math.max(state.failureCount ?? 0, state.tickRefusalCount ?? 0) < 2) return;
    if (state.failureAskId && this.keeper.store.get("asks", state.failureAskId)?.state === "open") return;
    const ask = this.keeper.ask(threadId, {
      kind: "blocker",
      question: (state.tickRefusalCount ?? 0) >= 2 ? "The host refused two Keeper ticks in a row" : "The Keeper's provider failed two turns in a row",
      why: (state.lastFailure ?? "Provider turn failed").slice(0, 200),
      options: [
        { id: "retry", label: "Retry", detail: "Allow another recovery attempt", recommended: true },
        { id: "switch-model", label: "Switch model", detail: "Change the provider/model in the composer, then send a message. No automatic switch or retry.", recommended: false },
      ],
      meanwhile: "Members keep working; their reports wait in the mailbox.",
      holds: [],
    }, undefined, true);
    this.keeper.store.patch(threadId, { failureAskId: ask.id });
    void this.push(threadId, ask.question, ask.why);
  }
  tickRefused(threadId: string, error: unknown) {
    const state = this.keeper.store.runtime(threadId);
    this.keeper.store.patch(threadId, {
      tickRefusalCount: (state.tickRefusalCount ?? 0) + 1,
      tickRetryAt: this.keeper.now() + LIMITS.retryMs,
      lastFailure: String(error).slice(0, 2000),
    });
    this.ensureFailureBlocker(threadId);
  }
  tickResent(threadId: string, tickId: string, count: number) {
    this.record("tick.resent", { tickId, count }, threadId, null, `tick-resent:${tickId}:${count}`);
    this.bb.log.warn(`Tavern tick delivery retry keeper=${threadId} id=${tickId} count=${count}; queue and accepted-input history have no confirmation`);
    if (count < 2) return;
    const state = this.keeper.store.runtime(threadId);
    if (state.tickDeliveryAskId && this.keeper.store.get("asks", state.tickDeliveryAskId)?.state === "open") return;
    const ask = this.keeper.ask(threadId, {
      kind: "blocker",
      question: "The host has not confirmed this Keeper tick after two delivery retries",
      why: `Tick ${tickId} is still the same batch. Its facts remain unread until the host confirms delivery; retries keep the same id so duplicate admission is refused.`,
      options: [{ id: "retry", label: "Check again", detail: "Recheck the queue and accepted-input history without creating another batch", recommended: true }],
      meanwhile: "Members keep working; their reports remain in the mailbox.",
      holds: [],
    }, undefined, true);
    this.keeper.store.patch(threadId, { tickDeliveryAskId: ask.id });
  }
  failed(threadId: string, error = "Provider turn failed", requestId?: string) {
    if (this.keeper.member(threadId)?.role !== "keeper") return;
    const state = this.keeper.store.runtime(threadId);
    if (requestId && state.failedRequests?.includes(requestId)) return;
    if (!state.turnEventsObserved) this.keeper.endTurn(threadId);
    const count = (state.failureCount ?? 0) + 1;
    this.keeper.store.patch(threadId, {
      failureCount: count, lastFailure: error.slice(0, 2000),
      failedRequests: requestId ? [...(state.failedRequests ?? []), requestId].slice(-50) : state.failedRequests,
    });
    if (this.config().tavern.paused) return;
    if (count >= 2) { this.ensureFailureBlocker(threadId); return; }
    this.keeper.reanchor(threadId, "failed turn");
  }
  async threadStarted(thread: Thread) {
    this.updateThread(thread);
    if (this.scopes) await this.scopes.pinWorktree(thread.id);
  }
  async threadLifecycle(
    type: "thread.archived" | "thread.unarchived" | "thread.deleted",
    event: { thread: Thread; actor?: unknown },
  ) {
    const member = this.keeper.member(event.thread.id);
    if (!member) return;
    const actor = actorSchema.safeParse(event.actor);
    this.keeper.store.event(
      this.keeper.now(),
      member.keeperThreadId ?? member.threadId,
      member.boardQuestId,
      type,
      `${this.keeper.name(member)} ${type.slice(7)}; actor ${actor.success ? JSON.stringify(actor.data) : "unknown (not supplied by the host)"}`,
      {
        memberThreadId: member.threadId,
        originActor: event.actor ?? null,
        keeperArchiveRequested:
          this.keeper.store.runtime(member.threadId).archivePending === true,
      },
      actor.success ? actor.data : { kind: "tavern" },
    );
    this.keeper.changed(member.threadId, member.boardQuestId);
    this.updateThread(event.thread, actor.success ? actor.data : { kind: "tavern" });
    if (
      type === "thread.unarchived" &&
      !this.keeper.store.runtime(member.threadId).released
    ) {
      const report = this.keeper.store.query(
        "reports",
        "memberThreadId",
        member.threadId,
        1,
      )[0];
      const state: Member["state"] = ["active", "starting"].includes(
        event.thread.status,
      )
        ? "working"
        : event.thread.status === "error"
          ? "failed"
          : event.thread.status === "stopping"
            ? "stopped"
            : member.role === "member" && report?.status === "done"
              ? "done"
              : "idle";
      this.keeper.activity(member.threadId, state);
      if (this.scopes)
        await this.scopes.ensure(this.keeper.member(member.threadId)!);
      if (member.role === "keeper")
        this.keeper.reanchor(member.threadId, "thread unarchived");
    }
  }
  private captureThreadMetadata(thread: Thread) {
    if (this.keeper.member(thread.id)?.role !== "keeper") return;
    const state = this.keeper.store.runtime(thread.id);
    if (state.threadTitle === thread.title && state.threadCreatedAt === thread.createdAt) return;
    this.keeper.store.patch(thread.id, {
      threadTitle: thread.title,
      threadCreatedAt: thread.createdAt,
    });
    this.bb.rpc.experimental_invalidate([tags.room()]);
  }
  threadGone(threadId: string) {
    const recordsChanged = this.serviceRecords.dropThreadLinks(threadId);
    const member = this.keeper.member(threadId);
    if (!member) return;
    const state = this.keeper.store.runtime(threadId);
    this.keeper.store.patch(threadId, { deletedAt: state.deletedAt ?? this.keeper.now(), archivedAt: state.archivedAt ?? this.keeper.now(), heldAt: null, typingAt: null, userAt: null, failureCount: 0, tickRefusalCount: 0, tickRetryAt: null, failureAskId: null });
    if (state.deletedAt == null && !recordsChanged) this.bb.rpc.experimental_invalidate([tags.registry()]);
    if (member.role === "keeper") {
      for (;;) {
        const asks = this.keeper.store.openAsks(threadId);
        if (!asks.length) break;
        for (const ask of asks) this.keeper.withdrawAsk(ask.id, "keeper-archived");
      }
    }
    this.scopes?.clearScope(threadId);
    this.keeper.activity(threadId, "stopped");
    this.keeper.changed(threadId, member.boardQuestId);
  }
  updateThread(thread: Thread, actor: Actor = { kind: "tavern" }) {
    const recordsChanged = thread.deletedAt !== null && this.serviceRecords.dropThreadLinks(thread.id);
    const member = this.keeper.member(thread.id);
    if (!member) return;
    this.captureThreadMetadata(thread);
    const state = this.keeper.store.runtime(thread.id);
    const goneAt = thread.archivedAt ?? thread.deletedAt;
    const archived = goneAt !== null;
    if (state.archivedAt !== goneAt || state.deletedAt !== thread.deletedAt || archived &&
      (state.heldAt !== null || state.typingAt !== null || state.userAt !== null)) {
      this.keeper.store.patch(thread.id, {
        archivedAt: goneAt,
        deletedAt: thread.deletedAt,
        ...(archived ? { heldAt: null, typingAt: null, userAt: null, failureCount: 0, tickRefusalCount: 0, tickRetryAt: null, failureAskId: null } : {}),
      });
      if (thread.deletedAt !== null && state.deletedAt == null && !recordsChanged) this.bb.rpc.experimental_invalidate([tags.registry()]);
    }
    if (member.role === "keeper" && archived) {
      const affectedQuests = new Set<string | null>();
      this.keeper.store.atomic(() => {
        for (;;) {
          const asks = this.keeper.store.openAsks(thread.id);
          if (!asks.length) break;
          for (const ask of asks) {
            this.keeper.withdrawAsk(ask.id, "keeper-archived");
            this.keeper.store.event(
              this.keeper.now(), thread.id, ask.boardQuestId, "ask.withdrawn",
              `Withdrawn because this Keeper was archived: ${ask.question}`,
              { askId: ask.id, reason: "keeper-archived", archivedAt: thread.archivedAt }, actor,
            );
            affectedQuests.add(ask.boardQuestId);
          }
        }
      });
      for (const questId of affectedQuests) this.keeper.changed(thread.id, questId);
    }
    const previous = member.state;
    if (thread.deletedAt !== null) this.scopes?.clearScope(thread.id);
    if (
      member.role === "keeper" &&
      !this.keeper.store.runtime(thread.id).turnEventsObserved &&
      !this.keeper.store.runtime(thread.id).turnBoundaryUnknown &&
      ["idle", "error"].includes(thread.status) &&
      previous === "working"
    )
      this.keeper.endTurn(thread.id);
    this.keeper.activity(
      thread.id,
      thread.archivedAt !== null || thread.deletedAt !== null
        ? "stopped"
        : thread.status === "active" || thread.status === "starting"
          ? "working"
          : thread.status === "error"
            ? "failed"
            : thread.status === "stopping"
              ? "stopped"
              : "idle",
      thread.updatedAt,
    );
    if (
      member.role === "member" &&
      thread.status === "error" &&
      previous !== "failed"
    )
      this.keeper.store.event(
        this.keeper.now(),
        member.keeperThreadId,
        member.boardQuestId,
        "member.failed",
        `${this.keeper.name(member)}'s thread failed. Inspect the failure before retrying.`,
        { memberThreadId: thread.id },
      );
  }
  private async observeMember(member: Member, sequence?: number): Promise<void> {
    if (!this.insights) return;
    const pending = this.memberObservations.get(member.threadId);
    if (pending) { await pending; return this.observeMember(member, sequence); }
    const before = this.keeper.store.runtime(member.threadId).eventSequence;
    if (sequence !== undefined && sequence <= before) return;
    let work: Promise<void>;
    work = (async () => {
      const events = await this.bb.sdk.threads.events.list({ threadId: member.threadId, afterSeq: String(before), types: ["system/thread/interrupted"], limit: "100", order: "asc" });
      for (const event of events) if (event.type === "system/thread/interrupted")
        this.record("turn.interrupted", { reason: event.data.reason, threadId: member.threadId }, member.keeperThreadId, member.boardQuestId, `native:${member.threadId}:${event.seq}`, event.createdAt);
      const current = this.keeper.store.runtime(member.threadId).eventSequence;
      const next = Math.max(current, events.at(-1)?.seq ?? before, events.length === 100 ? before : sequence ?? before);
      if (next > current) this.keeper.store.patch(member.threadId, { eventSequence: next });
    })().finally(() => { if (this.memberObservations.get(member.threadId) === work) this.memberObservations.delete(member.threadId); });
    this.memberObservations.set(member.threadId, work);
    return work;
  }
  async observe(thread: Thread, sequence?: number) {
    const m = this.keeper.member(thread.id);
    if (!m) return;
    this.captureThreadMetadata(thread);
    this.keeper.touch(thread.id);
    if (m.role !== "keeper") return this.observeMember(m, sequence);
    const rt = this.keeper.store.runtime(thread.id);
    if (sequence !== undefined && sequence <= rt.eventSequence) return;
    const events = await this.bb.sdk.threads.events.list({
      threadId: thread.id,
      afterSeq: String(rt.eventSequence),
      types: [
        "thread/compacted",
        "system/thread/interrupted",
        "turn/started",
        "turn/mainRun/updated",
        "turn/completed",
      ],
      limit: "100",
      order: "asc",
    });
    const interrupted = new Map(events.flatMap(event =>
      event.type === "turn/completed" && event.data.status === "interrupted" && event.scope?.kind === "turn"
        ? [[event.scope.turnId, event.createdAt] as const] : [],
    ));
    for (const event of events) {
      const current = this.keeper.store.runtime(thread.id);
      if (event.seq <= current.eventSequence) continue;
      if (event.type === "thread/compacted")
        this.keeper.reanchor(thread.id, "after compaction");
      if (event.type === "system/thread/interrupted") {
        this.keeper.store.patch(thread.id, {
          turnEventsObserved: true,
          ...(current.mainTurnId ? { interruptedMainTurns: [
            ...(current.interruptedMainTurns ?? []).filter(turn => turn.id !== current.mainTurnId),
            { id: current.mainTurnId, at: event.createdAt },
          ].slice(-20) } : {}),
        });
        this.record("turn.interrupted", { reason: event.data.reason, threadId: thread.id }, thread.id, null, `native:${thread.id}:${event.seq}`, event.createdAt);
        if (event.data.reason === "manual-stop") {
          if (current.userAt === null || current.userAt <= event.createdAt)
            this.keeper.store.patch(thread.id, {
              manualStopAt: event.createdAt,
            });
          this.keeper.reanchor(thread.id, "manual-stop");
        } else this.keeper.reanchor(thread.id, event.data.reason);
      }
      if (
        event.type === "turn/completed" &&
        event.data.status === "completed"
      ) {
        this.keeper.store.patch(thread.id, {
          failureCount: 0,
          tickRefusalCount: 0,
          tickRetryAt: null,
          failureAskId: null,
        });
        if (current.failureAskId) {
          const ask = this.keeper.store.get("asks", current.failureAskId);
          if (ask?.state === "open")
            this.keeper.withdrawAsk(ask.id, "turn-recovered");
        }
      }
      const turnId = event.scope?.kind === "turn" ? event.scope.turnId : null;
      if (
        turnId &&
        event.type === "turn/started" &&
        !event.data.parentToolCallId
      )
        this.keeper.store.patch(thread.id, {
          mainTurnId: turnId,
          turnEventsObserved: true,
          turnStartedAt: event.createdAt,
          interruptedMainTurns: current.interruptedMainTurns?.filter(turn => turn.id !== turnId),
        });
      const state = this.keeper.store.runtime(thread.id);
      if (
        turnId &&
        event.type === "turn/mainRun/updated" &&
        event.data.state === "running" &&
        (!state.mainTurnId || state.mainTurnId === turnId)
      )
        this.keeper.store.patch(thread.id, {
          endedMainTurns: state.endedMainTurns?.filter((id) => id !== turnId),
          interruptedMainTurns: state.interruptedMainTurns?.filter(turn => turn.id !== turnId),
        });
      if (
        turnId &&
        (!state.mainTurnId || state.mainTurnId === turnId) &&
        ((event.type === "turn/mainRun/updated" &&
          event.data.state === "idle") ||
          (event.type === "turn/completed" &&
            !(state.endedMainTurns ?? []).includes(turnId)))
      ) {
        if (state.turnStartedAt != null && event.createdAt >= state.turnStartedAt)
          this.record("keeper.turn", { seconds: (event.createdAt - state.turnStartedAt) / 1000 }, thread.id, null, `keeper-turn:${thread.id}:${turnId}`, event.createdAt);
        const stoppedAt = state.interruptedMainTurns?.find(turn => turn.id === turnId)?.at ?? interrupted.get(turnId);
        this.keeper.endTurn(thread.id, event.createdAt, stoppedAt);
        this.keeper.store.patch(thread.id, {
          turnEventsObserved: true,
          turnStartedAt: null,
          endedMainTurns: [
            ...new Set([...(state.endedMainTurns ?? []), turnId]),
          ].slice(-20),
        });
      }
      this.keeper.store.patch(thread.id, { eventSequence: event.seq });
    }
    this.keeper.store.patch(thread.id, {
      turnBoundaryUnknown: events.length === 100,
    });
    if (events.length < 100 && sequence !== undefined)
      this.keeper.store.patch(thread.id, {
        eventSequence: Math.max(
          this.keeper.store.runtime(thread.id).eventSequence,
          sequence,
        ),
      });
  }
  private async confirmMissingThread(threadId: string, error: unknown) {
    if (!isNotFound(error)) return;
    try {
      const thread = await loopCall(this.bb.sdk.threads.get({ threadId }), `confirm thread ${threadId}`);
      this.updateThread(thread);
    } catch (confirmation) {
      if (isNotFound(confirmation)) this.threadGone(threadId);
      else this.bb.log.warn(`Tavern could not confirm missing thread ${threadId}: ${String(confirmation)}`);
    }
  }
  async reconcile() {
    await this.maintain("service record backfill", null, [{ name: "history", run: () => this.serviceRecords.backfill() }]);
    this.keeper.store.pruneTicks();
    await this.maintain("startup hires", null, [{ name: "recovery", run: () => recoverHires(this.bb, this.keeper, undefined, id => this.spawnBriefDelivered(id)) }]);
    const projects = new Set(
      this.keeper.store
        .all("members")
        .map((m) => this.keeper.store.runtime(m.threadId).projectId)
        .filter((id): id is string => id !== null),
    );
    for (const projectId of projects) {
      try {
        await loopCall(this.prepareRegistry(projectId), `registry ${projectId}`);
      } catch (error) {
        this.bb.log.warn(
          `Tavern could not load project registry ${projectId}: ${String(error)}`,
        );
      }
    }
    await Promise.all(this.keeper.store.all("members").map(m => {
      let thread: Thread | null = null;
      return this.maintain(`reconcile ${m.threadId}`, m.threadId, [
        { name: "thread", run: async () => {
          thread = await loopCall(this.bb.sdk.threads.get({ threadId: m.threadId }), `startup thread ${m.threadId}`);
          this.updateThread(thread);
        } },
        { name: "observe", run: () => thread && isLiveKeeper(this.keeper.store, this.keeper.member(m.threadId), "present") ? this.observe(thread) : undefined },
        { name: "worktree", run: () => thread && thread.archivedAt === null && thread.deletedAt === null ? this.scopes?.pinWorktree(thread.id) : undefined },
        { name: "stops", run: () => m.role === "keeper" ? this.retryStops(m.threadId) : undefined },
        { name: "cleanup", run: () => m.role === "keeper" ? this.finishMemberCleanup(m.threadId) : undefined },
        { name: "tick recovery", run: () => isLiveKeeper(this.keeper.store, this.keeper.member(m.threadId), "present") ? this.loop.recover(m.threadId) : undefined },
      ]);
    }));
    if (this.scopes) await this.recheckDispatch();
  }
}
