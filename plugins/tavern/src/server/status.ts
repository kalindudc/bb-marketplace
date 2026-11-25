import { briefProgress, memberDetails, memberHost, releasedThreadOpen } from "./member-engagement";
import type { MemberBriefRow } from "../shared/contract";
import { memberActivityWord, wasReleased } from "../shared/member-engagement";
import { z } from "zod";
import { restingParty, showInFreeHands } from "./resting";
import { agentData } from "./agent-data";
import type { TavernRuntime } from "./runtime";
import { readRequestSources } from "./request-sources";
import { planDiff } from "./keeper/plan-diff";
import { isLiveMember } from "./liveness";

export const statusInput = z.object({
  boardQuestId: z.string().min(1).max(120).nullish(),
  section: z
    .enum([
      "summary",
      "brief",
      "archived",
      "holds",
      "events",
      "reports",
      "asks",
      "pending",
      "rules",
      "notes",
      "gates",
      "steers",
      "decisions",
      "errands",
      "requests",
      "placement",
      "lead-plan",
    ])
    .default("summary"),
  reportId: z.string().min(1).max(120).nullish(),
  member: z.string().min(1).max(120).nullish(),
  memberThreadId: z.string().min(1).max(120).nullish(),
  manifestId: z.string().min(1).max(120).nullish(),
  sourceIndex: z.number().int().nonnegative().default(0),
  offset: z.number().int().nonnegative().default(0),
  afterEventId: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(10).default(3),
}).refine(input => !input.member || !input.memberThreadId || input.member === input.memberThreadId,
  { path: ["member"], message: "Conflicting values; use member once." });
import { undoAskProjection } from "./undo-record";
import { currentLeadPlanNames, currentAskNames } from "./quest-names";

export function memberBriefRows(k: TavernRuntime["keeper"], threadId: string, boardQuestId?: string, memberThreadId?: string): MemberBriefRow[] {
  const now = k.now();
  return k.store.pendingMemberBriefs(threadId, boardQuestId, memberThreadId).map(({ member, pending }) => {
    return { memberThreadId: member.threadId, name: k.name(member), doing: member.doing,
      pendingBrief: {
        ...briefProgress(k.store, pending, now),
        attempts: pending.attempts, receiptChecks: pending.receiptChecks ?? 0,
        firstLine: (pending.assignmentText ?? pending.text).split("\n", 1)[0]!.trim().slice(0, 300),
      },
    };
  });
}

export function rangerCheckpointRows(k: TavernRuntime["keeper"], keeperId: string, boardQuestId?: string | null, memberThreadId?: string | null) {
  return k.store.activeStaffing(keeperId).flatMap(member => {
    const reportId = member.rangerCheckpointReportId;
    if (!reportId || !isLiveMember(k.store, member, "work") || boardQuestId && member.boardQuestId !== boardQuestId || memberThreadId && member.threadId !== memberThreadId) return [];
    return [{ memberThreadId: member.threadId, boardQuestId: member.boardQuestId, name: k.name(member), reportId, state: memberActivityWord(member) }];
  });
}

