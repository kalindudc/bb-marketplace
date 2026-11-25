import { authorize, commitUserAct, type UserActReceipt } from "../authority";
import { QuestAuthority } from "../quest-authority";
import { MERGE_APPROVAL_MS } from "../merge-approvals";
import { changeSpendBudget } from "../spend-budget";
import { DELEGATABLE_KINDS, preapprovalWords, type DelegationKind } from "../../shared/quest-authority";
import { clusterCommandTarget, fallbackActs } from "../../scope/acts";
import { clusterWriteCommands } from "../../scope/engine";
import { KeeperSuccessionStore } from "./succession-store";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { KeeperCallKind } from "../../shared/undo-lane";
import { applyAskEffect, hasUserAskOutcome, isNoticeEffect, keeperOwnsBlock, keeperRecoveryOptions, needsKeeperReview, askMemberTarget, scopeAskMember, type EffectHandlers, type AskEffect } from "../ask-effects";
import { issueShellGrant, settleShellGrant } from "../shell-grants";
import type { RequestSources } from "../../shared/request-source";
import { briefSteers } from "../request-sources";
import { LIMITS } from "../limits";
import { hasLiveName, isKeeperIdentity, isLiveKeeper, isLiveMember, isOpenQuest } from "../liveness";
import { assertChainPlan, assertLeadPathOpen, bindLead, currentLead, holdsLeadSeat, leadAncestors, leadDescendants, saveLead } from "./leads";
import { answerLeadPlan, decideLeadPlan, proposeLeadPlan, undoLeadPlan } from "./lead-plans";
import { leadChainView } from "./lead-chain-view";
import { memberDetails, memberHost, outstandingArchivedPlacement, patchMemberDetails, transitionMember } from "../member-engagement";
import { PlacementStore } from "../placement/store";
import { wasReleased } from "../../shared/member-engagement";
import type { JournalPort } from "../ports";
import { messageKey, SCOPE_DENIAL_TEXT } from "../../shared/text";
import { DEFAULT_SETTINGS, type TavernSettings } from "../../shared/settings";
import {
  askSchema,
  boardQuestSchema,
  checkerHandoffHoldDraftSchema,
  type CheckerHandoffHold,
  decisionSchema,
  planSchema,
  settleWaypointSchema,
  reportSchema,
  type Decision,
  type WaypointState,
  routeSchema,
  ruleSchema,
  type Ask,
  type Actor,
  questNamesSchema,
  type BoardQuest,
  type Brief,
  type JournalEntry,
  type Member,
  type Plan,
  type Report,
  type Route,
  type Rule,
} from "../../shared/schema";
import { tags, type BoardQuestSummary } from "../../shared/contract";
import { KeeperStore, type ReviewTarget } from "./store";
import { renderRestatement } from "./restatement";
import { planDiff } from "./plan-diff";
import { checkerAssignments } from "../assignments";
import { reviewLimitation } from "../../shared/check-posture";
import { KeeperMemory } from "./memory";
import type { NoteDraft } from "../../shared/schema";
import { appendSummary } from "../summaries";
import type { SummaryDraft } from "../../shared/schema";

export type PlanInput = Omit<
  Plan,
  "version" | "createdAt" | "fromSteer" | "reversible" | "alwaysAskKinds"
> & {
  alwaysAskKinds?: Plan["alwaysAskKinds"];
  reversible?: boolean;
  fromSteer?: string | null;
};
export type AskInput = Pick<
  Ask,
  "question" | "why" | "kind" | "options" | "meanwhile" | "holds"
> & {
  boardQuestId?: string | null;
  proceedInMinutes?: number | null;
  draft?: Ask["draft"];
  sendTarget?: Ask["sendTarget"];
  unsure?: boolean;
  target?: Ask["target"];
  change?: Ask["change"];
  runThreadId?: Ask["runThreadId"];
  undo?: Ask["undo"];
  scopeChange?: Ask["scopeChange"];
  releaseHoldId?: string;
  releaseCheckerHandoff?: boolean;
  waypointId?: string;
  completeOn?: string[];
  reversible?: boolean;
};
export { partyCounts } from "./quest-lifecycle";
export const routeQuestIds = (
  route: Pick<Route, "boardQuestId"> & { boardQuestIds?: string[] },
) => [
  ...new Set([
    ...(route.boardQuestId ? [route.boardQuestId] : []),
    ...(route.boardQuestIds ?? []),
  ]),
];

import { localClock } from "../clock";
import { scheduledSlots } from "../../shared/member-schedule";
import { startSchedules } from "../member-schedules";
import { moveTime } from "../../shared/time";
import { assertQuestTransition, transitionQuest, displayStage, nextNewsBy, storedPhase, partyFits, checksFit, approvedPartyReceipt } from "./quest-lifecycle";
import { keeperSubject, rangerOnlyPlan, settled, verifiedWaypoint, waypointCheck } from "../../shared/waypoint";
import { isCloseEffect, waiverWords } from "../../shared/closing";
import { assertUndoLane, readUndoLanes, undoAskProjection } from "../undo-record";
import { captureLegacyForwarding, currentAskNames, forwardedAskQuestion } from "../quest-names";

