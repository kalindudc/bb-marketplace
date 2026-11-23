import { isLiveMember } from "../liveness";
import { memberActivityWord } from "../../shared/member-engagement";
import { preapprovalWords } from "../../shared/quest-authority";
import { currentAskNames } from "../quest-names";
import type { Keeper } from "./service";
import type { BoardQuestSummary } from "../../shared/contract";
import type { KeeperNote, Rule } from "../../shared/schema";
import { boundedData, LEDGER_OVERFLOW } from "../instructions";
import { localClock } from "../clock";
import { restingParty } from "../resting";
import { isOpenQuest } from "../liveness";
import { settled } from "../../shared/waypoint";
import { keeperUndoLaneWords } from "../../shared/undo-lane";
import { readUndoLanes } from "../undo-record";
import { PLACEMENT_CLASSES, placementClassLine, placementGuidance } from "../placement/controller";
import { matchPlacementRule } from "../placement/match";
import { PlacementStore } from "../placement/store";
import { summariesToday } from "../summaries";
import { actAskKind, watchActWords } from "../../scope/act-routing";
import { leadDescendants } from "./leads";
import { keeperRecoveryOptions, needsKeeperReview } from "../ask-effects";

export const clock = localClock;
const quoted = (value: string) => JSON.stringify(value);
function short(value: string, limit: number) {
  return value.length <= limit
    ? value
    : value.slice(0, limit) + " [more: tavern_status]";
}
export function section(
  title: string,
  lines: string[],
  cap: number,
  more: string,
  total = lines.length,
) {
  const kept: string[] = [];
  let bytes = Buffer.byteLength(title) + 30;
  for (const line of lines) {
    if (bytes + Buffer.byteLength(line) > cap - 160) break;
    kept.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  const remaining = total - kept.length;
  return `${title}:\n${kept.join("\n") || "None"}${remaining ? `\n${remaining} ${more}` : ""}`;
}
function leadMinutes(text: string | null) {
  if (!text || /\bdone\b/i.test(text)) return 0;
  const found =
    /(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)/i.exec(text);
  if (!found) return Infinity;
  return (
    Number(found[1]) *
    (/^h/i.test(found[2]!)
      ? 60
      : /^d/i.test(found[2]!)
        ? 1440
        : /^w/i.test(found[2]!)
          ? 10080
          : 1)
  );
}
export function criticalWaypoints(waypoints: BoardQuestSummary["waypoints"]) {
  const open = waypoints.filter(w => !settled(w));
  const scores = new Map<string, number>();
  const score = (id: string, seen = new Set<string>()): number => {
    if (scores.has(id)) return scores.get(id)!;
    if (seen.has(id)) return 0;
    const next = new Set(seen).add(id);
    const waypoint = open.find((w) => w.id === id)!;
    const value =
      leadMinutes(waypoint.leadTime) +
      Math.max(
        0,
        ...open
          .filter((w) => w.dependsOn.includes(id))
          .map((w) => score(w.id, next)),
      );
    scores.set(id, value);
    return value;
  };
  const remaining = [...open],
    result: typeof open = [];
  while (remaining.length) {
    const ready = remaining.filter(
      (w) =>
        !w.dependsOn.some((id) => remaining.some((other) => other.id === id)),
    );
    const candidates = ready.length ? ready : remaining;
    candidates.sort((a, b) => {
      const left = score(a.id),
        right = score(b.id);
      if (left !== right) return left > right ? -1 : 1;
      const leftLead = leadMinutes(a.leadTime),
        rightLead = leadMinutes(b.leadTime);
      return leftLead === rightLead ? 0 : leftLead > rightLead ? -1 : 1;
    });
    const next = candidates[0]!;
    result.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return result;
}
function ruleLine(rule: Rule) {
  return `${rule.id} [${rule.scope}${rule.scope === "quest" ? ` ${rule.scopeId}` : ""}] ${quoted(rule.text)}`;
}
function noteLine(note: KeeperNote) {
  return `${note.id} [${note.kind}${note.boardQuestId ? `; ${note.boardQuestId}` : ""}] ${quoted(note.kind === "waiting-on-user" ? note.action ?? note.text : note.text)}${note.dueAt !== null ? `; due ${clock(note.dueAt)}` : note.kind === "commitment" ? "; no deadline" : ""}${note.condition ? `; when ${quoted(note.condition)}` : ""}${note.validUntil !== null ? `; valid until ${clock(note.validUntil)}` : ""}`;
}
function memberLines(k: Keeper, summary: BoardQuestSummary) {
  return summary.members.map(
    (m) =>
      `${k.name(m)} (${m.classId})${m.repo ? `, repo ${m.repo}` : ""}, ${memberActivityWord(m, !isOpenQuest(summary))}${m.checkIndependence === "same-family" ? "; same-family check (not independent)" : m.checkIndependence === "not-established" ? "; check independence not established" : ""}${m.guardPosture ? `; ${m.guardPosture.label}` : ""}; waypoint ${m.waypointId ?? (m.classId === "warden" ? k.checkerWaypoints(m.threadId).join(",") : "none")}; strikes ${m.strikes}; doing ${quoted(short(memberDoing(k, m.threadId, m.doing), needsAttention(k, m.threadId) ? 300 : 120))}`,
  );
}
function needsAttention(k: Keeper, threadId: string) {
  const report = k.store.query("reports", "memberThreadId", threadId, 1)[0];
  return report?.status === "blocked" || report?.status === "needs-decision";
}
function memberDoing(k: Keeper, threadId: string, doing: string | null) {
  const report = k.store.query("reports", "memberThreadId", threadId, 1)[0];
  return report && ["blocked", "needs-decision"].includes(report.status)
    ? report.outcome
    : (doing ?? "none");
}
function questSection(
  k: Keeper,
  summaries: BoardQuestSummary[],
  priorities: boolean,
) {
  if (!summaries.length) return "Board quests:\nNone";
  const cap = priorities ? 2500 : 14000;
  const budget = Math.floor((cap - 100) / summaries.length);
  return (
    "Board quests:\n" +
    summaries
      .map((summary) => {
        if (summary.phase === "held") return `${short(summary.title, 80)} (${summary.id}): held by you since ${clock(summary.held!.since)}`;
        const full = priorities
          ? `${short(summary.title, 80)} (${summary.id}): ${summary.move.text}`
          : questBlock(k, summary);
        if (Buffer.byteLength(full) <= budget) return full;
        if (budget < 250) {
          const header = `${summary.id} [${summary.phase}]`;
          const pointer = "\nMore: tavern_status";
          const titleBytes = budget - Buffer.byteLength(header + pointer) - 2;
          return `${header} ${boundedData(summary.title, titleBytes)}${pointer}`;
        }
        const header = `${summary.id} ${short(summary.title, 80)} [${summary.phase}]`;
        const pointer = `\nMore: tavern_status boardQuestId=${summary.id}`;
        const room = budget - Buffer.byteLength(header + pointer) - 4;
        return (
          header + (room > 80 ? "\n" + boundedData(full, room) : "") + pointer
        );
      })
      .join("\n\n")
  );
}
function questBlock(k: Keeper, summary: BoardQuestSummary) {
  const plan = summary.plan;
  const waypoints = criticalWaypoints(summary.waypoints);
  const next = waypoints.find((w) =>
    w.dependsOn.every((id) => !waypoints.some((other) => other.id === id)),
  );
  const nextLink =
    summary.phase === "closing" ? `tavern_wrap opened the Conclude or Close early card: ${summary.move.text}` : !plan || !isOpenQuest(summary) || summary.phase === "wrap"
      ? summary.move.text
      : next
        ? `${next.id}: ${short(next.title, 80)}; ${next.actor} ${next.actor === "agent" && next.ownerMember ? `${k.name(next.ownerMember)} (${next.ownerMember.classId})` : (next.owner ?? "unassigned")}; lead time ${next.leadTime ?? "unknown"}`
        : summary.move.text;
  const lines = [
    `${short(summary.title, 80)} (${summary.id}) — ${summary.phase}, plan v${summary.planVersion}, ${summary.greenlitVersion !== null ? `approved v${summary.greenlitVersion}` : summary.checkPlanVersion === summary.planVersion && summary.phase !== "greenlight" ? "no staffing greenlight needed" : "not approved yet"}`,
    `Done when: ${plan?.doneWhen ?? "Not planned yet"}`,
    `Next link: ${nextLink}`,
    `Allocated party: ${plan?.party.map((p) => `${p.classId} for ${p.waypointIds.join(",") || p.purpose}`).join("; ") || "not planned"}`,
    ...waypoints.map(
      (w) =>
        `${w.id} [${w.state}] ${quoted(short(w.title, 80))}; ${w.actor} owner ${w.actor === "agent" && w.ownerMember ? `${k.name(w.ownerMember)} (${w.ownerMember.classId}, ${memberActivityWord(w.ownerMember)})` : (w.owner ?? "unassigned")}; lead time ${w.leadTime ?? "unknown"}; after ${w.dependsOn.join(",") || "none"}${w.rejectedReason ? `; rejected: ${quoted(w.rejectedReason)}` : ""}${w.state === "reported" && w.check === "keeper" ? "; Keeper check: use tavern_settle" : ""}${w.actor === "outside" ? (w.gate ? `; asked ${w.gate.askedWho} at ${clock(w.gate.askedAt)} via ${quoted(w.gate.via)}; answer ${quoted(w.gate.answer ?? "waiting")}` : "; not asked yet") : ""}`,
    ),
    ...memberLines(k, summary),
  ];
  const authority = k.authority.view(summary.id);
  if (authority.delegations.length || authority.preapprovals.length) lines.push(`Quest authority: Keeper decides ${authority.rows.filter(r => r.lane === "keeper").map(r => r.kind).join(", ")}; Tavern answers ${authority.rows.filter(r => r.lane === "tavern").map(r => r.kind).join(", ") || "none"} within pre-approval. Exact act verdicts still gate delegated merges and production changes. Unsure choices go to the user.`);
  if (plan?.assumptions.length)
    lines.push(
      `${plan.assumptions.length} assumptions; call tavern_status boardQuestId=${summary.id}`,
    );
  if (plan?.questions.length)
    lines.push(
      `Plan questions: ${plan.questions.map((q) => `${q.id} ${quoted(q.text)}`).join("; ")}`,
    );
  return lines.join("\n");
}
export function renderRestatement(
  k: Keeper,
  threadId: string,
  priorities = false,
) {
  const standing = k.memory.rules(threadId, 100, 0, true);
  const proposed = k.memory.rules(threadId, 100, 0, false);
  const quests = k.store
    .visibleRecords("quests", threadId, 100)
    .filter((q) => !["done", "stopped"].includes(q.phase));
  const summaries = quests.map((q) => k.summary(q.id));
  const delegated = k.store.openAsks(threadId).filter(a => k.authority.lane(a) === "keeper" &&
    !(a.effect?.type === "conclude" && a.effect.draft.lead) && (!a.boardQuestId || k.quest(a.boardQuestId).archivedAt === null))
    .map(a => currentAskNames(k.store, a));
  const asks = k.store
    .openAsks(threadId, undefined, true)
    .sort((a, b) => (a.proceedAt ?? Infinity) - (b.proceedAt ?? Infinity));
  const notes = k.memory.notes(threadId, 100).filter(note => !note.boardQuestId || k.quest(note.boardQuestId).phase !== "held");
  const urgency = (summary: BoardQuestSummary) =>
    (summary.waypoints.some(
      (w) =>
        w.actor === "outside" &&
        !settled(w) &&
        !w.gate?.answer,
    )
      ? 4
      : 0) +
    (notes.some(
      (n) =>
        n.boardQuestId === summary.id &&
        n.kind === "commitment" &&
        n.dueAt !== null &&
        n.dueAt <= k.now(),
    )
      ? 2
      : 0) +
    (asks.some((a) => a.boardQuestId === summary.id) ? 1 : 0);
  summaries.sort(
    (a, b) => urgency(b) - urgency(a) || b.updatedAt - a.updatedAt,
  );
  const lastReply = k.store.runtime(threadId).lastReply;
  const holds = k.activeCheckerHolds(threadId);
  const machines = k.settings().machines;
  const projectId = k.store.runtime(threadId).projectId ?? null;
  const placementLines = PLACEMENT_CLASSES.map(classId => placementClassLine(classId, matchPlacementRule(
    { state: "valid", revision: 0, settings: machines },
    { projectId, classId, questId: null, repoRemotes: null, keeperPath: null, keeperHome: null, keeperEnvironmentProvider: null },
  )));
  if (machines.rules.some(rule => rule.enabled && (rule.match.repoRemotes || rule.match.keeperPathGlobs || rule.match.keeperEnvironmentProviders || rule.match.questIds)))
    placementLines.push("Source-dependent and quest-specific rules need current facts; call tavern_status section=placement before hiring.");
  const enabledRules = machines.rules.filter(rule => rule.enabled);
  const guidance = !enabledRules.length ? null : enabledRules.some(rule => !rule.match.projectIds || projectId !== null && rule.match.projectIds.includes(projectId))
    ? placementGuidance(placementLines, new PlacementStore(k.store.db).counts(threadId), machines)
    : "Where your party runs: where you run; no machine rule matches this project (tavern_status section=placement).";
  const leadPlans = summaries.flatMap(parent => k.store.leadLinksBy("parentQuestId", parent.id).flatMap(link => {
    if (parent.phase === "held" || !link.childQuestId || link.state !== "linked") return [];
    const child = k.store.get("quests", link.childQuestId);
    const record = child && k.store.get("leadPlans", `${child.id}:${child.planVersion}`);
    if (!child || child.phase !== "greenlight" || record?.state !== "pending" || record.lane !== "keeper") return [];
    return [`${quoted(boundedData(child.title, 72, "…"))} ${child.id} v${child.planVersion}; parent ${parent.id} ${link.parentWaypointId}. Read tavern_status section=lead-plan for the child, then decide with leadPlan.`];
  }));
  const descendants = summaries.flatMap(parent => leadDescendants(k.store, parent.id).flatMap(link => {
    const child = k.store.get("quests", link.childQuestId!);
    return child && !child.archivedAt ? [{ child, link }] : [];
  }));
  const childAsks = descendants.flatMap(({ child }) => k.store.openAsks(child.keeperThreadId, child.id)
    .filter(a => k.authority.lane(a) === "user")
    .map(a => `${a.id} (${quoted(short(child.title, 60))}): ${quoted(short(currentAskNames(k.store, a).question, 160))}`));
  const conclusions = descendants.flatMap(({ child, link }) => link.parentKeeperThreadId !== threadId ? [] :
    k.store.openAsks(child.keeperThreadId, child.id).flatMap(a => a.effect?.type === "conclude" && a.effect.draft.lead
      ? [`${a.id} (${quoted(short(child.title, 60))}): use tavern_decide with the parent quest ${link.parentQuestId} and optionId conclude.`] : []));
  const childUpdates = descendants.flatMap(({ child }) => [
    ...k.store.query("summaries", "boardQuestId", child.id, 1).map(s => `${s.id} (${quoted(short(child.title, 60))}): ${quoted(short(s.title, 100))}`),
    ...k.memory.notes(child.keeperThreadId, 5, 0, child.id).filter(note => note.kind === "waiting-on-user" && note.state === "open")
      .map(note => `${note.id} (${quoted(short(child.title, 60))}): read-only user hand-back, ${quoted(short(note.action ?? note.text, 100))}`),
  ]);
  const undoLanes = readUndoLanes(k.store, threadId);
  const today = summaries.length ? summariesToday(k.store, threadId, k.now()) : new Map<string, number>();
  const todayLines = summaries.flatMap(quest => {
    const count = today.get(quest.id);
    return count === undefined ? [] : [`${boundedData(quest.short, 60, "…")}: ${count} summaries today`];
  });
  const observations = k.store.query("scopeActObservations", "keeperThreadId", threadId, 100)
    .filter(row => row.boardQuestId === null || summaries.some(q => q.id === row.boardQuestId && q.phase !== "stopping"));
  const watch = watchActWords(observations);
  const grants = new Map<string, ReturnType<typeof k.store.issuedShellGrants>>();
  const held = [...new Set(observations.filter(row => row.preflight && row.resolvedAt === undefined).flatMap(row => {
    const member = k.member(row.threadId), ask = actAskKind(row.act);
    if (!ask || !(member?.role === "keeper" || isLiveMember(k.store, member, "brief"))) return [];
    if (!grants.has(row.threadId)) grants.set(row.threadId, k.store.query("shellGrants", "memberThreadId", row.threadId, 100));
    if (grants.get(row.threadId)!.some(grant => grant.boardQuestId === row.boardQuestId && grant.target.act === row.act && grant.issuedAt >= row.at)) return [];
    const reference = row.command && row.cwd ? ` heldEventId=${JSON.stringify(row.threadId + ":" + row.eventId)}` : "";
    return [`${boundedData(k.name(member), 45, "…")}: Held ${row.act}; needs a ${ask} ask.${reference}`];
  }))];
  const parts = [
    ...(held.length ? [section("Recently held shell acts", held, 700, "more holds; see the Ledger")] : []),
    ...(watch ? [watch] : []),
    ...(undoLanes.length ? [section("Undo record", undoLanes.map(keeperUndoLaneWords), priorities ? 800 : 1600, "more kinds; see the Ledger or call tavern_status")] : []),
    ...(holds.length ? [section(
      "Active user holds — checker handoff held, waiting for the user\'s release; Warden hire/re-task blocked; details: tavern_status section=holds",
      holds.map(quest => `${quoted(boundedData(quest.title, 40, "…"))}, held ${clock(quest.checkerHandoffHold!.createdAt)}: reason ${quoted(boundedData(quest.checkerHandoffHold!.reason, 40, "…"))}; source ${quoted(boundedData(quest.checkerHandoffHold!.sourceText, 40, "…"))}`),
      priorities ? 1400 : 3000,
      "more active holds; call tavern_status section=holds",
      holds.length,
    )] : []),
    section(
      "Standing rules",
      standing.rules.map(ruleLine),
      3200,
      "older rules; call tavern_status section=rules",
      standing.total,
    ),
    section(
      "Proposed, waiting for the user",
      proposed.rules.map(ruleLine),
      1000,
      "older rules; call tavern_status section=rules",
      proposed.total,
    ),
    ...(guidance ? [guidance] : []),
    questSection(k, summaries, priorities),
    ...(leadPlans.length || conclusions.length ? [section("Hiring Keeper decides", [...leadPlans, ...conclusions], 1200, "more child decisions; read the child quest")] : []),
    ...(childAsks.length ? [section("Read-only child asks (the user answers on the original card)", childAsks, 1300, "more child asks; see the child quest")] : []),
    ...(childUpdates.length ? [section("Child summaries and hand-backs", childUpdates, 1000, "more child updates; see the child quest")] : []),
    ...(summaries.length ? ["Summary reminder: aim for at most 6 summaries per quest per day."] : []),
    ...(todayLines.length ? [section("Summaries today", todayLines, 450, "more quests have at least 4 summaries today")] : []),
    ...(delegated.length ? [section("Keeper lane (not shown to the user)", delegated.map(a => `${a.id} [${a.kind}]: ${quoted(short(a.question, 160))}; holds ${a.holds.join(",") || "none"}; ${a.effect && needsKeeperReview(a.effect) ? "review, then use tavern_ask heldCommunicationAskId or dismiss:true" : a.effect && keeperRecoveryOptions(a.effect) ? `use tavern_decide askId with optionId ${keeperRecoveryOptions(a.effect)!.join(" or ")}` : a.kind === "merge" && a.effect?.type === "decision" ? "use tavern_decide source keeper or tavern_ask mergeAskId with action ask-user or withdraw" : "answer with tavern_decide askId and optionId, or tavern_ask unsure:true"}`), priorities ? 1200 : 2400, "more delegated asks; call tavern_status section=asks", delegated.length)] : []),
    section(
      "Open user asks",
      asks.map(
        (a) =>
          `${a.id} [${a.kind}]: ${quoted(priorities ? short(a.question, 100) : a.question)}; recommended ${a.options.find((o) => o.recommended)?.label ?? "none"}; ${a.proceedAt === null ? "waits for the user" : `defaults at ${clock(a.proceedAt)}`}; holds ${a.holds.join(",") || "none"}; meanwhile ${quoted(priorities ? short(a.meanwhile, 80) : a.meanwhile)}`,
      ),
      priorities ? 1800 : 6000,
      "more asks; call tavern_status section=asks",
      asks.length,
    ),
    ...(lastReply && !priorities
      ? [
          `Last thing you told the user (${clock(lastReply.at)}):\n${quoted(lastReply.text)}`,
        ]
      : []),
    ...(k.memory.olderPromiseCount(threadId)
      ? [
          `older promises: ${k.memory.olderPromiseCount(threadId)}; call tavern_status section=notes`,
        ]
      : []),
    section(
      "Facts, promises and hand-backs",
      notes.filter((note) => !priorities || note.kind !== "fact").map(noteLine),
      priorities ? 1800 : 3000,
      "more notes; call tavern_status section=notes",
      priorities
        ? notes.filter((n) => n.kind !== "fact").length
        : k.memory.noteCount(threadId),
    ),
  ];
  const resting = restingParty(k, threadId);
  parts.push(section("Free hands", resting.filter(m => m.mayRebriefFor !== null || m.machineLost || m.needsCleanup).map(m => [
    `${m.name} (${m.classId}, ${m.threadId}); quest ${m.quest}; resting ${m.restedMinutes} min${m.machineHeld ? "; machine held" : ""}; last work ${quoted(short(m.lastWork, 160))}`,
    ...(m.needsCleanup ? ["re-brief or release"] : []),
    ...(m.machineLost ? ["machine lost: can't take new work; release it"] : m.mayRebriefFor ? [`may be re-briefed for: ${m.mayRebriefFor}`] : ["no eligible re-brief"]),
  ].join("; ")), 2200, "more free hands; call tavern_status"));
  const settledMembers = resting.filter(m => m.settled);
  if (settledMembers.length) parts.push(section("Resting, settled", settledMembers.map(m => `${m.name} (${m.threadId}); resting ${m.restedMinutes} min${m.machineHeld ? "; machine held" : ""}${m.machineLost ? "; machine lost: can't take new work; release it" : m.kept ? `; kept until ${clock(m.kept.until)}: ${quoted(short(m.kept.why, 120))}` : "; release or keep"}`), 1500, "more resting members; call tavern_status"));
  if (!priorities) {
    const steers = summaries.flatMap((q) =>
      k.memory.steers(threadId, q.id).map((route) => {
        const plan = k.store
          .query("plans", "boardQuestId", q.id, 30)
          .find((p) => p.fromSteer?.routeId === route.id);
        const decisions = k.store
          .query("decisions", "boardQuestId", q.id, 100)
          .filter((d) => d.sourceRef === route.id);
        return `${q.id}, ${clock(route.messageAt)}: user ${quoted(k.memory.userWords(route))}; ${plan ? `plan v${plan.version}` : decisions.length ? `decisions ${decisions.map((d) => d.id).join(",")}` : "not yet applied to a plan or decision"}`;
      }),
    );
    const decisions = k.store.visibleRecords("decisions", threadId, 8);
    const answered = k.store
      .visibleRecords("asks", threadId, 100)
      .filter((a) => a.answer)
      .slice(0, 6);
    const errands = k.store
      .query("members", "keeperThreadId", threadId, 500)
      .filter(
        (m) => m.errand && isLiveMember(k.store, m, "work") && m.state !== "failed",
      );
    const recent = decisions.filter(
      (d) =>
        d.source === "keeper" &&
        !d.undone &&
        d.createdAt > (k.store.runtime(threadId).tickAt ?? 0),
    );
    parts.push(
      `Decided for you since the last tick: ${recent.length ? `${recent.length}; see Recent decisions below, or tavern_status section=decisions for the complete list` : "None"}`,
    );
    parts.push(
      section(
        "Errands in flight",
        errands.map(
          (m) =>
            `${k.name(m)} (${m.classId})${m.repo ? `, repo ${m.repo}` : ""}, ${memberActivityWord(m)}${m.checkIndependence === "same-family" ? "; same-family check (not independent)" : m.checkIndependence === "not-established" ? "; check independence not established" : ""}${m.guardPosture ? `; ${m.guardPosture.label}` : ""}, strikes ${m.strikes}; ${quoted(m.title ?? "errand")}; doing ${quoted(short(m.doing ?? "none", 120))}`,
        ),
        1500,
        "more errands; call tavern_status section=errands",
      ),
    );
    const review = k.memory.review();
    parts.push(`Review queue: ${review.waiting} of ${review.budget}`);
    parts.push(
      section(
        "Steers still in force",
        steers,
        3200,
        "more steers; call tavern_status section=steers",
      ),
    );
    parts.push(
      section(
        "Answered asks",
        answered.map(
          (a) =>
            `${a.id}: ${quoted(short(a.question, 160))}; ${a.answer?.preapproval ? preapprovalWords(a.answer.preapproval) : a.state} at ${a.answer ? clock(a.answer.at) : "unknown"}; ${a.options.find((o) => o.id === a.answer?.optionId)?.label ?? a.answer?.optionId}`,
        ),
        1500,
        "more answers; call tavern_status section=asks",
      ),
    );
    parts.push(
      section(
        "Recent decisions",
        decisions.map(
          (d) =>
            `${d.id}, ${clock(d.createdAt)}, ${d.boardQuestId ?? "Keeper"}, source ${d.source}, ${d.reversible ? "reversible" : "consequential"}${d.undone ? ", undone" : ""}: ${quoted(d.text)} — ${quoted(d.why)}`,
        ),
        1800,
        "more decisions; call tavern_status section=decisions",
      ),
    );
    const pending = k.store.runtime(threadId).pending;
    if (pending.length)
      parts.push(
        section(
          "Not yet routed",
          pending.map((p) => quoted(short(p.text, 200))),
          1000,
          "more messages; call tavern_status section=pending",
        ),
      );
  }
  if (priorities) {
    const review = k.memory.review();
    parts.push(`Review queue: ${review.waiting} of ${review.budget}`);
  }
  return boundedData(
    parts.join("\n\n"),
    k.settings().keepers.restatementBytes,
    LEDGER_OVERFLOW,
  );
}
