import { isMemberMachineGone, MACHINE_RELEASED, memberDetails, memberHost, patchMemberDetails, transitionMember } from "../member-engagement";
import { wasReleased } from "../../shared/member-engagement";
import { commitUserAct, type UserActReceipt } from "../authority";
import { currentAskNames } from "../quest-names";
import { randomUUID } from "node:crypto";
import { hasAwayDenials, localAwayPrevention, narrowAwayScope } from "./denials";
import type { Scope } from "../../scope";
import { readAwayDigest } from "./digest";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import type { AwayCloseInput, AwayReturnCause } from "../../shared/away";
import type { AwayControl } from "../../shared/away-rpc";
import { askSchema, type Member } from "../../shared/schema";
import { tags } from "../../shared/contract";
import { isUser } from "../dispatch";
import { isLiveKeeper, isLiveMember, isOpenQuest } from "../liveness";
import { isHireCancelled } from "../hires";
import { isQuiescentThread } from "../placement/quiescence";
import type { TavernRuntime } from "../runtime";
import { AwayConflict, AwayStore } from "./store";
import { AwayHolds, type AwayHold, type ContentHoldToken, type HeldInspection } from "./holds";
import { awayExecutionPolicy, awayReturnFromDispatch, awayShouldNotify } from "./policy";
import { AWAY_STOP_LIST, awayStopNames, windowStopKinds } from "../../shared/away";

// Return uses this persisted cause to recover the Close cohort after a restart.
const CLOSE_REANCHOR_REASON = "Closing time changed; check the current away window before assigning work";