export class Keeper {
  settings: (questId?: string | null) => TavernSettings = () =>
    DEFAULT_SETTINGS;
  askOpened: (ask: Ask) => void = () => {};
  syncShellGrants: (threadId: string) => void = () => {};
  syncCommunication: (threadId: string, approvedAskId?: string) => void = () => {};
  assertDraftApprovalOpen: () => void = () => {};
  routineAskOpened: (ask: Ask) => Promise<void> = async () => {};
  readonly authority = new QuestAuthority(this);
  readonly memory = new KeeperMemory(this);
  memoryReviewPending: (threadId: string) => boolean = () => false;
  readonly succession: KeeperSuccessionStore;
  private readonly syncing = new Set<string>();
  constructor(
    readonly store: KeeperStore,
    readonly journal: JournalPort,
    readonly now = Date.now,
    private readonly invalidate: (tags: string[]) => void = () => {},
  ) { this.succession = new KeeperSuccessionStore(store, now); }
  changed(threadId?: string | null, questId?: string | null) {
    this.invalidate(this.changedTags(threadId, questId));
  }
  /** What changed() does short of signalling: syncs the Keeper's board mirrors and returns the tags made stale, for a caller that signals them itself. */
  changedTags(threadId?: string | null, questId?: string | null): string[] {
    const member = threadId ? this.member(threadId) : null;
    const keeperId = member?.keeperThreadId ?? threadId;
    const keepers = this.syncJournalBoard(keeperId, member);
    return [...new Set([
      tags.room(), tags.rows(), tags.attentionCount(),
      ...(threadId ? [tags.thread(threadId), tags.journal(threadId)] : []),
      ...[...keepers].flatMap(id => id ? [tags.thread(id)] : []),
      ...(questId ? this.questChangeTags(questId) : []),
    ])];
  }
  journalChangedTags(member: Member | null, linkedQuestIds: readonly string[]): string[] {
    const keeperId = member?.keeperThreadId ?? (member && isKeeperIdentity(this.store, member) ? member.threadId : null);
    const keepers = this.syncJournalBoard(keeperId, member);
    const memberQuestId = member?.boardQuestId;
    const quests = new Set([...linkedQuestIds, ...(memberQuestId ? [memberQuestId] : [])]);
    const stale = [...keepers].flatMap(id => id ? [tags.thread(id)] : []);
    if (member?.keeperThreadId && !memberQuestId) stale.push(tags.room());
    for (const id of quests) {
      const quest = this.store.get("quests", id);
      if (quest) stale.push(tags.thread(quest.keeperThreadId));
      const recordedInRoom = member?.keeperThreadId && id === memberQuestId && quest?.archivedAt == null;
      const shownOnBoard = quest && quest.archivedAt == null && quest.deletedAt == null;
      if (recordedInRoom || shownOnBoard) stale.push(tags.room());
      if (quest && linkedQuestIds.includes(id)) {
        if (quest.deletedAt != null) stale.push(tags.deletedQuests());
        else if (quest.archivedAt != null) stale.push(tags.archivedQuests());
      }
      stale.push(...this.questChangeTags(id));
    }
    return stale;
  }
  private questChangeTags(questId: string): string[] {
    return [tags.boardQuest(questId), ...this.store.query("members", "boardQuestId", questId).map(m => tags.thread(m.threadId))];
  }
  private syncJournalBoard(keeperId: string | null | undefined, member: Member | null) {
    const keepers = new Set([keeperId, ...(member?.leadLinkId ? [member.threadId] : [])]);
    for (const id of keepers) {
      if (!id || !isKeeperIdentity(this.store, this.member(id)) || this.syncing.has(id)) continue;
      this.syncing.add(id);
      try {
        this.journal.syncBoardQuests(id);
      } finally {
        this.syncing.delete(id);
      }
    }
    return keepers;
  }
  userAction(
    threadId: string,
    reason = "user action after manual-stop",
    force = false,
  ) {
    const member = this.member(threadId);
    const keeperId =
      member?.role === "keeper" ? threadId : member?.keeperThreadId;
    if (
      !keeperId ||
      (!force && this.store.runtime(keeperId).manualStopAt == null)
    )
      return;
    this.store.patch(keeperId, { manualStopAt: null });
    this.reanchor(keeperId, reason);
    this.store.patch(keeperId, { queuedTickResetId: randomUUID() });
  }
  member(threadId: string) {
    return this.store.get("members", threadId);
  }
  require(threadId: string, role: "keeper" | "member") {
    this.succession.assertMutable(threadId);
    const member = this.member(threadId);
    const keeper = isKeeperIdentity(this.store, member);
    if (!member || (role === "keeper" ? !keeper : member.role !== "member" || !!member.leadLinkId))
      throw new Error(`Only a Tavern ${role} may call this tool`);
    if (role === "keeper" && member.leadLinkId) {
      if (!isLiveKeeper(this.store, member)) throw new Error("This lead is not active.");
      assertLeadPathOpen(this.store, currentLead(this.store, member)!);
      const placement = new PlacementStore(this.store.db).byMember(threadId);
      if (placement && placement.phase !== "ready" && placement.phase !== "running")
        throw new Error("Call tavern_ready and finish placement before working on the lead's quest.");
    }
    return member;
  }
  resolveMemberName?: (member: Member) => string;
  name(member: Member): string {
    return this.resolveMemberName?.(member) ?? member.displayName ?? (member.classId.charAt(0).toUpperCase() + member.classId.slice(1));
  }
  resolvePartyMember(keeperThreadId: string, reference: string, includeArchived = false): Member {
    const party = this.store.all("members").filter(member => member.role === "member" && member.keeperThreadId === keeperThreadId);
    const direct = party.find(member => member.threadId === reference);
    if (direct) return direct;
    const live = includeArchived ? party : party.filter(member => hasLiveName(this.store, member));
    const matches = live.filter(member => this.name(member).toLowerCase() === reference.trim().toLowerCase());
    if (matches.length === 1) return matches[0]!;
    throw new Error(`${matches.length ? "Ambiguous" : "Unknown"} member name in your own party. Members: ${live.map(member => `${this.name(member)} (${member.classId})`).join(", ") || "none"}.`);
  }
  bind(
    threadId: string,
    classId: string,
    characterId: string | null,
    projectId: string,
    owner?: {
      keeperThreadId: string;
      boardQuestId: string | null;
      waypointId: string | null;
      errand: boolean;
      title: string;
      displayName?: string;
      checkIndependence?: Member["checkIndependence"];
      guardPosture?: Member["guardPosture"];
      reviewTarget?: ReviewTarget;
      requestSources?: RequestSources;
      assignmentText?: string;
      brief: Brief;
    },
    bindingId?: string,
    kind = classId === "keeper" ? "keeper" : "member",
  ) {
    const hire = owner && bindingId ? this.store.get("hires", bindingId) : null;
    const existing = this.member(threadId);
    if (existing) {
      if (hire?.leadLinkId && (existing.leadLinkId !== hire.leadLinkId || hire.memberThreadId !== threadId))
        throw new Error("The lead hire is already bound or the thread has another identity.");
      if (hire?.replacesThreadId && hire.memberThreadId !== threadId)
        throw new Error("The replacement reservation does not own this thread.");
      return existing;
    }
    const state = "idle";
    let permanent = hire?.permanent;
    const permanentDecision = permanent && this.store.get("decisions", permanent.decisionId);
    if (permanent && owner?.boardQuestId && permanentDecision && !permanentDecision.undone) {
      // Read at bind: users can pause or remove schedules while a reserved hire is starting.
      const prior = this.store.latestPermanentOccupant(owner.boardQuestId, permanent.decisionId)?.permanent;
      if (prior) permanent = { ...permanent, schedules: prior.schedules };
    }
    const m: Member = {
      ...(permanentDecision && !permanentDecision.undone ? { permanent } : {}),
      threadId,
      classId,
      characterId,
      ...(owner?.displayName ? { displayName: owner.displayName } : {}),
      ...(owner?.checkIndependence ? { checkIndependence: owner.checkIndependence } : {}),
      ...(owner?.guardPosture ? { guardPosture: owner.guardPosture } : {}),
      role: owner ? "member" : kind === "keeper" ? "keeper" : "solo",
      ...(hire?.leadLinkId ? { leadLinkId: hire.leadLinkId } : {}),
      keeperThreadId: owner?.keeperThreadId ?? null,
      boardQuestId: owner?.boardQuestId ?? null,
      waypointId: owner?.waypointId ?? null,
      checkerWaypointId:
        classId === "warden" ? (owner?.waypointId ?? null) : null,
      ...(classId === "warden" && owner?.reviewTarget ? { checkerMakerThreadId: owner.reviewTarget.makerThreadId } : {}),
      errand: owner?.errand ?? false,
      title: owner?.title ?? null,
      state,
      doing: owner?.brief.outcome ?? null,
      createdAt: this.now(),
      lastActiveAt: this.now(),
      lastReportAt: null,
      strikes: 0,
      verifiedWins: 0,
    };
    this.store.atomic(() => {
      if (m.role === "keeper") this.store.put("members", threadId, m);
      else {
        if (!bindingId) throw new Error("Binding a member requires its hire or class-start receipt");
        if (owner) transitionMember(this.store, m, "briefing", "bind-hire", { kind: "agent", threadId: owner.keeperThreadId }, { kind: "hire", id: bindingId }, this.now());
        else transitionMember(this.store, m, "active", "bind-solo", { kind: "user" }, { kind: "class-start", id: bindingId }, this.now());
      }
      if (hire?.leadLinkId) {
        bindLead(this, bindingId!, hire.leadLinkId, m);
        this.store.put("hires", bindingId!, { ...hire, memberThreadId: threadId });
      }
      if (hire?.replacesThreadId) {
        const previous = this.member(hire.replacesThreadId);
        const replacement = memberDetails(this.store, hire.replacesThreadId).replacement;
        if (!previous || !wasReleased(previous) || !replacement || replacement.threadId ||
            previous.keeperThreadId !== m.keeperThreadId || previous.boardQuestId !== m.boardQuestId ||
            previous.waypointId !== m.waypointId || previous.classId !== m.classId)
          throw new Error("The replacement no longer matches its released member.");
        this.store.put("hires", bindingId!, { ...hire, memberThreadId: threadId });
        patchMemberDetails(this.store, previous.threadId, { replacement: { ...replacement, threadId } });
        this.store.event(this.now(), m.keeperThreadId, m.boardQuestId, "member.replaced",
          `Replaced ${this.name(previous)} with ${this.name(m)}: ${replacement.reason}`,
          { memberThreadId: previous.threadId, replacementThreadId: threadId, waypointId: m.waypointId, reason: replacement.reason },
          { kind: "agent", threadId: hire.owner.keeperThreadId });
      }
      this.store.patch(threadId, { projectId, brief: owner?.brief ?? null, reviewTarget: owner?.reviewTarget ?? null, requestSources: owner?.requestSources ?? null, assignmentText: owner?.assignmentText ?? null, ...(owner ? { clusterSessionPending: true } : {}) });
    });
    this.changed(threadId, m.boardQuestId);
    return this.member(threadId)!;
  }
  assertQuestNotHeld(id: string) {
    const quest = this.quest(id);
    if (quest.phase === "held") throw new Error(`${quest.title} is held by you since ${localClock(quest.held!.since)}; resume it first.`);
  }
  private questActReceipt(quest: BoardQuest, actor: Actor, messageId: string | undefined, act: "hold" | "resume" | "reopen") {
    if (actor.kind === "user") {
      if (act === "reopen") throw new Error("Reopening is user-in-words; cite the user’s own routed message for this quest.");
      authorize(act === "hold" ? "holdBoardQuest" : "resumeBoardQuest", { level: "user-explicit", receipt: "quest-page" });
      return { kind: "user-act", id: this.store.id("act"), surface: "client (unattested)", at: this.now() };
    }
    if (actor.kind !== "agent" || !messageId) throw new Error("Cite the user's own routed message for this quest");
    this.owned(actor.threadId, quest.id);
    const route = this.store.db.prepare("SELECT data FROM tavern_records WHERE kind='routes' AND json_extract(data,'$.keeperThreadId')=? AND json_extract(data,'$.sourceMessageId')=?").all(actor.threadId, messageId) as { data: string }[];
    const routed = route.map(row => JSON.parse(row.data) as Route).some(route => routeQuestIds(route).includes(quest.id) && !route.classSelectionOnly);
    const message = this.store.messageReceipt(actor.threadId, messageId, true);
    if (!routed || !message) throw new Error("Cite the user's own routed message for this quest");
    if (this.store.db.prepare("SELECT 1 FROM tavern_events WHERE json_extract(data,'$.receipt.kind')='user-message' AND json_extract(data,'$.receipt.id')=?").get(messageId)) throw new Error("This message is already a lifecycle receipt");
    if (this.store.db.prepare("SELECT 1 FROM tavern_events WHERE type='route.cancelled' AND json_extract(data,'$.receiptId')=?").get(messageId)) throw new Error("This message was cancelled");
    const last = this.store.db.prepare("SELECT at FROM tavern_events WHERE board_quest_id=? AND json_type(data,'$.phase')='object' ORDER BY id DESC LIMIT 1").get(quest.id) as { at: number } | undefined;
    const legacy = !last ? this.store.db.prepare(`SELECT e.at FROM tavern_events e WHERE e.board_quest_id=? AND
      (e.type IN ('quest.opened','plan.proposed','quest.phase','quest.stopping','quest.stopped','quest.wrapped','quest.reopened') OR
       e.type='ask.answered' AND json_extract(e.data,'$.optionId')='approve' AND EXISTS
       (SELECT 1 FROM tavern_records a WHERE a.kind='asks' AND a.id=json_extract(e.data,'$.askId') AND json_extract(a.data,'$.kind')='greenlight'))
      ORDER BY e.id DESC LIMIT 1`).get(quest.id) as { at: number } | undefined : undefined;
    if (message.at <= (last?.at ?? legacy?.at ?? quest.updatedAt)) throw new Error("Cite a user message newer than the last quest phase transition");
    authorize(act === "reopen" ? "reopenQuest" : act === "hold" ? "holdQuestFromMessage" : "resumeQuestFromMessage", { level: "user-in-words", receipt: messageId });
    return { kind: "user-message", id: messageId, text: message.text };
  }
  setQuestHeld(id: string, hold: boolean, actor: Actor, messageId?: string) {
    const result = this.store.atomic(() => {
      const quest = this.quest(id);
      const receipt = this.questActReceipt(quest, actor, messageId, hold ? "hold" : "resume");
      const to = hold ? "held" : quest.held?.from;
      if (!to) throw new Error("This quest is not held");
      return transitionQuest(this.store, quest, to, hold ? "hold" : "resume", actor, receipt, this.now());
    });
    this.userAction(result.keeperThreadId);
    this.changed(result.keeperThreadId, id);
    return result;
  }
  quest(id: string) {
    const q = this.store.get("quests", id);
    if (!q) throw new Error(`Unknown board quest: ${id}`);
    return { ...q, phase: storedPhase(q.phase) };
  }
  archiveQuests(
    ids: string[],
    archived: boolean,
    actor: Actor,
  ) {
    const quests = [...new Set(ids)].map((id) => this.quest(id));
    if (quests.some(q => q.deletedAt != null)) throw new Error("Restore deleted quests to the cellar before bringing them up.");
    if (quests.some((q) => !["done", "stopped"].includes(q.phase)))
      throw new Error(
        "Only done or stopped board quests can be archived or restored",
      );
    const changed = this.store.atomic(() =>
      quests.filter((q) => {
        if ((q.archivedAt !== null) === archived) return false;
        this.store.put("quests", q.id, {
          ...q,
          archivedAt: archived ? this.now() : null,
          updatedAt: this.now(),
        });
        this.store.event(
          this.now(),
          q.keeperThreadId,
          q.id,
          archived ? "quest.archived" : "quest.restored",
          `${archived ? "Archived" : "Restored"} ${q.title}`,
          {},
          actor,
        );
        return true;
      }),
    );
    for (const q of changed) {
      this.changed(q.keeperThreadId, q.id);
    }
    if (changed.length) this.invalidate([tags.mapHistory()]);
    return changed.length;
  }
  deleteQuest(id: string, actor: Actor) {
    const q = this.quest(id);
    if (!["done", "stopped"].includes(q.phase)) throw new Error("Only done or stopped board quests can be deleted");
    if (q.deletedAt != null) return false;
    this.store.atomic(() => {
      this.store.put("quests", id, { ...q, archivedAt: q.archivedAt ?? this.now(), deletedAt: this.now(), updatedAt: this.now() });
      this.store.event(this.now(), q.keeperThreadId, id, "quest.deleted", `Deleted ${q.title}; restorable from the cellar`, {}, actor);
    });
    this.changed(q.keeperThreadId, id);
    this.invalidate([tags.mapHistory(), tags.registry(), tags.deletedQuestCount()]);
    return true;
  }
  restoreDeletedQuest(id: string, actor: Actor) {
    const q = this.quest(id);
    if (q.deletedAt == null) return false;
    this.store.atomic(() => {
      this.store.put("quests", id, { ...q, deletedAt: null, archivedAt: q.archivedAt ?? this.now(), updatedAt: this.now() });
      this.store.event(this.now(), q.keeperThreadId, id, "quest.delete-restored", `Restored ${q.title} to the cellar`, {}, actor);
    });
    this.changed(q.keeperThreadId, id);
    this.invalidate([tags.mapHistory(), tags.registry(), tags.deletedQuestCount()]);
    return true;
  }
  /** A returned or stopped quest reopens for deviations; an archived one must be brought up from the cellar first. */
  reopenQuest(id: string, actor: Actor, messageId?: string): BoardQuest {
    const q = this.quest(id);
    if (q.deletedAt != null) throw new Error("A deleted board quest is in the cellar; bring it back before re-opening it");
    if (q.archivedAt != null) throw new Error("An archived board quest cannot be re-opened; bring it up from the cellar first");
    if (!["done", "stopped"].includes(q.phase)) throw new Error("Only a returned or stopped board quest can be re-opened");
    const reopened: BoardQuest = {
      ...q,
      endedAt: null,
      archivedAt: null,
      stopReason: null,
      stoppingSince: null,
      updatedAt: this.now(),
    };
    this.store.atomic(() => {
      transitionQuest(this.store, q, q.greenlitVersion === null ? "scout" : "build", "reopen", actor, this.questActReceipt(q, actor, messageId, "reopen"), this.now(), { patch: reopened, text: `Re-opened ${q.title} for deviations`, data: { planVersion: q.planVersion } });
    });
    this.changed(q.keeperThreadId, id);
    this.invalidate([tags.mapHistory()]);
    this.reanchor(q.keeperThreadId, "quest reopened for deviations");
    return this.quest(id);
  }
  owned(threadId: string, id: string) {
    this.require(threadId, "keeper");
    const q = this.quest(id);
    if (q.keeperThreadId !== threadId)
      throw new Error("A Keeper may change only its own board quests");
    return q;
  }
  liveQuest(threadId: string, id: string) {
    const quest = this.owned(threadId, id);
    if (!isOpenQuest(quest)) throw new Error("This board quest has ended or is stopping");
    return quest;
  }
  applicableRoutes(threadId: string) {
    const runtime = this.store.runtime(threadId);
    const ids =
      runtime.routes?.map((route) => route.id) ??
      (runtime.lastRouteId ? [runtime.lastRouteId] : []);
    return ids.flatMap((id) => {
      const route = this.store.get("routes", id);
      return route ? [route] : [];
    });
  }
  resetRoutes(threadId: string) {
    const routes = (this.store.runtime(threadId).routes ?? []).filter(
      (route) => route.pending,
    );
    this.store.patch(threadId, {
      routes,
      lastRouteId: routes.at(-1)?.id ?? null,
    });
  }
  guard(threadId: string, questId: string | null) {
    this.succession.assertMutable(threadId);
    const runtime = this.store.runtime(threadId);
    const questRoutes = this.applicableRoutes(threadId).filter(
      (route) => route.kind === "steer" || route.kind === "new-quest",
    );
    if (questId !== null && questRoutes.some((route) => routeQuestIds(route).includes(questId)))
      return;
    if (runtime.pending.length)
      throw new Error(
        `Route the oldest unrouted user message before changing a board quest: ${JSON.stringify(runtime.pending[0]!.text.slice(0, 300))}. No change was applied by this request.`, 
      );
    if (questRoutes.length && questId !== null)
      throw new Error("The current routes do not name this board quest");
  }
  receiveUser(
    threadId: string,
    text: string,
    hint: string | null = null,
    rowId?: string,
    at = this.now(),
    accepted = true,
    openingGoal = false,
    classSelectionOnly = false,
  ) {
    const member = this.member(threadId);
    if (!member || !text.trim()) return;
    const keeper = isKeeperIdentity(this.store, member);
    this.store.atomic(() => {
      if (openingGoal && !classSelectionOnly && keeper && !this.store.runtime(threadId).openingGoal)
        this.store.patch(threadId, { openingGoal: { text, at } });
      const receipt = this.store.receipt(threadId, text, at, rowId, accepted);
      const runtime = this.store.runtime(threadId);
      if (accepted && keeper) {
        const clearFailureAsk = (runtime.failureCount ?? 0) < 2;
        if (clearFailureAsk && runtime.failureAskId) this.withdrawAsk(runtime.failureAskId, "turn-recovered");
        this.store.patch(threadId, { tickRefusalCount: 0, tickRetryAt: null, ...(clearFailureAsk ? { failureAskId: null } : {}) });
      }
      const quietSince = this.store.runtime(
        member.keeperThreadId ?? threadId,
      ).manualStopAt;
      if (
        accepted &&
        quietSince != null &&
        at >= quietSince &&
        (receipt.fresh || at > quietSince)
      ) {
        this.userAction(threadId, "manual-stop; user resumed");
      }
      if (!receipt.fresh) {
        this.store.patch(threadId, {
          pending: runtime.pending.map((p) =>
            p.id === receipt.id
              ? {
                  ...p,
                  ...(classSelectionOnly ? { classSelectionOnly: true } : {}),
                  accepted,
                  ...(accepted
                    ? { acceptedAt: p.acceptedAt ?? this.now() }
                    : {}),
                }
              : p,
          ),
          routes: runtime.routes?.map((route) =>
            route.receiptId === receipt.id && accepted
              ? {
                  ...route,
                  pending: false,
                  acceptedAt: route.acceptedAt ?? this.now(),
                }
              : route,
          ),
        });
        if (
          accepted &&
          runtime.routes?.some((route) => route.receiptId === receipt.id)
        )
          this.store.finishReceipt(receipt.id);
        return;
      }
      const pending = {
        id: receipt.id,
        accepted,
        acceptedAt: accepted ? this.now() : undefined,
        text,
        at,
        key: messageKey(text),
        hint,
        ...(classSelectionOnly ? { classSelectionOnly: true } : {}),
      };
      this.store.patch(threadId, {
        userAt: this.now(),
        typingAt: null,
        ...(keeper
          ? { pending: [...runtime.pending, pending] }
          : {}),
      });
      this.store.event(
        at,
        keeper ? threadId : member.keeperThreadId ?? threadId,
        keeper ? null : member.boardQuestId,
        !keeper && member.role === "member" ? "user.told-member" : "user.message",
        !keeper && member.role === "member"
          ? `You told ${this.name(member)}: ${text}`
          : text,
        { receiptId: receipt.id, rowId, hint },
        { kind: "user" },
      );
    });
    this.changed(threadId, member.boardQuestId);
  }
  openingGoalHint(threadId: string) {
    if (this.store.runtime(threadId).pending[0]?.classSelectionOnly)
      return "No goal was supplied: this message only selects the Keeper class. Route it as aside, briefly acknowledge and ask what the user wants done. Do not open a placeholder quest.";
    const goal = this.store.runtime(threadId).openingGoal;
    if (!goal || this.store.query("quests", "keeperThreadId", threadId, 1).length) return null;
    const text = goal.text.length > 1000
      ? `${goal.text.slice(0, 1000)} [More: read the original opening user message]`
      : goal.text;
    return `If this opening message contains a concrete user goal, route it with tavern_route kind new-quest, then call tavern_quest. The goal itself is never a note. A class selection, greeting or question does not open a quest.\nOpening message (quoted data): ${JSON.stringify(text)}`;
  }
  cancelUser(threadId: string, rowId: string) {
    const id = this.store.messageId(rowId);
    if (!id) return;
    const runtime = this.store.runtime(threadId);
    const member = this.member(threadId);
    this.store.atomic(() => {
      this.store.finishReceipt(id);
      const routes = runtime.routes?.filter((route) => route.receiptId !== id);
      this.store.patch(threadId, {
        pending: runtime.pending.filter((p) => p.id !== id),
        routes,
        ...(routes ? { lastRouteId: routes.at(-1)?.id ?? null } : {}),
      });
      this.store.event(
        this.now(),
        member?.keeperThreadId ?? threadId,
        member?.boardQuestId ?? null,
        "route.cancelled",
        "The user cancelled a queued message; do not apply it.",
        { rowId, receiptId: id, threadId },
        { kind: "user" },
      );
    });
    this.changed(threadId, member?.boardQuestId);
  }
  endTurn(threadId: string, endedAt = Infinity, interruptedAt?: number) {
    const runtime = this.store.runtime(threadId);
    const belongsToTurn = (pending: (typeof runtime.pending)[number]) =>
      interruptedAt === undefined && pending.accepted !== false &&
      (pending.acceptedAt ?? pending.at) < endedAt;
    const routes = (runtime.routes ?? []).filter(route => {
      if (route.pending) return true;
      if (interruptedAt === undefined) return (route.acceptedAt ?? 0) >= endedAt;
      const recordedAt = this.store.get("routes", route.id)?.createdAt ?? 0;
      return Math.max(route.acceptedAt ?? 0, recordedAt) >= interruptedAt;
    });
    this.store.atomic(() => {
      for (const pending of runtime.pending.filter(belongsToTurn)) {
        this.store.finishReceipt(pending.id);
        this.store.event(
          this.now(),
          threadId,
          null,
          "route.missed",
          "The preceding user message was not routed.",
          { text: pending.text, receiptId: pending.id },
        );
      }
      this.store.patch(threadId, {
        pending: runtime.pending.filter((pending) => !belongsToTurn(pending)),
        routes,
        lastRouteId: routes.at(-1)?.id ?? null,
      });
    });
  }
  activeCheckerHolds(threadId: string) {
    return this.store.checkerHeldQuests(threadId).filter(quest => quest.phase !== "held");
  }
  checkerHandoffProblem(classId: string, questId: string | null | undefined): string | null {
    if (classId !== "warden" || !questId) return null;
    const quest = this.quest(questId);
    if (!isOpenQuest(quest) || !quest.checkerHandoffHold || quest.checkerHandoffHold.release !== null) return null;
    return `Checker handoff for “${quest.title}”. Held until the user releases it from the Tavern page or by answering the hold's ask. You cannot release it; tell the user what is waiting.`;
  }
  assertCheckerHandoff(classId: string, questId: string | null | undefined) {
    const problem = this.checkerHandoffProblem(classId, questId);
    if (problem) throw new Error(`Not handed off: ${problem}`);
  }
  private checkerHoldFromRoute(route: Route): CheckerHandoffHold {
    if (!route.checkerHandoffHold || !route.sourceMessageId) throw new Error("A checker-handoff hold needs its user source receipt");
    const text = this.store.messageText(route.sourceMessageId);
    if (text === undefined) throw new Error("The checker-handoff hold's user source receipt is missing");
    return { id: this.store.id("hold"), routeId: route.id, sourceMessageId: route.sourceMessageId,
      sourceText: text.slice(0, 2000), reason: route.checkerHandoffHold.reason, createdAt: this.now(), release: null };
  }
  releaseCheckerHandoff(questId: string, holdId: string, via: NonNullable<CheckerHandoffHold["release"]>["via"], askId: string | null = null) {
    const quest = this.quest(questId);
    this.liveQuest(quest.keeperThreadId, questId);
    const hold = quest.checkerHandoffHold;
    if (!hold || hold.id !== holdId) throw new Error("This checker-handoff hold is no longer current; read the quest again");
    if (hold.release !== null) return hold;
    const released: CheckerHandoffHold = { ...hold, release: { at: this.now(), via, askId } };
    this.store.atomic(() => {
      this.store.put("quests", questId, { ...quest, checkerHandoffHold: released, updatedAt: this.now() });
      for (const ask of this.store.openAsks(quest.keeperThreadId, questId))
        if (ask.releaseHoldId === holdId && ask.id !== askId) this.withdrawAsk(ask.id, "turn-recovered");
      this.store.event(this.now(), quest.keeperThreadId, questId, "checker-handoff.released", `You released the checker handoff for ${quest.title}`, { holdId, askId, via }, { kind: "user" });
    });
    this.userAction(quest.keeperThreadId);
    this.reanchor(quest.keeperThreadId, "user released the checker handoff");
    this.changed(quest.keeperThreadId, questId);
    return released;
  }
  renameQuest(id: string, input: Pick<BoardQuest, "title" | "short">, actor: Extract<Actor, { kind: "agent" | "user" }>, receipt?: UserActReceipt) {
    const quest = actor.kind === "agent" ? this.owned(actor.threadId, id) : this.quest(id);
    if (quest.archivedAt !== null || quest.deletedAt != null) throw new Error("Restore this archived or deleted quest from the cellar before renaming it.");
    if (actor.kind === "agent") this.guard(actor.threadId, id);
    const to = questNamesSchema.parse(input);
    if (quest.title === to.title && quest.short === to.short) return quest;
    const at = this.now();
    const next = { ...quest, ...to, updatedAt: at };
    const related = new Set([tags.mapHistory(), tags.settings()]);
    for (const link of leadAncestors(this.store, id)) {
      related.add(tags.boardQuest(link.parentQuestId));
      related.add(tags.thread(link.parentKeeperThreadId));
    }
    for (const link of leadDescendants(this.store, id)) {
      if (link.childQuestId) related.add(tags.boardQuest(link.childQuestId));
      if (link.childKeeperThreadId) related.add(tags.thread(link.childKeeperThreadId));
    }
    const stale = this.store.atomic(() => {
      if (quest.short !== to.short) captureLegacyForwarding(this.store, quest);
      this.store.put("quests", id, next);
      if (this.store.renameQuestCreditLabels(id, to)) related.add(tags.registry());
      this.store.event(at, quest.keeperThreadId, id, "quest.renamed", `Renamed “${quest.title}” to “${to.title}”`, {
        from: { title: quest.title, short: quest.short }, to, ...(receipt ? { receipt } : {}),
      }, actor);
      return this.changedTags(quest.keeperThreadId, id);
    });
    this.invalidate([...new Set([...stale, ...related])]);
    return next;
  }
  async openQuest(threadId: string, title: string, short: string) {
    const member = this.require(threadId, "keeper");
    await this.journal.prepare(threadId);
    this.require(threadId, "keeper");
    const link = currentLead(this.store, member);
    if (link?.childQuestId) return this.quest(link.childQuestId);
    const route = link ? null : this.applicableRoutes(threadId)
      .filter(
        (route) => route.kind === "new-quest" && route.boardQuestId === null,
      )
      .at(-1)?.id;
    const source = route ? this.store.get("routes", route) : null;
    if (!link) {
      if (!source) throw new Error("Opening a board quest requires an unbound new-quest route from an accepted user message. Ask for the goal; never open a placeholder.");
      const receipt = source.sourceMessageId && this.store.messageReceipt(threadId, source.sourceMessageId, true);
      if (!receipt || source.classSelectionOnly) throw new Error("The new-quest route needs its genuine accepted user receipt containing a goal; class selection is not a goal.");
      authorize("openQuest", { level: "user-in-words", receipt: source.sourceMessageId! });
    }
    const q: BoardQuest = {
      id: this.store.id("quest"),
      keeperThreadId: threadId,
      title,
      short,
      phase: "scout",
      planVersion: 0,
      greenlitVersion: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      endedAt: null,
      archivedAt: null,
      ...(route && this.store.get("routes", route)?.checkerHandoffHold ? { checkerHandoffHold: this.checkerHoldFromRoute(this.store.get("routes", route)!) } : {}),
    };
    this.store.atomic(() => {
      transitionQuest(this.store, q, "scout", link ? "open-lead" : "open", { kind: "agent", threadId },
        link ? { kind: "hire", id: link.hireToken } : { kind: "user-message", id: source!.sourceMessageId! }, this.now(), { text: `Opened ${title}` });
      if (link) saveLead(this, { ...link, childQuestId: q.id }, "lead.opened", { kind: "agent", threadId });
      const routed = route ? this.store.get("routes", route) : null;
      if (routed?.kind === "new-quest" && routed.boardQuestId === null)
        this.store.put("routes", routed.id, {
          ...routed,
          boardQuestId: q.id,
          boardQuestIds: [q.id],
        });
      this.journal.edit(
        threadId,
        {
          op: "add",
          descriptions: [`Quest: ${title} (${q.id})`],
          parentId: null,
        },
        { kind: "agent", threadId },
      );
    });
    this.changed(threadId, q.id);
    return q;
  }
  route(
    threadId: string,
    input: {
      kind: Route["kind"];
      boardQuestId?: string | null;
      boardQuestIds?: string[];
      summary: string;
      notes?: NoteDraft[];
      checkerHandoffHold?: { reason: string };
    },
  ) {
    this.require(threadId, "keeper");
    const boardQuestIds = routeQuestIds({
      boardQuestId: input.boardQuestId ?? null,
      boardQuestIds: input.boardQuestIds,
    });
    const boardQuestId = boardQuestIds[0] ?? null;
    this.validateRoute(threadId, input.kind, boardQuestId, boardQuestIds);
    if (input.checkerHandoffHold) {
      checkerHandoffHoldDraftSchema.parse(input.checkerHandoffHold);
      if (!["new-quest", "steer"].includes(input.kind)) throw new Error("A checker-handoff hold must accompany a new quest or a steer naming its quest");
    }
    const rt = this.store.runtime(threadId);
    const message = rt.pending[0];
    if (!message) throw new Error("No unrouted user message");
    if (message.classSelectionOnly && !["aside", "question"].includes(input.kind)) throw new Error("A class selection is setup, not a goal. Route it as aside and ask what the user wants done; no quest was opened.");
    if (!message.classSelectionOnly && message.hint && input.kind !== message.hint)
      throw new Error(
        `The user explicitly chose ${message.hint}; record that route kind. Only a user route correction may override it.`,
      );
    const route = routeSchema.parse({
      id: this.store.id("route"),
      keeperThreadId: threadId,
      messageKey: message.key,
      messageAt: message.at,
      userText: message.text.slice(0, 200),
      sourceMessageId: message.id ?? null,
      ...input,
      ...(message.classSelectionOnly ? { classSelectionOnly: true } : {}),
      boardQuestId,
      boardQuestIds,
      corrected: false,
      createdAt: this.now(),
    });
    this.store.atomic(() => {
      if (message.accepted !== false) this.store.finishReceipt(message.id);
      this.store.put("routes", route.id, route);
      if (route.checkerHandoffHold) {
        for (const id of boardQuestIds) {
          const quest = this.liveQuest(threadId, id);
          if (quest.checkerHandoffHold && quest.checkerHandoffHold.release === null) continue;
          const hold = this.checkerHoldFromRoute(route);
          this.store.put("quests", id, { ...quest, checkerHandoffHold: hold, updatedAt: this.now() });
          this.store.event(this.now(), threadId, id, "checker-handoff.held", `Checker handoff held for ${quest.title}`, { holdId: hold.id, routeId: route.id });
        }
      }
      this.store.patch(threadId, {
        pending: rt.pending.slice(1),
        lastRouteId: route.id,
        routes: [
          ...(rt.routes ?? []),
          {
            id: route.id,
            receiptId: message.id,
            pending: message.accepted === false,
            acceptedAt: message.acceptedAt,
          },
        ],
      });
      for (const note of input.notes ?? [])
        this.memory.note(threadId, note, {
          sourceMessageId: message.id ?? null,
          routeId: route.id,
        });
      this.store.event(
        this.now(),
        threadId,
        boardQuestId,
        "route.recorded",
        input.summary,
        {
          routeId: route.id,
          kind: route.kind,
          boardQuestIds,
        },
      );
    });
    for (const id of boardQuestIds.length ? boardQuestIds : [null]) this.changed(threadId, id);
    return route;
  }
  validateRoute(
    threadId: string,
    kind: Route["kind"],
    questId: string | null,
    questIds: string[] = questId ? [questId] : [],
  ) {
    if ((kind === "aside" || kind === "question") && questId)
      throw new Error("Asides and questions must not name a board quest");
    if (kind === "steer" && !questId)
      throw new Error("A steer must name a board quest");
    for (const id of questIds) {
      if (kind === "steer") {
        const quest = this.owned(threadId, id);
        if (quest.phase === "stopping") throw new Error("This board quest is stopping");
      } else if (kind === "new-quest") this.liveQuest(threadId, id);
      else this.owned(threadId, id);
    }
  }
  correctRoute(
    routeId: string,
    kind: Route["kind"],
    boardQuestId: string | null,
    boardQuestIds: string[] = [],
  ) {
    const r = this.store.get("routes", routeId);
    if (!r) throw new Error("Unknown route");
    const ids = routeQuestIds({ boardQuestId, boardQuestIds });
    boardQuestId = ids[0] ?? null;
    this.validateRoute(r.keeperThreadId, kind, boardQuestId, ids);
    if (kind === "new-quest" && !boardQuestId)
      throw new Error("A corrected new-quest route must name its board quest");
    this.store.atomic(() => {
      this.store.put("routes", r.id, {
        ...r,
        kind,
        boardQuestId,
        boardQuestIds: ids,
        corrected: true,
      });
      this.store.event(
        this.now(),
        r.keeperThreadId,
        boardQuestId,
        "route.corrected",
        `Read the message as ${kind}${boardQuestId ? ` for ${boardQuestId}` : ""}. Reconcile any earlier changes; do not silently discard them.`,
        { routeId, previousBoardQuestId: r.boardQuestId },
      );
    });
    const affected = new Set([...ids, ...routeQuestIds(r)]);
    for (const id of affected.size ? affected : [null]) this.changed(r.keeperThreadId, id);
  }
  plan(threadId: string, input: PlanInput) {
    const q = this.owned(threadId, input.boardQuestId);
    this.assertQuestNotHeld(q.id);
    if (!isOpenQuest(q)) throw new Error("This board quest has ended or is stopping");
    const r = input.fromSteer
      ? this.store.get("routes", input.fromSteer)
      : null;
    if (
      input.fromSteer &&
      (!r ||
        r.kind !== "steer" ||
        !routeQuestIds(r).includes(q.id) ||
        r.keeperThreadId !== threadId ||
        !this.applicableRoutes(threadId).some((route) => route.id === r.id))
    )
      throw new Error(
        "fromSteer must name an applicable, unexpired steer route for this quest",
      );
    this.guard(threadId, q.id);
    const plan = planSchema.parse({
      ...input,
      version: q.planVersion + 1,
      createdAt: this.now(),
      fromSteer: r ? { routeId: r.id, at: r.messageAt, text: (r.sourceMessageId && this.store.messageText(r.sourceMessageId) || r.userText || r.summary).slice(0, 300) } : null,
    });
    assertChainPlan(this, q, plan);
    const ids = new Set(plan.waypoints.map((w) => w.id));
    if (
      ids.size !== plan.waypoints.length ||
      plan.waypoints.some((w) => w.dependsOn.some((id) => !ids.has(id)))
    )
      throw new Error("Waypoints need unique ids and valid dependencies");
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("Waypoint dependency cycle");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of plan.waypoints.find((w) => w.id === id)!.dependsOn)
        visit(dep);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id);
    const previous = q.planVersion > 0 ? this.store.get("plans", `${q.id}:${q.planVersion}`) : null;
    const approved = q.greenlitVersion === null ? null : this.store.get("plans", `${q.id}:${q.greenlitVersion}`);
    const priorSlots = new Map([...approved?.party ?? [], ...previous?.party ?? []].flatMap(slot => {
      const id = slot.permanent?.decisionId;
      return id && !this.store.get("decisions", id)?.undone ? [[id, slot] as const] : [];
    }));
    for (const slot of plan.party) {
      if (!slot.permanent) continue;
      const candidates = [...priorSlots].filter(([, candidate]) => candidate.classId === slot.classId &&
        candidate.characterId === slot.characterId && candidate.permanent!.why === slot.permanent!.why &&
        isDeepStrictEqual(candidate.permanent!.schedules, slot.permanent!.schedules));
      const prior = candidates.find(([, candidate]) => isDeepStrictEqual([...candidate.waypointIds].sort(), [...slot.waypointIds].sort())) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      slot.permanent = { ...slot.permanent, decisionId: prior?.[0] };
      if (prior) priorSlots.delete(prior[0]);
    }
    const checkPlan = this.store.get("plans", `${q.id}:${q.checkPlanVersion ?? q.greenlitVersion}`);
    let previousWaypoints: BoardQuestSummary["waypoints"] | undefined;
    const weakensChecks = !!checkPlan && !checksFit(plan, checkPlan, approved, waypointId => {
      previousWaypoints ??= this.summary(q.id, checkPlan.version).waypoints;
      return previousWaypoints.some(w => w.id === waypointId && settled(w));
    });
    const steer = weakensChecks && r ? this.checkSteer(q, r) : null;
    const leadPath = leadAncestors(this.store, q.id);
    const previousBudget = this.store.get("plans", `${q.id}:${q.planVersion}`)?.spendBudgetCents;
    const carriesPendingBudget = q.phase === "greenlight" && q.spendProposal?.planVersion === q.planVersion && q.spendProposal.cents === plan.spendBudgetCents;
    const proposesBudget = plan.spendBudgetCents !== undefined && (plan.spendBudgetCents !== previousBudget || carriesPendingBudget) && plan.spendBudgetCents !== q.spendBudget?.cents && !q.spendBudget?.reached;
    const spendProposal = proposesBudget ? { planVersion: plan.version, cents: plan.spendBudgetCents! }
      : plan.spendBudgetCents !== undefined && plan.spendBudgetCents === previousBudget ? q.spendProposal : null;
    const rangers = rangerOnlyPlan(plan);
    const needsGreenlight = leadPath.length > 0 || !rangers && (approved === null || !partyFits(plan, approved)) || weakensChecks && !steer || proposesBudget;
    const automatic =
      needsGreenlight && !weakensChecks && !leadPath.length && !plan.party.some(slot => slot.leadEnvelope || slot.permanent) &&
      this.settings().keepers.greenlight === "by-size" &&
      plan.reversible &&
      plan.party.length === 1 &&
      !plan.questions.length &&
      !plan.waypoints.some((w) => w.actor !== "agent") &&
      !this.store.openAsks(threadId).length;
    this.store.atomic(() => {
      for (const [index, slot] of plan.party.entries()) {
        if (!slot.permanent || slot.permanent.decisionId) continue;
        const decision = this.decide(threadId, {
          boardQuestId: q.id, text: `Proposed permanent party slot ${index + 1} (${slot.characterId ?? slot.classId}) in plan v${plan.version}`.slice(0, 400),
          why: slot.permanent.why, reversible: true, source: "keeper",
        }, undefined, { permanentChange: "slot" });
        slot.permanent.decisionId = decision.id;
      }
      const diff = previous && planDiff(previous, plan);
      if (previous && diff) this.carryWaypointAcceptances(q, plan, diff);
      this.store.put("plans", `${q.id}:${plan.version}`, plan);
      const updated = { ...q, planVersion: plan.version, ...(spendProposal || q.spendProposal ? { spendProposal: spendProposal ?? null } : {}), ...(leadPath.length ? { greenlitVersion: null, checkPlanVersion: undefined } : !needsGreenlight ? { checkPlanVersion: plan.version } : {}), updatedAt: this.now() };
      const data = { version: plan.version, routeId: r?.id ?? null };
      if (needsGreenlight && storedPhase(q.phase) !== "greenlight") {
        transitionQuest(this.store, q, "greenlight", "plan", { kind: "agent", threadId }, { kind: "plan", id: `${q.id}:${plan.version}` }, this.now(), { patch: updated, text: `Plan v${plan.version}`, data });
      } else if (!needsGreenlight && rangers && (q.phase === "scout" || q.phase === "greenlight")) {
        transitionQuest(this.store, q, "build", "ranger-plan", { kind: "agent", threadId }, { kind: "plan", id: `${q.id}:${plan.version}` }, this.now(), { patch: updated, text: `Ranger-only plan v${plan.version}; no staffing greenlight needed`, data });
      } else if (!needsGreenlight && q.phase === "greenlight") {
        const receipt = approvedPartyReceipt(this.store, q);
        if (!receipt) throw new Error("Replacement plan requires this quest\'s earlier party approval");
        transitionQuest(this.store, q, "build", "replacement-plan", { kind: "agent", threadId }, receipt, this.now(), { patch: updated, text: `Plan v${plan.version}`, data });
      } else {
        this.store.put("quests", q.id, updated);
        this.store.event(this.now(), threadId, q.id, "plan.proposed", `Plan v${plan.version}`, data, { kind: "agent", threadId });
      }
      if (previous) this.store.event(this.now(), threadId, q.id, "plan.revised", `Revised plan v${previous.version} to v${plan.version}`, {
        fromVersion: previous.version, toVersion: plan.version, reason: plan.changeNote, diff,
      }, { kind: "agent", threadId });
      for (const ask of this.store.openAsks(threadId, q.id)) {
        if (ask.kind === "greenlight" || ask.effect?.type === "user-waypoint")
          this.withdrawAsk(ask.id, "plan-superseded");
      }
      if (automatic) {
        if (proposesBudget && spendProposal) this.store.event(this.now(), threadId, q.id, "spend-budget.proposal-not-set", "The plan was greenlit automatically. Its proposed spend budget was not set.", spendProposal, { kind: "tavern" });
        const decision = this.decide(threadId, {
          boardQuestId: q.id,
          text: `Automatically greenlit reversible plan v${plan.version}`,
          why: "By-size policy permits one party slot, with no unresolved asks, questions or outside/user gates. Undo returns this plan to awaiting greenlight and releases members that have not reported.",
          reversible: true,
          source: "keeper",
        }, { questId: q.id, planVersion: plan.version });
        this.store.put("autoGreenlights", decision.id, {
          keeperThreadId: threadId,
          boardQuestId: q.id,
          planVersion: plan.version,
        });
      }
      if (leadPath.length) proposeLeadPlan(this, q, plan, leadPath);
      else if (needsGreenlight && !automatic) this.askGreenlight(q, plan, weakensChecks ? "This plan reduces the checks you approved. Review its checks before it can proceed." : "Staffing requires your explicit greenlight.", weakensChecks);
      if (!needsGreenlight && (!rangers || steer)) {
        this.decide(threadId, {
          boardQuestId: q.id,
          text: steer ? `Changed checks in plan v${plan.version} from your steer` : `Replanned to v${plan.version} within the greenlit party`,
          why: steer ? "You steered the checks for this quest. Undo requires a fresh greenlight for the weaker checks." : "The party size, classes and checks fit the approvals for this quest.",
          reversible: true,
          source: steer ? "steer" : "keeper",
          sourceRef: steer ? r!.id : null,
        }, undefined, steer ? { checkChange: { planVersion: plan.version, previousVersion: checkPlan!.version, steer } } : undefined);
      }
    });
    this.changed(threadId, q.id);
    return plan;
  }
  private carryWaypointAcceptances(q: BoardQuest, plan: Plan, diff: ReturnType<typeof planDiff>) {
    const calls = this.waypointCalls(q.id, q.planVersion);
    if (![...calls.values()].some(call => call.waypointCall?.as === "accepted")) return;
    const changed = new Set([
      ...diff.waypoints.removed.map(w => w.id),
      ...diff.waypoints.changed.filter(w =>
        plan.waypoints.find(waypoint => waypoint.id === w.id)?.actor !== "agent" ||
        Object.keys(w.fields).some(field => field !== "owner")).map(w => w.id),
    ]);
    const acceptances = this.summary(q.id).waypoints.flatMap(w => w.state === "accepted" && !changed.has(w.id)
      ? [{ waypointId: w.id, decisionId: calls.get(w.id)!.id }] : []);
    if (acceptances.length) this.store.event(this.now(), q.keeperThreadId, q.id, "waypoint.acceptance-carried",
      `Carried acceptance for ${acceptances.map(a => a.waypointId).join(", ")} from v${q.planVersion} to v${plan.version}`,
      { fromVersion: q.planVersion, toVersion: plan.version, acceptances }, { kind: "tavern" });
  }
  closingSteer(q: BoardQuest, routeId: string) {
    const route = this.applicableRoutes(q.keeperThreadId).find(r => r.id === routeId && r.kind === "steer" && routeQuestIds(r).includes(q.id));
    if (!route) throw new Error("fromSteer must name an applicable steer for this quest");
    return { routeId, ...this.steerMessage(q, route) };
  }
  private steerMessage(q: BoardQuest, route: Route) {
    const message = this.store.messageReceipt(q.keeperThreadId, route.sourceMessageId ?? "", true);
    if (!message || route.classSelectionOnly) throw new Error("Cite the user's own routed steer for this quest");
    return message;
  }
  private checkSteer(q: BoardQuest, route: Route) {
    const message = this.steerMessage(q, route);
    if (this.store.db.prepare("SELECT 1 FROM tavern_records WHERE kind='decisions' AND json_extract(data,'$.sourceRef')=? AND json_type(data,'$.checkChange')='object' AND json_extract(data,'$.undone')=1").get(route.id)) throw new Error("Weakening checks needs a current user steer for this quest that was not undone");
    authorize("weakenChecks", { level: "user-in-words", receipt: route.sourceMessageId! });
    return message;
  }
  private askGreenlight(q: BoardQuest, plan: Plan, why: string, requiresExplicit = false) {
    const schedules = scheduledSlots(plan);
    return this.ask(q.keeperThreadId, {
      effect: { type: "greenlight", planVersion: plan.version, ...(requiresExplicit ? { requiresExplicit: true } : {}), ...(schedules.length ? { scheduledSlots: schedules } : {}) },
      boardQuestId: q.id,
      kind: "greenlight",
      question: requiresExplicit ? `Approve the updated checks for ${q.title}, plan v${plan.version}?` : `Form the party for ${q.title}, plan v${plan.version}?`,
      why: plan.party.some(slot => slot.permanent) ? `${why} The quest map lists permanent slots and their reasons.` : why,
      options: [
        { id: "approve", label: requiresExplicit ? "Approve the updated plan" : "Form the party", recommended: true, detail: "Approve this plan version" },
        { id: "revise", label: "Revise the plan", recommended: false, detail: "Keep scouting; do not staff" },
      ],
      meanwhile: "Keep scouting and preparing private drafts.",
      holds: plan.waypoints.map(w => w.id),
    }, { planVersion: plan.version });
  }
  settle(threadId: string, input: Parameters<typeof settleWaypointSchema.parse>[0], legacySkipAskId?: string): Decision | Ask {
    const call = settleWaypointSchema.parse(input);
    const target = this.waypointForSettlement(threadId, call);
    const { q, w } = target;
    const shift = !legacySkipAskId && this.keeperCallShift(threadId, call.as);
    if (shift) {
      const { boardQuestId, ...effect } = call;
      const verb = { accepted: "Accept", skipped: "Skip", open: "Reopen" }[call.as];
      return this.askForKeeperCall(threadId, boardQuestId, { ...effect, type: "settle-waypoint", planVersion: q.planVersion },
        `${verb} ${w.id}: ${w.title}?`, verb, `${verb} this waypoint.`, "Leave the waypoint unchanged.", "The Keeper waits for your answer on this waypoint.");
    }
    return this.recordSettlement(threadId, call, target, legacySkipAskId);
  }
  private waypointForSettlement(threadId: string, { boardQuestId, waypointId, as }: ReturnType<typeof settleWaypointSchema.parse>) {
    const q = this.liveQuest(threadId, boardQuestId);
    this.assertQuestNotHeld(q.id);
    this.guard(threadId, q.id);
    const submission = { waypointId, entries: [] as JournalEntry[] };
    const w = this.readQuestSummary(q.id, undefined, submission).waypoints.find(w => w.id === waypointId);
    if (!w) throw new Error("Settlement must name a waypoint in the current plan");
    if (as === "accepted") {
      if (w.actor === "outside" && (w.gate?.answer == null || w.gate.answeredAt === null))
        throw new Error("Record the outside gate answer before accepting this waypoint");
      if (w.check !== "keeper" || !(w.actor === "outside" ? !settled(w) : w.actor === "agent" && w.state === "reported"))
        throw new Error("Only a reported or answered outside waypoint with a Keeper check can be accepted");
    }
    if (as === "skipped" && (!w.optional || settled(w)))
      throw new Error("Only an unsettled optional waypoint can be skipped");
    if (as === "open" && !(w.state === "skipped" || w.state === "accepted"))
      throw new Error("Only a waypoint the Keeper accepted or skipped can be reopened");
    const acceptedEntries = as === "accepted" && w.actor === "agent"
      ? submission.entries.map(({ threadId, id }) => ({ threadId, id })) : undefined;
    return { q, w, acceptedEntries };
  }
  private recordSettlement(threadId: string, { boardQuestId, waypointId, as, reason }: ReturnType<typeof settleWaypointSchema.parse>, { q, w, acceptedEntries }: ReturnType<Keeper["waypointForSettlement"]>, askId?: string, answerReceipt?: string) {
    const words = as === "open" ? "Reopened" : as === "accepted" ? "Accepted" : "Skipped";
    return this.store.atomic(() => {
      const decision = this.decide(threadId, { boardQuestId, text: `${words} ${waypointId}: ${w.title}`, why: reason, reversible: true,
        ...(askId ? { source: "ask", sourceRef: askId } : { source: "keeper" }),
      }, undefined, { waypointCall: { planVersion: q.planVersion, waypointId, as, acceptedEntries }, answerReceipt });
      if (!askId) authorize(as === "accepted" ? "acceptWaypoint" : as === "skipped" ? "skipWaypoint" : "reopenWaypoint", { level: "keeper", receipt: decision.id });
      if (!askId || answerReceipt) this.withdrawClosingForWaypointChange(q);
      return decision;
    });
  }
  private keeperCallShift(threadId: string, kind: KeeperCallKind) {
    return readUndoLanes(this.store, threadId).find(row => row.kind === kind);
  }
  private askForKeeperCall(threadId: string, boardQuestId: string | null, effect: Extract<AskEffect, { type: "settle-waypoint" | "soft-limit" }>,
    question: string, label: string, approve: string, decline: string, meanwhile: string) {
    const pending = this.store.openAsks(threadId).find(a => a.boardQuestId === boardQuestId && isDeepStrictEqual(a.effect, effect));
    if (pending) return pending;
    return this.ask(threadId, { boardQuestId, kind: "decision", effect, question, why: effect.reason.slice(0, 200), meanwhile, holds: [],
      options: [{ id: "approve", label, detail: approve, recommended: true }, { id: "deny", label: "Leave as is", detail: decline, recommended: false }],
    });
  }
  decideOrAsk(threadId: string, input: Parameters<Keeper["decide"]>[1]): Decision | Ask {
    this.require(threadId, "keeper");
    if (input.source === "user") return this.decide(threadId, input);
    if (input.askId && input.source === "ask") {
      if (input.unsure !== false || !input.consequence) throw new Error(`To record the answer to ${input.askId}, give consequence and unsure:false.`);
      const ask = this.store.get("asks", input.askId);
      if (!ask || ask.keeperThreadId !== threadId || ask.state !== "answered" || ask.answer?.by !== "user")
        throw new Error(`Ask ${input.askId} is not a user-answered ask of this Keeper. ${ask?.keeperThreadId === threadId && ask.kind === "merge" && ask.state === "open" && ask.effect?.type === "decision" ? `Use tavern_ask with mergeAskId "${ask.id}", action "ask-user", and reason so the user can answer its card.` : "Read tavern_status section=asks for the recorded answer."}`);
      if (input.boardQuestId !== undefined && input.boardQuestId !== ask.boardQuestId)
        throw new Error(`Ask ${ask.id} belongs to ${ask.boardQuestId ?? "no quest"}. Record it with boardQuestId ${JSON.stringify(ask.boardQuestId)}.`);
      if (input.optionId !== ask.answer.optionId || input.kind && input.kind !== ask.kind || input.sourceRef && input.sourceRef !== ask.id)
        throw new Error(`Ask ${ask.id} was answered with optionId ${JSON.stringify(ask.answer.optionId)}. Record it with source "ask", that option and no kind or sourceRef.`);
      return this.decide(threadId, { ...input, boardQuestId: ask.boardQuestId, sourceRef: ask.id,
        coveredBy: { kind: "answer", id: ask.id }, options: ask.options.map(option => option.label) });
    }
    const quest = input.boardQuestId ? this.liveQuest(threadId, input.boardQuestId) : null;
    if (quest) this.guard(threadId, quest.id);
    if (input.askId) {
      if (input.unsure === true) throw new Error("This is uncertain; ask the user instead of recording a decision.");
      if (input.unsure !== false || !input.consequence) throw new Error("Give consequence and unsure:false, or ask the user.");
      const ask = this.store.get("asks", input.askId);
      if (!ask || ask.keeperThreadId !== threadId || ask.boardQuestId !== (quest?.id ?? null))
        throw new Error("A Keeper answer needs its own exact quest ask, kind and option");
      return this.decide(threadId, { ...input, coveredBy: { kind: "answer", id: ask.id }, options: ask.options.map(option => option.label) });
    }
    if (input.leadPlan) {
      if (input.unsure !== true) this.checkDecision(threadId, quest, input);
      return decideLeadPlan(this, threadId, input);
    }
    this.checkDecision(threadId, quest, input);
    if (!input.exceeds || !input.reversible || input.kind) return this.decide(threadId, input);
    this.assertUnusedSoftLimitAnswer(input.sourceRef);
    const shift = this.keeperCallShift(threadId, input.exceeds);
    if (!shift) return this.decide(threadId, input);
    const target = input.exceeds === "party" ? "party" : "Ranger";
    const question = `Allow one hire beyond the class ${target} limit?`;
    return this.askForKeeperCall(threadId, input.boardQuestId ?? null, { type: "soft-limit", limit: input.exceeds, text: input.text, reason: input.why },
      question, "Allow one hire", `Give the Keeper one ${target} exception for this hire; your settings ceiling still applies.`, "Do not give the Keeper an exception.", "The Keeper waits for your answer before using an exception.");
  }
  private checkDecision(threadId: string, quest: BoardQuest | null, input: Parameters<Keeper["decide"]>[1]) {
    if (input.unsure === true) throw new Error("This is uncertain; ask the user instead of recording a decision.");
    const { coveredBy, options, consequence, unsure } = input;
    if (!coveredBy || !options || !consequence || unsure !== false) {
      throw new Error("Give coveredBy, options, consequence and unsure:false, or ask the user.");
    }
    const questId = quest?.id ?? null;
    let valid: boolean;
    switch (coveredBy.kind) {
      case "route": {
        const route = this.store.get("routes", coveredBy.id);
        const receipt = route?.sourceMessageId && this.store.db.prepare("SELECT 1 FROM tavern_messages WHERE id=? AND thread_id=? AND accepted=2 AND length(trim(text))>0").get(route.sourceMessageId, threadId);
        valid = !!receipt && route?.keeperThreadId === threadId && !route.classSelectionOnly &&
          (questId === null ? route.kind === "aside" : ["new-quest", "steer"].includes(route.kind) && routeQuestIds(route).includes(questId));
        break;
      }
      case "rule": {
        const rule = this.store.get("rules", coveredBy.id);
        valid = !!rule?.active && (rule.scope === "global" ||
          rule.scope === "keeper" && rule.scopeId === threadId ||
          rule.scope === "quest" && rule.scopeId === questId ||
          rule.scope === "project" && rule.scopeId === this.store.runtime(threadId).projectId);
        break;
      }
      case "answer": {
        const ask = this.store.get("asks", coveredBy.id);
        valid = ask?.keeperThreadId === threadId && ask.boardQuestId === questId && ask.state === "answered" && ask.answer?.by === "user";
        break;
      }
      case "plan": {
        const version = coveredBy.version;
        const plan = quest && version === (quest.checkPlanVersion ?? quest.greenlitVersion) && this.store.get("plans", `${quest.id}:${version}`);
        valid = !!plan && plan.waypoints.some(w => w.id === coveredBy.waypointId);
        break;
      }
    }
    if (!valid) throw new Error("coverageKind and coverageId (or legacy coveredBy) must name a real route, active rule or user answer here; for a plan use its approved planVersion and waypointId.");
  }
  private assertUnusedSoftLimitAnswer(sourceRef: string | null | undefined) {
    if (sourceRef && this.store.get("asks", sourceRef)?.effect?.type === "soft-limit")
      throw new Error("The Keeper cannot reuse a soft-limit answer; it records one exception when answered.");
  }
  private withdrawClosingForWaypointChange(q: BoardQuest) {
    if (q.phase !== "closing") return;
    for (const ask of this.store.openAsks(q.keeperThreadId, q.id)) {
      if (ask.kind === "conclude") this.withdrawStaleClosing(ask, "The waypoints changed after this card was shown.");
    }
  }
  withdrawStaleClosing(ask: Ask, reason: string) {
    this.store.atomic(() => {
      if (this.withdrawAsk(ask.id, "closing-stale", this.now(), { kind: "tavern" }, reason))
        this.reanchor(ask.keeperThreadId, "the closing card went stale; review the quest before proposing closing again");
    });
  }
  asks(threadId: string) {
    return this.store.query("asks", "keeperThreadId", threadId, 500);
  }
  withdrawAsk(
    id: string,
    cause: NonNullable<Ask["withdrawnCause"]>,
    at = this.now(),
    actor: Actor = { kind: "tavern" },
    text?: string,
    data: Record<string, unknown> = {},
  ): Ask | null {
    const ask = this.store.get("asks", id);
    if (!ask || ask.state !== "open" && !(cause === "merge-moot" && ask.kind === "merge" && ask.state === "answered" && ask.mergeApproval && !ask.mergeUse)) return null;
    const withdrawn = this.store.atomic(() => {
      const closing = ask.kind === "conclude" && ask.boardQuestId && this.quest(ask.boardQuestId).phase === "closing";
      if (closing)
        transitionQuest(this.store, this.quest(ask.boardQuestId!), isCloseEffect(ask.effect) ? ask.effect.draft.returnTo ?? "build" : "build", "conclude-withdrawn", { kind: "tavern" }, { kind: "ask", id }, at, { text, data: { ...data, askId: id, withdrawnCause: cause } });
      if (!closing) this.store.event(at, ask.keeperThreadId, ask.boardQuestId, "ask.withdrawn", text ?? ask.question, { ...data, askId: id, cause }, actor);
      return this.store.put("asks", id, { ...ask, state: "withdrawn", withdrawnAt: at, withdrawnCause: cause });
    });
    const target = askMemberTarget(ask);
    if (target) this.invalidate([tags.thread(target)]);
    return withdrawn;
  }
  pendingStopHires(id: string) {
    return this.store.db.prepare("SELECT h.id AS token,json_extract(h.data,'$.classId') AS classId,json_extract(h.data,'$.owner.title') AS title FROM tavern_records h WHERE h.kind='hires' AND json_extract(h.data,'$.owner.boardQuestId')=? AND NOT EXISTS (SELECT 1 FROM tavern_records m WHERE m.kind='members' AND m.id=json_extract(h.data,'$.memberThreadId'))").all(id) as { token: string; classId: string; title: string }[];
  }
  pendingQuestHires(id: string) {
    return this.pendingStopHires(id).length;
  }
  recordStop(id: string, reason: string | null = null, surface = "stopBoardQuest", chainReceipt?: string): BoardQuest {
    const stopReason = boardQuestSchema.shape.stopReason.parse(reason) || null;
    const quest = this.quest(id);
    if (quest.phase === "done") throw new Error("This board quest has already returned");
    if (quest.phase === "stopped" || quest.phase === "stopping") return quest;
    const at = this.now();
    return this.store.atomic(() => {
      const stopPatch = {
        ...quest,
        endedAt: null,
        stoppingSince: at,
        updatedAt: at,
        stopReason,
      };
      const withdrawnAskIds = (this.store.db.prepare("SELECT id FROM tavern_records WHERE kind='asks' AND json_extract(data,'$.keeperThreadId')=? AND json_extract(data,'$.boardQuestId')=? AND json_extract(data,'$.state')='open'").all(quest.keeperThreadId, id) as { id: string }[]).map(ask => ask.id);
      const actor: Actor = chainReceipt ? { kind: "tavern" } : { kind: "user" };
      const stopped = transitionQuest(this.store, quest, "stopping", chainReceipt ? "stop-chain" : "stop", actor,
        { kind: chainReceipt ? "chain-stop" : "user-act", id: chainReceipt ?? this.store.id("act"), surface, at }, at,
        { patch: stopPatch, text: "Stop requested for every party member", data: { reason: stopReason, withdrawnAskIds } });
      this.store.cancelQuestHires(id, at);
      const request = this.store.latestQuestEvent(id, "quest.stopping")!;
      for (const member of this.store.query("members", "boardQuestId", id, 500)) {
        if (member.leadLinkId || !["briefing", "active", "resting", "releasing"].includes(member.engagement ?? "")) continue;
        const receipt = { kind: "quest-stop", id: String(request.id) };
        transitionMember(this.store, member, "stopping", "quest-stop", actor, receipt, at,
          { details: { operation: { id: this.store.id("stop"), reason: stopReason ?? "Quest stop", receipt,
            skipStopIfQuiet: member.engagement === "resting", placementRequired: this.store.runtime(member.threadId).placementExecution != null || new PlacementStore(this.store.db).byMember(member.threadId) !== null }, release: null },
            data: { previouslyResting: member.engagement === "resting" } });
      }
      this.memory.closeQuest(quest.keeperThreadId, id);
      for (const askId of withdrawnAskIds) this.withdrawAsk(askId, "quest-stopped", at);
      return stopped;
    });
  }
  private moveNoticeAsk(ask: Ask) {
    const effect = ask.effect!;
    const at = this.now();
    const moved: Ask = { ...ask, lane: "keeper", state: "answered", answer: {
      by: "tavern", via: "tavern", at, optionId: "moved-to-keeper", note: "Moved to the Keeper.",
    } };
    this.store.put("asks", ask.id, moved);
    this.store.event(at, ask.keeperThreadId, ask.boardQuestId, "blocker.moved", `${ask.question}: ${ask.why}`, {
      askId: ask.id, effectType: effect.type, memberThreadId: scopeAskMember(effect), reason: ask.why,
    }, { kind: "tavern" });
    return moved;
  }
  moveNoticeAsks() {
    this.store.atomic(() => {
      for (const ask of this.store.openAsks()) {
        if (isNoticeEffect(ask.effect!)) this.moveNoticeAsk(ask);
        else if (keeperRecoveryOptions(ask.effect!) && ask.lane !== "keeper") {
          this.store.put("asks", ask.id, { ...ask, lane: "keeper" });
          this.store.event(this.now(), ask.keeperThreadId, ask.boardQuestId, "blocker.assigned", ask.question,
            { askId: ask.id, reason: ask.why }, { kind: "tavern" });
        }
      }
    });
  }
  ask(
    threadId: string,
    input: AskInput & { effect: AskEffect },
    eventData: Record<string, unknown> = {},
    trusted = false,
  ) {
    const questId = input.boardQuestId ?? null;
    const stopRetry = trusted && input.effect.type === "retry-stop" && questId !== null;
    const callingKeeper = stopRetry ? this.member(threadId) : this.require(threadId, "keeper");
    if (!callingKeeper || stopRetry && (this.quest(questId).phase !== "stopping" || this.quest(questId).keeperThreadId !== threadId))
      throw new Error("A retry requires this Keeper's stopping quest.");
    if (input.releaseCheckerHandoff) {
      if (!questId) throw new Error("A checker-handoff release ask needs its quest");
      const hold = this.liveQuest(threadId, questId).checkerHandoffHold;
      if (!hold || hold.release !== null) throw new Error("This quest has no active checker-handoff hold");
      input = { ...input, releaseHoldId: hold.id, effect: { type: "release-hold", holdId: hold.id } };
    }
    if (input.releaseHoldId) {
      if (!questId || input.kind !== "blocker" || input.proceedInMinutes != null) throw new Error("A checker-handoff release ask must be a never-timed blocker for its quest");
      const quest = this.liveQuest(threadId, questId);
      if (quest.checkerHandoffHold?.id !== input.releaseHoldId || quest.checkerHandoffHold.release !== null) throw new Error("This checker-handoff hold is no longer current");
      const existing = this.store.openAsks(threadId, questId).find(ask => ask.releaseHoldId === input.releaseHoldId);
      if (existing) return existing;
      input = { ...input, effect: { type: "release-hold", holdId: input.releaseHoldId }, question: `Release the checker handoff for “${quest.title}”?`,
        why: "Only your explicit answer releases this hold. A request for a check result is not a release.",
        options: [{ id: "release", label: "Release checker handoff", detail: "Allow this quest's checker handoff; other guards still apply.", recommended: false },
          { id: "keep-held", label: "Keep held", detail: "Keep waiting for your explicit release.", recommended: false }],
        holds: [], meanwhile: "Maker work and the Keeper conversation can continue; checker handoff stays held." };
    }
    if (questId) {
      if (!stopRetry) this.liveQuest(threadId, questId);
      if (!trusted && !input.releaseHoldId) this.guard(threadId, questId);
    }
    if (input.waypointId !== undefined || input.completeOn !== undefined) {
      if (!questId || input.kind !== "decision" || input.effect.type !== "decision" || input.target || input.draft || input.runThreadId)
        throw new Error("A user waypoint needs a plain decision ask for its quest.");
      if (input.proceedInMinutes != null) throw new Error("A user waypoint ask is never timed.");
      const completeOn = input.completeOn;
      if (!completeOn?.length || new Set(completeOn).size !== completeOn.length ||
          completeOn.some(id => !input.options.some(option => option.id === id)))
        throw new Error("completeOn must name unique option IDs on this card that close the waypoint.");
      const quest = this.summary(questId);
      const waypoint = quest.waypoints.find(w => w.id === input.waypointId && w.actor === "user");
      if (!waypoint || settled(waypoint)) throw new Error("Name an open user waypoint in the current quest plan.");
      if (waypoint.askId) throw new Error(`This user waypoint already has an open ask: ${waypoint.askId}.`);
      input = { ...input, effect: { type: "user-waypoint", waypointId: waypoint.id, planVersion: quest.planVersion, completeOn } };
    } else if (input.effect.type === "user-waypoint") throw new Error("A user waypoint ask must be bound to the current plan.");
    if (input.kind !== "decision" && input.proceedInMinutes != null)
      throw new Error(
        "Only decision asks may have timed defaults; other kinds never default and require an explicit answer",
      );
    if (input.proceedInMinutes != null && input.reversible !== true)
      throw new Error(
        "A timed decision must explicitly declare reversible: true",
      );
    if (
      input.kind === "sends-as-you" && input.effect.type !== "communication-hold" &&
      (!input.draft?.to || !input.draft.body)
    )
      throw new Error("Sends-as-you requires the complete recipient and draft");
    if (new Set(input.options.map((o) => o.id)).size !== input.options.length)
      throw new Error("Option ids must be unique");
    if (
      input.proceedInMinutes != null &&
      (input.proceedInMinutes <= 0 ||
        input.proceedInMinutes > this.settings().keepers.decisionTimerMax ||
        input.options.filter((o) => o.recommended).length !== 1)
    )
      throw new Error(
        "A timed default needs one recommendation and a time within seven days",
      );
    if (input.kind === "greenlight" && input.effect.type !== "greenlight" && (input.effect.type !== "lead-plan" || !trusted))
      throw new Error("A greenlight ask needs its typed plan version; propose the plan instead.");
    if (input.kind === "conclude" && !isCloseEffect(input.effect)) throw new Error("A conclude ask needs its typed draft; tell the quest result instead.");
    if (["placement-blocker", "communication-hold", "repair-guard", "member-schedules"].includes(input.effect.type) && !trusted) throw new Error("Only Tavern may open this typed ask");
    if (input.kind === "drafts-as-you" && input.effect.type !== "communication-hold") throw new Error("Call the draft tool first so Tavern can record the exact arguments.");
    if (input.kind === "sends-as-you" && input.effect.type === "decision") input = { ...input,
      options: [{ id: "acknowledge", label: "I have the draft", detail: "Records your answer. The agent does not send anything.", recommended: false }, { id: "deny", label: "Dismiss", detail: "Nothing is sent.", recommended: false }],
    };
    if (input.options.some(o => o.id === "delegate")) throw new Error("The delegation answer is reserved for Tavern");
    const exactCommand = input.target?.command;
    let clusterTargets: Ask["clusterTargets"];
    if (exactCommand) {
      let writes: ReturnType<typeof clusterWriteCommands> | undefined;
      try { writes = clusterWriteCommands(exactCommand, "/"); } catch (error) {
        if (input.kind === "cluster-write" || fallbackActs(exactCommand).some(act => act.kind === "cluster-write")) {
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(`Tavern can't parse this command (${cause}). Send the literal command with supported shell syntax.`);
        }
      }
      if (writes?.length && input.kind !== "cluster-write") throw new Error("Use kind cluster-write for a cluster write command.");
      if (input.kind === "cluster-write") {
        if (!writes?.length) throw new Error("Give the exact command that performs the cluster write.");
        const targets = writes.map(clusterCommandTarget).filter(target => target !== undefined);
        clusterTargets = [...new Map(targets.map(target => [JSON.stringify(target), target])).values()];
      }
    }
    const runner = input.kind === "cluster-write" ? this.clusterRunner(threadId, questId, input.runThreadId ?? threadId) : null;
    if (runner && (!exactCommand?.trim() || !input.change?.trim()))
      throw new Error("Cluster writes need the exact command and what it changes.");
    if (input.kind === "cluster-write" || (input.effect.type !== "grant-shell-act" && ["merge", "production"].includes(input.kind))) {
      const detail = runner ? "Approve this exact command for the named thread. Nothing runs until you confirm."
        : "Record approval for the exact act. This does not run it. In the Keeper lane, approval needs a current Warden verdict.";
      input = { ...input, options: [{ id: "approve", label: runner ? "Approve" : "Approve the act", detail, recommended: false }, { id: "deny", label: "Decline the act", detail: "Do not authorize this act.", recommended: false }], effect: { type: "decision", outcomes: [{ optionId: runner ? "confirm-run" : "approve", outcome: "approve" }, { optionId: "deny", outcome: "decline" }] } };
    }
    if (input.kind === "merge" && input.target?.merge && input.effect.type === "decision") {
      const { repository, sourceBranch, pullRequest, targetBranch } = input.target.merge;
      const detail = `${repository}: ${sourceBranch ?? pullRequest} into ${targetBranch} at ${input.target.commit}.`;
      if (detail.length > 300) throw new Error("Use shorter exact repository and pull request names so the approval shows the full target.");
      input = { ...input, options: input.options.map(option => option.id === "approve" ? { ...option, detail } : option) };
    }
    const lane = this.authority.baseLane({ kind: input.kind, boardQuestId: questId, unsure: input.unsure, effect: input.effect, sendTarget: input.sendTarget });
    const childLink = questId ? this.store.leadLinksBy("childQuestId", questId)[0] : undefined;
    let forwardedQuestion: Ask["forwardedQuestion"];
    if (lane === "user" && childLink?.childKeeperThreadId === threadId) {
      const parent = this.quest(childLink.parentQuestId), parentKeeper = this.member(parent.keeperThreadId);
      const byline = `${this.name(callingKeeper)} asks, for ${parentKeeper ? this.name(parentKeeper) + "’s " : ""}`;
      forwardedQuestion = { parentQuestId: parent.id, byline, body: input.question.slice(0, 400) };
      input = { ...input, question: forwardedAskQuestion(forwardedQuestion, parent.short) };
    }
    if (questId && lane === "user" && input.kind !== "drafts-as-you" && DELEGATABLE_KINDS.some(kind => kind === input.kind)) {
      input = { ...input, options: [...input.options, this.authority.delegationOption(threadId)] };
    }
    const ask = askSchema.parse({
      ...input,
      ...(forwardedQuestion ? { forwardedQuestion } : {}),
      lane,
      ...(clusterTargets?.length ? { clusterTargets } : {}),
      runThreadId: runner?.threadId,
      runThreadName: runner ? this.name(runner) : undefined,
      effect: input.effect,
      reversible: input.reversible === true,
      id: this.store.id("ask"),
      keeperThreadId: threadId,
      boardQuestId: questId,
      proceedAt:
        input.proceedInMinutes == null
          ? null
          : this.now() + input.proceedInMinutes * 60_000,
      draft: input.draft ?? null,
      state: "open",
      answer: null,
      createdAt: this.now(),
    });
    if (isNoticeEffect(input.effect)) {
      const moved = this.store.atomic(() => this.moveNoticeAsk(ask));
      this.changed(threadId, questId);
      return moved;
    }
    const projected = undoAskProjection(this.store)(ask);
    const recovery = keeperRecoveryOptions(input.effect);
    const keeperBlock = keeperOwnsBlock(input.effect);
    this.store.atomic(() => {
      this.store.put("asks", ask.id, ask);
      if (ask.kind === "conclude" && questId && this.quest(questId).phase !== "closing") {
        transitionQuest(this.store, this.quest(questId), "closing", "close", { kind: "agent", threadId }, { kind: "ask", id: ask.id }, this.now(), { text: ask.question, data: { askId: ask.id, ...eventData } });
      } else this.store.event(
        this.now(),
        threadId,
        questId,
        keeperBlock ? "blocker.assigned" : "ask.opened",
        ask.question,
        { askId: ask.id, lane: projected.lane, keeperName: this.name(callingKeeper), ...(keeperBlock ? { reason: ask.why, options: recovery } : {}), ...eventData },
        keeperBlock ? { kind: "tavern" } : { kind: "agent", threadId },
      );
    });
    const standing = this.authority.match(ask);
    if (standing && ask.effect?.type === "greenlight") this.answerAsk(ask.id, standing.optionId, null, "timer", "preapproval");
    this.changed(threadId, questId);
    const target = askMemberTarget(ask);
    if (target && !questId) this.invalidate([tags.thread(target)]);
    void Promise.resolve()
      .then(() => {
        const current = this.store.get("asks", ask.id);
        if (current?.state !== "open") return;
        if (this.authority.match(current)) return this.routineAskOpened(current);
        if (hasUserAskOutcome(current, current.effect!) && this.authority.lane(current) === "user") return this.askOpened(currentAskNames(this.store, undoAskProjection(this.store)(current)));
      })
      .catch((error) =>
        console.warn(`Tavern ask notification ${ask.id}: ${String(error)}`),
      );
    return projected;
  }
  changeMergeAsk(threadId: string, askId: string, action: "ask-user" | "withdraw", reason: string) {
    this.require(threadId, "keeper");
    const ask = this.store.get("asks", askId);
    if (!ask || ask.keeperThreadId !== threadId || ask.kind !== "merge" || ask.effect?.type !== "decision")
      throw new Error(`Ask ${askId} is not a plain merge ask owned by this Keeper. Read tavern_status section=asks for the right ID.`);
    if (action === "withdraw" && ask.state === "withdrawn" && ask.withdrawnCause === "merge-moot") return ask;
    const closed = () => new Error(`Merge ask ${askId} is no longer open (${ask.state}). Read its outcome in tavern_status section=asks.`);
    if (ask.state !== "open" && action === "ask-user") throw closed();
    if (ask.boardQuestId) {
      this.liveQuest(threadId, ask.boardQuestId);
      this.guard(threadId, ask.boardQuestId);
    }
    if (action === "withdraw") {
      const withdrawn = this.withdrawAsk(askId, "merge-moot", this.now(), { kind: "agent", threadId }, reason);
      if (!withdrawn) throw closed();
      this.changed(threadId, ask.boardQuestId);
      return withdrawn;
    }
    if (ask.lane === "user" && ask.unsure) return ask;
    const link = ask.boardQuestId ? this.store.leadLinksBy("childQuestId", ask.boardQuestId)[0] : undefined;
    const forwarded = !ask.forwardedQuestion && link?.childKeeperThreadId === threadId ? (() => {
      const parent = this.quest(link.parentQuestId), keeper = this.member(parent.keeperThreadId);
      const forwardedQuestion = { parentQuestId: parent.id, byline: `${this.name(this.require(threadId, "keeper"))} asks, for ${keeper ? this.name(keeper) + "’s " : ""}`, body: ask.question };
      return { forwardedQuestion, question: forwardedAskQuestion(forwardedQuestion, parent.short) };
    })() : {};
    const moved = this.store.atomic(() => {
      const record = this.store.put("asks", askId, { ...ask, ...forwarded, lane: "user", unsure: true, options: ask.options.filter(o => o.id !== "delegate") });
      this.store.event(this.now(), threadId, ask.boardQuestId, "ask.lane-changed", reason, { askId, from: ask.lane ?? "user", to: "user" }, { kind: "agent", threadId });
      return record;
    });
    this.changed(threadId, ask.boardQuestId);
    void Promise.resolve().then(() => {
      if (this.store.get("asks", askId)?.state === "open") return this.askOpened(currentAskNames(this.store, moved));
    }).catch(error => console.warn(`Tavern ask notification ${askId}: ${String(error)}`));
    return moved;
  }
  reviewHeldCommunication(threadId: string, askId: string, dismiss = false) {
    this.require(threadId, "keeper");
    const ask = this.store.get("asks", askId);
    const effect = ask?.effect;
    if (ask?.keeperThreadId !== threadId || ask.state !== "open" || effect?.type !== "communication-hold" || !effect.keeperReview)
      throw new Error("No matching held communication for this Keeper to review.");
    const { hold } = effect;
    if (dismiss) {
      this.withdrawAsk(ask.id, "turn-recovered", this.now(), { kind: "agent", threadId }, "Keeper dismissed the held message.");
      this.changed(threadId, ask.boardQuestId);
      return null;
    }
    if (!hold.target?.trim() || !hold.body?.trim() || hold.act === "draft" && !hold.callDigest)
      throw new Error("The held call does not contain an exact recipient and message. Ask the member for the missing details or dismiss the hold.");
    if (ask.boardQuestId) this.guard(threadId, ask.boardQuestId);
    this.clusterRunner(threadId, ask.boardQuestId, hold.threadId);
    const reviewed: Ask = { ...ask, effect: { type: "communication-hold", hold } };
    const lane = this.authority.lane(reviewed);
    const routed = this.store.atomic(() => {
      const saved = this.store.put("asks", ask.id, { ...reviewed, lane });
      this.store.event(this.now(), threadId, ask.boardQuestId, "ask.opened", ask.question, { askId, lane }, { kind: "agent", threadId });
      return saved;
    });
    this.changed(threadId, ask.boardQuestId);
    if (lane === "user") void Promise.resolve().then(() => this.askOpened(routed))
      .catch(error => console.warn(`Tavern ask notification ${askId}: ${String(error)}`));
    return routed;
  }
  clusterRunner(keeperThreadId: string, questId: string | null, runThreadId: string) {
    const runner = this.member(runThreadId);
    const live = runThreadId === keeperThreadId ? isLiveKeeper(this.store, runner) :
      isLiveMember(this.store, runner) && runner.keeperThreadId === keeperThreadId && runner.boardQuestId === questId;
    if (!runner || !live)
      throw new Error("The cluster command must name a live Keeper or a live member of this quest.");
    return runner;
  }
  answerAsk(
    askId: string,
    optionId: string,
    note: string | null,
    via: Exclude<NonNullable<Ask["answer"]>["via"], "tavern">,
    by: "user" | "default" | "keeper" | "preapproval",
    surface?: string,
    effects: Partial<EffectHandlers> = {},
    receipt?: UserActReceipt,
  ) {
    const ask = this.store.get("asks", askId);
    if (!ask) throw new Error("Unknown ask");
    if (ask.effect && needsKeeperReview(ask.effect)) throw new Error("The Keeper must review the held communication first.");
    const heldCommunication = ask.effect?.type === "communication-hold" ? ask.effect.hold : undefined;
    if (ask.kind === "sends-as-you" && (by !== "user" || optionId === "delegate" || heldCommunication && !["acknowledge", "deny"].includes(optionId)))
      throw new Error("Only the user can acknowledge or dismiss a send handoff.");
    if (heldCommunication?.act === "draft" && optionId === "approve") {
      this.assertDraftApprovalOpen();
      if (by !== "keeper" && (by !== "user" || receipt?.act !== "answerAsk" || via === "timer")) throw new Error("Draft approval needs an explicit answer.");
      if (!heldCommunication.callDigest) throw new Error("Tavern could not match this draft to exact arguments.");
      this.clusterRunner(ask.keeperThreadId, ask.boardQuestId, heldCommunication.threadId);
    }
    if (ask.kind === "cluster-write" && by === "user" && (receipt?.act !== "answerAsk" || via === "timer" || via === "cli")) throw new Error("Cluster writes require your explicit answer on the card.");
    if (ask.effect?.type === "user-waypoint" && (by !== "user" || receipt?.act !== "answerAsk" || receipt.threadId || via === "cli" || via === "timer"))
      throw new Error("This waypoint needs your explicit answer on the card.");
    const scheduleApproval = ask.effect?.type === "greenlight" ? ask.effect.scheduledSlots : ask.effect?.type === "lead-plan" ? ask.effect.request.scheduledSlots : undefined;
    if ((ask.effect?.type === "member-schedules" || scheduleApproval?.length) &&
        (by !== "user" || receipt?.act !== "answerAsk" || receipt.threadId || via === "cli" || via === "timer"))
      throw new Error("Schedules need your explicit answer on the card.");
    if (ask.state !== "open") {
      if (ask.answer?.optionId === optionId) {
        if (by === "user") this.userAction(ask.keeperThreadId);
        return;
      }
      throw new Error("This ask is no longer open");
    }
    const standing = by === "preapproval" ? this.authority.match(ask) : null;
    if (by === "preapproval" && (!standing || standing.optionId !== optionId)) throw new Error("No matching quest pre-approval");
    if (optionId === "delegate") {
      if (by !== "user" || !ask.boardQuestId || !ask.options.some(o => o.id === "delegate")) throw new Error("Only the user may delegate this quest kind");
      this.authority.delegate(ask.boardQuestId, ask.kind as import("../../shared/quest-authority").DelegationKind, receipt ? { ...receipt, surface: via === "cli" ? receipt.surface : `${via} (client, unattested)` } : receipt!);
      this.store.put("asks", ask.id, { ...ask, lane: "keeper", options: ask.options.filter(o => o.id !== "delegate") });
      this.userAction(ask.keeperThreadId);
      this.changed(ask.keeperThreadId, ask.boardQuestId); return;
    }
    if (by === "keeper") {
      assertUndoLane(this.store, ask.keeperThreadId, ask.kind);
      if (this.authority.lane(ask) !== "keeper") throw new Error("This ask belongs to the user; ask them to decide.");
      const recovery = keeperRecoveryOptions(ask.effect!);
      if (recovery && !recovery.includes(optionId)) throw new Error("The Keeper cannot resolve this recovery with that option.");
      const outcome = ask.effect?.type === "decision" ? ask.effect.outcomes?.find(answer => answer.optionId === optionId)?.outcome : undefined;
      if (outcome !== "decline" && !(ask.effect?.type === "grant-shell-act" && optionId === "deny")) this.authority.assertVerdict(ask);
    }
    const effect = ask.effect!;
    if (ask.kind === "greenlight" && effect.type !== "greenlight" && effect.type !== "lead-plan")
      throw new Error("This old ask has no plan version; ask the Keeper to propose the plan again.");
    if (effect.type === "conclude" && effect.draft.lead && (by !== "user" || via === "timer" || receipt?.act !== "answerAsk"))
      throw new Error("This child conclusion needs your explicit answer or the current hiring Keeper.");
    if (effect.type === "lead-plan" && (by !== "user" || via === "timer")) throw new Error("This lead plan needs your explicit answer.");
    if (effect.type === "greenlight" && ask.boardQuestId && this.store.leadLinksBy("childQuestId", ask.boardQuestId).length)
      throw new Error("An ordinary greenlight cannot approve a lead plan.");
    if (ask.kind === "conclude" && !isCloseEffect(effect)) throw new Error("This old ask has no conclusion draft; ask the Keeper to tell the result again.");
    if (ask.boardQuestId && (isCloseEffect(effect) || effect.type === "greenlight" && optionId === "approve")) {
      const quest = this.quest(ask.boardQuestId);
      if (quest.phase === "held") throw new Error("This quest is held; resume it first");
      if (effect.type === "greenlight") {
        assertQuestTransition(this.store, quest, "build", "approve", { kind: "user" }, { kind: "ask-answer", id: askId });
        if ((effect.type !== "greenlight" || effect.planVersion !== quest.planVersion)) throw new Error("This greenlight belongs to an old plan version");
      } else {
        const closing = optionId === effect.type;
        const to = closing ? "done" : optionId === "hold" ? effect.draft.returnTo ?? "build" : "build";
        assertQuestTransition(this.store, quest, to, closing ? effect.type : optionId === "hold" ? "keep-open" : "extensions", { kind: "user" }, { kind: "ask-answer", id: askId });
      }
    }
    if (ask.boardQuestId && effect.type !== "retry-stop") this.liveQuest(ask.keeperThreadId, ask.boardQuestId);
    if (ask.kind === "cluster-write" && by === "user") {
      if (optionId === "confirm-run" && !ask.clusterApproval) throw new Error("Approve the exact cluster command before confirming it.");
      if (optionId === "approve" && via !== "cli" && via !== "timer") {
        if (ask.clusterApproval) return;
        const clusterApproval = { at: this.now(), via, surface: surface ?? "client (unattested)", note };
        commitUserAct(this.store, () => this.now(), receipt, () => {
          this.store.put("asks", ask.id, { ...ask, clusterApproval, options: [{ id: "confirm-run", label: "Run it now", detail: "Allow one run of this exact command.", recommended: false }, ...ask.options.filter(option => option.id === "deny")] });
          this.store.event(this.now(), ask.keeperThreadId, ask.boardQuestId, "ask.cluster-approved", ask.question, { askId, clusterApproval }, { kind: "user" });
        });
        this.changed(ask.keeperThreadId, ask.boardQuestId);
        return;
      }
    }
    if (!ask.options.some((o) => o.id === optionId))
      throw new Error("Unknown option");
    if (
      by === "default" &&
      (ask.kind !== "decision" ||
        ask.reversible !== true ||
        ask.proceedAt === null ||
        ask.proceedAt > this.now())
    )
      throw new Error("This ask cannot default");
    if (ask.releaseHoldId && (by !== "user" || via === "timer")) throw new Error("A checker-handoff hold needs an explicit user answer");
    const keeperSource = by === "keeper" ? this.authority.keeperDecisionSource(ask) : {};
    const mergeApproval = ask.kind === "merge" && ask.effect?.type === "decision" && ask.target?.merge && optionId === "approve" &&
      (by === "keeper" && !ask.unsure || by === "user" && receipt?.act === "answerAsk" && via !== "cli" && via !== "timer") ?
      { expiresAt: this.now() + MERGE_APPROVAL_MS, ...(keeperSource.delegation ? { delegationId: keeperSource.delegation.id } : {}) } : undefined;
    const answerData = { askId, optionId, answeredBy: by, ...(standing ? { preapproval: { id: standing.grant.id, at: standing.grant.at, surface: standing.grant.surface } } : {}), ...(by === "keeper" ? { keeperName: this.name(this.require(ask.keeperThreadId, "keeper")), ...keeperSource } : {}), ...(receipt ? { authority: receipt } : {}) };
    commitUserAct(this.store, () => this.now(), receipt, () => {
      if (standing) this.authority.consume(standing);
      this.store.put("asks", ask.id, {
        ...ask,
        state: by === "default" ? "defaulted" : "answered",
        ...(mergeApproval ? { mergeApproval } : {}),
        answer: { optionId, note, via, by, at: this.now(), ...(keeperSource.keeperAuthority ? { keeperAuthority: keeperSource.keeperAuthority } : {}), ...(heldCommunication?.act === "draft" && keeperSource.delegation ? { draftDelegationId: keeperSource.delegation.id } : {}), ...(surface ? { surface } : {}), ...(standing ? { preapproval: { id: standing.grant.id, at: standing.grant.at, surface: standing.grant.surface } } : {}) },
      });
      applyAskEffect(effect, {
        ...effects,
        "grant-shell-act": () => {
          if (effect.type !== "grant-shell-act") return;
          if (by !== "keeper" && (by !== "user" || receipt?.act !== "answerAsk" || via === "timer")) throw new Error("A shell grant needs an explicit answer.");
          if (optionId === "once" || optionId === "quest") issueShellGrant(this.store, ask, optionId, by, this.now());
          if (effect.heldEventId) {
            const hold = this.store.get("scopeActObservations", effect.heldEventId);
            if (hold && hold.keeperThreadId === ask.keeperThreadId && hold.threadId === effect.memberThreadId)
              this.store.put("scopeActObservations", effect.heldEventId, { ...hold, resolvedAt: this.now() });
          }
        },
        "settle-waypoint": effect => {
          if (effect.type !== "settle-waypoint" || optionId !== "approve") return;
          if (by !== "user" || receipt?.act !== "answerAsk" || !ask.boardQuestId) throw new Error("This waypoint needs your explicit answer.");
          const call = { boardQuestId: ask.boardQuestId, waypointId: effect.waypointId, as: effect.as, reason: effect.reason };
          const target = this.waypointForSettlement(ask.keeperThreadId, call);
          if (target.q.planVersion !== effect.planVersion) throw new Error("This waypoint ask belongs to an old plan.");
          this.recordSettlement(ask.keeperThreadId, call, target, ask.id, ask.id);
        },
        "user-waypoint": effect => {
          if (effect.type !== "user-waypoint" || !ask.boardQuestId) throw new Error("A user waypoint ask needs its quest.");
          const q = this.quest(ask.boardQuestId);
          const waypoint = this.store.get("plans", `${q.id}:${q.planVersion}`)?.waypoints.find(w => w.id === effect.waypointId);
          if (q.planVersion !== effect.planVersion || waypoint?.actor !== "user") throw new Error("This waypoint ask belongs to an old plan.");
          if (effect.completeOn.includes(optionId)) this.withdrawClosingForWaypointChange(q);
        },
        "soft-limit": effect => {
          if (effect.type !== "soft-limit" || optionId !== "approve") return;
          if (by !== "user" || receipt?.act !== "answerAsk") throw new Error("This exception needs your explicit answer.");
          this.decide(ask.keeperThreadId, { boardQuestId: ask.boardQuestId, text: effect.text, why: effect.reason,
            reversible: true, source: "ask", sourceRef: ask.id, exceeds: effect.limit }, undefined, { answerReceipt: ask.id });
        },
        "lead-plan": effect => {
          if (effect.type === "lead-plan") answerLeadPlan(this, effect.request, ask.id, optionId);
        },
        "member-schedules": effect => {
          if (effect.type !== "member-schedules" || optionId !== "approve") return;
          const member = this.member(effect.memberThreadId), permanent = member?.permanent;
          if (!member || member.role !== "member" || !isLiveMember(this.store, member, "schedule") || !permanent ||
              member.keeperThreadId !== ask.keeperThreadId || member.boardQuestId !== ask.boardQuestId || permanent.decisionId !== effect.permanentDecisionId)
            throw new Error("This ask no longer names a permanent member who is active or resting.");
          const current = permanent.schedules ?? [];
          if (current.length + effect.schedules.length > 3) throw new Error("A member can have at most three schedules.");
          this.store.put("members", member.threadId, { ...member, permanent: { ...permanent, schedules: [...current, ...startSchedules(this, effect.schedules)] } });
          this.changed(member.threadId, member.boardQuestId);
        },
        greenlight: effect => {
          if (effect.type !== "greenlight" || optionId !== "approve") return;
          if (!ask.boardQuestId) throw new Error("A greenlight needs its quest");
          const q = this.quest(ask.boardQuestId);
          if (q.phase !== "greenlight") throw new Error("This plan is no longer waiting for greenlight");
          if (effect.planVersion !== q.planVersion) throw new Error("This greenlight belongs to an old plan version");
          transitionQuest(this.store, q, "build", "approve", { kind: "user" }, { kind: "ask-answer", id: askId }, this.now(), { patch: { greenlitVersion: q.planVersion, checkPlanVersion: q.planVersion }, text: standing ? `Party approved: ${preapprovalWords(standing.grant)}. Hire it now, critical path first.` : "Party approved: hire it now, critical path first.", data: answerData });
          const proposal = q.spendProposal;
          if (proposal?.planVersion !== effect.planVersion) return;
          if (by === "user" && via !== "timer" && receipt?.act === "answerAsk" && !q.spendBudget?.reached)
            changeSpendBudget(this, q.id, proposal.cents, receipt, null, effect.planVersion);
          else this.store.event(this.now(), q.keeperThreadId, q.id, "spend-budget.proposal-not-set", "The plan was greenlit without setting its proposed spend budget.", proposal, { kind: "tavern" });
        },
        "release-hold": effect => {
          if (effect.type !== "release-hold" || optionId !== "release") return;
          if (!ask.boardQuestId) throw new Error("A checker-handoff release ask needs its quest");
          this.releaseCheckerHandoff(ask.boardQuestId, effect.holdId, via as NonNullable<CheckerHandoffHold["release"]>["via"], ask.id);
        },
      }, { by, id: ask.id });
      if (!(effect.type === "greenlight" && optionId === "approve")) this.store.event(
        this.now(),
        ask.keeperThreadId,
        ask.boardQuestId,
        by === "default" ? "ask.defaulted" : "ask.answered",
        effect.type === "lead-plan" && optionId === "approve"
          ? "You approved this exact lead plan."
          : ask.kind === "greenlight" && optionId === "approve"
          ? "Party approved: hire it now, critical path first."
          : ask.kind === "scope" && optionId === "deny"
            ? `${SCOPE_DENIAL_TEXT}${note ? ` User note: ${note}` : ""}`
            : effect.type === "user-waypoint"
            ? `Answered: ${ask.question} — ${optionId}. ${effect.completeOn.includes(optionId) ? "Your waypoint is done." : "Your waypoint stays open."}${note ? ` User note: ${note}` : ""}`
            : `${standing ? preapprovalWords(standing.grant) : by === "keeper" ? "Keeper decided" : by === "default" ? "Default applied to a reversible choice" : "Answered"}: ${ask.question} — ${optionId}${note ? `: ${note}` : ""}`,
        answerData,
        by === "keeper" ? { kind: "agent", threadId: ask.keeperThreadId } : by === "user" ? { kind: "user" } : { kind: "tavern" },
      );
    }, () => {
      if (by === "user") this.userAction(ask.keeperThreadId);
      if (effect.type === "grant-shell-act" && by !== "keeper") this.syncShellGrants(effect.memberThreadId);
      if (heldCommunication?.act === "draft" && optionId === "approve" && by !== "keeper") this.syncCommunication(heldCommunication.threadId, askId);
      const target = askMemberTarget({ ...ask, effect });
      const stale = this.changedTags(ask.keeperThreadId, ask.boardQuestId);
      if (target && !stale.includes(tags.thread(target))) stale.push(tags.thread(target));
      this.invalidate(stale);
    });
  }
  postSummary(threadId: string, draft: SummaryDraft) {
    this.require(threadId, "keeper");
    const quest = this.quest(draft.boardQuestId);
    if (quest.keeperThreadId !== threadId) throw new Error("A Keeper can only post a summary to its own quest.");
    if (!isOpenQuest(quest)) throw new Error("Only an active quest can receive a summary.");
    this.guard(threadId, quest.id);
    const summary = this.store.atomic(() => {
      const summary = appendSummary(this.store, threadId, draft, this.now());
      const [link] = this.store.leadLinksBy("childQuestId", quest.id);
      if (link?.childKeeperThreadId === threadId && link.state === "linked") {
        this.store.event(this.now(), link.parentKeeperThreadId, link.parentQuestId, "lead.summary", summary.title,
          { summaryId: summary.id, childQuestId: quest.id, leadLinkId: link.id }, { kind: "agent", threadId });
        this.changed(link.parentKeeperThreadId, link.parentQuestId);
      }
      return summary;
    });
    this.invalidate([tags.room(), tags.thread(threadId), tags.boardQuest(quest.id)]);
    return summary;
  }
  decide(
    threadId: string,
    input: Pick<Decision, "coveredBy" | "options" | "consequence" | "unsure" | "leadPlan"> & {
      askId?: string; optionId?: string; kind?: import("../../shared/quest-authority").DelegationKind;
      boardQuestId?: string | null;
      text: string;
      why: string;
      reversible: boolean;
      exceeds?: "party" | "rangers";
      source: "keeper" | "steer" | "ask" | "user";
      sourceRef?: string | null;
    },
    autoApproval?: { questId: string; planVersion: number },
    effect?: Pick<Decision, "waypointCall" | "checkChange" | "answerReceipt" | "pullRequestReady" | "pullRequestGrant" | "leadPlan" | "permanentChange">,
  ) {
    this.require(threadId, "keeper");
    const questId = input.boardQuestId ?? null;
    if (questId) {
      this.liveQuest(threadId, questId);
      this.guard(threadId, questId);
    }
    if (input.source === "user") {
      const citation = input.askId ?? (input.coveredBy?.kind === "answer" ? input.coveredBy.id : input.sourceRef);
      throw new Error(`A tool cannot assert user consent${citation ? ` for ${citation}` : ""}; record the user's answer with source "ask", askId and the selected optionId.`);
    }
    if (input.source === "keeper" && !input.reversible)
      throw new Error(
        "Consequential decisions need a user ask, not an autonomous decision",
      );
    if (input.source === "ask") {
      const ask = input.sourceRef
        ? this.store.get("asks", input.sourceRef)
        : null;
      if (
        !ask ||
        ask.keeperThreadId !== threadId ||
        ask.boardQuestId !== questId ||
        ask.state !== "answered" ||
        ask.answer?.by !== "user"
      )
        throw new Error(`Decision source ${input.sourceRef ?? "(missing)"} must be an ask answered by the user for this quest. Read tavern_status section=asks for the recorded answer.`);
      if (input.askId && (input.askId !== ask.id || input.optionId !== ask.answer.optionId))
        throw new Error(`Ask ${ask.id} was answered with optionId ${JSON.stringify(ask.answer.optionId)}. Record that exact ask and option.`);
    }
    if (input.source === "steer") {
      const route = input.sourceRef
        ? this.store.get("routes", input.sourceRef)
        : null;
      if (
        !route ||
        route.kind !== "steer" ||
        route.keeperThreadId !== threadId ||
        (questId !== null && !routeQuestIds(route).includes(questId))
      )
        throw new Error(
          "Decision source must be a recorded steer for this quest",
        );
      if (!input.reversible)
        throw new Error("Consequential decisions require an answered user ask");
    }
    if (input.exceeds) {
      if (!input.reversible || input.askId || input.kind) throw new Error("A soft limit decision must be a separate, reversible call.");
      if (!effect?.answerReceipt) {
        this.assertUnusedSoftLimitAnswer(input.sourceRef);
        assertUndoLane(this.store, threadId, input.exceeds);
      }
    }
    authorize(input.source === "steer" ? "steerDecision" : input.source === "ask" ? "answerAsk" : "defaultDecision", { level: input.source === "steer" ? "user-in-words" : input.source === "ask" ? "user-explicit" : "keeper", receipt: input.sourceRef ?? input.text });
    const decision = decisionSchema.parse({
      ...input,
      leadPlan: undefined,
      ...effect,
      id: this.store.id("decision"),
      keeperThreadId: threadId,
      boardQuestId: questId,
      sourceRef: input.sourceRef ?? null,
      undone: false,
      createdAt: this.now(),
    });
    this.store.atomic(() => {
      if (input.askId && input.source !== "ask") {
        const ask = this.store.get("asks", input.askId);
        if (!ask || ask.keeperThreadId !== threadId || ask.boardQuestId !== questId || input.source !== "keeper" || !input.optionId || (input.kind && input.kind !== ask.kind)) throw new Error("A Keeper answer needs its own exact quest ask, kind and option");
        this.answerAsk(ask.id, input.optionId, input.why, "chat", "keeper");
      } else if (!input.askId && input.kind) throw new Error("A delegated kind needs its exact askId and optionId");
      this.store.put("decisions", decision.id, decision);
      if (autoApproval) {
        transitionQuest(this.store, this.quest(autoApproval.questId), "build", "auto-approve", { kind: "agent", threadId }, { kind: "decision", id: decision.id }, this.now(), { patch: { greenlitVersion: autoApproval.planVersion, checkPlanVersion: autoApproval.planVersion }, text: decision.text, data: { decisionId: decision.id } });
      } else {
      const askSource = !input.askId ? {} : input.source === "ask"
        ? { askId: input.askId, optionId: input.optionId, answeredBy: "user" }
        : { askId: input.askId, answeredBy: "keeper", keeperName: this.name(this.require(threadId, "keeper")), ...this.authority.keeperDecisionSource(this.store.get("asks", input.askId)!) };
      this.store.event(
        this.now(),
        threadId,
        questId,
        "decision.made",
        decision.text,
        { decisionId: decision.id, ...(effect?.waypointCall ? { waypoint: { ...effect.waypointCall, reason: decision.why } } : {}), ...askSource, ...(decision.answerReceipt ? { askId: decision.answerReceipt, answeredBy: "user" } : {}) },
        decision.answerReceipt ? { kind: "user" } : { kind: "agent", threadId },
      );
      }
    });
    const keeperAskId = input.source === "keeper" ? input.askId : undefined;
    const grant = keeperAskId ? this.store.get("shellGrants", keeperAskId) : null;
    if (grant) this.syncShellGrants(grant.memberThreadId);
    const answered = keeperAskId ? this.store.get("asks", keeperAskId) : null;
    if (answered?.effect?.type === "communication-hold" && answered.effect.hold.act === "draft" && answered.answer?.optionId === "approve") this.syncCommunication(answered.effect.hold.threadId, answered.id);
    this.changed(threadId, questId);
    return decision;
  }
  undoDecision(id: string) {
    const d = this.store.get("decisions", id);
    if (!d) throw new Error("Unknown decision");
    if (!d.reversible) throw new Error("This decision is not reversible");
    if (d.undone) return;
    const approval = this.store.get("autoGreenlights", id);
    const shellGrant = d.askId ? this.store.get("shellGrants", d.askId) : null;
    if (shellGrant) this.syncShellGrants(shellGrant.memberThreadId);
    const q = (approval || d.waypointCall || d.checkChange) && d.boardQuestId ? this.quest(d.boardQuestId) : null;
    if ((approval || d.checkChange) && q?.phase === "held") throw new Error("This quest is held; resume it first");
    if ((d.waypointCall || d.checkChange) && q && !isOpenQuest(q)) throw new Error("This quest has ended; its waypoint record is fixed");
    const affectsCurrentWaypoint = q && d.waypointCall && (d.waypointCall.planVersion === q.planVersion ||
      this.waypointCalls(q.id, q.planVersion).get(d.waypointCall.waypointId)?.id === id);
    const affectedMembers: string[] = [];
    this.store.atomic(() => {
      this.store.put("decisions", id, { ...d, undone: true });
      if (d.permanentChange === "slot" && d.boardQuestId) {
        for (const plan of this.store.query("plans", "boardQuestId", d.boardQuestId, -1)) {
          if (plan.party.some(slot => slot.permanent?.decisionId === id))
            this.store.put("plans", `${plan.boardQuestId}:${plan.version}`, { ...plan, party: plan.party.map(slot => slot.permanent?.decisionId === id ? { ...slot, permanent: undefined } : slot) });
        }
        for (const member of this.store.query("members", "boardQuestId", d.boardQuestId, -1)) {
          if (member.permanent?.decisionId !== id) continue;
          this.store.put("members", member.threadId, { ...member, permanent: undefined });
          affectedMembers.push(member.threadId);
        }
      } else if (d.permanentChange && d.permanentChange !== "slot") {
        const member = this.member(d.permanentChange.memberThreadId);
        if (member?.permanent?.decisionId === id) {
          this.store.put("members", member.threadId, { ...member, permanent: undefined });
          affectedMembers.push(member.threadId);
        } else if (member?.permanent?.closingExemption?.decisionId === id) {
          this.store.put("members", member.threadId, { ...member, permanent: { ...member.permanent, closingExemption: undefined } });
          affectedMembers.push(member.threadId);
        }
      }
      let phaseChanged = undoLeadPlan(this, d);
      const grantAtUndo = shellGrant && this.store.get("shellGrants", shellGrant.id);
      if (grantAtUndo?.state === "issued") settleShellGrant(this.store, grantAtUndo.id, "revoked", this.now(), "Undo revoked the Keeper’s shell grant.");
      if (d.askId && !shellGrant) {
        const ask = this.store.get("asks", d.askId);
        if (ask?.answer?.by === "keeper" && ask.answer.optionId === d.optionId && (!ask.boardQuestId || isOpenQuest(this.quest(ask.boardQuestId)))) this.store.put("asks", ask.id, { ...ask, state: "open", answer: null, unsure: true, lane: "user" });
      }
      if (q && affectsCurrentWaypoint) this.withdrawClosingForWaypointChange(q);
      if (d.checkChange && q && (q.greenlitVersion ?? 0) < d.checkChange.planVersion) {
        const previous = this.store.get("plans", `${q.id}:${d.checkChange.previousVersion}`);
        const current = this.store.get("plans", `${q.id}:${q.planVersion}`);
        if (previous && current && !checksFit(current, previous)) {
          for (const ask of this.store.openAsks(q.keeperThreadId, q.id)) {
            if (ask.kind === "conclude" || ask.kind === "greenlight") this.withdrawAsk(ask.id, "plan-superseded");
          }
          const patch = { checkPlanVersion: previous.version };
          const text = `Undid the check change: ${d.text}`;
          if (this.quest(q.id).phase === "build") {
            transitionQuest(this.store, q, "greenlight", "undo", { kind: "user" }, { kind: "undo", id }, this.now(), { patch, text, data: { decisionId: id } });
            phaseChanged = true;
          } else this.store.put("quests", q.id, { ...this.quest(q.id), ...patch });
          this.askGreenlight(q, current, "You undid the change to these checks. The weaker checks need your greenlight.", true);
        }
      }
      const approval = this.store.get("autoGreenlights", id);
      if (approval) {
        const q = this.quest(approval.boardQuestId);
        if (
          q.greenlitVersion === approval.planVersion &&
          isOpenQuest(q)
        ) {
          transitionQuest(this.store, q, "greenlight", "undo", { kind: "user" }, { kind: "undo", id }, this.now(), { patch: { greenlitVersion: null, checkPlanVersion: undefined }, text: `Undo this decision and reconcile its effects: ${d.text}`, data: { decisionId: id } });
          phaseChanged = true;
          this.ask(
            d.keeperThreadId,
            { effect: { type: "greenlight", planVersion: q.planVersion },
              boardQuestId: q.id,
              kind: "greenlight",
              question: `Form the party for ${q.title}, plan v${q.planVersion}?`,
              why: "The user undid the automatic approval; staffing requires a new explicit greenlight.",
              options: [
                {
                  id: "approve",
                  label: "Form the party",
                  recommended: true,
                  detail: "Approve this plan version",
                },
                {
                  id: "revise",
                  label: "Revise the plan",
                  recommended: false,
                  detail: "Keep scouting; do not staff",
                },
              ],
              meanwhile: "Wait for the user's greenlight.",
              holds: this.store
                .get("plans", `${q.id}:${q.planVersion}`)!
                .waypoints.map((w) => w.id),
            },
            { planVersion: q.planVersion },
          );
        }
      }
      if (!phaseChanged) this.store.event(
        this.now(),
        d.keeperThreadId,
        d.boardQuestId,
        "decision.undone",
        grantAtUndo ? "The grant cannot be used again. Commands that already ran cannot be undone by Tavern." : d.pullRequestGrant ? "Undo revokes the one-use exception. If the command already ran, its effects cannot be reversed by Tavern." : `Undo this decision and reconcile its effects: ${d.text}`,
        { decisionId: id },
        { kind: "user" },
      );
    });
    if (shellGrant) this.syncShellGrants(shellGrant.memberThreadId);
    this.userAction(d.keeperThreadId);
    this.invalidate([...this.changedTags(d.keeperThreadId, d.boardQuestId), ...affectedMembers.map(tags.thread), tags.undoLanes()]);
  }
  private messageRule(threadId: string, text: string, questId: string | null, sourceMessageId?: string) {
    if (sourceMessageId) {
      const receipt = this.store.partyMessageReceipt(threadId, sourceMessageId);
      const member = receipt && this.member(receipt.thread_id);
      if (!receipt || member?.role !== "member" || member.keeperThreadId !== threadId ||
          questId && (receipt.board_quest_id !== questId || member.boardQuestId !== questId))
        throw new Error(`Source ${sourceMessageId} is not a user message to a member of this party for that scope. Cite the receiptId of an applicable user.told-member event.`);
      if (receipt.accepted !== 1)
        throw new Error(`Source ${sourceMessageId} in ${member.threadId} was not accepted. Cite an accepted user message instead.`);
      if (receipt.text.trim() !== text.trim())
        throw new Error(`Copy the user's rule verbatim from ${sourceMessageId} in ${member.threadId}.`);
      return { sourceMessageId, sourceThreadId: member.threadId, at: receipt.at };
    }
    const routes = this.applicableRoutes(threadId).filter(
      (route) =>
        route.kind === "rule" &&
        (!questId || routeQuestIds(route).includes(questId)),
    );
    if (!routes.length)
      throw new Error("Source message needs an applicable user rule route or sourceMessageId from a user.told-member event.");
    const metadata = this.store.runtime(threadId).routes ?? [];
    const route = routes.find((route) => {
      const receiptId = metadata.find(
        (item) => item.id === route.id,
      )?.receiptId;
      return (
        receiptId && this.store.messageText(receiptId)?.trim() === text.trim()
      );
    });
    if (!route)
      throw new Error(
        "Copy the user's rule verbatim for source message; otherwise propose it for confirmation",
      );
    return { sourceRef: route.id, at: route.messageAt };
  }
  addRule(
    input: Pick<Rule, "scope" | "scopeId" | "text" | "source">,
    keeperThreadId: string | null = null,
    evidence?: { sourceMessageId?: string; supersedesRuleId?: string },
  ) {
    if (input.scope === "quest" && input.scopeId && !isOpenQuest(this.quest(input.scopeId))) throw new Error("This board quest has ended or is stopping");
    if ((input.scope === "global") !== (input.scopeId === null))
      throw new Error("Only global rules have no scope id");
    if (input.source === "message" && keeperThreadId && input.scope === "global") {
      const broad = /\b(?:all(?:\s+of)?(?:\s+the)?\s+keepers|every\s+keeper|all(?:\s+the)?\s+tavern\s+threads|every\s+tavern\s+thread)\b/i.test(input.text);
      const local = /\b(?:(?:only|just)\s+(?:this|the current)\s+(?:keeper|thread)|not\s+(?:all|every)\s+keepers?)\b/i.test(input.text);
      const denied = /\b(?:do not|don['’]t|never)\s+(?:apply|extend|share)\b[^.!?\n]*\b(?:all|every)\b/i.test(input.text);
      if (!broad || local || denied)
        throw new Error("Keep this rule scoped to this Keeper unless the user's own words explicitly apply it to all Keepers or all Tavern threads. The user can widen it on its route receipt.");
    }
    const supersedesRuleId = evidence?.supersedesRuleId;
    if (evidence && input.source !== "message" && (supersedesRuleId || evidence.sourceMessageId))
      throw new Error(`Only a user's exact message can ${supersedesRuleId ? `supersede rule ${supersedesRuleId}` : `cite ${evidence.sourceMessageId}`}. Use source "message" with the user's verbatim correction.`);
    const origin = input.source === "message" && keeperThreadId && evidence
      ? this.messageRule(keeperThreadId, input.text, input.scope === "quest" ? input.scopeId : null, evidence.sourceMessageId)
      : undefined;
    const previous = supersedesRuleId ? this.store.get("rules", supersedesRuleId) : null;
    if (supersedesRuleId && (!origin || !previous?.active || previous.keeperThreadId !== keeperThreadId ||
        previous.scope !== input.scope || previous.scopeId !== input.scopeId || origin.at < previous.createdAt))
      throw new Error(`Cannot supersede rule ${supersedesRuleId}: it needs a newer user message and an active rule of this Keeper in the same scope. Read tavern_status section=rules for the active rule and its scope.`);
    const r = ruleSchema.parse({
      ...input,
      supersedesRuleId,
      id: this.store.id("rule"),
      keeperThreadId,
      active: input.source !== "keeper-proposed",
      createdAt: this.now(),
    });
    this.store.atomic(() => {
      this.store.put("rules", r.id, r);
      if (previous) this.store.put("rules", previous.id, { ...previous, active: false, supersededByRuleId: r.id });
      const sourceRef = origin?.sourceRef;
      if (sourceRef) {
        const route = this.store.get("routes", sourceRef);
        if (!route || route.kind !== "rule" || route.keeperThreadId !== keeperThreadId)
          throw new Error("A rule needs its own Keeper's rule route");
        this.store.put("routes", sourceRef, { ...route, ruleId: r.id });
      }
      this.store.event(
        this.now(), keeperThreadId, input.scope === "quest" ? input.scopeId : null,
        "rule.added", r.text, { ruleId: r.id, sourceRef: sourceRef ?? null, scope: r.scope, scopeId: r.scopeId,
          ...(origin?.sourceMessageId ? { sourceMessageId: origin.sourceMessageId, sourceThreadId: origin.sourceThreadId } : {}),
          ...(previous ? { supersedesRuleId: previous.id } : {}) },
      );
    });
    this.invalidateRule(r, r.active, keeperThreadId);
    return r;
  }
  confirmRule(id: string, active: boolean) {
    const r = this.store.get("rules", id);
    if (!r) throw new Error("Unknown rule");
    if (active && r.supersededByRuleId) throw new Error(`Rule ${id} was superseded by ${r.supersededByRuleId}. Review the replacement instead.`);
    this.store.put("rules", id, { ...r, active, confirmedAt: this.now() });
    this.store.event(
      this.now(),
      r.scope === "keeper" ? r.scopeId : null,
      r.scope === "quest" ? r.scopeId : null,
      "rule.confirmed",
      `${active ? "Activated" : "Deactivated"}: ${r.text}`,
      { ruleId: id },
      { kind: "user" },
    );
    const keeperId = r.keeperThreadId ?? (r.scope === "keeper" ? r.scopeId : r.scope === "quest" ? this.quest(r.scopeId!).keeperThreadId : null);
    if (keeperId && isLiveKeeper(this.store, this.member(keeperId), "present")) this.userAction(keeperId);
    this.invalidateRule(r);
  }
  private ruleMembers(rule: Rule) {
    const questKeeper = rule.scope === "quest" ? this.quest(rule.scopeId!).keeperThreadId : null;
    return this.store.all("members").filter(member =>
      rule.scope === "global" ||
      (rule.scope === "project" && this.store.runtime(member.threadId).projectId === rule.scopeId) ||
      (rule.scope === "keeper" && (member.threadId === rule.scopeId || member.keeperThreadId === rule.scopeId)) ||
      (rule.scope === "quest" && (member.threadId === questKeeper || member.boardQuestId === rule.scopeId)),
    );
  }
  private invalidateRule(rule: Rule, notify = true, exceptKeeperId?: string | null) {
    for (const member of this.ruleMembers(rule)) {
      if (notify && isLiveKeeper(this.store, member, "present") && member.threadId !== exceptKeeperId)
        this.store.event(this.now(), member.threadId, null, "rules.changed",
          "Standing rules changed. Re-read the active rules in this ledger.");
      this.changed(member.threadId, member.boardQuestId);
    }
    this.invalidate([tags.room(), tags.attentionCount()]);
  }
  widenRule(id: string, scope: "global" | "project" | "keeper") {
    const rule = this.store.get("rules", id);
    if (!rule) throw new Error("Unknown rule");
    const rank = { quest: 0, keeper: 1, project: 2, global: 3 };
    if (rank[scope] <= rank[rule.scope]) throw new Error("Choose a strictly wider rule scope");
    const keeperId = rule.scope === "keeper" ? rule.scopeId
      : rule.scope === "quest" ? this.quest(rule.scopeId!).keeperThreadId : null;
    const projectId = rule.scope === "project" ? rule.scopeId
      : keeperId ? this.store.runtime(keeperId).projectId : null;
    const scopeId = scope === "global" ? null : scope === "keeper" ? keeperId : projectId;
    if (scope !== "global" && !scopeId) throw new Error("The rule has no identity for that wider scope");
    const widened: Rule = { ...rule, scope, scopeId, widenedAt: this.now(), widenedBy: { kind: "user" } };
    this.store.atomic(() => {
      this.store.put("rules", id, widened);
      this.store.event(this.now(), keeperId, null, "rule.widened", rule.text,
        { ruleId: id, previousScope: rule.scope, previousScopeId: rule.scopeId, scope, scopeId }, { kind: "user" });
      const actedKeeperId = rule.keeperThreadId ?? keeperId;
      if (actedKeeperId && isLiveKeeper(this.store, this.member(actedKeeperId), "present")) this.userAction(actedKeeperId);
    });
    this.invalidateRule(widened, widened.active);
    return widened;
  }
  invalidateAll(notify = true, exceptKeeperId?: string | null) {
    for (const m of this.store.all("members")) {
      if (notify && isLiveKeeper(this.store, m, "present") && m.threadId !== exceptKeeperId)
        this.store.event(
          this.now(),
          m.threadId,
          null,
          "rules.changed",
          "Standing rules changed. Re-read the active rules in this ledger.",
        );
      this.changed(m.threadId, m.boardQuestId);
    }
    this.invalidate([tags.room(), tags.attentionCount()]);
  }
  rules(threadId: string, questId?: string | null, includeInactive = false) {
    const m = this.member(threadId);
    const keeper = isKeeperIdentity(this.store, m);
    const keeperId = keeper ? threadId : m?.keeperThreadId ?? threadId;
    const projectId = this.store.runtime(threadId).projectId;
    return this.store.activeRules(
      keeperId,
      projectId,
      questId ?? null,
      keeper,
      includeInactive,
    );
  }
  report(
    threadId: string,
    input: Pick<
      Report,
      "status" | "outcome" | "headline" | "evidence" | "artifacts" | "confidence" | "wait" | "checkpoint"
    > & Partial<Pick<Report, "voice">>,
  ) {
    const m = this.require(threadId, "member");
    const ranger = m.classId === "ranger";
    if (input.status === "checkpoint" ? !ranger || !input.checkpoint : input.checkpoint !== undefined)
      throw new Error("Only a Ranger checkpoint includes checkpoint.left and checkpoint.moreMinutes.");
    if (input.status === "done" && input.wait) throw new Error("A done report cannot declare a wait.");
    if (input.status === "checkpoint" && input.wait) throw new Error("A checkpoint already waits for the Keeper; omit wait.");
    const rangerCheckIn = ranger && (input.status === "done" || input.status === "checkpoint");
    const late = !isLiveMember(this.store, m, "brief") || m.engagement === "resting" && (input.status !== "done" || ranger) || !isLiveKeeper(this.store, this.member(m.keeperThreadId!), "present");
    const entries = this.journal
      .get(threadId)
      .entries.filter((e) => e.link?.boardQuestId === m.boardQuestId);
    if (
      !late && input.status === "done" &&
      (m.waypointId || entries.length) &&
      m.classId !== "warden" &&
      (!entries.length ||
        entries.some(
          (e) =>
            !["done", "verified"].includes(e.status) || e.evidence.length === 0,
        ))
    ) {
      throw new Error(
        "Mark every linked waypoint entry done with evidence first, then file the done report.",
      );
    }
    const limitation = reviewLimitation(m.checkIndependence);
    const outcome = m.classId === "warden" && limitation && !input.outcome.startsWith(limitation)
      ? `${limitation}: ${input.outcome}`
      : input.outcome;
    const { headline: suppliedHeadline, ...details } = input;
    let headline = reportSchema.shape.headline.parse(suppliedHeadline);
    if (m.classId === "warden" && headline !== undefined) {
      const claim = headline.replace(/\b(?:not|no)\s+independen(?:t(?:ly)?|ce)\b/gi, "");
      if (/\bindependen(?:t(?:ly)?|ce)\b/i.test(claim))
        throw new Error("A Warden's headline must state the check result, not claim independence");
      if (limitation && !headline.startsWith(limitation))
        headline = `${limitation}: ${headline}`;
      if (limitation && headline.length > 160)
        throw new Error(`Headline must leave room for the ${m.checkIndependence === "same-family" ? "same-family" : "not-established"} label; use at most ${160 - limitation.length - 2} characters before the label`);
    }
    const report = reportSchema.parse({
      ...details,
      ...(headline === undefined ? {} : { headline }),
      outcome,
      id: this.store.id("report"),
      memberThreadId: threadId,
      keeperThreadId: m.keeperThreadId,
      boardQuestId: m.boardQuestId,
      waypointId: m.waypointId,
      voice: null,
      createdAt: this.now(),
      deliveredAt: late ? this.now() : null,
    });
    const previous = this.store.query("reports", "memberThreadId", threadId, 1)[0];
    const quest = m.boardQuestId ? this.store.get("quests", m.boardQuestId) : null;
    const reviewPlanVersion = quest?.checkPlanVersion ?? quest?.greenlitVersion;
    const reviewPlan = quest && reviewPlanVersion && this.store.get("plans", `${quest.id}:${reviewPlanVersion}`);
    const reviewWaypoints = !late && report.status === "done" && !ranger && m.classId !== "warden" && reviewPlan
      ? reviewPlan.waypoints.flatMap(w => {
          const entryIds = entries.filter(e => e.link?.waypointId === w.id && e.status === "done").map(e => e.id);
          return entryIds.length && w.actor === "agent" && waypointCheck(w) === "warden" ? [{ waypointId: w.id, entryIds }] : [];
        })
      : [];
    const rejections = quest && previous && reviewWaypoints.length
      ? this.store.db.prepare(`SELECT DISTINCT json_extract(data,'$.waypointId') AS waypointId
        FROM tavern_events WHERE board_quest_id=? AND type IN ('waypoint.review-round','waypoint.review-rejected')
        AND json_extract(data,'$.reportId')=? AND json_extract(data,'$.verdict')='rejected'`)
        .all(quest.id, previous.id) as { waypointId: string }[]
      : [];
    if (
      previous && !rejections.some(rejection => reviewWaypoints.some(w => w.waypointId === rejection.waypointId)) &&
      (this.store.runtime(threadId).briefVersion ?? 0) ===
        (this.store.runtime(threadId).reportedBriefVersion ?? 0) &&
      previous.status === report.status &&
      previous.outcome === report.outcome &&
      previous.headline === report.headline &&
      JSON.stringify(previous.evidence) === JSON.stringify(report.evidence) &&
      JSON.stringify(previous.artifacts) === JSON.stringify(report.artifacts) &&
      isDeepStrictEqual(previous.wait, report.wait) && isDeepStrictEqual(previous.checkpoint, report.checkpoint)
    )
      return { ...previous, voice: null };
    if (!late && rangerCheckIn && m.rangerCheckpointReportId)
      throw new Error(`Report ${m.rangerCheckpointReportId} is waiting for the Keeper; end your turn.`);
    this.store.atomic(() => {
      this.store.put("reports", report.id, report);
      if (!late) {
        this.memory.clearMemberWait(threadId);
        this.memory.recordMemberWait(report);
      }
      this.store.patch(threadId, { reportedBriefVersion: this.store.runtime(threadId).briefVersion ?? 0 });
      const text = `${this.name(m)}: ${input.outcome}`, data = { reportId: report.id, status: input.status,
        ...(reviewWaypoints.length ? { makerThreadId: threadId, reviewPlanVersion, reviewWaypoints } : {}) };
      if (!late && input.status === "done" && !ranger && m.engagement === "active") {
        transitionMember(this.store, m, memberDetails(this.store, threadId).delivery ? "briefing" : "resting", "done-report", { kind: "agent", threadId }, { kind: "report", id: report.id }, this.now(), { text, data });
      } else {
        if (!late && (input.status !== "done" || rangerCheckIn)) this.activity(threadId, "waiting");
        this.store.event(this.now(), m.keeperThreadId, m.boardQuestId, late ? "report.late" : "report.filed", text, data);
      }
      this.store.put("members", threadId, {
        ...this.member(threadId)!,
        ...(!late && rangerCheckIn ? { rangerCheckpointReportId: report.id } : {}),
        doing: input.outcome.slice(0, 300),
        lastReportAt: this.now(),
        strikes: 0,
      });
    });
    this.changed(threadId, m.boardQuestId);
    return report;
  }
  private reviewSubmission(questId: string, makerThreadId: string, waypointId: string) {
    return this.store.db.prepare(`SELECT json_extract(data,'$.reportId') AS reportId,
      json_extract(data,'$.reviewPlanVersion') AS planVersion, json_extract(w.value,'$.entryIds') AS entryIds
      FROM tavern_events, json_each(data,'$.reviewWaypoints') w WHERE board_quest_id=? AND tavern_events.type='report.filed'
      AND json_extract(data,'$.makerThreadId')=? AND json_extract(w.value,'$.waypointId')=? ORDER BY tavern_events.id DESC LIMIT 1`)
      .get(questId, makerThreadId, waypointId) as { reportId: string; planVersion: number; entryIds: string } | undefined;
  }
  recordWardenRound(actor: Actor, entries: JournalEntry[]) {
    const warden = actor.kind === "agent" ? this.member(actor.threadId) : null;
    if (warden?.classId !== "warden" || !warden.boardQuestId) return;
    const q = this.quest(warden.boardQuestId);
    if (!isOpenQuest(q)) return;
    const makerThreadId = entries[0]?.threadId;
    if (!makerThreadId) return;
    const waypoints = new Set(entries.flatMap(e => e.link?.boardQuestId === q.id ? [e.link.waypointId] : []));
    for (const waypointId of waypoints) {
      const submission = this.reviewSubmission(q.id, makerThreadId, waypointId);
      if (!submission) continue;
      const { reportId } = submission;
      const submitted = new Set<string>(JSON.parse(submission.entryIds));
      const reviewed = entries.filter(e => e.link?.waypointId === waypointId && submitted.has(e.id));
      if (!reviewed.length) continue;
      const verdict = reviewed.some(e => e.status === "rejected") ? "rejected" : "verified";
      const prior = this.store.db.prepare(`SELECT json_extract(data,'$.verdict') AS verdict, json_extract(data,'$.planVersion') AS planVersion
        FROM tavern_events WHERE board_quest_id=? AND type IN ('waypoint.review-round','waypoint.review-rejected')
        AND json_extract(data,'$.waypointId')=? AND json_extract(data,'$.reportId')=? ORDER BY id DESC LIMIT 1`)
        .get(q.id, waypointId, reportId) as { verdict: string; planVersion: number } | undefined;
      if (prior && (prior.verdict === "rejected" || verdict === "verified")) continue;
      const planVersion = prior?.planVersion ?? submission.planVersion;
      this.store.event(this.now(), q.keeperThreadId, q.id, prior ? "waypoint.review-rejected" : "waypoint.review-round",
        `Warden ${verdict} work on ${waypointId} in plan v${planVersion}`,
        { waypointId, planVersion, verdict, reportId, makerThreadId, entryIds: reviewed.map(entry => entry.id) }, actor);
    }
  }
  checkerWaypoints(threadId: string) {
    const member = this.member(threadId);
    if (
      !member ||
      member.classId !== "warden" ||
      !member.boardQuestId ||
      wasReleased(member)
    )
      return [];
    const quest = this.quest(member.boardQuestId);
    const plan = this.store.get("plans", `${quest.id}:${quest.planVersion}`);
    if (!plan)
      return member.checkerWaypointId ? [member.checkerWaypointId] : [];
    const members = this.store
      .query("members", "boardQuestId", quest.id, 500)
      .filter((member) => !wasReleased(member));
    const waitingLeads = new Set(this.store.leadLinksBy("parentQuestId", quest.id)
      .filter(link => link.state === "linked" && !link.result).map(link => link.parentWaypointId));
    return checkerAssignments(plan, members).find(assignment => assignment.memberThreadId === threadId)
      ?.waypointIds.filter(id => !waitingLeads.has(id)) ?? [];
  }
  private waypointCalls(questId: string, version: number) {
    const rows = this.store.db.prepare(`SELECT d.data, 0 AS priority, d.rowid AS sequence
      FROM tavern_events e, json_each(e.data,'$.acceptances') a
      JOIN tavern_records d ON d.kind='decisions' AND d.id=json_extract(a.value,'$.decisionId')
      WHERE e.board_quest_id=@questId AND e.type='waypoint.acceptance-carried' AND json_extract(e.data,'$.toVersion')=@version
        AND json_extract(d.data,'$.undone')=0
      UNION ALL
      SELECT data, 1 AS priority, rowid AS sequence FROM tavern_records WHERE kind='decisions'
        AND json_extract(data,'$.boardQuestId')=@questId AND json_extract(data,'$.waypointCall.planVersion')=@version
        AND json_extract(data,'$.undone')=0 ORDER BY priority, sequence`).all({ questId, version }) as { data: string }[];
    const calls = new Map<string, Decision>();
    for (const row of rows) {
      const decision = JSON.parse(row.data) as Decision;
      calls.set(decision.waypointCall!.waypointId, decision);
    }
    return calls;
  }
  summary(id: string, planVersion?: number): BoardQuestSummary {
    return this.readQuestSummary(id, planVersion);
  }
  private readQuestSummary(id: string, planVersion?: number, submission?: { waypointId: string; entries: JournalEntry[] }): BoardQuestSummary {
    const current = this.quest(id);
    const q = planVersion === undefined ? current : { ...current, planVersion };
    const storedPlan = this.store.get("plans", `${id}:${q.planVersion}`),
      members = this.store.query("members", "boardQuestId", id),
      entries = this.journal.linkedEntries(id);
    const plan = storedPlan && { ...storedPlan, waypoints: storedPlan.waypoints.map(w => ({ ...w, check: waypointCheck(w) })) };
    const baseline = plan && q.greenlitVersion !== null && q.greenlitVersion !== plan.version
      ? this.store.get("plans", `${id}:${q.greenlitVersion}`) : null;
    const pathChange = plan && baseline ? (() => {
      const before = new Set(baseline.waypoints.map(w => w.id)), after = new Set(plan.waypoints.map(w => w.id));
      return { added: [...after].filter(id => !before.has(id)).length, removed: [...before].filter(id => !after.has(id)).length };
    })() : null;
    const missed = briefSteers(this, q, members);
    const byId = new Map<string, Member | null>(members.map(member => [member.threadId, member]));
    const memberOf = (threadId: string) => {
      if (!byId.has(threadId)) byId.set(threadId, this.member(threadId));
      return byId.get(threadId);
    };
    const released = new Set(
      [
        ...new Set([
          ...members.map((member) => member.threadId),
          ...entries.map((entry) => entry.threadId),
        ]),
      ].filter((threadId) => wasReleased(memberOf(threadId))),
    );
    const calls = this.waypointCalls(id, q.planVersion);
    const leadSeats = this.store.leadLinksBy("parentQuestId", q.id);
    const asks = this.store.openAsks(q.keeperThreadId, id).map(ask => currentAskNames(this.store, ask));
    const userAsks = new Map(asks.flatMap(ask => ask.effect?.type === "user-waypoint" && ask.effect.planVersion === q.planVersion
      ? [[ask.effect.waypointId, ask.id] as const] : []));
    const userAnswers = new Map<string, { done: boolean; label: string }>();
    if (storedPlan?.waypoints.some(w => w.actor === "user")) {
      const plans = new Map([[q.planVersion, storedPlan]]);
      for (const ask of this.store.answeredUserWaypoints(q.id)) {
        const effect = ask.effect;
        if (ask.keeperThreadId !== q.keeperThreadId || effect?.type !== "user-waypoint" || !ask.answer || effect.planVersion > q.planVersion) continue;
        const waypoint = storedPlan.waypoints.find(w => w.id === effect.waypointId && w.actor === "user");
        if (!waypoint) continue;
        // An answer carries across revisions only while the waypoint stays unchanged.
        let version = q.planVersion;
        for (; version > effect.planVersion; version--) {
          const previous = plans.get(version - 1) ?? this.store.get("plans", `${id}:${version - 1}`);
          if (previous) plans.set(version - 1, previous);
          if (!isDeepStrictEqual(waypoint, previous?.waypoints.find(w => w.id === waypoint.id))) break;
        }
        if (version !== effect.planVersion || userAnswers.get(waypoint.id)?.done) continue;
        const option = ask.options.find(o => o.id === ask.answer!.optionId);
        if (option) userAnswers.set(waypoint.id, { done: effect.completeOn.includes(option.id), label: option.label });
      }
    }
    const waypoints: BoardQuestSummary["waypoints"] = (
      plan?.waypoints ?? []
    ).map((w) => {
      const call = calls.get(w.id);
      const waiver = q.waivers?.find(waiver => waiver.waypointId === w.id && waiver.planVersion === q.planVersion);
      const recordsSubject = keeperSubject(w, q.keeperThreadId);
      const isLeadResult = (e: JournalEntry) => leadSeats.some(link => link.parentWaypointId === w.id && link.result?.entryId === e.id && link.result.makerThreadId === e.threadId);
      const candidates = entries.filter(e =>
        e.link?.boardQuestId === id && e.link.waypointId === w.id &&
        (w.actor === "user" ? e.threadId === q.keeperThreadId : w.actor === "agent" && e.owner !== "You" &&
          (recordsSubject ? e.threadId === q.keeperThreadId : e.threadId !== q.keeperThreadId)) &&
        memberOf(e.threadId)?.classId !== "warden" &&
        (recordsSubject || !memberOf(e.threadId)?.leadLinkId || isLeadResult(e)),
      );
      const currentWork = candidates.some(e => !released.has(e.threadId));
      let linked = candidates.filter(e =>
        isLeadResult(e) || !released.has(e.threadId) || e.status === "verified" ||
        e.status === "done" && (w.check === "none" || w.check === "keeper" && !currentWork || call?.waypointCall?.as === "accepted"));
      const journalMakers = new Set(linked.map(entry => entry.threadId));
      const owners = !recordsSubject && w.actor === "agent" ? members.filter(m =>
        m.classId !== "warden" && (m.threadId === w.owner || m.waypointId === w.id)).reverse() : [];
      const ownerMember = owners.find(m => m.threadId === w.owner && !released.has(m.threadId)) ??
        owners.find(m => !released.has(m.threadId)) ??
        owners.find(m => journalMakers.has(m.threadId)) ?? null;
      const legacySkip = w.optional && !call && this.store.get("skips", `${id}:${q.planVersion}:${w.id}`);
      const gate = this.memory.gateFor(q.id, q.planVersion, w.id);
      const hasReport = (rows: JournalEntry[]) => rows.length > 0 && rows.every(e =>
        e.status === "verified" || e.status === "done" && (w.check === "warden" || e.evidence.length > 0));
      const reported = hasReport(linked);
      const acceptedRefs = call?.waypointCall?.acceptedEntries;
      const acceptedKeys = acceptedRefs && new Set(acceptedRefs.map(ref => `${ref.threadId}:${ref.id}`));
      const acceptedWork = acceptedKeys ? linked.filter(e => acceptedKeys.has(`${e.threadId}:${e.id}`)) : linked;
      const rejected = linked.find(e => e.status === "rejected");
      const userAnswer = userAnswers.get(w.id);
      let state: WaypointState;
      let resolutionReason: string | null = userAnswer && !userAnswer.done ? `You answered “${userAnswer.label}”; this waypoint stays open.` : null;
      let acceptedBy: string | null = null;
      if (waiver) {
        state = "waived";
        resolutionReason = `${waiverWords(waiver.state)}; closed early at your request: ${waiver.reason}`;
      } else if (w.optional && (call?.waypointCall?.as === "skipped" || legacySkip)) {
        state = "skipped";
        const receipt = legacySkip && this.store.db.prepare(`SELECT json_extract(data,'$.reason') AS reason FROM tavern_events
          WHERE board_quest_id=? AND type='waypoint.skipped' AND json_extract(data,'$.version')=?
          AND json_extract(data,'$.waypointId')=? ORDER BY id DESC LIMIT 1`).get(id, q.planVersion, w.id) as { reason: string | null } | false | undefined;
        resolutionReason = call?.why ?? (receipt ? receipt.reason : null);
      } else if (w.check === "keeper" && call?.waypointCall?.as === "accepted" &&
        (w.actor === "outside" ? gate?.answer != null && gate.answeredAt !== null && gate.answeredAt <= call.createdAt
          : w.actor === "agent" && (!acceptedRefs || acceptedWork.length === acceptedRefs.length) &&
            hasReport(acceptedWork) && acceptedWork.every(e => (e.doneAt ?? e.createdAt) <= call.createdAt))) {
        state = "accepted";
        linked = acceptedWork;
        resolutionReason = call.why;
        const keeper = this.member(q.keeperThreadId);
        acceptedBy = call.answerReceipt ? "you" : keeper ? this.name(keeper) : "the Keeper";
      } else if (userAnswer?.done || reported && (w.check === "none" || w.check === "you" && linked.every(e => e.doneBy?.kind === "user"))) {
        state = "done";
        resolutionReason = userAnswer?.done ? `You answered “${userAnswer.label}”.` : null;
      }
      else if (w.check === "warden" && reported && linked.every(e => e.status === "verified")) state = "verified";
      else if (rejected) state = "rejected";
      else if (linked.some(e => e.status === "blocked")) state = "blocked";
      else if (linked.some(e => e.status === "doing")) state = "doing";
      else if (reported && w.actor === "agent") state = "reported";
      else state = linked.length ? "todo" : "planned";
      if (submission?.waypointId === w.id) submission.entries = linked;
      const madeBy = !recordsSubject && (state === "reported" || state === "verified" || (state === "accepted" || state === "done") && w.actor === "agent")
        ? [...new Set(linked.map(e => e.threadId))] : [];
      const checkedBy = state === "verified" ? [...new Set(linked.flatMap(entry => {
        const author = entry.review?.actor ?? entry.updatedBy;
        if (author.kind !== "agent" || author.threadId === entry.threadId) return [];
        const member = memberOf(author.threadId);
        return !member || member.classId === "warden" ? [author.threadId] : [];
      }))] : [];
      return {
        ...w,
        gate,
        state,
        resolutionReason,
        ...(!settled({ state }) && userAsks.has(w.id) ? { askId: userAsks.get(w.id)! } : {}),
        ...(waiver ? { waiver } : {}),
        acceptedBy,
        ownerMember,
        evidenceCount: linked.reduce((n, e) => n + e.evidence.length, 0),
        madeBy,
        checkedBy,
        verifiedBy: checkedBy[0] ?? null,
        rejectedReason: rejected
          ? rejected.review
            ? rejected.review.reason
            : rejected.note
          : null,
      };
    });
    const next = waypoints.find(w => !settled(w));
    const userMoveAsk = asks.find(ask => ask.id === next?.askId) ?? asks.find(ask => waypoints.some(w => w.askId === ask.id));
    const closing = q.phase === "closing" ? asks.find(a => a.kind === "conclude") : undefined;
    const verified = waypoints.filter(verifiedWaypoint).length;
    const skippedCount = waypoints.filter(
      (waypoint) => waypoint.state === "skipped",
    ).length;
    const accepted = waypoints.filter(w => w.state === "accepted").length;
    const done = waypoints.filter(w => w.state === "done").length;
    const progress = waypoints.length
      ? ` · verified ${verified} of ${waypoints.length}${accepted ? ` · accepted ${accepted}` : ""}${done ? ` · done ${done}` : ""}${skippedCount ? ` · skipped ${skippedCount}` : ""}`
      : "";
    const phase = displayStage(q.phase, waypoints, plan !== null);
    const newsBy = nextNewsBy(phase, members.filter(member => member.classId === "ranger" && !member.rangerCheckpointReportId && member.state !== "failed" && isLiveMember(this.store, member, "work")).flatMap(member => {
      const runtime = this.store.runtime(member.threadId);
      return runtime.brief?.timeboxMinutes != null ? [(runtime.rangerBox?.startedAt ?? runtime.initialBriefAt ?? member.createdAt) + runtime.brief.timeboxMinutes * 60_000] : [];
    }), this.memory.notes(q.keeperThreadId, 500, 0, id).filter(note => note.kind === "commitment" && note.state === "open" && note.dueAt != null).map(note => note.dueAt!));
    const clock = (at: number) => moveTime(at, this.now());
    const outcome =
      q.phase === "held" ? `Held by you since ${clock(q.held!.since)} · Resume` :
      q.phase === "done"
        ? q.outcome === "closed-early"
          ? plan
            ? `Returned, ${verified} verified${accepted ? `, ${accepted} accepted` : ""}, closed early, ${q.waivers?.length ?? 0} not verified`
            : "Returned, closed early without a quest map"
          : `Returned${progress}`
        : q.phase === "stopping"
          ? "Stopping"
          : q.phase === "stopped"
          ? `Stopped${progress}`
          : phase === "wrap"
            ? `Wrapping${progress}`
            : null;
    const placements = new PlacementStore(this.store.db);
    const pendingMachines = new Map(q.phase === "stopping" ? members.flatMap(member => {
      const record = outstandingArchivedPlacement(placements, member);
      return record ? [[member.threadId, record.blocked?.message ?? record.preservation.reason ?? "Machine cleanup is not confirmed."] as const] : [];
    }) : []);
    const childPlan = q.phase === "greenlight" ? this.store.get("leadPlans", `${q.id}:${q.planVersion}`) : null;
    const leadPlanLane = childPlan?.state === "pending" ? childPlan.lane : undefined;
    const leadChain = leadChainView(this, q, leadSeats, waypoints, asks);
    return {
      ...q,
      phase,
      ...(leadPlanLane ? { leadPlanLane } : {}),
      ...(leadChain ? { leadChain } : {}),
      nextNewsBy: newsBy,
      stopUnconfirmed: members.filter(member => !member.leadLinkId && (member.engagement === "stopping" || pendingMachines.has(member.threadId))).length + this.pendingQuestHires(id) +
        (q.phase === "stopping" ? this.store.leadLinksBy("parentQuestId", id).filter(link => link.childKeeperThreadId && holdsLeadSeat(link)).length : 0),
      stopPendingHires: q.phase === "stopping" ? this.pendingStopHires(id) : [],
      plan,
      waypoints,
      ...(missed.length ? { briefSteers: missed.map(({ memberThreadId, at, excerpt }) => ({ memberThreadId, at, excerpt })) } : {}),
      ...(pathChange && (pathChange.added || pathChange.removed) ? { pathChange } : {}),
      members: members.map(member => pendingMachines.has(member.threadId) ? { ...member, stopError: pendingMachines.get(member.threadId) } : member),
      openAsks: asks.filter(a => this.authority.lane(a) !== "keeper").length,
      move: {
        who:
          q.phase === "held" || !isOpenQuest(q)
            ? "nobody"
            : closing ? "you"
            : leadPlanLane === "keeper" ? "keeper"
            : phase === "wrap" || !plan
              ? "keeper"
              : asks.some(a => this.authority.lane(a) === "user")
                ? "you"
                : asks.some(a => this.authority.lane(a) === "keeper") || next?.state === "reported" && next.check === "keeper"
                  ? "keeper"
                : next?.actor === "outside"
                  ? "outside"
                  : next?.actor === "user"
                    ? "you"
                    : members.some(member => member.state !== "failed" && isLiveMember(this.store, member, "work"))
                      ? "party"
                      : "keeper",
        ...(!outcome && !closing && leadPlanLane !== "keeper" && userMoveAsk ? { askId: userMoveAsk.id } : {}),
        text:
          outcome ?? closing?.question ?? userMoveAsk?.question ??
          (leadPlanLane === "keeper" ? "The hiring Keeper decides on this child plan." : null) ??
          (asks.some(a => this.authority.lane(a) === "keeper") && !asks.some(a => this.authority.lane(a) === "user")
            ? `Waiting on ${this.name(this.require(q.keeperThreadId, "keeper"))}: ${asks.find(a => this.authority.lane(a) === "keeper")!.question}`
            : !plan
            ? "Propose the quest map"
            : (asks[0]?.question ?? next?.title ?? "Review the done-when")) + (newsBy === null ? "" : ` · ${newsBy < this.now() ? "news overdue since" : "next news by"} ${clock(newsBy)}`),
      },
    };
  }
  restatement(threadId: string) {
    return renderRestatement(this, threadId);
  }
  ledger(threadId: string) {
    const pending = this.memoryReviewPending(threadId) ? "Durable notes await review (tavern_memory unreviewed).\n\n" : "";
    return this.memory.snapshot(threadId, pending + this.restatement(threadId));
  }
  priorities(threadId: string) {
    return renderRestatement(this, threadId, true);
  }
  stale(keeperThreadId?: string, held: (threadId: string) => boolean = () => false,
    pendingWakeups?: (threadIds: string[]) => Promise<ReadonlySet<string>>) {
    const alerts = new Map<string, () => void>();
    const members = keeperThreadId
      ? this.store.query("members", "keeperThreadId", keeperThreadId)
      : this.store.all("members");
    for (const m of members.filter((m) => m.role === "member" && !m.permanent && !m.rangerCheckpointReportId && isLiveMember(this.store, m, "work") && m.state !== "failed" && isLiveKeeper(this.store, this.member(m.keeperThreadId!)) && !held(m.threadId))) {
      const now = this.now();
      const wait = this.memory.openMemberWait(m.threadId);
      if (wait?.dueAt != null && wait.dueAt > now) continue;
      const rt = this.store.runtime(m.threadId);
      const interval = this.settings(m.boardQuestId).knobs.staleMinutes * 60_000;
      const progress = this.journal.progress(m.threadId);
      const evidenceAt = Math.max(m.createdAt, m.lastReportAt ?? 0, rt.lastBriefAt ?? 0, progress.lastEvidenceAt ?? 0);
      if (m.state === "working" && now - (m.lastActiveAt ?? 0) < interval) {
        if (now - evidenceAt >= interval && rt.quietHintAt !== evidenceAt) alerts.set(m.threadId, () => {
          this.store.atomic(() => {
            this.store.patch(m.threadId, { quietHintAt: evidenceAt });
            this.store.event(now, m.keeperThreadId, m.boardQuestId, "member.quiet",
              `${this.name(m)} is working without recent progress evidence. Check the work before deciding whether to intervene.`, { memberThreadId: m.threadId });
          });
          this.changed(m.threadId, m.boardQuestId);
        });
        continue;
      }
      const releaseAt = this.settings().keepers.staleStrikes;
      const lastStrikeAt = rt.lastStrikeAt ?? 0;
      const strikes = lastStrikeAt && evidenceAt > lastStrikeAt ? 1 : m.strikes + 1;
      if (strikes > Math.max(2, releaseAt) || now - Math.max(m.lastActiveAt ?? 0, evidenceAt, lastStrikeAt, progress.quietSince ?? 0) < interval) continue;
      alerts.set(m.threadId, () => {
        this.store.atomic(() => {
          const current = this.member(m.threadId);
          if (!current || current.lastActiveAt !== m.lastActiveAt || current.lastReportAt !== m.lastReportAt || current.engagement !== m.engagement || current.strikes !== m.strikes) return;
          this.store.put("members", m.threadId, { ...current, strikes });
          this.store.patch(m.threadId, { lastStrikeAt: now });
          if (strikes <= 2 || strikes === releaseAt)
            this.store.event(now, m.keeperThreadId, m.boardQuestId, "member.stale",
              `${this.name(m)}: stale strike ${strikes}${strikes >= releaseAt ? `; releasable: call tavern_release for ${m.threadId}, with replace:true to reuse the slot` : ""}`,
              { memberThreadId: m.threadId, strikes });
        });
        this.changed(m.threadId, m.boardQuestId);
      });
    }
    if (alerts.size && pendingWakeups) return pendingWakeups([...alerts.keys()]).then(pending => {
      for (const [id, alert] of alerts) if (!pending.has(id) && !held(id) && !this.member(id)?.permanent) alert();
    });
    for (const alert of alerts.values()) alert();
  }
  defaults(
    keeperThreadId?: string,
    onError: (error: unknown) => void = () => {},
  ) {
    const asks = this.store.openAsks(keeperThreadId);
    for (const ask of asks) {
      if (!isLiveKeeper(this.store, this.member(ask.keeperThreadId))) continue;
      if (ask.boardQuestId && !isOpenQuest(this.store.get("quests", ask.boardQuestId))) {
        if (ask.effect?.type !== "retry-stop") this.withdrawAsk(ask.id, "quest-returned");
        continue;
      }
      if (
        ask.state !== "open" ||
        ask.proceedAt === null ||
        ask.proceedAt > this.now()
      )
        continue;
      try {
        const option = ask.options.find((o) => o.recommended);
        if (!option) throw new Error(`Ask ${ask.id} has no default`);
        this.answerAsk(ask.id, option.id, null, "timer", "default");
      } catch (error) {
        onError(error);
      }
    }
  }
  activity(threadId: string, state: Member["state"], at = this.now()) {
    const member = this.member(threadId);
    if (!member) return;
    if (member.state === state) return;
    this.store.put("members", threadId, {
      ...member,
      state,
      lastActiveAt: at,
      strikes: state === "working" ? 0 : member.strikes,
    });
    this.changed(threadId, member.boardQuestId);
  }
  touch(threadId: string) {
    const member = this.member(threadId);
    if (member && this.now() - (member.lastActiveAt ?? 0) >= LIMITS.memberActivityWriteMs)
      this.store.put("members", threadId, {
        ...member,
        lastActiveAt: this.now(),
      });
  }
  reanchor(threadId: string, reason: string) {
    const m = this.member(threadId);
    if (!isKeeperIdentity(this.store, m)) return;
    this.store.patch(threadId, {
      reanchor: reason,
      reanchorVersion: (this.store.runtime(threadId).reanchorVersion ?? 0) + 1,
    });
    this.store.event(
      this.now(),
      threadId,
      null,
      "reanchor.requested",
      `Re-anchor after ${reason}`,
      { cause: reason },
    );
    this.changed(threadId);
  }
}
