import type { InsightData } from "./aggregate";
import { numberAt } from "./aggregate";
import type { TuningSignals } from "../settings/tuner";

export function tuningSignals(data: InsightData, from: number, to: number): TuningSignals {
  const events = data.events.filter(event => event.at >= from && event.at <= to);
  const count = (kind: string) => events.filter(event => event.type === kind).length;
  const measurements = (kind: string, key: string) => events.filter(event => event.type === kind).flatMap(event => {
    const value = numberAt(event, key); return value === null ? [] : [value];
  });
  const held = events.filter(event => event.type === "tick.held");
  const classes = new Map(data.members.map(member => [member.threadId, member.classId]));
  const lastReport = new Map<string, number>(), reportIntervals: TuningSignals["reportIntervals"] = [];
  const reportsPerMinute = new Map<number, number>();
  for (const report of [...data.reports].sort((a, b) => a.createdAt - b.createdAt)) {
    const previous = lastReport.get(report.memberThreadId);
    if (report.createdAt >= from && report.createdAt <= to) {
      const bucket = Math.floor(report.createdAt / 60000);
      reportsPerMinute.set(bucket, (reportsPerMinute.get(bucket) ?? 0) + 1);
      const classId = classes.get(report.memberThreadId);
      if (previous !== undefined && classId !== undefined && report.createdAt > previous)
        reportIntervals.push({ classId, seconds: (report.createdAt - previous) / 1000 });
    }
    lastReport.set(report.memberThreadId, report.createdAt);
  }
  const stale = events.filter(event => event.type === "member.stale");
  let lateReportsAfterStrike = 0;
  for (const strike of stale) {
    if (typeof strike.data.memberThreadId !== "string") continue;
    const report = data.reports.filter(report => report.memberThreadId === strike.data.memberThreadId && report.createdAt > strike.at && report.createdAt <= to).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (report && !events.some(event => event.type === "member.released" && event.data.memberThreadId === strike.data.memberThreadId && event.at >= strike.at && event.at < report.createdAt)) lateReportsAfterStrike++;
  }
  return {
    ticks: count("tick.sent") + held.length + count("tick.deferred"), held: held.length, deferred: count("tick.deferred"),
    typingHolds: held.filter(event => event.data.reason === "typing").length,
    afterMessageHolds: held.filter(event => event.data.reason === "after-message").length,
    keeperTurnSeconds: measurements("keeper.turn", "seconds"), reportIntervals,
    staleStrikes: stale.length, lateReportsAfterStrike, releases: count("member.released"), reportsPerMinute: [...reportsPerMinute.values()],
    restatementBytes: measurements("restatement.measured", "bytes"),
    restatementClipped: events.filter(event => event.type === "restatement.measured" && event.data.clipped === true).length,
    tickFactChars: measurements("facts.measured", "chars"),
    factsClipped: count("facts.clipped") + events.filter(event => event.type === "facts.measured" && event.data.clipped === true).length,
    rangerMinutes: measurements("ranger.completed", "minutes"),
    rangerOverruns: events.filter(event => event.type === "ranger.completed" && event.data.overrun === true).length,
  };
}
