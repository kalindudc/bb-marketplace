import type { Ask, BoardQuest, GateRecord, KeeperNote, Member, Report, Route } from "../../shared/schema";
import type { InsightSection, InsightsView, InsightUnit } from "../../shared/insights";
import { levelFromCount, levelRole, earnedCount } from "../../shared/level";
import type { CharacterServiceRecord } from "../../shared/service-record";
import { TUNABLES, type SettingsSnapshot, type SettingDecision } from "../../shared/settings";
import { LIMITS } from "../limits";
import { tuningSignals } from "./signals";

export interface Observation { id: string; at: number; type: string; text: string; keeperThreadId: string | null; questId: string | null; data: Record<string, unknown> }
export interface InsightCharacters { characters: { id: string; classIds: string[] }[]; serviceRecords: Pick<CharacterServiceRecord, "characterId" | "maker" | "warden" | "keeper">[] }
export interface InsightData { quests: BoardQuest[]; asks: Ask[]; members: Member[]; reports: Report[]; routes: Route[]; gates: GateRecord[]; notes: KeeperNote[]; events: Observation[] }
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function percentile(values: number[], share: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)]!;
}
export const numberAt = (event: Observation, key: string): number | null => typeof event.data[key] === "number" && Number.isFinite(event.data[key]) ? event.data[key] as number : null;
const section = (caption: string, series: InsightSection["series"]): InsightSection => ({ caption, series });
const metric = (id: string, label: string, value: number | null, unit: InsightUnit = "count") => ({ id, label, value, unit });
function categories(id: string, label: string, values: string[], unit: InsightUnit = "count") {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return { id, label, unit, points: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([x, y]) => ({ x, y })) };
}
function union(intervals: [number, number][]): [number, number][] {
  const result: [number, number][] = [];
  for (const [start, end] of intervals.filter(([start, end]) => end > start).sort(([a], [b]) => a - b)) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
const overlap = (a: number, b: number, intervals: [number, number][]) => intervals.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(b, end) - Math.max(a, start)), 0);
export function phaseSeconds(data: InsightData, from: number, to: number) {
  const result: Record<string, number> = { scout: 0, greenlight: 0, build: 0, held: 0, closing: 0, stopping: 0, unrecorded: 0, outside: 0 };
  for (const quest of data.quests) {
    const end = Math.min(quest.endedAt ?? to, to);
    if (end < from || quest.createdAt > to) continue;
    const gates = union(data.gates.filter(gate => gate.boardQuestId === quest.id)
      .map(gate => [Math.max(gate.askedAt, from, quest.createdAt), Math.min(gate.answeredAt ?? end, end)]));
    result.outside! += gates.reduce((sum, [a, b]) => sum + b - a, 0) / 1000;
    const transitions: { at: number; phase: string | null }[] = [{ at: quest.createdAt, phase: "unrecorded" }];
    for (const event of data.events.filter(event => event.questId === quest.id)) {
      const phase = event.data.phase as { to?: unknown } | undefined;
      if (typeof phase?.to === "string") transitions.push({ at: event.at, phase: phase.to });
    }
    transitions.sort((a, b) => a.at - b.at);
    for (const [index, transition] of transitions.entries()) {
      if (!transition.phase || !Object.prototype.hasOwnProperty.call(result, transition.phase)) continue;
      const start = Math.max(from, transition.at), stop = Math.min(end, transitions[index + 1]?.at ?? end);
      if (stop > start) result[transition.phase]! += Math.max(0, stop - start - overlap(start, stop, gates)) / 1000;
    }
  }
  return result;
}
export function aggregateInsights(data: InsightData, settings: SettingsSnapshot, range: InsightsView["range"], now: number, collectingSince: number, tuningHistory: SettingDecision[], characters: InsightCharacters | null = null): Omit<InsightsView, "wardenQuality"> {
  const days = { "7d": 7, "30d": 30, "90d": 90 }[range], from = now - days * LIMITS.dayMs;
  const events = data.events.filter(event => event.at >= from && event.at <= now);
  const count = (type: string) => events.filter(event => event.type === type).length;
  const signals = tuningSignals(data, from, now), intervals = new Map<string, number[]>();
  for (const interval of signals.reportIntervals) intervals.set(interval.classId, [...(intervals.get(interval.classId) ?? []), interval.seconds]);
  const returned = data.quests.filter(quest => quest.phase === "done" && quest.endedAt !== null && quest.endedAt >= from && quest.endedAt <= now);
  const answered = data.asks.filter(ask => ask.answer !== null && ask.answer.at >= from && ask.answer.at <= now);
  const reviews = events.filter(event => event.type === "waypoint.reviewed" && ["verified", "rejected"].includes(String(event.data.verdict)));
  const reviewKey = (review: Observation) => `${review.questId}:${review.data.planVersion}:${review.data.waypointId}`;
  const reviewedHere = new Set(reviews.map(reviewKey));
  const first = new Map<string, Observation>();
  for (const review of data.events.filter(event => event.type === "waypoint.reviewed" && ["verified", "rejected"].includes(String(event.data.verdict))).sort((a, b) => a.at - b.at)) {
    const key = reviewKey(review);
    if (reviewedHere.has(key) && !first.has(key)) first.set(key, review);
  }
  const routes = data.routes.filter(route => route.createdAt >= from && route.createdAt <= now);
  const sizes = events.filter(event => event.type === "restatement.measured");
  const notes = new Map(data.notes.map(note => [note.id, note]));
  const noteKind = (event: Observation) => event.data.kind ?? notes.get(String(event.data.noteId))?.kind;
  const phases = phaseSeconds(data, from, now);
  const requested = data.asks.filter(ask => ask.createdAt >= from && ask.createdAt <= now);
  const byClass = new Map(data.members.map(member => [member.threadId, member.classId]));
  const classOf = (event: Observation) => typeof event.data.classId === "string" ? event.data.classId : byClass.get(String(event.data.memberThreadId)) ?? "unrecorded";
  const records = new Map(characters?.serviceRecords.map(record => [record.characterId, record]));
  const levels = characters === null ? [] : characters.characters.map(character => {
    const record = records.get(character.id), classId = character.classIds[0];
    return { x: character.id, y: classId ? levelFromCount(earnedCount(record ?? null, levelRole(classId))) : null };
  });
  const factsClipped = count("facts.clipped") + events.filter(event => event.type === "facts.measured" && event.data.clipped === true).length;
  const ideas: InsightsView["ideas"] = settings.suggestions.filter(suggestion => suggestion.revision === settings.revision && !settings.pinned[suggestion.key]).map(suggestion => ({
    id: `tune:${suggestion.key}`, title: `Adjust the ${TUNABLES[suggestion.key].label.toLowerCase()}`, detail: suggestion.reason, severity: "act",
    action: { kind: "apply-tuned", key: suggestion.key, value: suggestion.value }, evidence: { section: suggestion.evidence.section, chart: suggestion.evidence.chart },
  }));
  const sameFamilyChecks = events.filter(event => event.type === "member.hired" && event.data.checkIndependence === "same-family").length;
  const unknownFamilyChecks = events.filter(event => event.type === "member.hired" && event.data.checkIndependence === "not-established").length;
  if (sameFamilyChecks + unknownFamilyChecks > 0) ideas.push({
    id: "warden-family", title: "Set a different-family Warden model",
    detail: `${sameFamilyChecks} Warden hires used a same-family check (not independent); ${unknownFamilyChecks} had check independence not established. Choose a known different-family Warden model in settings.`,
    severity: "act", action: { kind: "open-setting", key: "classes.warden.model" },
  });
  if (factsClipped > 0) ideas.push({ id: "facts-clipped", title: "Inspect clipped tick packets", detail: `${factsClipped} recorded tick packets exceeded their facts allowance. Undelivered facts must remain available for later ticks.`, severity: "info", action: { kind: "open-section", section: "reliability" }, evidence: { section: "reliability", chart: "facts" } });
  return {
    range, from, to: now, collectingSince,
    headline: [metric("quests-returned", "Quests returned", returned.length),
      metric("goal-to-return", "Median goal to return", median(returned.map(quest => (quest.endedAt! - quest.createdAt) / 1000)), "s"),
      metric("ask-wait", "Median ask wait", median(answered.map(ask => (ask.answer!.at - ask.createdAt) / 1000)), "s"),
      metric("first-pass", "Waypoints verified on first recorded review", first.size ? [...first.values()].filter(event => event.data.verdict === "verified").length / first.size : null, "ratio")],
    ideas,
    reliability: section("How often Keepers routed your messages right the first time, and how their memory and ticks held up. Counted from recorded events since Tavern started collecting.", [
      metric("routing-accuracy", "Routed requests not corrected", routes.length ? 1 - routes.filter(route => route.corrected).length / routes.length : null, "ratio"),
      categories("reanchors", "Re-anchors requested by cause", events.filter(event => event.type === "reanchor.requested").map(event => typeof event.data.cause === "string" ? event.data.cause : event.text.replace(/^Re-anchor after /, ""))),
      metric("restatement-median", "Median requested restatement", median(sizes.flatMap(event => { const size = numberAt(event, "bytes"); return size === null ? [] : [size]; })), "bytes"),
      metric("restatement-cap", "Current restatement cap", settings.effective.keepers.restatementBytes, "bytes"),
      metric("facts-clipped", "Fact packets clipped", factsClipped),
      metric("facts", "Median tick fact packet", median(signals.tickFactChars), "chars"),
      categories("ticks", "Tick holds by reason", events.filter(event => event.type === "tick.held").map(event => String(event.data.reason ?? "unrecorded"))),
      metric("keeper-turn-p90", "Keeper turn time, P90", percentile(signals.keeperTurnSeconds, 0.9), "s"),
      { id: "report-intervals", label: "Report interval, P95 by class", unit: "s", points: [...intervals].sort(([a], [b]) => a.localeCompare(b)).map(([x, values]) => ({ x, y: percentile(values, 0.95) })) },
      categories("reports", "Reports per day", events.filter(event => event.type === "report.filed").map(event => new Date(event.at).toISOString().slice(0, 10))),
      metric("ticks-sent", "Ticks sent", count("tick.sent")), metric("ticks-held", "Tick attempts held", count("tick.held")), metric("ticks-deferred", "Tick attempts deferred", count("tick.deferred")),
      metric("turns-interrupted", "Turns interrupted", count("turn.interrupted")),
      metric("facts-recorded", "Facts recorded", events.filter(event => event.type === "note.recorded" && noteKind(event) === "fact").length),
      metric("commitments-recorded", "Commitments recorded", events.filter(event => event.type === "note.recorded" && noteKind(event) === "commitment").length),
      metric("promises-due", "Promises due", count("promise.due")), metric("members-unreported", "Unreported member completions", count("member.unreported")),
    ]),
    phases: section("Recorded phase and outside-gate time, summed across quests. Concurrent gates within one quest count once. Missing historical transitions are not inferred.", Object.entries(phases).map(([id, value]) => metric(id, ({ scout: "Scouting", greenlight: "Waiting for greenlight", build: "Building", held: "Held by you", closing: "Waiting to conclude", stopping: "Stopping", unrecorded: "Phases not recorded", outside: "Outside gates" } as Record<string, string>)[id]!, value, "s"))),
    attention: section("Asks are grouped by kind and outcome. Waits include asks answered in this range even when they were opened earlier.", [
      categories("asks-by-kind", "Asks opened by kind", requested.map(ask => ask.kind)),
      categories("asks-per-week", "Asks opened per UTC week", requested.map(ask => { const day = new Date(ask.createdAt); day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7); return day.toISOString().slice(0, 10); })),
      metric("answered-user", "Answered by you", answered.filter(ask => ask.answer?.by === "user").length),
      metric("defaulted", "Applied by timed default", answered.filter(ask => ask.state === "defaulted").length),
      metric("withdrawn", "Withdrawn asks opened in range", requested.filter(ask => ask.state === "withdrawn").length),
      metric("review-budget", "Current review budget", settings.effective.attention.reviewBudget),
      metric("review-held", "New work held for review load", count("review-budget.held")),
    ]),
    party: section("Hires and review verdicts use the selected range. Character levels use each character\'s first class and its lasting service record across all quests, including archived quests.", [
      categories("hires", "Hires by class", events.filter(event => event.type === "member.hired").map(classOf)),
      metric("verified-wins", "Verified waypoint verdicts", reviews.filter(event => event.data.verdict === "verified").length),
      metric("warden-rejections", "Warden rejections", reviews.filter(event => event.data.verdict === "rejected").length),
      metric("stale-strikes", "Stale strikes", count("member.stale")), metric("releases", "Member releases", count("member.released")),
      metric("failed-spawns", "Failed spawn attempts", count("spawn.failed")),
      metric("ranger-time", "Completed Ranger run time, P95", percentile(signals.rangerMinutes.map(minutes => minutes * 60), 0.95), "s"),
      { id: "character-levels", label: "Character levels", unit: "level", points: levels },
    ]),
    guardrails: section("Only enforced scope violations count as blocks. Watch-mode observations are separate; a stopped violation needs recorded stop confirmation.", [
      categories("scope-blocks-class", "Scope blocks by class", events.filter(event => event.type === "scope.violation" && event.data.mode !== "watch").map(classOf)),
      categories("scope-blocks-rule", "Scope blocks by rule", events.filter(event => event.type === "scope.violation" && event.data.mode !== "watch").map(event => String(event.data.ruleId ?? "unrecorded"))),
      metric("violations-stopped", "Violations stopped", events.filter(event => event.type === "scope.violation" && event.data.mode !== "watch" && event.data.stopped === true).length),
      metric("scope-watches", "Watch-mode observations", events.filter(event => event.type === "scope.violation" && event.data.mode === "watch").length),
      metric("widening-asks", "Scope widening asks", requested.filter(ask => ask.kind === "scope").length),
      metric("widening-grants", "Scope widening grants", count("scope.granted")),
    ]), tuningHistory, cost: null,
  };
}