export function readStatus(runtime: TavernRuntime, threadId: string, input: z.output<typeof statusInput>) {
  if (input.section === "placement") return runtime.placements().controller.status(threadId, input.boardQuestId ?? null).then(agentData);
  return agentData(statusData(runtime, threadId, input));
}
function statusData(
  runtime: TavernRuntime,
  threadId: string,
  input: z.output<typeof statusInput>,
) {
  const k = runtime.keeper;
  if (input.section === "lead-plan") {
    if (!input.boardQuestId) throw new Error("Name the child board quest id.");
    const child = k.quest(input.boardQuestId);
    const [link] = k.store.leadLinksBy("childQuestId", child.id);
    const parent = link && k.quest(link.parentQuestId);
    if (!link || !parent || parent.keeperThreadId !== threadId && child.keeperThreadId !== threadId)
      throw new Error("Only the lead and its current hiring Keeper can read this lead-plan decision.");
    const record = k.store.get("leadPlans", `${child.id}:${child.planVersion}`);
    const plan = k.store.get("plans", `${child.id}:${child.planVersion}`);
    const previous = child.planVersion > 1 ? k.store.get("plans", `${child.id}:${child.planVersion - 1}`) : null;
    return { record: record?.state === "pending" ? { ...record, request: currentLeadPlanNames(k.store, record.request) } : record,
      change: previous && plan ? planDiff(previous, plan) : "First plan", plan };
  }
  if (input.section === "brief") {
    const memberId = input.memberThreadId ?? threadId;
    const member = k.member(memberId);
    if (!member || memberId !== threadId && member.keeperThreadId !== threadId)
      throw new Error("Only the member or its Keeper may read this brief.");
    const state = k.store.runtime(memberId);
    if (memberId === threadId && state.scopePending) throw new Error("The brief is held for a scope decision.");
    const brief = state.brief;
    if (!brief) throw new Error("No saved brief. A Keeper can name one of their members.");
    const text = JSON.stringify(brief, null, 2);
    const start = Math.min(input.offset, text.length);
    const max = runtime.config(member.boardQuestId).limits.transport.toolResultChars;
    let end = Math.min(start + Math.min(8000, max - 180), text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
    return `Saved brief, characters ${start}-${end} of ${text.length} (data):\n${text.slice(start, end)}\n${end < text.length ? `More: call tavern_status section=brief with the same member and offset=${end}.` : "End of brief."}`;
  }
  if (input.section === "requests") return readRequestSources(k, threadId, { memberThreadId: input.memberThreadId ?? undefined, manifestId: input.manifestId ?? undefined, sourceIndex: input.sourceIndex, offset: input.offset });
  const party = k.store.query("members", "keeperThreadId", threadId, -1);
  const archivedRows = party.filter(member => memberHost(k.store, member).archivedAt !== null).map(member => {
    const state = k.store.runtime(member.threadId);
    const quest = member.boardQuestId ? k.store.get("quests", member.boardQuestId) : null;
    return { threadId: member.threadId, name: k.name(member), classId: member.classId, quest: quest?.deletedAt != null ? "a deleted quest" : quest?.short ?? null, released: wasReleased(member), deleted: memberHost(k.store, member).deletedAt !== null };
  });
  const archivedMembers = archivedRows.slice(input.offset, input.offset + input.limit);
  const archivedMemberTotal = archivedRows.length;
  const nextArchivedOffset = input.offset + archivedMembers.length < archivedMemberTotal ? input.offset + archivedMembers.length : null;
  if (input.section === "archived") return { archivedMembers, archivedMemberTotal, nextArchivedOffset };
  const archivedCount = k.store.archivedQuestCount(threadId);
  const archived = {
    archivedCount,
    more: "Archived board quests remain available in the common room archive.",
  };
  if (
    input.boardQuestId &&
    k.owned(threadId, input.boardQuestId).archivedAt !== null
  )
    return archived;
  if (input.section === "holds") {
    const holds = k.activeCheckerHolds(threadId).filter(quest => !input.boardQuestId || quest.id === input.boardQuestId);
    return { holds: holds.slice(input.offset, input.offset + input.limit), total: holds.length };
  }
  if (input.section === "errands") {
    const page = k.store.errandsPage(
      threadId,
      input.limit,
      input.offset,
      input.boardQuestId ?? undefined,
    );
    const entries = page.members.map(({ member, occupies }) => {
      const state = k.store.runtime(member.threadId);
      const failed = member.state === "failed";
      const row = {
        memberThreadId: member.threadId,
        keeperThreadId: threadId,
        owner: {
          threadId: member.threadId,
          name: k.name(member),
          classId: member.classId,
        },
        title: member.title,
        ask: state.brief?.outcome ?? null,
        doneWhen: state.brief?.doneWhen ?? null,
        state: failed ? "failed" : member.engagement === "resting" ? "done" : memberActivityWord(member),
        engagement: member.engagement,
        slotNote: failed && occupies ? "Holds its slot until the Keeper releases it." : null,
        doing: member.doing,
        released: wasReleased(member) ? memberDetails(k.store, member.threadId).release ?? { reason: "Its machine was released." } : null,
        createdAt: member.createdAt,
        lastActiveAt: member.lastActiveAt,
        lastReportAt: member.lastReportAt,
      };
      return { row, inFlight: occupies && !failed };
    });
    return {
      total: page.total,
      inFlightCount: page.inFlightCount,
      recentCount: page.total - page.inFlightCount,
      offset: input.offset,
      nextOffset:
        input.offset + entries.length < page.total
          ? input.offset + entries.length
          : null,
      inFlight: entries.filter(entry => entry.inFlight).map(entry => entry.row),
      recent: entries.filter(entry => !entry.inFlight).map(entry => entry.row),
    };
  }
  if (input.section === "rules")
    return {
      ...k.memory.rules(
        threadId,
        input.limit,
        input.offset,
        undefined,
        input.boardQuestId ?? undefined,
      ),
      offset: input.offset,
    };
  if (input.section === "notes")
    return {
      notes: k.memory.notes(
        threadId,
        input.limit,
        input.offset,
        input.boardQuestId,
        true,
      ),
      total: k.memory.noteCount(threadId, input.boardQuestId, true),
      olderPromises: k.memory.olderPromiseCount(threadId),
      offset: input.offset,
    };
  if (input.section === "gates")
    return {
      gates: k.memory
        .gates(threadId)
        .filter(
          (gate) =>
            !input.boardQuestId || gate.boardQuestId === input.boardQuestId,
        )
        .slice(input.offset, input.offset + input.limit),
    };
  if (input.section === "steers")
    return {
      steers: (input.boardQuestId
        ? k.memory.steers(threadId, input.boardQuestId)
        : k.store
            .visibleRecords("quests", threadId, 100)
            .flatMap((q) => k.memory.steers(threadId, q.id))
      ).slice(input.offset, input.offset + input.limit),
    };
  if (input.section === "decisions")
    return {
      decisions: k.store.visibleRecords(
        "decisions",
        threadId,
        input.limit,
        input.offset,
        input.boardQuestId ?? undefined,
      ),
    };
  if (input.reportId) {
    const report = k.store.get("reports", input.reportId);
    if (!report || report.keeperThreadId !== threadId)
      throw new Error("Unknown report for this Keeper");
    if (report.boardQuestId && k.quest(report.boardQuestId).archivedAt !== null)
      return archived;
    const text = JSON.stringify({
      report,
      originalBrief: k.store.runtime(report.memberThreadId).brief,
    });
    const end = Math.min(input.offset + 8000, text.length);
    return `Report ${report.id}, characters ${input.offset}-${end} of ${text.length} (data):\n${text.slice(input.offset, end)}\n${end < text.length ? `More: call tavern_status with reportId=${report.id}, offset=${end}` : "End of report."}`;
  }
  if (input.section === "events") {
    const events = k.store.unreadEvents(
      threadId,
      input.afterEventId,
      input.limit,
      true,
    );
    return {
      archivedCount,
      events,
      nextAfterEventId: events.at(-1)?.id ?? input.afterEventId,
      more: k.store.eventCount(
        threadId,
        events.at(-1)?.id ?? input.afterEventId,
        true,
      ),
    };
  }
  if (input.section === "reports")
    return {
      archivedCount,
      reports: k.store
        .visibleRecords(
          "reports",
          threadId,
          input.limit,
          input.offset,
          input.boardQuestId ?? undefined,
        )
        .map((report) => ({
          id: report.id,
          status: report.status,
          outcome: report.outcome.slice(0, 500),
          detail:
            "Call tavern_status with reportId for the full outcome, evidence, artifacts and original brief.",
        })),
    };
  if (input.section === "asks")
    return {
      archivedCount,
      asks: k.store.visibleRecords(
        "asks",
        threadId,
        input.limit,
        input.offset,
        input.boardQuestId ?? undefined,
      ).map(undoAskProjection(k.store)).map(ask => currentAskNames(k.store, ask)),
    };
  const pending = k.store.runtime(threadId).pending;
  if (input.section === "pending") {
    const briefs = memberBriefRows(k, threadId, input.boardQuestId ?? undefined, input.memberThreadId ?? undefined);
    return {
      archivedCount,
      pending: pending.slice(input.offset, input.offset + input.limit),
      total: pending.length,
      memberBriefs: briefs.slice(input.offset, input.offset + input.limit),
      memberBriefTotal: briefs.length,
    };
  }
  const resting = restingParty(k, threadId);
  const releasedRows = party.filter(member => releasedThreadOpen(k.store, member) && (!input.boardQuestId || member.boardQuestId === input.boardQuestId) && (!input.memberThreadId || member.threadId === input.memberThreadId));
  const releasedNotArchived = releasedRows.slice(input.offset, input.offset + input.limit).map(member => ({
    threadId: member.threadId, name: k.name(member), classId: member.classId, boardQuestId: member.boardQuestId,
  }));
  const nextReleasedNotArchivedOffset = input.offset + releasedNotArchived.length < releasedRows.length ? input.offset + releasedNotArchived.length : null;
  const review = runtime.review();
  return {
    archivedCount,
    archivedMembers, archivedMemberTotal, nextArchivedOffset,
    memberBriefs: memberBriefRows(k, threadId, input.boardQuestId ?? undefined, input.memberThreadId ?? undefined),
    rangerCheckpoints: rangerCheckpointRows(k, threadId, input.boardQuestId, input.memberThreadId),
    unreviewedMemory: runtime.memory.unreviewedFor(threadId, 0, 3),
    freeHands: resting.filter(showInFreeHands).map(m => m.machineLost ? { ...m, unavailable: "machine lost: can't take new work; release it" } : m),
    restingMembers: resting.filter(m => m.settled),
    releasedNotArchived, nextReleasedNotArchivedOffset,
    quests: (input.boardQuestId
      ? [k.quest(input.boardQuestId)]
      : k.store.visibleRecords("quests", threadId, input.limit, input.offset)
    ).map((q) => k.summary(q.id)),
    scopeBlocks: k.store.recentScopeBlocks(threadId, 5, input.boardQuestId ?? undefined),
    delegatedAsks: k.store.openAsks(threadId).filter(a => k.authority.lane(a) === "keeper" && (!a.boardQuestId || k.quest(a.boardQuestId).archivedAt === null)).slice(0, 5).map(ask => currentAskNames(k.store, ask)),
    asks: k.store.openAsks(threadId, undefined, true).slice(0, 5),
    recentReports: k.store.visibleRecords("reports", threadId, 3).map((r) => ({
      id: r.id,
      status: r.status,
      outcome: r.outcome.slice(0, 500),
    })),
    review: { ...review, items: review.items.map(({ title, url, boardQuestId }) => ({ title, url, boardQuestId })) },
    more: (releasedRows.length ? "Use tavern_release on releasedNotArchived members to archive them. " : "") + "Use section=errands for in-flight and recent side quests with owners, asks and states. Other sections: reports, asks, events or pending with offset/limit (afterEventId for events). Full report: reportId and character offset.",
  };
}