export class AwayRuntime {
  readonly store: AwayStore;
  private readonly holds: AwayHolds;
  private dueBack = false;
  private scopesRestored: string | null = null;
  private interrupting = new Map<string, Promise<void>>();
  constructor(private readonly runtime: TavernRuntime) {
    this.store = new AwayStore(runtime.keeper.store.db, () => runtime.keeper.now());
    this.holds = new AwayHolds(runtime.keeper.store.db);
  }
  private get k() { return this.runtime.keeper; }
  private eligible(member: Member | null): member is Member {
    return member?.role === "member" && member.state !== "failed" && isLiveMember(this.k.store, member, "work");
  }
  private preservationEligible(member: Member | null): member is Member {
    if (member?.role !== "member") return false;
    const host = memberHost(this.k.store, member);
    return !wasReleased(member) && host.archivedAt === null && host.deletedAt === null;
  }
  private heldEligible(threadId: string): boolean {
    const member = this.k.member(threadId);
    return this.eligible(member) || !!this.holds.get(threadId)?.reasons.some(reason => reason.kind === "content" && reason.preservation && reason.idleOnly) && this.preservationEligible(member);
  }
  private members() { return this.k.store.all("members").filter(member => this.eligible(member)); }
  private keepers() { return this.k.store.all("members").filter(member => isLiveKeeper(this.k.store, member, "automatic")); }
  private keepersWithWork() {
    const ids = new Set<string>();
    for (const quest of this.k.store.all("quests")) if (isOpenQuest(quest)) ids.add(quest.keeperThreadId);
    for (const member of this.k.store.all("members")) {
      if (member.role !== "member" || !member.keeperThreadId) continue;
      if (["archiving", "releasing", "stopping"].includes(member.engagement ?? "") || member.state !== "failed" && isLiveMember(this.k.store, member, "occupy")) ids.add(member.keeperThreadId);
    }
    for (const hire of this.k.store.all("hires")) if (!hire.memberThreadId && !isHireCancelled(this.k, hire)) ids.add(hire.owner.keeperThreadId);
    return ids;
  }
  hasState() { return !!this.k.store.db.prepare("SELECT 1 FROM tavern_records WHERE kind IN ('away','awayHolds') LIMIT 1").get(); }
  private followsWindow(windowId: string | null, hold: AwayHold): boolean {
    return windowId !== null && (hold.resumeRequired || hold.stopPending)
      && (hold.windowId === windowId || hold.reasons?.some(reason => reason.kind === "away" && reason.windowId === windowId) === true);
  }
  status() {
    const { status } = this.store.snapshot();
    return { ...status, followUp: status.windowId !== null && this.holds.all().some(hold =>
      this.followsWindow(status.windowId, hold) && this.eligible(this.k.member(hold.threadId))) };
  }
  snapshot(): AwayControl {
    const state = this.store.snapshot(), members = this.members(), ids = new Set(members.map(member => member.threadId));
    const holds = this.holds.all().filter(hold => ids.has(hold.threadId) && (hold.resumeRequired || hold.stopPending));
    const scopes = members.length && this.runtime.scopes ? this.runtime.scopes.api.status() : null;
    const counts = new Map<string | null, { members: number; watchedCount: number }>();
    let watchedCount = 0;
    const noGuards = state.status.closed && state.window?.stopList.length === 0;
    for (const member of members) {
      const watched = Number(!noGuards && !localAwayPrevention(scopes, member, state.window));
      watchedCount += watched;
      const group = counts.get(member.boardQuestId);
      if (group) { group.members++; group.watchedCount += watched; }
      else counts.set(member.boardQuestId, { members: 1, watchedCount: watched });
    }
    return { ...state, status: { ...state.status, followUp: holds.some(hold => this.followsWindow(state.status.windowId, hold)) }, watchedCount, watchedByQuest: [...counts].map(([questId, group]) => ({ questId, watchedCount: group.watchedCount })),
      eligibleByQuest: [...counts].map(([questId, group]) => ({ questId, ...group })),
      soloCount: this.k.store.all("members").filter(member => member.role === "solo" && member.state !== "failed" && isLiveMember(this.k.store, member, "work")).length, heldCount: holds.length,
      pendingStops: holds.filter(hold => hold.stopPending).map(hold => ({ threadId: hold.threadId, error: hold.error })),
      resumeRequired: holds.filter(hold => hold.resumeRequired).map(({ threadId, keeperThreadId, questId }) => ({ threadId, keeperThreadId, questId })) };
  }
  narrowScope(scope: Scope): Scope { return narrowAwayScope(scope, this.store.snapshot().window); }
  private prevention(threadId: string) {
    return localAwayPrevention(this.runtime.scopes ? this.runtime.scopes.api.status() : null, this.k.member(threadId), this.store.snapshot().window);
  }
  canPrepareLocalHire() {
    const status = this.runtime.scopes?.api.status();
    return !!status && status.mode === "enforce" && status.guard.installed && !status.guard.stale;
  }
  assertHire(questId: string | null, guardedLocal: boolean) {
    if (awayExecutionPolicy(this.store.snapshot().window, questId, guardedLocal).mode === "held") throw new Error("Tavern is closed; this hire is held unless it can be guarded locally or watched work was explicitly permitted.");
  }
  private policy(questId: string | null, threadId?: string) {
    return awayExecutionPolicy(this.store.snapshot().window, questId, threadId !== undefined && this.prevention(threadId));
  }
  cleanupHeld() { return this.store.snapshot().status.closed; }
  wrapWindow(questId: string) {
    const window = this.store.snapshot().window;
    if (!window || window.returnedAt !== null) return null;
    if (!window.quests.some(quest => quest.questId === questId && quest.endState === "drafts-ready")) throw new Error("Tavern is closed; this quest is held and cannot be wrapped.");
    return window;
  }
  assertWork(questId: string | null, threadId?: string) {
    if (threadId !== undefined && this.cleanupHeld() && this.k.member(threadId)?.engagement === "archiving") throw new Error("This finished quest is waiting for deferred cleanup; do not assign new work.");
    if (this.policy(questId, threadId).mode === "held") throw new Error("Tavern is closed; this work is held until you return. Watched work needs the explicit closing-time opt-in.");
  }
  blocked(threadId: string) {
    const member = this.k.member(threadId);
    if (member?.role !== "member") return false;
    const hold = this.holds.get(threadId);
    return member.engagement === "archived" || member.engagement === "archiving" || !!hold && (hold.resumeRequired || hold.stopPending) || this.policy(member.boardQuestId, member.threadId).mode === "held";
  }
  private stage(input: Member) {
    const member = this.k.member(input.threadId);
    if (!this.eligible(member)) return;
    const window = this.store.snapshot().window;
    if (!window || window.returnedAt !== null || this.policy(member.boardQuestId, member.threadId).mode !== "held") return;
    this.holds.requestAway(this.holdOwner(member), window.id);
  }
  private holdOwner(member: Member) {
    if (member.role !== "member" || !member.keeperThreadId) throw new Error("A member hold requires a party member with a Keeper");
    const pending = memberDetails(this.k.store, member.threadId).delivery;
    return { threadId: member.threadId, keeperThreadId: member.keeperThreadId, questId: member.boardQuestId,
      heldAt: this.k.now(), cancelledBrief: pending ? { id: pending.id, text: pending.text } : null };
  }
  requestContentHold(memberThreadId: string, identity: { operationId: string; idleOnly?: boolean; preservation?: boolean }): ContentHoldToken {
    const member = this.k.member(memberThreadId);
    if (identity.preservation && !identity.idleOnly) throw new Error("Preservation content holds must be idle-only");
    if (!member || !(identity.preservation ? this.preservationEligible(member) : this.eligible(member))) throw new Error("A content hold requires an active party member; inactive, archived or finished work cannot be interrupted");
    const token = this.holds.requestContent(this.holdOwner(member), identity.operationId, identity.idleOnly, identity.preservation);
    this.changed();
    return token;
  }
  inspectHeld(token: ContentHoldToken): HeldInspection {
    const hold = this.holds.findContent(token);
    return !hold || !this.heldEligible(hold.threadId) ? { state: "stale", error: null } : { state: hold.stopPending ? "pending" : "confirmed", error: hold.error };
  }
  async confirmHeld(token: ContentHoldToken): Promise<HeldInspection> {
    const hold = this.holds.findContent(token);
    if (!hold || !this.heldEligible(hold.threadId)) return { state: "stale", error: null };
    const reason = hold.reasons.find(reason => reason.kind === "content" && reason.token === token);
    if (reason?.kind === "content" && reason.idleOnly) await this.confirmIdle(hold.threadId);
    else await this.interrupt(hold.threadId);
    return this.inspectHeld(token);
  }
  finishContentHold(token: ContentHoldToken): { state: "finished" | "stale" } {
    const finished = this.holds.finishContent(token);
    if (finished) this.changed();
    return { state: finished ? "finished" : "stale" };
  }
  private changed() { this.runtime.bb.rpc.experimental_invalidate([tags.room(), ...this.k.store.all("members").filter(member => member.role === "keeper").map(member => tags.thread(member.threadId))]); }
  async close(input: AwayCloseInput, receipt?: UserActReceipt) {
    const revision = this.store.snapshot().revision;
    if (revision !== input.revision || input.settingsRevision !== undefined && this.runtime.settings?.snapshot().revision !== input.settingsRevision) throw new AwayConflict(revision);
    for (const selected of input.quests) {
      const quest = this.k.quest(selected.questId);
      if (!isOpenQuest(quest)) throw new Error("Closing time can only include live quests");
    }
    const affected = this.keepersWithWork();
    const { neverWhileClosed, productionWakeHours } = this.runtime.config().away;
    await this.runtime.closeAfterRevokingClusterGrants(() => {
      const latest = this.store.snapshot().revision;
      if (revision !== latest || input.settingsRevision !== undefined && this.runtime.settings?.snapshot().revision !== input.settingsRevision) throw new AwayConflict(latest);
      commitUserAct(this.k.store, () => this.k.now(), receipt, () => this.store.close(input, neverWhileClosed, productionWakeHours));
      this.runtime.memory.cancel(true);
    });
    await this.refreshLocalScopes();
    for (const member of this.members()) this.stage(member);
    this.changed();
    for (const threadId of this.keepersWithWork()) affected.add(threadId);
    for (const member of this.keepers()) {
      this.k.store.patch(member.threadId, { queuedTickResetId: randomUUID() });
      if (affected.has(member.threadId)) this.k.reanchor(member.threadId, CLOSE_REANCHOR_REASON);
    }
    await this.sweep();
    const state = this.snapshot();
    return { code: state.pendingStops.length ? "pending" as const : "closed" as const, state };
  }
  async return(cause: AwayReturnCause, windowId?: string, receipt?: UserActReceipt) {
    const current = this.store.snapshot();
    if (!current.window) return { code: "unchanged" as const, state: this.snapshot() };
    const result = commitUserAct(this.k.store, () => this.k.now(), receipt, () => this.store.finish(windowId ?? current.window!.id, cause));
    if (result.changed) {
      const affected = this.keepersWithWork();
      const cohort = this.k.store.db.prepare("SELECT DISTINCT keeper_thread_id AS threadId FROM tavern_events WHERE type='reanchor.requested' AND keeper_thread_id IS NOT NULL AND id>? AND id<=? AND json_extract(data,'$.cause')=?")
        .all(current.window.eventFloor, result.snapshot.window!.eventCeiling!, CLOSE_REANCHOR_REASON) as { threadId: string }[];
      for (const member of cohort) affected.add(member.threadId);
      this.holds.finishAway(current.window.id, new Set(this.members().map(member => member.threadId)));
      await this.refreshLocalScopes();
      for (const member of this.keepers()) {
        this.k.store.patch(member.threadId, { queuedTickResetId: randomUUID() });
        if (affected.has(member.threadId)) this.k.reanchor(member.threadId, "Tavern reopened. Read the since-return digest; held members need fresh tavern_tell instructions. Nothing resumes automatically.");
      }
      this.changed();
      await this.runtime.recheckDispatch();
    }
    return { code: result.changed ? "returned" as const : "unchanged" as const, state: this.snapshot() };
  }
  async detectReturn(ctx: MessageDispatchHookContext) {
    const cause = awayReturnFromDispatch(this.store.snapshot().window, ctx, this.k.member(ctx.thread.id) !== null);
    if (cause) await this.return(cause);
  }
  async dispatch(ctx: MessageDispatchHookContext) {
    const member = this.k.member(ctx.thread.id);
    await this.detectReturn(ctx);
    if (member?.role !== "member") return null;
    if (member.engagement === "archived" || ctx.thread.archivedAt !== null || ctx.thread.deletedAt !== null)
      return { action: "wait" as const, reason: "This member's thread is archived or deleted; queued work cannot run." };
    if ((member.engagement === "released" || member.engagement === "stopped") && isMemberMachineGone(this.runtime.placements().store.byMember(member.threadId)))
      return { action: "reject" as const, message: `${this.k.name(member)}: ${MACHINE_RELEASED}` };
    this.stage(member);
    if (["archiving", "stopping", "releasing"].includes(member.engagement ?? "")) return { action: "wait" as const, reason: "This finished quest is waiting for deferred cleanup; queued work will not replay." };
    if (this.holds.get(member.threadId)?.reasons.some(reason => reason.kind === "content")) return { action: "wait" as const, reason: "A content transfer holds this member; it must finish before fresh Keeper instructions. No queued work is replayed." };
    return this.blocked(member.threadId) ? { action: "wait" as const, reason: "Closing time paused this member; the Keeper must send a fresh brief after return. No queued work is replayed." } : null;
  }
  private async clearOwnQueue(threadId: string, allowed: () => boolean) {
    const queued = await this.runtime.bb.sdk.threads.queuedMessages.list({ threadId });
    for (const row of queued) {
      if (!allowed()) return;
      if (row.originPluginId !== this.runtime.bb.pluginId || isUser(row)) continue;
      await this.runtime.bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: row.id });
    }
  }
  private async confirmIdle(threadId: string) {
    if (!this.heldEligible(threadId)) return;
    const hold = this.holds.prepareStop(threadId);
    if (!hold?.stopPending) return;
    const current = () => {
      const latest = this.holds.get(threadId);
      return this.heldEligible(threadId) && latest?.version === hold.version && latest.token === hold.token;
    };
    try {
      const thread = await this.runtime.bb.sdk.threads.get({ threadId });
      if (!current() || thread.archivedAt !== null || thread.deletedAt !== null || !isQuiescentThread(thread)) return;
      await this.clearOwnQueue(threadId, current);
      const after = await this.runtime.bb.sdk.threads.get({ threadId });
      if (current() && after.archivedAt === null && after.deletedAt === null && isQuiescentThread(after) && after.updatedAt === thread.updatedAt)
        this.holds.compareAndSet(hold, { stopPending: false, error: null });
    } catch (error) {
      if (current()) this.holds.compareAndSet(hold, { error: String(error).slice(0, 1000) });
      this.runtime.bb.log.warn(`Tavern idle-only content hold ${threadId}: ${String(error)}`);
    }
    this.changed();
  }
  private async interrupt(threadId: string) {
    const existing = this.interrupting.get(threadId);
    if (existing) return existing;
    const work = this.interruptOnce(threadId);
    this.interrupting.set(threadId, work);
    try { await work; } finally { this.interrupting.delete(threadId); }
  }
  private async interruptOnce(threadId: string) {
    if (!this.eligible(this.k.member(threadId))) return;
    const hold = this.holds.prepareStop(threadId);
    if (!hold?.stopPending) return;
    if (hold.reasons.length && hold.reasons.every(reason => reason.kind === "content" && reason.idleOnly)) return this.confirmIdle(threadId);
    const current = () => {
      const latest = this.holds.get(threadId);
      return this.eligible(this.k.member(threadId)) && latest?.version === hold.version && latest.token === hold.token;
    };
    try {
      const before = await this.runtime.bb.sdk.threads.get({ threadId });
      if (before.archivedAt !== null || before.deletedAt !== null) { this.runtime.updateThread(before); return; }
      if (!current()) return;
      await this.runtime.bb.sdk.threads.stop({ threadId });
      if (!current()) return;
      const thread = await this.runtime.bb.sdk.threads.get({ threadId });
      if (thread.archivedAt !== null || thread.deletedAt !== null) { this.runtime.updateThread(thread); return; }
      if (!current()) return;
      if (thread.status !== "idle" && thread.archivedAt === null && thread.deletedAt === null) throw new Error(`Interruption not confirmed: ${thread.status}`);
      await this.clearOwnQueue(threadId, current);
      if (current()) this.holds.compareAndSet(hold, { stopPending: false, error: null });
    } catch (error) {
      if (current()) this.holds.compareAndSet(hold, { error: String(error).slice(0, 1000) });
      this.runtime.bb.log.warn(`Tavern Closing time interruption ${threadId}: ${String(error)}`);
    }
    this.changed();
  }
  async beforeTell(threadId: string) {
    const member = this.k.member(threadId)!;
    this.assertWork(member.boardQuestId, threadId);
    const hold = this.holds.get(threadId);
    if (!hold?.resumeRequired) return;
    if (hold.reasons.some(reason => reason.kind === "content")) throw new Error("A content transfer still holds this member; finish it before sending fresh instructions.");
    if (hold.stopPending) throw new Error("The member's previous turn has not stopped; retry the interruption before sending work.");
    await this.clearOwnQueue(threadId, () => true);
    if ((await this.runtime.bb.sdk.threads.queuedMessages.list({ threadId })).length)
      throw new Error("This member still has queued messages from you or another plugin; review them before sending a new brief. Nothing was replayed.");
    this.assertWork(this.k.member(threadId)!.boardQuestId, threadId);
    this.k.store.atomic(() => {
      const current = this.holds.get(threadId)!;
      if (current.reasons.some(reason => reason.kind === "content")) throw new Error("A content transfer still holds this member; finish it before sending fresh instructions.");
      if (current.stopPending) throw new Error("The member's previous turn has not stopped; retry the interruption before sending work.");
      const details = memberDetails(this.k.store, threadId), pending = details.delivery;
      if (!this.holds.compareAndSet(current, { resumeRequired: false, reasons: [], cancelledBrief: pending ? { id: pending.id, text: pending.text } : current.cancelledBrief })) throw new Error("Member hold changed; retry the fresh instruction");
      if (pending) {
        const member = this.k.member(threadId)!;
        if (member.engagement === "briefing" && details.rest) {
          transitionMember(this.k.store, member, "resting", "rebrief-cancelled", { kind: "tavern" }, { kind: "brief-cancelled", id: pending.id, evidence: { holdVersion: current.version } }, this.k.now(), { details: { delivery: null } });
        } else patchMemberDetails(this.k.store, threadId, { delivery: null });
        if (pending.blockerAskId) this.k.withdrawAsk(pending.blockerAskId, "turn-recovered");
      }
    });
    this.changed();
  }
  shouldNotify(kind: string, createdAt: number) { return awayShouldNotify(this.store.snapshot().window, kind, createdAt, this.k.now()); }
  notificationKey(askId: string) {
    const window = this.store.snapshot().window;
    return window && window.returnedAt === null ? `${window.id}:${askId}` : askId;
  }
  notified(key: string) { return !!this.k.store.db.prepare("SELECT 1 FROM tavern_records WHERE kind='awayWakes' AND id=?").get(key); }
  markNotified(key: string) {
    if (!key.startsWith("away_")) return;
    this.k.store.writeRecords("INSERT OR IGNORE INTO tavern_records(kind,id,data) VALUES('awayWakes',?,?)", key, JSON.stringify({ at: this.k.now() }));
  }
  private async refreshLocalScopes() {
    const scopes = this.runtime.scopes;
    if (!scopes) return;
    const window = this.store.snapshot().window;
    if (window === null) return;
    const restoredKey = window.returnedAt !== null ? JSON.stringify([window.id, window.version, window.returnedAt]) : null;
    if (restoredKey !== null && restoredKey === this.scopesRestored) return;
    let failed = false;
    for (const row of scopes.api.status().threads) {
      if (!row.scope || row.binding !== undefined || row.hostScope !== undefined) continue;
      const active = window !== null && window.returnedAt === null;
      const current = active ? hasAwayDenials(row.scope, window) : !row.scope.shell.deny.some(rule => rule.id.startsWith("away:") || rule.id === "cluster-write-while-away");
      if (current && !row.error) continue;
      try { await scopes.api.rebindScope(row.threadId); }
      catch (error) { failed = true; this.runtime.bb.log.warn(`Tavern Closing time local denials ${row.threadId}: ${String(error)}; protection or restoration remains pending.`); }
    }
    if (!failed && restoredKey !== null) this.scopesRestored = restoredKey;
  }
  async sweep() {
    const window = this.store.snapshot().window;
    if (window !== null) {
      await this.refreshLocalScopes();
      for (const member of this.members()) this.stage(member);
    }
    const pending = this.holds.pending();
    if (pending.length) {
      for (const hold of pending) if (this.eligible(this.k.member(hold.threadId))) await this.interrupt(hold.threadId);
    }
    if (window === null) return;
    const state = this.store.snapshot();
    if (state.status.dueBack !== this.dueBack) { this.dueBack = state.status.dueBack; this.changed(); }
    if (!state.status.closed || this.runtime.config().tavern.paused) return;
    const rows = this.k.store.db.prepare("SELECT data FROM tavern_records WHERE kind='asks' AND json_extract(data,'$.state')='open' AND json_extract(data,'$.kind') IN ('blocker','production','cluster-write')").all() as { data: string }[];
    for (const row of rows) {
      const ask = askSchema.parse(JSON.parse(row.data));
      if (!this.shouldNotify(ask.kind, ask.createdAt)) continue;
      await this.runtime.push(ask.keeperThreadId, currentAskNames(this.k.store, ask).question, ask.why, ask.id);
    }
  }
  facts(keeperThreadId: string) {
    const state = this.store.snapshot();
    if (!state.window) return "";
    const { window, status } = state;
    if (status.closed) {
      const quests = window.quests.filter(quest => this.k.store.get("quests", quest.questId)?.keeperThreadId === keeperThreadId);
      const items = windowStopKinds(window);
      const drafts = items.length === AWAY_STOP_LIST.length ? "Drafts-ready means private work and reports only. " : "";
      return `Closing time: ${status.dueBack ? "due back" : "closed until"} ${new Date(window.until).toISOString()}. Per-quest ends (first 12 of ${quests.length}): ${JSON.stringify(quests.slice(0, 12))}. ${items.length ? `Closing time blocks ${awayStopNames(items)} until you return.` : "No other Closing time stops are selected; cluster writes still wait for your return."} ${drafts}An expected closing-time hold is not a blocker to wake the user about. No new consent or scope widening. Watched work is ${window.allowWatched ? "explicitly permitted, not prevented" : "held"}. User note (quoted data): ${JSON.stringify(window.note)}`;
    }
    if (this.k.store.runtime(keeperThreadId).cursor > window.eventCeiling!) return "";
    const digest = readAwayDigest(this.k, this.store, { limit: 1 });
    const quests = digest.quests.filter(quest => this.k.store.get("quests", quest.questId)?.keeperThreadId === keeperThreadId);
    const rows = quests.slice(0, 8).map(quest => ({ title: quest.title.slice(0, 120), reports: quest.reports, decisions: quest.decisions, asks: quest.asks, returnedWhileAway: quest.returnedWhileAway === true, deferredCleanup: quest.deferredCleanup?.filter(row => row.pending).length ?? 0 }));
    return `Tavern reopened (${window.returnCause!.kind}). Since-return digest, first ${rows.length} of ${quests.length} quests: ${JSON.stringify(rows)}. Full digest: awayDigest. Held members need fresh Keeper instructions; do not replay old queued work.`;
  }
}
