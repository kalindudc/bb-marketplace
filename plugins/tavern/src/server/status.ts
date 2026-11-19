import { z } from "zod";
import { restingParty } from "./resting";
import { agentData } from "./agent-data";
import type { TavernRuntime } from "./runtime";
import { readRequestSources } from "./request-sources";

export const statusInput = z.object({
  boardQuestId: z.string().min(1).max(120).nullish(),
  section: z
    .enum([
      "summary",
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
    ])
    .default("summary"),
  reportId: z.string().min(1).max(120).nullish(),
  memberThreadId: z.string().min(1).max(120).nullish(),
  manifestId: z.string().min(1).max(120).nullish(),
  sourceIndex: z.number().int().nonnegative().default(0),
  offset: z.number().int().nonnegative().default(0),
  afterEventId: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(10).default(3),
});
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
  if (input.section === "requests") return readRequestSources(k, threadId, { memberThreadId: input.memberThreadId ?? undefined, manifestId: input.manifestId ?? undefined, sourceIndex: input.sourceIndex, offset: input.offset });
  const archivedRows = k.store.all("members").filter(member => member.keeperThreadId === threadId && k.store.runtime(member.threadId).archivedAt != null).map(member => {
    const state = k.store.runtime(member.threadId);
    const quest = member.boardQuestId ? k.store.get("quests", member.boardQuestId) : null;
    return { threadId: member.threadId, name: k.name(member), classId: member.classId, quest: quest?.deletedAt != null ? "a deleted quest" : quest?.short ?? null, released: !!state.released, deleted: state.deletedAt != null };
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
    const rows = page.members.map((member) => {
      const state = k.store.runtime(member.threadId);
      return {
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
        state: member.state,
        doing: member.doing,
        released: state.released ?? null,
        createdAt: member.createdAt,
        lastActiveAt: member.lastActiveAt,
        lastReportAt: member.lastReportAt,
      };
    });
    const recent = (row: (typeof rows)[number]) =>
      row.released !== null ||
      ["done", "stopped", "failed"].includes(row.state);
    return {
      total: page.total,
      inFlightCount: page.inFlightCount,
      recentCount: page.total - page.inFlightCount,
      offset: input.offset,
      nextOffset:
        input.offset + rows.length < page.total
          ? input.offset + rows.length
          : null,
      inFlight: rows.filter((row) => !recent(row)),
      recent: rows.filter(recent),
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
      ),
    };
  const pending = k.store.runtime(threadId).pending;
  if (input.section === "pending")
    return {
      archivedCount,
      pending: pending.slice(input.offset, input.offset + input.limit),
      total: pending.length,
    };
  const resting = restingParty(k, threadId);
  const review = runtime.review();
  return {
    archivedCount,
    archivedMembers, archivedMemberTotal, nextArchivedOffset,
    freeHands: resting.filter(m => m.mayRebriefFor !== null),
    restingMembers: resting.filter(m => m.settled),
    quests: (input.boardQuestId
      ? [k.quest(input.boardQuestId)]
      : k.store.visibleRecords("quests", threadId, input.limit, input.offset)
    ).map((q) => k.summary(q.id)),
    delegatedAsks: k.store.openAsks(threadId).filter(a => k.authority.lane(a) === "keeper" && (!a.boardQuestId || k.quest(a.boardQuestId).archivedAt === null)).slice(0, 5),
    asks: k.store.openAsks(threadId, undefined, true).slice(0, 5),
    recentReports: k.store.visibleRecords("reports", threadId, 3).map((r) => ({
      id: r.id,
      status: r.status,
      outcome: r.outcome.slice(0, 500),
    })),
    review: { ...review, items: review.items.map(({ title, url, boardQuestId }) => ({ title, url, boardQuestId })) },
    more: "Use section=errands for in-flight and recent side quests with owners, asks and states. Other sections: reports, asks, events or pending with offset/limit (afterEventId for events). Full report: reportId and character offset.",
  };
}
