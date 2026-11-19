import { LimitPolicy } from "./limit-policy";
import { userActHandlers, requireUserAct, type OptionalRpcContext, commitUserAct, type UserActReceipt } from "./authority";
import type { BbPluginApi, ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import {
  DECOR_BRIEF_CONTEXT_MAX,
  rpcContract,
  tags,
  type BoardQuestDetail,
  type Ledger,
  type Room,
  type ThreadDecor,
} from "../shared/contract";
import { currentMoodReport, waypointMoodVerdict } from "../shared/mood";
import type { Brief, Decision } from "../shared/schema";
import { isLiveMember } from "./liveness";
import { DecisionViews } from "./decisions";
import { stopAllHandlers } from "./stop-all-rpc";
import { placementHandlers } from "./placement/rpc";
import { PlacementStore } from "./placement/store";
import { voiceCheckHandlers } from "./voice-check/rpc";
import { awayHandlers } from "./away/rpc";
import { classEditorHandlers, requireClassClient } from "./registry-rpc";
import { classExecutionFacts } from "./class-execution";
import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { backfillTaleDelivery, memberCredits, readTale } from "./tale";
import { readCharacterPresentation } from "./character-presentation";
import type { TavernRuntime } from "./runtime";

/** The stored brief for the widget: every hire-time line, then as many of the newest follow-ups as fit. */
function decorBrief(brief: Brief | null | undefined) {
  if (!brief) return null;
  const isFollowUp = (line: string) => /^Follow-up v\d+: /.test(line);
  const hired = brief.context.filter(line => !isFollowUp(line)).slice(0, DECOR_BRIEF_CONTEXT_MAX);
  const followUps = brief.context.filter(isFollowUp);
  const room = DECOR_BRIEF_CONTEXT_MAX - hired.length;
  return { ...brief, context: [...hired, ...(room > 0 ? followUps.slice(-room) : [])] };
}

export function rpcHandlers(
  runtime: TavernRuntime,
): OptionalRpcContext<ExperimentalPluginRpcHandlersWithContext<typeof rpcContract>> {
  const k = runtime.keeper;
  const placementStore = new PlacementStore(k.store.db);
  const projectMember = (member: import("../shared/schema").Member) => ({ ...member,
    pullRequests: runtime.keeper.store.pullRequestsForMember(member.threadId),
    placement: placementStore.byMember(member.threadId) ? runtime.placements().controller.forMember(member.threadId) : null });
  const projectQuest = (quest: import("../shared/contract").BoardQuestSummary) => ({ ...quest,
    members: quest.members.map(projectMember),
    waypoints: quest.waypoints.map(waypoint => ({ ...waypoint, ownerMember: waypoint.ownerMember ? projectMember(waypoint.ownerMember) : null })) });
  const status = (threadId: string): "listening" | "busy" | "holding" => {
    if (k.store.runtime(threadId).archivedAt != null) return "listening";
    if (k.member(threadId)?.state === "working") return "busy";
    return runtime.held(threadId) ? "holding" : "listening";
  };
  const quests = (threadId: string) =>
    k.store
      .visibleRecords("quests", threadId, 100)
      .reverse()
      .map((q) => projectQuest(k.summary(q.id)));
  const decisions = new DecisionViews(k.store);
  const decisionsChanged = (changed: Decision[]) => {
    if (!changed.length) return;
    runtime.bb.rpc.experimental_invalidate([...new Set([
      tags.room(),
      ...changed.flatMap(decision => [
        tags.thread(decision.keeperThreadId),
        ...(decision.boardQuestId ? [tags.boardQuest(decision.boardQuestId)] : []),
      ]),
    ])]);
  };
  const errands = (threadId: string) => k.store.errandsPage(threadId, 100, 0).members.map(projectMember);
  const partyIds = (threadId: string) => [
    threadId,
    ...k.store
      .query("members", "keeperThreadId", threadId, 500)
      .map((member) => member.threadId),
  ];
  const wake = (threadId: string) => {
    void runtime.wakeKeeper(threadId, "user-action");
  };
  const invalidateCharacter = () => runtime.bb.rpc.experimental_invalidate([
    tags.registry(), tags.rows(), tags.room(), ...k.store.all("members").map(m => tags.thread(m.threadId)),
  ]);
  return userActHandlers({
    ...stopAllHandlers(runtime),
    ...placementHandlers(runtime),
    ...voiceCheckHandlers(() => runtime.voiceChecks),
    ...awayHandlers(runtime),
    registry: async ({ projectId }) => {
      const snapshot = projectId ? await runtime.prepareRegistry(projectId) : runtime.snapshot();
      const serviceRecords = runtime.serviceRecords.read();
      const { levels, voice, ambientMotion, hearthFlicker } = runtime.config().tavern;
      return {
        ...snapshot,
        ...readCharacterPresentation(runtime.registry, snapshot, k.store),
        serviceRecords,
        levels, voice, ambientMotion: hearthFlicker ? ambientMotion : "off",
      };
    },
    reports: ({ ids, memberThreadId }) => ({
      pullRequests: k.store.all("pullRequests").filter(pr => memberThreadId === null || pr.memberThreadId === memberThreadId || pr.owner === memberThreadId),
      reports: (ids.length
        ? ids.slice(0, 30).flatMap((id) => {
            const report = k.store.get("reports", id);
            return report ? [report] : [];
          })
        : memberThreadId
          ? k.store.query("reports", "memberThreadId", memberThreadId, 30)
          : k.store.latest("reports", 30)
      ).filter(
        (r) => memberThreadId === null || r.memberThreadId === memberThreadId,
      ),
    }),
    classExecution: input => classExecutionFacts(runtime, input),
    classExecutions: async ({ projectId }) => {
      const snapshot = projectId ? await runtime.prepareRegistry(projectId) : runtime.snapshot();
      return { classes: await Promise.all(snapshot.classes.map(async role => ({
        classId: role.id,
        start: await classExecutionFacts(runtime, { classId: role.id, projectId, mode: "start" }, snapshot),
        hire: await classExecutionFacts(runtime, { classId: role.id, projectId, mode: "hire" }, snapshot),
      }))) };
    },
    applyClassExecution: async ({ threadId }: { threadId: string }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      requireClassClient(context);
      const requested = k.store.runtime(threadId).classNotice?.switchExecution;
      if (!requested) throw new Error("There is no class execution change to apply.");
      const thread = await runtime.bb.sdk.threads.get({ threadId });
      if (thread.archivedAt !== null || thread.deletedAt !== null) throw new Error("This thread is archived or deleted.");
      await runtime.bb.sdk.threads.update({ threadId, ...requested });
      const applied = await runtime.bb.sdk.threads.defaultExecutionOptions({ threadId });
      if (!applied || Object.entries(requested).some(([key, value]) => applied[key as "model" | "reasoningLevel"] !== value))
        throw new Error("bb did not apply the class model and reasoning. The notice was kept; check the thread’s execution settings.");
      commitUserAct(k.store, () => k.now(), receipt, () => k.store.patch(threadId, { classNotice: null }));
      runtime.bb.rpc.experimental_invalidate([tags.thread(threadId)]);
      return { ...(applied.model ? { model: applied.model } : {}), ...(applied.reasoningLevel ? { reasoningLevel: applied.reasoningLevel } : {}) };
    },
    dismissClassNotice: ({ threadId }: { threadId: string }, context?: ExperimentalPluginRpcHandlerContext) => {
      requireClassClient(context);
      k.store.patch(threadId, { classNotice: null });
      runtime.bb.rpc.experimental_invalidate([tags.thread(threadId)]);
      return { ok: true as const };
    },
    ...classEditorHandlers(runtime),
    saveCharacterVoice: ({ characterId, voice }) => {
      const character = runtime.registry.saveVoice(characterId, voice);
      invalidateCharacter();
      return character;
    },
    saveCharacterAvatar: ({ characterId, avatar }) => {
      const character = runtime.registry.saveAvatar(characterId, avatar);
      invalidateCharacter();
      return character;
    },
    decor: ({ threadId }): ThreadDecor => {
      const m = k.member(threadId), thread = k.store.runtime(threadId);
      const boardQuest = m?.boardQuestId ? k.quest(m.boardQuestId) : null;
      const plan = boardQuest ? k.store.get("plans", `${boardQuest.id}:${boardQuest.planVersion}`) : null;
      const verdict = m && boardQuest ? waypointMoodVerdict(m, k.journal.linkedEntries(boardQuest.id)) : null;
      const reviewer = verdict?.checkerThreadId ? k.member(verdict.checkerThreadId) : null;
      const checkerName = reviewer?.classId === "warden" && reviewer.characterId
        ? reviewer.displayName ?? runtime.snapshot(k.store.runtime(reviewer.threadId).projectId ?? undefined).characters.find(c => c.id === reviewer.characterId)?.name ?? null : null;
      const titleOf = (id: string | null) => plan?.waypoints.find(w => w.id === id)?.title ?? null;
      return {
        threadId,
        widgetRow: runtime.config().tavern.widgetRow,
        ambientMotion: runtime.config().tavern.hearthFlicker ? runtime.config().tavern.ambientMotion : "off",
        repeatSeconds: runtime.config().tavern.repeatSeconds,
        characters: runtime.config().tavern.characters,
        voice: runtime.config().tavern.voice,
        ...(m ? { moodSignals: {
          released: thread.released != null,
          archived: thread.archivedAt != null || thread.deletedAt != null,
          handBack: m.role === "keeper" && k.memory.notes(threadId, 200).some(note => note.kind === "waiting-on-user"),
          report: currentMoodReport(k.store.query("reports", "memberThreadId", threadId, 1)[0], thread.lastBriefAt),
          waypointTitle: titleOf(m.waypointId ?? m.checkerWaypointId ?? null),
          verdict: verdict ? { status: verdict.status, at: verdict.at, waypointTitle: titleOf(verdict.waypointId), checkerName } : null,
        } } : {}),
        classNotice: thread.classNotice ?? null,
        scope: runtime.scopes?.view(threadId) ?? null,
        violations: runtime.scopes?.violations([threadId]) ?? [],
        member: m ? projectMember(m) : null,
        keeper: m?.keeperThreadId ? k.member(m.keeperThreadId) : null,
        boardQuest: m?.boardQuestId ? k.summary(m.boardQuestId) : null,
        briefFields: decorBrief(k.store.runtime(threadId).brief),
        brief: k.store.runtime(threadId).brief
          ? JSON.stringify(k.store.runtime(threadId).brief, null, 2)
          : null,
        progress: k.journal.progress(threadId),
        hidden: k.store.runtime(threadId).hidden,
        pendingEvents: runtime.pendingNews(threadId),
        wakeBatching: runtime.wakeBatching(),
        keeperView:
          m?.role === "keeper"
            ? {
                boardQuests: quests(threadId),
                errands: errands(threadId),
                openAsks: k.store.openAsks(threadId, undefined, true),
                ...decisions.attention({ keeperThreadId: threadId }),
                quietSince: k.store.runtime(threadId).manualStopAt ?? null,
                archived: k.store.runtime(threadId).archivedAt != null,
                status: status(threadId),
              }
            : null,
      };
    },
    crests: ({ threadIds }) => ({
      crests: threadIds.flatMap((threadId) => {
        const m = k.member(threadId);
        if (!m) return [];
        const registry = runtime.snapshot(
          k.store.runtime(threadId).projectId ?? undefined,
        );
        return [
          {
            threadId,
            classId: m.classId,
            characterId: m.characterId,
            label: `${runtime.keeper.name(m)} · ${registry.classes.find((c) => c.id === m.classId)?.label ?? m.classId}`,
          },
        ];
      }),
    }),
    journal: ({ threadId }) => k.journal.get(threadId),
    journalEdit: async ({ threadId, edit }, _context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      await k.journal.prepare(threadId);
      const result = commitUserAct(k.store, () => k.now(), receipt, () => k.journal.edit(threadId, edit, { kind: "user" }));
      k.changed(threadId, k.member(threadId)?.boardQuestId);
      return { ok: true, message: result.message };
    },
    resumeKeeper: ({ threadId }) => {
      k.require(threadId, "keeper");
      k.userAction(threadId, "explicit user resume after manual-stop", true);
      wake(threadId);
      return { ok: true };
    },
    ledger: ({ threadId }): Ledger => {
      const history = decisions.history({ keeperThreadId: threadId });
      return {
        notes: k.memory.notes(threadId, 200),
        notesTotal: k.memory.noteCount(threadId),
        gates: k.memory.gates(threadId),
        scopes: runtime.scopes?.views(partyIds(threadId)) ?? [],
        violations: runtime.scopes?.violations(partyIds(threadId)) ?? [],
        keeperThreadId: threadId,
        quietSince: k.store.runtime(threadId).manualStopAt ?? null,
        olderPromises: k.memory.olderPromiseCount(threadId),
        boardQuests: quests(threadId),
        ...decisions.attention({ keeperThreadId: threadId }),
        decisions: history.decisions,
        decisionsNextCursor: history.nextCursor,
        decisionsTotal: history.total,
        rules: k.rules(threadId, null, true),
        asks: k.store.visibleRecords("asks", threadId, 100).reverse(),
        routes: k.store.visibleRecords("routes", threadId, 100).reverse(),
        restatement: k.restatement(threadId),
        lastReanchorAt: k.store.runtime(threadId).lastReanchorAt,
      };
    },
    routes: ({ threadId }) => {
      const routes = k.store.query("routes", "keeperThreadId", threadId, 100).filter(route => !route.boardQuestId || k.store.get("quests", route.boardQuestId)?.deletedAt == null);
      const ids = new Set(routes.flatMap(route => route.ruleId ? [route.ruleId] : []));
      return {
        routes,
        boardQuests: k.store.query("quests", "keeperThreadId", threadId, 100).filter(quest => quest.deletedAt == null),
        rules: [...ids].flatMap(id => {
          const rule = k.store.get("rules", id);
          return rule ? [rule] : [];
        }),
      };
    },
    boardQuest: async ({ id }): Promise<BoardQuestDetail> => {
      const q = k.quest(id);
      if (q.deletedAt != null) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "This quest is deleted. Restore it from the cellar’s Deleted view." });
      try { await backfillTaleDelivery(k, q, args => runtime.bb.sdk.threads.output(args)); }
      catch (error) { runtime.bb.log.warn(`Tavern tale backfill ${id}: ${String(error)}`); }
      void runtime.taleRenderer?.ensure(id);
      const summary = k.summary(id);
      const tale: BoardQuestDetail["tale"] = readTale(k, summary);
      if (tale?.delivery) {
        try {
          const thread = await runtime.bb.sdk.threads.get({ threadId: q.keeperThreadId });
          if (thread.environmentId) {
            const environment = await runtime.bb.sdk.environments.get({ environmentId: thread.environmentId });
            tale.fileHostId = environment.hostId;
            if (environment.path) tale.document = { threadId: q.keeperThreadId, rootPath: environment.path, target: { kind: "workspace", environmentId: thread.environmentId, path: environment.path } };
          }
        } catch (error) { runtime.bb.log.warn(`Tavern tale document ${id}: ${String(error)}`); }
      }
      const history = decisions.history({ keeperThreadId: q.keeperThreadId, boardQuestId: id });
      const ids = k.store
        .query("members", "boardQuestId", id, 500)
        .map((member) => member.threadId);
      const events = k.store.events(q.keeperThreadId, 0, 500).filter(e => e.boardQuestId === id);
      const stopped = q.phase === "stopped" || q.phase === "stopping";
      const through = q.stoppingSince ?? q.endedAt ?? q.updatedAt;
      const roadEvent = stopped ? k.store.questRoadEvent(id, through) : null;
      if (roadEvent && !events.some(e => e.id === roadEvent.id)) {
        events.push(roadEvent);
        events.sort((a, b) => a.id - b.id);
      }
      if ((roadEvent?.data.phase as { from?: string } | undefined)?.from === "held") {
        const hold = k.store.questHeldEvent(id, roadEvent!.id);
        if (hold && !events.some(e => e.id === hold.id)) {
          events.push(hold);
          events.sort((a, b) => a.id - b.id);
        }
      }
      const asks: BoardQuestDetail["asks"] = k.store.query("asks", "boardQuestId", id, 500);
      return {
        notes: k.memory.notes(q.keeperThreadId, 200, 0, id),
        gates: k.memory
          .gates(q.keeperThreadId)
          .filter((gate) => gate.boardQuestId === id),
        scopes: runtime.scopes?.views(ids) ?? [],
        violations: runtime.scopes?.violations(ids) ?? [],
        quest: projectQuest(summary),
        tale,
        memberCredits: memberCredits(k, summary),
        plans: k.store.query("plans", "boardQuestId", id, 30),
        asks,
        decisions: history.decisions,
        decisionsNextCursor: history.nextCursor,
        decisionsTotal: history.total,
        rules: k.rules(q.keeperThreadId, id, true),
        reports: k.store.query("reports", "boardQuestId", id, 100),
        routes: k.store.query("routes", "boardQuestId", id, 100),
        events,
      };
    },
    allowReview: ({ id }, context?: ExperimentalPluginRpcHandlerContext) => new LimitPolicy(k).allowReview(id, requireUserAct(context, "allowReview").surface),
    holdBoardQuest: ({ id }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      return runtime.setQuestHeld(id, true, { kind: "user" }, undefined, receipt);
    },
    resumeBoardQuest: ({ id }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      return runtime.setQuestHeld(id, false, { kind: "user" }, undefined, receipt);
    },
    setTaleKept: (input, context?: ExperimentalPluginRpcHandlerContext) => {
      return runtime.serviceRecords.setTaleKept(input);
    },
    archiveBoardQuests: ({ ids, archived }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      return runtime.archiveBoardQuests(ids, archived, receipt);
    },
    deleteBoardQuest: ({ id }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      return runtime.deleteBoardQuest(id, receipt);
    },
    restoreDeletedQuest: ({ id }, context?: ExperimentalPluginRpcHandlerContext) => {
      return { ok: true, changed: Number(k.restoreDeletedQuest(id, { kind: "user" })) };
    },
    deletedBoardQuests: ({ cursor, limit }) => {
      const page = k.store.deletedQuestPage(cursor, limit);
      return { boardQuests: page.quests.map(q => projectQuest(k.summary(q.id))), nextCursor: page.nextCursor, total: page.total };
    },
    mapHistory: () => k.store.mapHistory(),
    archivedBoardQuests: ({ cursor, limit }) => {
      const page = k.store.archivedQuestPage(cursor, limit);
      return {
        boardQuests: page.quests.map((q) => projectQuest(k.summary(q.id))),
        nextCursor: page.nextCursor,
        total: page.total,
      };
    },
    room: (): Room => ({
      away: runtime.away.status(),
      hearthFlicker: runtime.config().tavern.hearthFlicker,
      ambientMotion: runtime.config().tavern.hearthFlicker ? runtime.config().tavern.ambientMotion : "off",
      repeatSeconds: runtime.config().tavern.repeatSeconds,
      archivedCount: k.store.archivedQuestCount(),
      keepers: k.store
        .all("members")
        .filter((m) => m.role === "keeper")
        .map((m) => {
          const thread = k.store.runtime(m.threadId);
          return {
            member: projectMember(m),
            archived: thread.archivedAt != null,
            threadTitle: thread.threadTitle ?? null,
            threadCreatedAt: thread.threadCreatedAt ?? null,
            quietSince: thread.manualStopAt ?? null,
            boardQuests: quests(m.threadId),
            errands: errands(m.threadId),
            status: status(m.threadId),
          };
        }),
      asks: k.store
        .openAsks(undefined, undefined, true)
        .sort((a, b) => a.createdAt - b.createdAt),
      ...decisions.attention(),
      review: runtime.review(),
      solos: k.store.all("members").filter((m) => m.role === "solo" && isLiveMember(k.store, m, "occupy")).map(projectMember),
      recent: k.store.roomEvents(60),
    }),
    releaseCheckerHandoff: async ({ boardQuestId, holdId, via }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      const quest = k.quest(boardQuestId);
      const wasHeld = quest.checkerHandoffHold?.id === holdId && quest.checkerHandoffHold.release === null;
      const checkerHandoffHold = commitUserAct(k.store, () => k.now(), receipt, () => k.releaseCheckerHandoff(boardQuestId, holdId, via));
      if (wasHeld) {
        await runtime.away.return({ kind: "explicit-return", threadId: quest.keeperThreadId, refId: holdId });
        wake(quest.keeperThreadId);
      }
      return { checkerHandoffHold };
    },
    questAuthority: ({ boardQuestId }) => { const view = k.authority.view(boardQuestId); const review = runtime.review(); return { ...view, review: { used: review.waiting, total: review.budget } }; },
    delegateQuest: ({ boardQuestId, kind, via }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => { requireUserAct(context, "delegateQuest"); k.authority.delegate(boardQuestId, kind, receipt ? { ...receipt, surface: `${via} (client, unattested)` } : receipt!); return { ok: true }; },
    preapproveQuest: ({ boardQuestId, via, ...input }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => { requireUserAct(context, "preapproveQuest"); k.authority.preapprove(boardQuestId, input, receipt ? { ...receipt, surface: `${via} (client, unattested)` } : receipt!); void runtime.applyStandingAnswers(boardQuestId).catch(error => runtime.bb.log.warn(`Tavern pre-approval: ${String(error)}`)); return { ok: true }; },
    revokeQuestAuthority: ({ boardQuestId, id, via }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => { requireUserAct(context, "revokeQuestAuthority"); k.authority.revoke(boardQuestId, id, receipt ? { ...receipt, surface: `${via} (client, unattested)` } : receipt!); return { ok: true }; },
    answerAsk: async ({ askId, optionId, note, via }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      await runtime.answerAsk(askId, optionId, note, via, context?.experimental_caller.kind === "client", receipt?.surface, receipt);
      const ask = k.store.get("asks", askId)!;
      wake(ask.keeperThreadId);
      return { ok: true };
    },
    markDecisionsSeen: (input) => {
      const { changed, result } = decisions.mark(input, k.now());
      decisionsChanged(changed);
      return result;
    },
    markDecisionsUnseen: ({ undoToken }) => {
      const { changed, result } = decisions.unseen(undoToken);
      decisionsChanged(changed);
      return result;
    },
    decisionHistory: ({ keeperThreadId, boardQuestId, cursor, limit }) =>
      decisions.history({ keeperThreadId, boardQuestId }, cursor, limit),
    undoDecision: async ({ decisionId }, _context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      await runtime.undoDecision(decisionId, receipt);
      k.userAction(k.store.get("decisions", decisionId)!.keeperThreadId);
      wake(k.store.get("decisions", decisionId)!.keeperThreadId);
      return { ok: true };
    },
    correctRoute: ({ routeId, kind, boardQuestId, boardQuestIds }) => {
      k.correctRoute(routeId, kind, boardQuestId, boardQuestIds);
      k.userAction(k.store.get("routes", routeId)!.keeperThreadId);
      wake(k.store.get("routes", routeId)!.keeperThreadId);
      return { ok: true };
    },
    addRule: (input) => {
      k.addRule(input);
      return { ok: true };
    },
    confirmRule: ({ ruleId, active }) => {
      k.confirmRule(ruleId, active);
      return { ok: true };
    },
    widenRule: ({ ruleId, scope }) => {
      k.widenRule(ruleId, scope);
      return { ok: true };
    },
    stopBoardQuest: ({ id, reason }, _context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => runtime.stop(id, reason, receipt),
    setHidden: ({ threadId, hidden }) => {
      k.store.patch(threadId, { hidden });
      k.changed(threadId);
      return { ok: true };
    },
    typing: ({ threadId }) => {
      if (k.member(threadId)?.role === "keeper" && k.store.runtime(threadId).archivedAt == null) {
        k.store.patch(threadId, { typingAt: k.now() });
        runtime.bb.rpc.experimental_invalidate([tags.thread(threadId)]);
      }
      return { ok: true };
    },
  }, k.store, () => k.now());
}
export function registerRpc(bb: BbPluginApi, runtime: TavernRuntime) {
  bb.rpc.register(rpcContract, rpcHandlers(runtime));
}
