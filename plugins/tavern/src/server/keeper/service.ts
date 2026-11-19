import { authorize, commitUserAct, type UserActReceipt } from "../authority";
import { QuestAuthority } from "../quest-authority";
import { preapprovalWords } from "../../shared/quest-authority";
import { randomUUID } from "node:crypto";
import { applyAskEffect, type EffectHandlers, type AskEffect } from "../ask-effects";
import type { RequestSources } from "../../shared/request-source";
import { LIMITS } from "../limits";
import { isLiveKeeper, isLiveMember, isOpenQuest } from "../liveness";
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
  reportSchema,
  routeSchema,
  ruleSchema,
  type Ask,
  type Actor,
  type BoardQuest,
  type Brief,
  type Member,
  type Plan,
  type Report,
  type Route,
  type Rule,
} from "../../shared/schema";
import { tags, type BoardQuestSummary } from "../../shared/contract";
import { KeeperStore, type ReviewTarget } from "./store";
import { renderRestatement } from "./restatement";
import { checkerAssignments } from "../assignments";
import { reviewLimitation } from "../../shared/check-posture";
import { KeeperMemory } from "./memory";
import type { NoteDraft } from "../../shared/schema";
import { memberPlace } from "../../shared/member-place";

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
  unsure?: boolean;
  target?: Ask["target"];
  scopeChange?: Ask["scopeChange"];
  releaseHoldId?: string;
  releaseCheckerHandoff?: boolean;
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
import { moveTime } from "../../shared/time";
import { assertQuestTransition, transitionQuest, displayStage, nextNewsBy, storedPhase, partyFits, approvedPartyReceipt } from "./quest-lifecycle";

