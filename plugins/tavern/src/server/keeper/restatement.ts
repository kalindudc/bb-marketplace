import type { Keeper } from "./service";
import type { BoardQuestSummary } from "../../shared/contract";
import type { KeeperNote, Rule } from "../../shared/schema";
import { boundedData, LEDGER_OVERFLOW } from "../instructions";
import { localClock } from "../clock";
import { MEMORY_LIMITS } from "../../shared/settings";
import { isOpenQuest } from "../liveness";
import { PLACEMENT_CLASSES, placementClassLine, placementGuidance } from "../placement/controller";
import { matchPlacementRule } from "../placement/match";
import { PlacementStore } from "../placement/store";

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
  const open = waypoints.filter(
    (w) => !["verified", "skipped"].includes(w.state),
  );
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
  return `${note.id} [${note.kind}${note.boardQuestId ? `; ${note.boardQuestId}` : ""}] ${quoted(note.text)}${note.dueAt !== null ? `; due ${clock(note.dueAt)}` : ""}${note.condition ? `; when ${quoted(note.condition)}` : ""}${note.validUntil !== null ? `; valid until ${clock(note.validUntil)}` : ""}`;
}
function memberLines(k: Keeper, summary: BoardQuestSummary) {
  return summary.members.map(
    (m) =>
      `${k.name(m)} (${m.classId}), ${m.state}${m.checkIndependence === "same-family" ? "; same-family check (not independent)" : m.checkIndependence === "not-established" ? "; check independence not established" : ""}${m.guardPosture ? `; ${m.guardPosture.label}` : ""}; waypoint ${m.waypointId ?? (m.classId === "warden" ? k.checkerWaypoints(m.threadId).join(",") : "none")}; strikes ${m.strikes}; doing ${quoted(short(memberDoing(k, m.threadId, m.doing), needsAttention(k, m.threadId) ? 300 : 120))}${k.store.runtime(m.threadId).released ? "; released" : ""}`,
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
    !plan || !isOpenQuest(summary) || summary.phase === "wrap"
      ? summary.move.text
      : next
        ? `${next.id}: ${short(next.title, 80)}; ${next.actor} ${next.actor === "agent" && next.ownerMember ? `${k.name(next.ownerMember)} (${next.ownerMember.classId})` : (next.owner ?? "unassigned")}; lead time ${next.leadTime ?? "unknown"}`
        : summary.move.text;
  const lines = [
    `${short(summary.title, 80)} (${summary.id}) — ${summary.phase}, plan v${summary.planVersion}, ${summary.greenlitVersion === null ? "not approved yet" : `approved v${summary.greenlitVersion}`}`,
    `Done when: ${plan?.doneWhen ?? "Not planned yet"}`,
    `Next link: ${nextLink}`,
    `Allocated party: ${plan?.party.map((p) => `${p.classId} for ${p.waypointIds.join(",") || p.purpose}`).join("; ") || "not planned"}`,
    ...waypoints.map(
      (w) =>
        `${w.id} [${w.state}] ${quoted(short(w.title, 80))}; ${w.actor} owner ${w.actor === "agent" && w.ownerMember ? `${k.name(w.ownerMember)} (${w.ownerMember.classId}, ${w.ownerMember.state})` : (w.owner ?? "unassigned")}; lead time ${w.leadTime ?? "unknown"}; after ${w.dependsOn.join(",") || "none"}${w.rejectedReason ? `; rejected: ${quoted(w.rejectedReason)}` : ""}${w.actor === "outside" ? (w.gate ? `; asked ${w.gate.askedWho} at ${clock(w.gate.askedAt)} via ${quoted(w.gate.via)}; answer ${quoted(w.gate.answer ?? "waiting")}` : "; not asked yet") : ""}`,
    ),
    ...memberLines(k, summary),
  ];
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
  const asks = k.store
    .openAsks(threadId, undefined, true)
    .sort((a, b) => (a.proceedAt ?? Infinity) - (b.proceedAt ?? Infinity));
  const notes = k.memory.notes(threadId, 100).filter(note => !note.boardQuestId || k.quest(note.boardQuestId).phase !== "held");
  const urgency = (summary: BoardQuestSummary) =>
    (summary.waypoints.some(
      (w) =>
        w.actor === "outside" &&
        !["verified", "skipped"].includes(w.state) &&
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
  const parts = [
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
    section(
      "Open asks",
      asks.map(
        (a) =>
          `${a.id} [${a.kind}]: ${quoted(priorities ? short(a.question, 100) : a.question)}; recommended ${a.options.find((o) => o.recommended)?.label ?? "none"}; ${a.proceedAt === null ? "waits for you" : `defaults at ${clock(a.proceedAt)}`}; holds ${a.holds.join(",") || "none"}; meanwhile ${quoted(priorities ? short(a.meanwhile, 80) : a.meanwhile)}`,
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
        (m) => m.errand && !["done", "stopped", "failed"].includes(m.state),
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
            `${k.name(m)} (${m.classId}), ${m.state}${m.checkIndependence === "same-family" ? "; same-family check (not independent)" : m.checkIndependence === "not-established" ? "; check independence not established" : ""}${m.guardPosture ? `; ${m.guardPosture.label}` : ""}, strikes ${m.strikes}; ${quoted(m.title ?? "errand")}; doing ${quoted(short(m.doing ?? "none", 120))}`,
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
            `${a.id}: ${quoted(short(a.question, 160))}; ${a.state} at ${a.answer ? clock(a.answer.at) : "unknown"}; ${a.options.find((o) => o.id === a.answer?.optionId)?.label ?? a.answer?.optionId}`,
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
    MEMORY_LIMITS.restatementBytes,
    LEDGER_OVERFLOW,
  );
}
