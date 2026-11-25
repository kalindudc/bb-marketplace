import { memberIdentityFacts, memberIdentityLabel } from "../shared/identity";
import { memberHost } from "./member-engagement";
import { updateMemberSchedule } from "./member-schedules";
import { memberBriefRows, rangerCheckpointRows } from "./status";
import { wasReleased } from "../shared/member-engagement";
import { askHistory } from "./ask-history";
import { askMemberTarget, scopeAskMember } from "./ask-effects";
import { refreshQuestPullRequests } from "./conclude-pull-requests";
import { askNeedsUser, attention, attentionCount, AttentionSnapshot } from "./attention";
import { LimitPolicy } from "./limit-policy";
import { userActHandlers, requireUserAct, type OptionalRpcContext, commitUserAct, type UserActReceipt } from "./authority";
import { readUndoLanes, undoAskProjection } from "./undo-record";
import type { BbPluginApi, ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import {
  DECOR_BRIEF_CONTEXT_MAX,
  rpcContract,
  tags,
  type BoardQuestDetail,
  type BoardQuestSummary,
  type Ledger,
  type Room,
  type ThreadDecor,
} from "../shared/contract";
import { currentMoodReport, waypointMoodVerdict } from "../shared/mood";
import type { Brief, Decision, Member } from "../shared/schema";
import { isLiveKeeper, isLiveMember, isOpenQuest } from "./liveness";
import { isNotFound } from "./host-errors";
import type { Runtime } from "./keeper/store";
import { DecisionViews } from "./decisions";
import { markSummariesSeen, markVisitSummariesSeen, searchAnswers, startAnswerTracking, summariesForQuest, summaryCounts, summaryView, unansweredMessages } from "./summaries";
import { markQuestChangesSeen } from "./quest-change-attention";
import { stopAllHandlers } from "./stop-all-rpc";
import { placementHandlers } from "./placement/rpc";
import { PlacementStore } from "./placement/store";
import { awayHandlers } from "./away/rpc";
import { classEditorHandlers, requireClassClient } from "./registry-rpc";
import { classExecutionFacts } from "./class-execution";
import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { backfillTaleDelivery, memberCredits, readTale } from "./tale";
import { readCharacterPresentation } from "./character-presentation";
import type { TavernRuntime } from "./runtime";
import { freeHands, restingContext } from "./resting";
import { threadIdentities } from "./identity";
import { currentAskNames } from "./quest-names";
import { readStripScene } from "./strip-scene";

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
  const answerTrackingStarted = startAnswerTracking(k.store, k.now());
  const { identities } = threadIdentities(runtime);
  const placementStore = new PlacementStore(k.store.db);
  const pullRequestsFor = (id: string) => k.store.pullRequestsForMember(id);
  const memberExtras = (member: Member, context: ReturnType<typeof restingContext>, pullRequestsOf = pullRequestsFor) => {
    const placement = placementStore.byMember(member.threadId);
    return { restNote: runtime.restNote(member, context), pullRequests: pullRequestsOf(member.threadId),
      placement: placement ? runtime.placements().controller.view(placement) : null };
  };
  const projectMember = (member: Member) => ({ ...member, ...memberExtras(member, restingContext(k)) });
  const memberProjection = (context: ReturnType<typeof restingContext>, pullRequestsOf = pullRequestsFor) => {
    const extras = new Map<string, ReturnType<typeof memberExtras>>();
    return (member: Member) => {
      if (!extras.has(member.threadId)) extras.set(member.threadId, memberExtras(member, context, pullRequestsOf));
      return { ...member, ...extras.get(member.threadId)! };
    };
  };
  const projectQuest = (quest: BoardQuestSummary, snapshot?: AttentionSnapshot, project = memberProjection(restingContext(k))) => ({
    ...quest, attention: snapshot ? snapshot.view({ boardQuestId: quest.id }, 0, 0, false) : attention(k.store, { boardQuestId: quest.id }, k.now()),
    members: quest.members.map(project),
    waypoints: quest.waypoints.map(waypoint => ({ ...waypoint, ownerMember: waypoint.ownerMember ? project(waypoint.ownerMember) : null })),
  });
  const status = (threadId: string, thread: Runtime, member: Member | null): "listening" | "busy" | "holding" => {
    if (thread.archivedAt != null) return "listening";
    if (member?.state === "working") return "busy";
    return runtime.held(threadId, thread, member) ? "holding" : "listening";
  };
  const quests = (threadId: string, snapshot?: AttentionSnapshot, project?: typeof projectMember, summaryOf = (id: string) => k.summary(id)) =>
    k.store
      .visibleRecords("quests", threadId, 100)
      .reverse()
      .map((q) => projectQuest(summaryOf(q.id), snapshot, project));
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
  const errands = (threadId: string, project = memberProjection(restingContext(k))) =>
    k.store.errandsPage(threadId, 100, 0).members.map(({ member }) => project(member));
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
  const handlers = userActHandlers<OptionalRpcContext<ExperimentalPluginRpcHandlersWithContext<Omit<typeof rpcContract, "renameBoardQuest">>>>({
    ...stopAllHandlers(runtime),
    ...placementHandlers(runtime),
    ...awayHandlers(runtime),
    alertRoute: () => runtime.alerts.view(),
    alertTestSend: (_input, context, receipt?: UserActReceipt) => runtime.alerts.sendTest(receipt ?? requireUserAct(context, "alertTestSend")),
    alertTestConfirm: ({ id, arrived }) => runtime.alerts.confirm(id, arrived),
    prepareTellKeepers: async ({ keeperIds }) => ({ targets: await Promise.all([...new Set(keeperIds)].map(async threadId => {
      const keeper = k.member(threadId);
      const name = keeper?.role === "keeper" ? k.name(keeper) : "Keeper";
      if (!isLiveKeeper(k.store, keeper, "present")) return { threadId, name, status: "gone" as const };
      try {
        const thread = await runtime.bb.sdk.threads.get({ threadId });
        return { threadId, name, status: thread.archivedAt != null || thread.deletedAt != null ? "gone" as const : "ready" as const };
      } catch (error) {
        return { threadId, name, status: isNotFound(error) ? "gone" as const : "unavailable" as const };
      }
    })) }),
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
      const entries = boardQuest ? k.journal.linkedEntries(boardQuest.id) : [];
      const verdict = m ? waypointMoodVerdict(m, entries) : null;
      const reviewer = verdict?.checkerThreadId ? k.member(verdict.checkerThreadId) : null;
      const checkerName = reviewer?.classId === "warden" && reviewer.characterId
        ? reviewer.displayName ?? runtime.snapshot(k.store.runtime(reviewer.threadId).projectId ?? undefined).characters.find(c => c.id === reviewer.characterId)?.name ?? null : null;
      const titleOf = (id: string | null) => plan?.waypoints.find(w => w.id === id)?.title ?? null;
      const lastReport = m ? k.store.query("reports", "memberThreadId", threadId, 1)[0] : undefined;
      const snapshot = m?.role === "keeper" ? new AttentionSnapshot(k.store, { keeperThreadId: threadId }) : null;
      const host = m ? memberHost(k.store, m) : null;
      const memberAsks = m?.role === "member" && m.keeperThreadId && isLiveMember(k.store, m, "brief") && host?.archivedAt == null && host?.deletedAt == null
        ? k.store.openAsks(m.keeperThreadId, undefined, true).filter(ask => {
            const target = askMemberTarget(ask);
            const waypoint = m.checkerWaypointId ?? m.waypointId;
            return (target ? target === threadId : waypoint && ask.boardQuestId === m.boardQuestId && ask.holds.includes(waypoint)) && askNeedsUser(k.store, ask);
          })
        : [];
      const report = currentMoodReport(lastReport, thread.lastBriefAt);
      const handBack = m?.role === "keeper" && k.memory.notes(threadId, 200).some(note => note.kind === "waiting-on-user");
      const archived = !!host && (host.archivedAt != null || host.deletedAt != null);
      const scene = m && readStripScene(k, m, { thread, boardQuest, plan, entries, lastReport, verdict, archived,
        held: handBack || memberAsks.length > 0 || !!snapshot?.asks.some(a => a.state === "open"),
      });
      return {
        threadId,
        ...(scene ? { stripScene: scene } : {}),
        ...(runtime.config().tavern.contextualSpeech ? { contextualSpeech: true } : {}),
        speechGapMinutes: runtime.config().tavern.speechGapMinutes,
        widgetRow: runtime.config().tavern.widgetRow,
        succession: runtime.succession.view(threadId),
        ambientMotion: runtime.config().tavern.hearthFlicker ? runtime.config().tavern.ambientMotion : "off",
        repeatSeconds: runtime.config().tavern.repeatSeconds,
        characters: runtime.config().tavern.characters,
        characterQuietUntil: runtime.config().tavern.characterQuietUntil,
        voice: runtime.config().tavern.voice,
        voiceBeforeOff: runtime.config().tavern.voiceBeforeOff,
        reportedPoseSeconds: runtime.config().tavern.reportedPoseSeconds,
        verifiedPoseMinutes: runtime.config().tavern.verifiedPoseMinutes,
        ...(m ? { moodSignals: {
          released: wasReleased(m),
          archived,
          handBack,
          report,
          waypointTitle: titleOf(m.checkerWaypointId ?? m.waypointId),
          verdict: verdict ? { status: verdict.status, at: verdict.at, waypointTitle: titleOf(verdict.waypointId), checkerName } : null,
        } } : {}),
        classNotice: thread.classNotice ?? null,
        scope: runtime.scopes?.view(threadId) ?? null,
        openScopeAsk: memberAsks.some(ask => scopeAskMember(ask.effect) === threadId),
        memberAsks,
        violations: runtime.scopes?.violations([threadId]) ?? [],
        member: m ? projectMember(m) : null,
        keeper: m?.keeperThreadId ? k.member(m.keeperThreadId) : null,
        boardQuest: m?.boardQuestId ? k.summary(m.boardQuestId) : null,
        lastReportedWaypointId: lastReport?.waypointId ?? null,
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
                attention: snapshot!.view({ keeperThreadId: threadId }, 50),
                boardQuests: quests(threadId, snapshot!),
                errands: errands(threadId),
                openAsks: snapshot!.asks.slice(0, 50),
                ...snapshot!.calls({ keeperThreadId: threadId }),
                quietSince: k.store.runtime(threadId).manualStopAt ?? null,
                archived: k.store.runtime(threadId).archivedAt != null,
                status: status(threadId, thread, m),
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
        const keeper = m.keeperThreadId ? k.member(m.keeperThreadId) : null;
        return [{
          threadId, classId: m.classId, characterId: m.characterId,
          label: keeper ? memberIdentityLabel(m, registry, keeper) : `${memberIdentityLabel(m, registry)} · ${memberIdentityFacts(m, registry).className}`,
        }];
      }),
    }),
    identities: async ({ ids, viewer }) => ({ identities: await identities(ids, viewer) }),
    journal: ({ threadId }) => k.journal.get(threadId),
    journalEdit: async ({ threadId, edit }, _context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      k.succession.assertMutable(threadId);
      await k.journal.prepare(threadId);
      k.succession.assertMutable(threadId);
      const result = commitUserAct(k.store, () => k.now(), receipt, () => k.journal.edit(threadId, edit, { kind: "user" }));
      return { ok: true, message: result.message };
    },
    resolveHandBack: ({ noteId, how, reply }, _context, receipt?: UserActReceipt) => {
      const result = k.memory.resolveByUser(noteId, how, reply);
      if (result.changed) { k.userAction(result.note.keeperThreadId); wake(result.note.keeperThreadId); }
      return { ok: true as const };
    },
    refreshKeeper: ({ threadId }) => {
      runtime.succession.request(threadId, { kind: "user" }, "You asked to refresh this Keeper.");
      return { ok: true as const };
    },
    cancelKeeperRefresh: ({ threadId, successionId }) => {
      runtime.succession.cancel(threadId, successionId);
      return { ok: true as const };
    },
    finishKeeperHandover: async ({ threadId, successionId }, _context, receipt?: UserActReceipt) => {
      await runtime.succession.finishHandover(threadId, successionId, receipt);
      return { ok: true as const };
    },
    resumeKeeper: ({ threadId }) => {
      k.require(threadId, "keeper");
      k.userAction(threadId, "explicit user resume after manual-stop", true);
      wake(threadId);
      return { ok: true };
    },
    askHistory: ({ threadId, cursor }) => askHistory(k.store, threadId, cursor),
    ledger: ({ threadId }): Ledger => {
      const snapshot = new AttentionSnapshot(k.store, { keeperThreadId: threadId });
      const history = decisions.history({ keeperThreadId: threadId }, null, 50);
      const askPage = askHistory(k.store, threadId);
      const memberBriefs = memberBriefRows(k, threadId);
      const briefIds = new Set(memberBriefs.map(row => row.pendingBrief.id));
      const keeperBlocks = k.store.openAsks(threadId).filter(ask => ask.kind === "blocker" && !askNeedsUser(k.store, ask) &&
        (!ask.boardQuestId || isOpenQuest(k.store.get("quests", ask.boardQuestId))) &&
        !(ask.effect?.type === "retry-brief" && briefIds.has(ask.effect.briefId)))
        .slice(0, 50).map(({ id, question, why }) => ({ id, question, why }));
      return {
        attention: snapshot.view({ keeperThreadId: threadId }),
        notes: k.memory.notes(threadId, 200).filter(note => note.kind !== "waiting-on-user"),
        notesTotal: k.memory.noteCount(threadId),
        gates: k.memory.gates(threadId),
        scopes: runtime.scopes?.views(partyIds(threadId)) ?? [],
        violations: runtime.scopes?.violations(partyIds(threadId)) ?? [],
        keeperThreadId: threadId,
        memberBriefs,
        rangerCheckpoints: rangerCheckpointRows(k, threadId),
        scheduledRounds: k.store.recentScheduledRounds(threadId),
        keeperBlocks,
        succession: runtime.succession.view(threadId),
        undoLanes: readUndoLanes(k.store, threadId),
        quietSince: k.store.runtime(threadId).manualStopAt ?? null,
        olderPromises: k.memory.olderPromiseCount(threadId),
        boardQuests: quests(threadId, snapshot),
        ...snapshot.calls({ keeperThreadId: threadId }),
        decisions: history.decisions,
        decisionsNextCursor: history.nextCursor,
        decisionsTotal: history.total,
        rules: k.rules(threadId, null, true),
        asks: [...snapshot.asks, ...askPage.asks],
        asksNextCursor: askPage.nextCursor,
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
    boardQuest: async ({ id, refreshPullRequests }): Promise<BoardQuestDetail> => {
      const q = k.quest(id);
      const snapshot = new AttentionSnapshot(k.store, { boardQuestId: id });
      if (q.deletedAt != null) throw new experimental_PluginRpcRefusal({ code: "not_found", message: "This quest is deleted. Restore it from the cellar’s Deleted view." });
      if (refreshPullRequests) await refreshQuestPullRequests(runtime, id);
      try { await backfillTaleDelivery(k, q, args => runtime.bb.sdk.threads.output(args)); }
      catch (error) { runtime.bb.log.warn(`Tavern tale backfill ${id}: ${String(error)}`); }
      void runtime.taleRenderer?.ensure(id);
      const summary = k.summary(id);
      const tale: BoardQuestDetail["tale"] = readTale(k, summary);
      const historyPage = summariesForQuest(k.store, id, runtime.config().attention.answerPageSize);
      const boardAttention = snapshot.view({ boardQuestId: id });
      const visitChangeId = boardAttention.items.find(item => item.kind === "quest-changed")?.id;
      let summaryDocument: BoardQuestDetail["summaryDocument"];
      if (tale?.delivery || historyPage.summaries.length) {
        try {
          const thread = await runtime.bb.sdk.threads.get({ threadId: q.keeperThreadId });
          if (thread.environmentId) {
            const environment = await runtime.bb.sdk.environments.get({ environmentId: thread.environmentId });
            const path = environment.path;
            if (tale?.delivery) tale.fileHostId = environment.hostId;
            if (path) {
              const document = { threadId: q.keeperThreadId, rootPath: path, target: { kind: "workspace" as const, environmentId: thread.environmentId, path } };
              if (tale?.delivery) tale.document = document;
              if (historyPage.summaries.length) summaryDocument = document;
            }
          }
        } catch (error) { runtime.bb.log.warn(`Tavern Keeper document ${id}: ${String(error)}`); }
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
      const asks: BoardQuestDetail["asks"] = k.store.query("asks", "boardQuestId", id, 500).map(undoAskProjection(k.store)).map(ask => currentAskNames(k.store, ask));
      return {
        ...historyPage,
        ...(visitChangeId ? { visitChangeId } : {}),
        ...(summaryDocument ? { summaryDocument } : {}),
        ...(historyPage.summaries.length ? { summaryCounts: summaryCounts(k.store, id) } : {}),
        attention: boardAttention,
        notes: k.memory.notes(q.keeperThreadId, 200, 0, id).filter(note => note.kind !== "waiting-on-user"),
        gates: k.memory
          .gates(q.keeperThreadId)
          .filter((gate) => gate.boardQuestId === id),
        scopes: runtime.scopes?.views(ids) ?? [],
        violations: runtime.scopes?.violations(ids) ?? [],
        quest: { ...projectQuest(summary, snapshot), attention: boardAttention },
        tale,
        memberCredits: memberCredits(summary),
        pullRequests: k.store.pullRequestsForQuest(summary.id),
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
    searchAnswers: ({ query, boardQuestId, before }) => searchAnswers(k.store, query, runtime.config().attention.answerPageSize, boardQuestId, before),
    unansweredMessages: ({ boardQuestId, before }) => {
      const quest = k.quest(boardQuestId);
      if (quest.deletedAt != null) return { messages: [], nextCursor: null };
      return unansweredMessages(k.store, quest, answerTrackingStarted, runtime.config().attention.answerPageSize, before);
    },
    olderSummaries: ({ boardQuestId, beforeId }) => {
      if (k.quest(boardQuestId).deletedAt != null) return { summaries: [], nextCursor: null };
      const { summaries, summariesNextCursor } = summariesForQuest(k.store, boardQuestId, runtime.config().attention.answerPageSize, beforeId);
      return { summaries, nextCursor: summariesNextCursor };
    },
    summary: ({ id, threadId }) => {
      const summary = summaryView(k.store, id);
      if (!summary || summary.keeperThreadId !== threadId || k.quest(summary.boardQuestId).deletedAt != null) return { summary: null, ask: null, handBack: null };
      const request = summary.request;
      const ask = request?.kind === "ask" ? k.store.get("asks", request.id) : null;
      const handBack = request?.kind === "hand-back" ? k.store.get("notes", request.id) : null;
      return { summary, ask: ask ? currentAskNames(k.store, undoAskProjection(k.store)(ask)) : null, handBack };
    },
    allowReview: ({ id }, context?: ExperimentalPluginRpcHandlerContext) => new LimitPolicy(k).allowReview(id, requireUserAct(context, "allowReview").surface),
    questSpend: ({ id }) => runtime.spend.view(id),
    setSpendBudget: async ({ id, budgetCents }, _context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      await runtime.spend.set(id, budgetCents, receipt!);
      const quest = k.quest(id);
      wake(quest.keeperThreadId);
      void runtime.recheckDispatch();
      return { ok: true };
    },
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
    deletedQuestCount: () => ({ total: k.store.deletedQuestPage(null, 1).total }),
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
    attentionCount: () => ({ count: attentionCount(k.store) }),
    room: (): Room => {
      const members = k.store.all("members");
      const summaries = new Map<string, BoardQuestSummary>();
      const summaryOf = (id: string) => {
        if (!summaries.has(id)) summaries.set(id, k.summary(id));
        return summaries.get(id)!;
      };
      const context = restingContext(k, members, summaryOf);
      const pullRequests = new Map<string, ReturnType<typeof pullRequestsFor>>();
      for (const request of k.store.all("pullRequests")) for (const id of new Set([request.memberThreadId, request.owner])) {
        const list = pullRequests.get(id);
        if (list) list.push(request);
        else pullRequests.set(id, [request]);
      }
      const project = memberProjection(context, id => pullRequests.get(id) ?? []);
      const snapshot = new AttentionSnapshot(k.store);
      const list = snapshot.view({}, 50);
      const askIds = new Set(list.items.filter(item => item.kind === "ask").map(item => item.id));
      const { hearthFlicker, characterQuietUntil, ambientMotion, repeatSeconds } = runtime.config().tavern;
      return {
        attention: list,
        sinceVisit: snapshot.sinceVisit(),
        away: runtime.away.status(),
        hearthFlicker,
        characterQuietUntil,
        ambientMotion: hearthFlicker ? ambientMotion : "off",
        repeatSeconds,
        archivedCount: k.store.archivedQuestCount(),
        keepers: members.filter(m => m.role === "keeper" && runtime.succession.state.current(m.threadId) === m.threadId).map(m => {
          const thread = k.store.runtime(m.threadId);
          return {
            member: project(m),
            freeHands: freeHands(k, m.threadId, context).length,
            succession: runtime.succession.view(m.threadId),
            archived: !isLiveKeeper(k.store, m, "present"),
            threadTitle: thread.threadTitle ?? null,
            threadCreatedAt: thread.threadCreatedAt ?? null,
            quietSince: thread.manualStopAt ?? null,
            attention: snapshot.view({ keeperThreadId: m.threadId }, 0, 0, false),
            boardQuests: quests(m.threadId, snapshot, project, summaryOf),
            errands: errands(m.threadId, project),
            status: status(m.threadId, thread, m),
          };
        }),
        asks: snapshot.asks.filter(ask => askIds.has(ask.id)),
        ...snapshot.calls(),
        review: runtime.review("present", summaryOf),
        solos: members.filter(m => m.role === "solo" && isLiveMember(k.store, m, "occupy")).map(project),
        recent: k.store.roomEvents(60),
      };
    },
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
    delegateQuest: (input, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => { requireUserAct(context, "delegateQuest"); k.authority.delegate(input.boardQuestId, input.kind, receipt ? { ...receipt, surface: `${input.via} (client, unattested)` } : receipt!, input.kind === "drafts-as-you" ? input.targets : undefined); return { ok: true }; },
    preapproveQuest: ({ boardQuestId, via, ...input }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => { requireUserAct(context, "preapproveQuest"); k.authority.preapprove(boardQuestId, input, receipt ? { ...receipt, surface: `${via} (client, unattested)` } : receipt!); void runtime.applyStandingAnswers(boardQuestId).catch(error => runtime.bb.log.warn(`Tavern pre-approval: ${String(error)}`)); return { ok: true }; },
    revokeQuestAuthority: async ({ boardQuestId, id, via }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      requireUserAct(context, "revokeQuestAuthority");
      const grant = k.quest(boardQuestId).delegations?.find(record => record.id === id);
      if (grant?.kind === "drafts-as-you") {
        if (k.authority.revokingDraftDelegations.has(id)) throw new Error("This draft authority is already being revoked.");
        k.authority.revokingDraftDelegations.add(id);
        try { await runtime.scopes?.revokeDraftReceipts(boardQuestId, id); }
        finally { k.authority.revokingDraftDelegations.delete(id); }
      }
      k.authority.revoke(boardQuestId, id, receipt ? { ...receipt, surface: `${via} (client, unattested)` } : receipt!);
      return { ok: true as const };
    },
    scopeCallPage: ({ threadId, before }) => runtime.keeper.store.scopeCallPage(threadId, before),
    revokeShellGrant: ({ threadId, id }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      requireUserAct(context, "revokeShellGrant");
      if (!runtime.scopes) throw new Error("Shell grants are unavailable.");
      runtime.scopes.revokeGrant(threadId, id, receipt);
      return { ok: true };
    },
    updateMemberSchedule: ({ threadId, ...control }) => {
      updateMemberSchedule(k, threadId, control);
      return { ok: true };
    },
    clusterRunStatus: ({ askId }) => {
      const ask = k.store.get("asks", askId);
      return ask?.kind === "cluster-write" && ask.state === "open" ? runtime.clusterRunStatus(ask) : { guarded: false };
    },
    answerAsk: async ({ askId, optionId, note, via, pullRequestChoices }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      const result = await runtime.answerAsk(askId, optionId, note, via, context?.experimental_caller.kind === "client", receipt?.surface, receipt, false, pullRequestChoices);
      const ask = k.store.get("asks", askId)!;
      if (!result.awaitingClusterConfirmation && !(ask.kind === "cluster-write" && optionId === "confirm-run")) wake(ask.keeperThreadId);
      return { ok: true, ...(result.pullRequestErrors ? { pullRequestErrors: result.pullRequestErrors } : {}), ...(result.ask ? { ask: currentAskNames(k.store, result.ask) } : {}), ...(result.clusterGrantError ? { clusterGrantError: result.clusterGrantError } : {}) };
    },
    markVisitSeen: ({ summaryIds, changeIds }) => {
      const now = k.now();
      const { marked, changed } = k.store.atomic(() => ({
        marked: markVisitSummariesSeen(k.store, summaryIds, now),
        changed: markQuestChangesSeen(k.store, changeIds, now),
      }));
      if (changed || marked.length) runtime.bb.rpc.experimental_invalidate([...new Set([tags.room(), ...marked.flatMap(s => [tags.thread(s.keeperThreadId), tags.boardQuest(s.boardQuestId)])])]);
      return { ok: true };
    },
    markSummariesSeen: ({ boardQuestId, ids }) => {
      const quest = k.quest(boardQuestId);
      if (quest.deletedAt == null && markSummariesSeen(k.store, boardQuestId, ids, k.now())) {
        runtime.bb.rpc.experimental_invalidate([tags.room(), tags.thread(quest.keeperThreadId), tags.boardQuest(boardQuestId)]);
      }
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
    resetUndoLane: ({ threadId, kind }, _context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      const result = k.authority.resetUndoLane(threadId, kind, receipt!);
      k.userAction(threadId);
      runtime.bb.rpc.experimental_invalidate([...k.changedTags(threadId), tags.undoLanes()]);
      wake(threadId);
      return result;
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
  return {
    ...handlers,
    renameBoardQuest: ({ id, title, short }, context) => {
      const receipt = requireUserAct(context, "renameBoardQuest");
      k.renameQuest(id, { title, short }, { kind: "user" }, receipt);
      return { ok: true };
    },
  };
}
export function registerRpc(bb: BbPluginApi, runtime: TavernRuntime) {
  bb.rpc.register(rpcContract, rpcHandlers(runtime));
}