export class Keeper {
  settings: (questId?: string | null) => TavernSettings = () =>
    DEFAULT_SETTINGS;
  askOpened: (ask: Ask) => void = () => {};
  routineAskOpened: (ask: Ask) => Promise<void> = async () => {};
  readonly authority = new QuestAuthority(this);
  readonly memory = new KeeperMemory(this);
  private readonly syncing = new Set<string>();
  constructor(
    readonly store: KeeperStore,
    readonly journal: JournalPort,
    readonly now = Date.now,
    private readonly invalidate: (tags: string[]) => void = () => {},
  ) {}
  changed(threadId?: string | null, questId?: string | null) {
    this.invalidate(this.changedTags(threadId, questId));
  }
  /** What changed() does short of signalling: syncs the Keeper's board mirrors and returns the tags made stale, for a caller that signals them itself. */
  changedTags(threadId?: string | null, questId?: string | null): string[] {
    const member = threadId ? this.member(threadId) : null;
    const keeperId = member?.keeperThreadId ?? threadId;
    if (
      keeperId &&
      this.member(keeperId)?.role === "keeper" &&
      !this.syncing.has(keeperId)
    ) {
      this.syncing.add(keeperId);
      try {
        this.journal.syncBoardQuests(keeperId);
      } finally {
        this.syncing.delete(keeperId);
      }
    }
    return [
      ...new Set([
        tags.room(),
        tags.rows(),
        ...(threadId ? [tags.thread(threadId), tags.journal(threadId)] : []),
        ...(keeperId ? [tags.thread(keeperId)] : []),
        ...(questId
          ? [
              tags.boardQuest(questId),
              ...this.store
                .query("members", "boardQuestId", questId)
                .map((m) => tags.thread(m.threadId)),
            ]
          : []),
      ]),
    ];
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
    const member = this.member(threadId);
    if (!member || member.role !== role)
      throw new Error(`Only a Tavern ${role} may call this tool`);
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
    const live = party.filter(member => {
      const state = this.store.runtime(member.threadId);
      return includeArchived || state.archivedAt == null && state.deletedAt == null && !state.released;
    });
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
  ) {
    const existing = this.member(threadId);
    if (existing) return existing;
    const state = "idle";
    const m: Member = {
      threadId,
      classId,
      characterId,
      ...(owner?.displayName ? { displayName: owner.displayName } : {}),
      ...(owner?.checkIndependence ? { checkIndependence: owner.checkIndependence } : {}),
      ...(owner?.guardPosture ? { guardPosture: owner.guardPosture } : {}),
      role: owner ? "member" : classId === "keeper" ? "keeper" : "solo",
      keeperThreadId: owner?.keeperThreadId ?? null,
      boardQuestId: owner?.boardQuestId ?? null,
      waypointId: owner?.waypointId ?? null,
      checkerWaypointId:
        classId === "warden" ? (owner?.waypointId ?? null) : null,
      ...(classId === "warden" && owner?.reviewTarget ? { checkerMakerThreadId: owner.reviewTarget.makerThreadId } : {}),
      errand: owner?.errand ?? false,
      title: owner?.title ?? null,
      place: memberPlace(state),
      state,
      doing: owner?.brief.outcome ?? null,
      createdAt: this.now(),
      lastActiveAt: this.now(),
      lastReportAt: null,
      strikes: 0,
      verifiedWins: 0,
    };
    this.store.atomic(() => {
      this.store.put("members", threadId, m);
      this.store.patch(threadId, { projectId, brief: owner?.brief ?? null, reviewTarget: owner?.reviewTarget ?? null, requestSources: owner?.requestSources ?? null, assignmentText: owner?.assignmentText ?? null });
    });
    this.changed(threadId, m.boardQuestId);
    return m;
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
    const message = this.store.db.prepare("SELECT text,at FROM tavern_messages WHERE id=? AND thread_id=? AND accepted=2 AND length(trim(text))>0").get(messageId, actor.threadId) as { text: string; at: number } | undefined;
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
    this.invalidate([tags.mapHistory(), tags.registry()]);
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
    this.invalidate([tags.mapHistory(), tags.registry()]);
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
    const runtime = this.store.runtime(threadId);
    const routes = this.applicableRoutes(threadId);
    if (
      questId !== null &&
      routes.some(
        (route) =>
          ["steer", "new-quest"].includes(route.kind) &&
          routeQuestIds(route).includes(questId),
      )
    )
      return;
    if (runtime.pending.length)
      throw new Error(
        `Route the oldest unrouted user message before changing a board quest: ${JSON.stringify(runtime.pending[0]!.text.slice(0, 300))}. No change was applied by this request.`, 
      );
    if (routes.length && questId !== null)
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
    this.store.atomic(() => {
      if (openingGoal && !classSelectionOnly && member.role === "keeper" && !this.store.runtime(threadId).openingGoal)
        this.store.patch(threadId, { openingGoal: { text, at } });
      const receipt = this.store.receipt(threadId, text, at, rowId, accepted);
      const runtime = this.store.runtime(threadId);
      if (accepted && member.role === "keeper") {
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
        ...(member.role === "keeper"
          ? { pending: [...runtime.pending, pending] }
          : {}),
      });
      this.store.event(
        at,
        member.keeperThreadId ?? threadId,
        member.boardQuestId,
        member.role === "member" ? "user.told-member" : "user.message",
        member.role === "member"
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
  async openQuest(threadId: string, title: string, short: string) {
    this.require(threadId, "keeper");
    await this.journal.prepare(threadId);
    const route = this.applicableRoutes(threadId)
      .filter(
        (route) => route.kind === "new-quest" && route.boardQuestId === null,
      )
      .at(-1)?.id;
    if (!route) throw new Error("Opening a board quest requires an unbound new-quest route from an accepted user message. Ask for the goal; never open a placeholder.");
    const source = this.store.get("routes", route)!;
    const receipt = source.sourceMessageId && this.store.db.prepare("SELECT id FROM tavern_messages WHERE id=? AND thread_id=? AND accepted=2 AND length(trim(text))>0").get(source.sourceMessageId, threadId);
    if (!receipt || source.classSelectionOnly) throw new Error("The new-quest route needs its genuine accepted user receipt containing a goal; class selection is not a goal.");
    authorize("openQuest", { level: "user-in-words", receipt: source.sourceMessageId! });
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
      transitionQuest(this.store, q, "scout", "open", { kind: "agent", threadId }, { kind: "user-message", id: source.sourceMessageId! }, this.now(), { text: `Opened ${title}` });
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
    this.changed(threadId, boardQuestId);
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
    this.changed(r.keeperThreadId, boardQuestId);
    if (r.boardQuestId) this.changed(r.keeperThreadId, r.boardQuestId);
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
      fromSteer: r ? { routeId: r.id, at: r.messageAt, text: r.summary } : null,
    });
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
    const approved =
      q.greenlitVersion === null
        ? null
        : this.store.get("plans", `${q.id}:${q.greenlitVersion}`);
    const needsGreenlight = approved === null || !partyFits(plan, approved);
    const automatic =
      needsGreenlight &&
      this.settings().keepers.greenlight === "by-size" &&
      plan.reversible &&
      plan.party.length === 1 &&
      !plan.questions.length &&
      !plan.waypoints.some((w) => w.actor !== "agent") &&
      !this.store.openAsks(threadId).length;
    this.store.atomic(() => {
      this.store.put("plans", `${q.id}:${plan.version}`, plan);
      const updated = { ...q, planVersion: plan.version, greenlitVersion: q.greenlitVersion, updatedAt: this.now() };
      const data = { version: plan.version, routeId: r?.id ?? null };
      if (needsGreenlight && storedPhase(q.phase) !== "greenlight") {
        transitionQuest(this.store, q, "greenlight", "plan", { kind: "agent", threadId }, { kind: "plan", id: `${q.id}:${plan.version}` }, this.now(), { patch: updated, text: `Plan v${plan.version}`, data });
      } else if (!needsGreenlight && q.phase === "greenlight") {
        const receipt = approvedPartyReceipt(this.store, q);
        if (!receipt) throw new Error("Replacement plan requires this quest\'s earlier party approval");
        transitionQuest(this.store, q, "build", "replacement-plan", { kind: "agent", threadId }, receipt, this.now(), { patch: updated, text: `Plan v${plan.version}`, data });
      } else {
        this.store.put("quests", q.id, updated);
        this.store.event(this.now(), threadId, q.id, "plan.proposed", `Plan v${plan.version}`, data, { kind: "agent", threadId });
      }
      for (const ask of this.asks(threadId).filter(
        (a) =>
          a.boardQuestId === q.id &&
          a.kind === "greenlight" &&
          a.state === "open",
      ))
        this.withdrawAsk(ask.id, "plan-superseded");
      if (automatic) {
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
      if (needsGreenlight && !automatic) {
        for (const ask of this.asks(threadId).filter(
          (a) =>
            a.boardQuestId === q.id &&
            a.kind === "greenlight" &&
            a.state === "open",
        ))
          this.withdrawAsk(ask.id, "plan-superseded");
        this.ask(
          threadId,
          { effect: { type: "greenlight", planVersion: plan.version },
            boardQuestId: q.id,
            kind: "greenlight",
            question: `Form the party for ${q.title}, plan v${plan.version}?`,
            why: "Staffing requires your explicit greenlight.",
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
                detail: "Keep scouting; do not staff",
                recommended: false,
              },
            ],
            meanwhile: "Keep scouting and preparing private drafts.",
            holds: plan.waypoints.map((w) => w.id),
          },
          { planVersion: plan.version },
        );
      }
    });
    if (approved && !needsGreenlight)
      this.decide(threadId, {
        boardQuestId: q.id,
        text: `Replanned to v${plan.version} within the greenlit party`,
        why: "The class counts do not exceed the user's approved party.",
        reversible: true,
        source: "keeper",
      });
    this.changed(threadId, q.id);
    return plan;
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
    if (!ask || ask.state !== "open") return null;
    return this.store.atomic(() => {
      const closing = ask.kind === "conclude" && ask.boardQuestId && this.quest(ask.boardQuestId).phase === "closing";
      if (closing)
        transitionQuest(this.store, this.quest(ask.boardQuestId!), "build", "conclude-withdrawn", { kind: "tavern" }, { kind: "ask", id }, at, { text, data: { ...data, askId: id, withdrawnCause: cause } });
      if (!closing) this.store.event(at, ask.keeperThreadId, ask.boardQuestId, "ask.withdrawn", text ?? ask.question, { ...data, askId: id, cause }, actor);
      return this.store.put("asks", id, { ...ask, state: "withdrawn", withdrawnAt: at, withdrawnCause: cause });
    });
  }
  pendingStopHires(id: string) {
    return this.store.db.prepare("SELECT h.id AS token,json_extract(h.data,'$.classId') AS classId,json_extract(h.data,'$.owner.title') AS title FROM tavern_records h WHERE h.kind='hires' AND json_extract(h.data,'$.owner.boardQuestId')=? AND NOT EXISTS (SELECT 1 FROM tavern_records m WHERE m.kind='members' AND m.id=json_extract(h.data,'$.memberThreadId'))").all(id) as { token: string; classId: string; title: string }[];
  }
  pendingQuestHires(id: string) {
    return this.pendingStopHires(id).length;
  }
  recordStop(id: string, reason: string | null = null): BoardQuest {
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
      const stopped = transitionQuest(this.store, quest, "stopping", "stop", { kind: "user" }, { kind: "user-act", id: this.store.id("act"), surface: "stopBoardQuest", at }, at, { patch: stopPatch, text: "Stop requested for every party member", data: { reason: stopReason, withdrawnAskIds } });
      this.store.db.prepare("UPDATE tavern_records SET data=json_set(data,\'$.cancelledAt\',?) WHERE kind=\'hires\' AND json_extract(data,\'$.owner.boardQuestId\')=?").run(at, id);
      for (const member of this.store.query("members", "boardQuestId", id, 500)) {
        if (["done", "stopped"].includes(member.state) || this.store.runtime(member.threadId).released) continue;
        this.store.put("members", member.threadId, { ...member, stopPending: true, stopError: null });
      }
      this.memory.closeQuest(quest.keeperThreadId, id);
      for (const askId of withdrawnAskIds) this.withdrawAsk(askId, "quest-stopped", at);
      return stopped;
    });
  }
  ask(
    threadId: string,
    input: AskInput & { effect: AskEffect },
    eventData: Record<string, unknown> = {},
    trusted = false,
  ) {
    this.require(threadId, "keeper");
    const questId = input.boardQuestId ?? null;
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
      if (trusted && input.effect.type === "retry-stop") this.owned(threadId, questId);
      else this.liveQuest(threadId, questId);
      if (!trusted && !input.releaseHoldId) this.guard(threadId, questId);
    }
    if (input.kind !== "decision" && input.proceedInMinutes != null)
      throw new Error(
        "Only decision asks may have timed defaults; other kinds never default and require an explicit answer",
      );
    if (input.proceedInMinutes != null && input.reversible !== true)
      throw new Error(
        "A timed decision must explicitly declare reversible: true",
      );
    if (
      input.kind === "sends-as-you" &&
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
    if (input.kind === "greenlight" && input.effect.type !== "greenlight") throw new Error("A greenlight ask needs its typed plan version; propose the plan instead.");
    if (input.kind === "conclude" && input.effect.type !== "conclude") throw new Error("A conclude ask needs its typed draft; tell the quest result instead.");
    if (input.effect.type === "placement-blocker" && !trusted) throw new Error("Only Tavern may open a typed placement blocker");
    if (input.options.some(o => o.id === "delegate")) throw new Error("The delegation answer is reserved for Tavern");
    if (["merge", "production"].includes(input.kind)) input = { ...input, options: [{ id: "approve", label: "Approve the act", detail: "Authorize the exact act; delegated approval needs a current Warden verdict.", recommended: false }, { id: "deny", label: "Decline the act", detail: "Do not authorize this act.", recommended: false }], effect: { type: "decision", outcomes: [{ optionId: "approve", outcome: "approve" }, { optionId: "deny", outcome: "decline" }] } };
    const lane = this.authority.lane({ kind: input.kind, boardQuestId: questId, unsure: input.unsure });
    if (questId && lane === "user" && ["production", "merge", "credential", "sends-as-you", "destructive"].includes(input.kind)) {
      input = { ...input, options: [...input.options, { id: "delegate", label: `Let ${this.name(this.require(threadId, "keeper"))} decide these for the rest of this quest`, detail: "Records a revocable grant for this kind on this quest only. This act still needs a decision.", recommended: false }] };
    }
    const ask = askSchema.parse({
      ...input,
      lane,
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
    this.store.atomic(() => {
      this.store.put("asks", ask.id, ask);
      if (ask.kind === "conclude" && questId && this.quest(questId).phase !== "closing") {
        transitionQuest(this.store, this.quest(questId), "closing", "close", { kind: "agent", threadId }, { kind: "ask", id: ask.id }, this.now(), { text: ask.question, data: { askId: ask.id, ...eventData } });
      } else this.store.event(
        this.now(),
        threadId,
        questId,
        "ask.opened",
        ask.question,
        { askId: ask.id, lane, keeperName: this.name(this.require(threadId, "keeper")), ...eventData },
        { kind: "agent", threadId },
      );
    });
    const standing = this.authority.match(ask);
    if (standing && ask.effect?.type === "greenlight") this.answerAsk(ask.id, standing.optionId, null, "timer", "preapproval");
    this.changed(threadId, questId);
    void Promise.resolve()
      .then(() => {
        const current = this.store.get("asks", ask.id);
        if (current?.state !== "open") return;
        if (this.authority.match(current)) return this.routineAskOpened(current);
        if (this.authority.lane(current) === "user") return this.askOpened(current);
      })
      .catch((error) =>
        console.warn(`Tavern ask notification ${ask.id}: ${String(error)}`),
      );
    return ask;
  }
  answerAsk(
    askId: string,
    optionId: string,
    note: string | null,
    via: NonNullable<Ask["answer"]>["via"],
    by: "user" | "default" | "keeper" | "preapproval",
    surface?: string,
    effects: Partial<EffectHandlers> = {},
    receipt?: UserActReceipt,
  ) {
    const ask = this.store.get("asks", askId);
    if (!ask) throw new Error("Unknown ask");
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
      if (this.authority.lane(ask) !== "keeper") throw new Error("This ask belongs to the user");
      const outcome = ask.effect?.type === "decision" ? ask.effect.outcomes?.find(answer => answer.optionId === optionId)?.outcome : undefined;
      if (outcome !== "decline") this.authority.assertVerdict(ask);
    }
    const effect = ask.effect!;
    if (ask.kind === "greenlight" && effect.type !== "greenlight") throw new Error("This old ask has no plan version; ask the Keeper to propose the plan again.");
    if (ask.kind === "conclude" && effect.type !== "conclude") throw new Error("This old ask has no conclusion draft; ask the Keeper to tell the result again.");
    if (ask.boardQuestId && (effect.type === "conclude" || effect.type === "greenlight" && optionId === "approve")) {
      const quest = this.quest(ask.boardQuestId);
      if (quest.phase === "held") throw new Error("This quest is held; resume it first");
      if (effect.type === "greenlight") {
        assertQuestTransition(this.store, quest, "build", "approve", { kind: "user" }, { kind: "ask-answer", id: askId });
        if ((effect.type !== "greenlight" || effect.planVersion !== quest.planVersion)) throw new Error("This greenlight belongs to an old plan version");
      } else
        assertQuestTransition(this.store, quest, optionId === "conclude" ? "done" : "build", optionId === "conclude" ? "conclude" : optionId === "hold" ? "keep-open" : "extensions", { kind: "user" }, { kind: "ask-answer", id: askId });
    }
    if (ask.boardQuestId && effect.type !== "retry-stop") this.liveQuest(ask.keeperThreadId, ask.boardQuestId);
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
    const answerData = { askId, optionId, answeredBy: by, ...(standing ? { preapproval: { id: standing.grant.id, at: standing.grant.at, surface: standing.grant.surface } } : {}), ...(by === "keeper" ? { keeperName: this.name(this.require(ask.keeperThreadId, "keeper")), delegation: this.quest(ask.boardQuestId!).delegations?.find(g => g.kind === ask.kind && g.endedAt === null && g.revokedAt === null) } : {}), ...(receipt ? { authority: receipt } : {}) };
    commitUserAct(this.store, () => this.now(), receipt, () => {
      if (standing) this.authority.consume(standing);
      this.store.put("asks", ask.id, {
        ...ask,
        state: by === "default" ? "defaulted" : "answered",
        answer: { optionId, note, via, by, at: this.now(), ...(surface ? { surface } : {}), ...(standing ? { preapproval: { id: standing.grant.id, at: standing.grant.at, surface: standing.grant.surface } } : {}) },
      });
      applyAskEffect(effect, {
        ...effects,
        greenlight: effect => {
          if (effect.type !== "greenlight" || optionId !== "approve") return;
          if (!ask.boardQuestId) throw new Error("A greenlight needs its quest");
          const q = this.quest(ask.boardQuestId);
          if (q.phase !== "greenlight") throw new Error("This plan is no longer waiting for greenlight");
          if (effect.planVersion !== q.planVersion) throw new Error("This greenlight belongs to an old plan version");
          transitionQuest(this.store, q, "build", "approve", { kind: "user" }, { kind: "ask-answer", id: askId }, this.now(), { patch: { greenlitVersion: q.planVersion }, text: standing ? `Party approved: ${preapprovalWords(standing.grant)}. Hire it now, critical path first.` : "Party approved: hire it now, critical path first.", data: answerData });
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
        ask.kind === "greenlight" && optionId === "approve"
          ? "Party approved: hire it now, critical path first."
          : ask.kind === "scope" && optionId === "deny"
            ? `${SCOPE_DENIAL_TEXT}${note ? ` User note: ${note}` : ""}`
            : `${standing ? preapprovalWords(standing.grant) : by === "keeper" ? "Keeper decided" : by === "default" ? "Default applied to a reversible choice" : "Answered"}: ${ask.question} — ${optionId}${note ? `: ${note}` : ""}`,
        answerData,
        by === "keeper" ? { kind: "agent", threadId: ask.keeperThreadId } : by === "user" ? { kind: "user" } : { kind: "tavern" },
      );
    });
    if (by === "user") this.userAction(ask.keeperThreadId);
    this.changed(ask.keeperThreadId, ask.boardQuestId);
  }
  decide(
    threadId: string,
    input: {
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
  ) {
    this.require(threadId, "keeper");
    const questId = input.boardQuestId ?? null;
    if (questId) {
      this.liveQuest(threadId, questId);
      this.guard(threadId, questId);
    }
    if (input.source === "user")
      throw new Error(
        "A tool cannot assert user consent; reference an answered ask or a recorded steer instead",
      );
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
        throw new Error(
          "Decision source must be an ask answered by the user for this quest",
        );
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
    if (input.exceeds && !input.reversible)
      throw new Error("A soft limit decision must be reversible");
    authorize(input.source === "steer" ? "steerDecision" : input.source === "ask" ? "answerAsk" : "defaultDecision", { level: input.source === "steer" ? "user-in-words" : input.source === "ask" ? "user-explicit" : "keeper", receipt: input.sourceRef ?? input.text });
    const decision = decisionSchema.parse({
      ...input,
      id: this.store.id("decision"),
      keeperThreadId: threadId,
      boardQuestId: questId,
      sourceRef: input.sourceRef ?? null,
      undone: false,
      createdAt: this.now(),
    });
    this.store.atomic(() => {
      if (input.askId) {
        const ask = this.store.get("asks", input.askId);
        if (!ask || ask.keeperThreadId !== threadId || ask.boardQuestId !== questId || input.source !== "keeper" || !input.optionId) throw new Error("A Keeper answer needs its own quest ask and option");
        this.answerAsk(ask.id, input.optionId, input.why, "chat", "keeper");
      } else if (input.kind) throw new Error("A delegated kind needs its exact askId and optionId");
      this.store.put("decisions", decision.id, decision);
      if (autoApproval) {
        transitionQuest(this.store, this.quest(autoApproval.questId), "build", "auto-approve", { kind: "agent", threadId }, { kind: "decision", id: decision.id }, this.now(), { patch: { greenlitVersion: autoApproval.planVersion }, text: decision.text, data: { decisionId: decision.id } });
      } else {
      this.store.event(
        this.now(),
        threadId,
        questId,
        "decision.made",
        decision.text,
        { decisionId: decision.id, ...(input.askId ? { askId: input.askId, answeredBy: "keeper", keeperName: this.name(this.require(threadId, "keeper")), delegation: this.quest(questId!).delegations?.find(g => g.kind === this.store.get("asks", input.askId!)?.kind && g.endedAt === null && g.revokedAt === null) } : {}) },
        { kind: "agent", threadId },
      );
      }
    });
    this.changed(threadId, questId);
    return decision;
  }
  undoDecision(id: string) {
    const d = this.store.get("decisions", id);
    if (!d) throw new Error("Unknown decision");
    if (!d.reversible) throw new Error("This decision is not reversible");
    if (d.undone) return;
    const approval = this.store.get("autoGreenlights", id);
    if (approval && this.quest(approval.boardQuestId).phase === "held") throw new Error("This quest is held; resume it first");
    this.store.atomic(() => {
      let phaseChanged = false;
      this.store.put("decisions", id, { ...d, undone: true });
      if (d.askId) {
        const ask = this.store.get("asks", d.askId);
        if (ask?.answer?.by === "keeper" && ask.answer.optionId === d.optionId && (!ask.boardQuestId || isOpenQuest(this.quest(ask.boardQuestId)))) this.store.put("asks", ask.id, { ...ask, state: "open", answer: null, unsure: true, lane: "user" });
      }
      const approval = this.store.get("autoGreenlights", id);
      if (approval) {
        const q = this.quest(approval.boardQuestId);
        if (
          q.greenlitVersion === approval.planVersion &&
          isOpenQuest(q)
        ) {
          transitionQuest(this.store, q, "greenlight", "undo", { kind: "user" }, { kind: "undo", id }, this.now(), { patch: { greenlitVersion: null }, text: `Undo this decision and reconcile its effects: ${d.text}`, data: { decisionId: id } });
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
        `Undo this decision and reconcile its effects: ${d.text}`,
        { decisionId: id },
        { kind: "user" },
      );
    });
    this.userAction(d.keeperThreadId);
    this.changed(d.keeperThreadId, d.boardQuestId);
  }
  messageRule(threadId: string, text: string, questId?: string | null) {
    const routes = this.applicableRoutes(threadId).filter(
      (route) =>
        route.kind === "rule" &&
        (!questId || routeQuestIds(route).includes(questId)),
    );
    if (!routes.length)
      throw new Error("A source message needs an applicable user rule route");
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
    return route.id;
  }
  addRule(
    input: Pick<Rule, "scope" | "scopeId" | "text" | "source">,
    keeperThreadId: string | null = null,
    sourceRef?: string,
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
    const r = ruleSchema.parse({
      ...input,
      id: this.store.id("rule"),
      keeperThreadId,
      active: input.source !== "keeper-proposed",
      createdAt: this.now(),
    });
    this.store.atomic(() => {
      this.store.put("rules", r.id, r);
      if (sourceRef) {
        const route = this.store.get("routes", sourceRef);
        if (!route || route.kind !== "rule" || route.keeperThreadId !== keeperThreadId)
          throw new Error("A rule needs its own Keeper's rule route");
        this.store.put("routes", sourceRef, { ...route, ruleId: r.id });
      }
      this.store.event(
        this.now(), keeperThreadId, input.scope === "quest" ? input.scopeId : null,
        "rule.added", r.text, { ruleId: r.id, sourceRef: sourceRef ?? null, scope: r.scope, scopeId: r.scopeId },
      );
    });
    this.invalidateRule(r, r.active, keeperThreadId);
    return r;
  }
  confirmRule(id: string, active: boolean) {
    const r = this.store.get("rules", id);
    if (!r) throw new Error("Unknown rule");
    this.store.put("rules", id, { ...r, active });
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
    this.invalidate([tags.room()]);
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
    this.invalidate([tags.room()]);
  }
  rules(threadId: string, questId?: string | null, includeInactive = false) {
    const m = this.member(threadId);
    const keeperId = m?.keeperThreadId ?? threadId;
    const projectId = this.store.runtime(threadId).projectId;
    return this.store.activeRules(
      keeperId,
      projectId,
      questId ?? null,
      m?.role === "keeper",
      includeInactive,
    );
  }
  report(
    threadId: string,
    input: Pick<
      Report,
      "status" | "outcome" | "headline" | "evidence" | "artifacts" | "confidence" | "voice"
    >,
  ) {
    const m = this.require(threadId, "member");
    const voiceOff = this.settings(m.boardQuestId).tavern.voice === "off";
    const late = !isLiveMember(this.store, m, "brief") || m.state === "done" && input.status !== "done" || !isLiveKeeper(this.store, this.member(m.keeperThreadId!), "present");
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
      voice: input.status === "done" && !voiceOff ? input.voice : null,
      createdAt: this.now(),
      deliveredAt: late ? this.now() : null,
    });
    const previous = this.store.query(
      "reports",
      "memberThreadId",
      threadId,
      1,
    )[0];
    if (
      previous &&
      (this.store.runtime(threadId).briefVersion ?? 0) ===
        (this.store.runtime(threadId).reportedBriefVersion ?? 0) &&
      previous.status === report.status &&
      previous.outcome === report.outcome &&
      previous.headline === report.headline &&
      JSON.stringify(previous.evidence) === JSON.stringify(report.evidence) &&
      JSON.stringify(previous.artifacts) === JSON.stringify(report.artifacts)
    )
      return voiceOff ? { ...previous, voice: null } : previous;
    this.store.atomic(() => {
      this.store.put("reports", report.id, report);
      this.store.patch(threadId, {
        reportedBriefVersion: this.store.runtime(threadId).briefVersion ?? 0,
        ...(!late && input.status === "done" ? { restSince: this.store.runtime(threadId).restSince ?? this.now() } : {}),
      });
      const state = late ? m.state : input.status === "done" ? "done" : "waiting";
      this.store.put("members", threadId, {
        ...m,
        state,
        place: memberPlace(state),
        doing: input.outcome.slice(0, 300),
        lastReportAt: this.now(),
        strikes: 0,
      });
      this.store.event(
        this.now(),
        m.keeperThreadId,
        m.boardQuestId,
        late ? "report.late" : "report.filed",
        `${this.name(m)}: ${input.outcome}`,
        { reportId: report.id, status: input.status },
      );
    });
    this.changed(threadId, m.boardQuestId);
    if (m.characterId && report.status === "done" && report.voice?.trim()) this.invalidate([tags.registry()]);
    return report;
  }
  checkerWaypoints(threadId: string) {
    const member = this.member(threadId);
    if (
      !member ||
      member.classId !== "warden" ||
      !member.boardQuestId ||
      this.store.runtime(threadId).released
    )
      return [];
    const quest = this.quest(member.boardQuestId);
    const plan = this.store.get("plans", `${quest.id}:${quest.planVersion}`);
    if (!plan)
      return member.checkerWaypointId ? [member.checkerWaypointId] : [];
    const members = this.store
      .query("members", "boardQuestId", quest.id, 500)
      .filter((member) => !this.store.runtime(member.threadId).released);
    return (
      checkerAssignments(plan, members).find(
        (assignment) => assignment.memberThreadId === threadId,
      )?.waypointIds ?? []
    );
  }
  summary(id: string): BoardQuestSummary {
    const q = this.quest(id),
      plan = this.store.get("plans", `${id}:${q.planVersion}`),
      members = this.store.query("members", "boardQuestId", id),
      entries = this.journal.linkedEntries(id);
    const released = new Set(
      [
        ...new Set([
          ...members.map((member) => member.threadId),
          ...entries.map((entry) => entry.threadId),
        ]),
      ].filter((threadId) => this.store.runtime(threadId).released),
    );
    const skipped = new Set(
      this.store
        .query("skips", "boardQuestId", id, 100)
        .filter((s) => s.version === q.planVersion)
        .map((s) => s.waypointId),
    );
    const waypoints: BoardQuestSummary["waypoints"] = (
      plan?.waypoints ?? []
    ).map((w) => {
      const linked = entries.filter(
        (e) =>
          e.link?.waypointId === w.id &&
          this.member(e.threadId)?.classId !== "warden" &&
          (!released.has(e.threadId) || e.status === "verified"),
      );
      const ownerMember =
        members.find(
          (m) =>
            m.classId !== "warden" &&
            (m.threadId === w.owner || m.waypointId === w.id) &&
            (!released.has(m.threadId) ||
              linked.some(
                (entry) =>
                  entry.threadId === m.threadId && entry.status === "verified",
              )),
        ) ?? null;
      const state =
        w.optional && skipped.has(w.id)
          ? "skipped"
          : linked.length === 0
            ? "planned"
            : linked.every((e) => e.status === "verified")
              ? "verified"
              : linked.some((e) => e.status === "rejected")
                ? "rejected"
                : linked.some((e) => e.status === "blocked")
                  ? "blocked"
                  : linked.some((e) => e.status === "doing")
                    ? "doing"
                    : linked.every(
                          (e) => e.status === "done" || e.status === "verified",
                        )
                      ? "reported"
                      : "todo";
      const verifier = linked
        .filter((entry) => entry.status === "verified")
        .map((entry) => {
          if (entry.review) return entry.review.actor;
          const author = entry.updatedBy;
          if (author.kind !== "agent") return null;
          const member = this.member(author.threadId);
          return !member || member.classId === "warden" ? author : null;
        })
        .find((actor) => actor?.kind === "agent");
      const rejected = linked.find((entry) => entry.status === "rejected");
      return {
        ...w,
        gate: this.memory.gateFor(q.id, q.planVersion, w.id),
        state,
        ownerMember,
        evidenceCount: linked.reduce((n, e) => n + e.evidence.length, 0),
        verifiedBy: verifier?.kind === "agent" ? verifier.threadId : null,
        rejectedReason: rejected
          ? rejected.review
            ? rejected.review.reason
            : rejected.note
          : null,
      };
    });
    const asks = this.store.openAsks(q.keeperThreadId, id);
    const next = waypoints.find(
      (w) => w.state !== "verified" && w.state !== "skipped",
    );
    const verified = waypoints.filter(
      (waypoint) => waypoint.state === "verified",
    ).length;
    const skippedCount = waypoints.filter(
      (waypoint) => waypoint.state === "skipped",
    ).length;
    const progress = waypoints.length
      ? ` · verified ${verified} of ${waypoints.length}${skippedCount ? ` · skipped ${skippedCount}` : ""}`
      : "";
    const phase = displayStage(q.phase, waypoints, plan !== null);
    const newsBy = nextNewsBy(phase, members.filter(member => member.classId === "ranger" && isLiveMember(this.store, member, "work")).flatMap(member => {
      const runtime = this.store.runtime(member.threadId);
      return runtime.brief?.timeboxMinutes != null ? [(runtime.initialBriefAt ?? member.createdAt) + runtime.brief.timeboxMinutes * 60_000] : [];
    }), this.memory.notes(q.keeperThreadId, 500, 0, id).filter(note => note.kind === "commitment" && note.state === "open" && note.dueAt != null).map(note => note.dueAt!));
    const clock = (at: number) => moveTime(at, this.now());
    const outcome =
      q.phase === "held" ? `Held by you since ${clock(q.held!.since)} · Resume` :
      q.phase === "done"
        ? `Returned${progress}`
        : q.phase === "stopping"
          ? "Stopping"
          : q.phase === "stopped"
          ? `Stopped${progress}`
          : phase === "wrap"
            ? `Wrapping${progress}`
            : null;
    return {
      ...q,
      phase,
      nextNewsBy: newsBy,
      stopUnconfirmed: members.filter(member => member.stopPending).length + this.pendingQuestHires(id),
      stopPendingHires: q.phase === "stopping" ? this.pendingStopHires(id) : [],
      plan,
      waypoints,
      members,
      openAsks: asks.filter(a => this.authority.lane(a) !== "keeper").length,
      move: {
        who:
          q.phase === "held" || !isOpenQuest(q)
            ? "nobody"
            : phase === "wrap" || !plan
              ? "keeper"
              : asks.some(a => this.authority.lane(a) === "user")
                ? "you"
                : asks.some(a => this.authority.lane(a) === "keeper")
                  ? "keeper"
                : next?.actor === "outside"
                  ? "outside"
                  : next?.actor === "user"
                    ? "you"
                    : members.some(member => isLiveMember(this.store, member, "work"))
                      ? "party"
                      : "keeper",
        text:
          outcome ??
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
    return this.memory.snapshot(threadId, this.restatement(threadId));
  }
  priorities(threadId: string) {
    return renderRestatement(this, threadId, true);
  }
  stale(keeperThreadId?: string, held: (threadId: string) => boolean = () => false) {
    const members = keeperThreadId
      ? this.store.query("members", "keeperThreadId", keeperThreadId)
      : this.store.all("members");
    for (const m of members.filter((m) => m.role === "member" && isLiveMember(this.store, m, "work") && isLiveKeeper(this.store, this.member(m.keeperThreadId!)) && !held(m.threadId))) {
      const rt = this.store.runtime(m.threadId);
      const quietSince = this.journal.progress(m.threadId).quietSince;
      const last = Math.max(
        m.lastActiveAt ?? m.createdAt,
        m.lastReportAt ?? m.createdAt,
        rt.lastStrikeAt ?? 0,
        quietSince ?? 0,
      );
      if (
        this.now() - last <
        this.settings(m.boardQuestId).knobs.staleMinutes * 60_000
      )
        continue;
      this.store.atomic(() => {
        this.store.put("members", m.threadId, { ...m, strikes: m.strikes + 1 });
        this.store.patch(m.threadId, { lastStrikeAt: this.now() });
        this.store.event(
          this.now(),
          m.keeperThreadId,
          m.boardQuestId,
          "member.stale",
          `${this.name(m)}: stale strike ${m.strikes + 1}${m.strikes + 1 >= this.settings().keepers.staleStrikes ? `; releasable: call tavern_release for ${m.threadId}, then re-plan or replace` : ""}`,
        );
      });
      this.changed(m.threadId, m.boardQuestId);
    }
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
    const released = this.store.runtime(threadId).released;
    const ended = member.role === "member" && member.boardQuestId !== null && !isOpenQuest(this.store.get("quests", member.boardQuestId));
    const next = released ? "stopped"
      : member.state === "done" && ["idle", "stopped", "waiting"].includes(state) ? "done"
      : ended ? member.state === "done" ? "done" : "stopped" : state;
    if (member.state === next) return;
    if (next === "done") this.store.patch(threadId, { restSince: this.now() });
    if (next === "working") this.store.patch(threadId, { restSince: null, restReminderFor: null, kept: null });
    this.store.put("members", threadId, {
      ...member,
      state: next,
      place: memberPlace(next),
      lastActiveAt: at,
      strikes: next === "working" ? 0 : member.strikes,
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
    if (m?.role !== "keeper") return;
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
