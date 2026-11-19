import { KNOB_FIELDS, TUNABLES, TUNABLE_KEYS, type Tunables, type TunableKey, type SettingsEvidence, type TuningSuggestion } from "../../shared/settings";
import { LIMITS } from "../limits";
import type { SettingsStore } from "./store";

export interface TuningSignals {
  ticks: number; held: number; deferred: number; typingHolds: number; afterMessageHolds: number;
  keeperTurnSeconds: number[]; reportIntervals: { classId: string; seconds: number }[];
  staleStrikes: number; lateReportsAfterStrike: number; releases: number; reportsPerMinute: number[];
  restatementBytes: number[]; restatementClipped: number; tickFactChars: number[]; factsClipped: number;
  rangerMinutes: number[]; rangerOverruns: number;
}
export type TuningProposal = Pick<TuningSuggestion, "key" | "value" | "reason" | "evidence">;
export const TUNING_RULES: Record<TunableKey, string> = {
  tickSeconds: "After 20 tick attempts, if at least 30% were held or deferred, or 20 measured turns have a 90th percentile above 75% of the interval, increase to the larger of 125% of the interval and that percentile plus five seconds.",
  typingHoldSeconds: "After 20 tick attempts, if at least 25% were held for typing, add fifteen seconds.",
  afterMessageHoldSeconds: "After 20 tick attempts, if at least 25% were held after a user message, add fifteen seconds.",
  staleMinutes: "For each class with 20 report intervals, allow twice its 95th-percentile interval; use the largest such allowance and never shorten the current allowance.",
  reportBatchSeconds: "After 20 observed report-minute buckets, if their 95th percentile has at least four reports, increase batching by 25%.",
};
function percentile(values: number[], share: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)]!;
}
export function evaluateRules(current: Tunables, signals: TuningSignals, minSamples: number = KNOB_FIELDS.tuning.minSamples.default): TuningProposal[] {
  const proposals: TuningProposal[] = [];
  function add(key: TunableKey, target: number, chart: string, facts: NonNullable<SettingsEvidence["facts"]>) {
    const value = Math.min(TUNABLES[key].max, Math.max(TUNABLES[key].min, Math.ceil(target), current[key]));
    if (value === current[key]) return;
    proposals.push({ key, value, reason: `${TUNING_RULES[key].replace(/\b20\b/g, String(minSamples))} Measured data supports ${current[key]} to ${value} ${TUNABLES[key].unit}.`,
      evidence: { section: "reliability", chart, facts } });
  }
  const enoughTicks = signals.ticks >= minSamples;
  const longTurns = signals.keeperTurnSeconds.length >= minSamples && percentile(signals.keeperTurnSeconds, 0.9) > current.tickSeconds * 0.75;
  if (enoughTicks && ((signals.held + signals.deferred) / signals.ticks >= 0.3 || longTurns))
    add("tickSeconds", Math.max(current.tickSeconds * 1.25, percentile(signals.keeperTurnSeconds, 0.9) + 5), "ticks", {
      attempts: signals.ticks, held: signals.held, deferred: signals.deferred, turnP90Seconds: percentile(signals.keeperTurnSeconds, 0.9),
    });
  if (enoughTicks && signals.typingHolds / signals.ticks >= 0.25)
    add("typingHoldSeconds", current.typingHoldSeconds + 15, "ticks", { attempts: signals.ticks, typingHolds: signals.typingHolds });
  if (enoughTicks && signals.afterMessageHolds / signals.ticks >= 0.25)
    add("afterMessageHoldSeconds", current.afterMessageHoldSeconds + 15, "ticks", { attempts: signals.ticks, afterMessageHolds: signals.afterMessageHolds });
  const byClass = new Map<string, number[]>();
  for (const interval of signals.reportIntervals) byClass.set(interval.classId, [...(byClass.get(interval.classId) ?? []), interval.seconds]);
  const observed = [...byClass].filter(([, values]) => values.length >= minSamples);
  if (observed.length) add("staleMinutes", Math.max(...observed.map(([, values]) => percentile(values, 0.95) * 2 / 60)), "report-intervals", {
    classes: observed.length, intervals: observed.reduce((sum, [, values]) => sum + values.length, 0),
    longestP95Seconds: Math.max(...observed.map(([, values]) => percentile(values, 0.95))),
  });
  if (signals.reportsPerMinute.length >= minSamples && percentile(signals.reportsPerMinute, 0.95) >= 4)
    add("reportBatchSeconds", current.reportBatchSeconds * 1.25, "reports", { minutes: signals.reportsPerMinute.length, peakP95: percentile(signals.reportsPerMinute, 0.95) });
  return proposals;
}
export function runTuner(store: SettingsStore, trigger: string, signals: TuningSignals, minSamples: number = KNOB_FIELDS.tuning.minSamples.default): TuningProposal[] {
  const settings = store.read();
  if (settings.tuning.mode === "off") return [];
  return store.db.transaction(() => {
    if (store.db.prepare("SELECT id FROM tavern_tuning_runs WHERE id=?").get(trigger)) return [];
    const snapshot = store.snapshot(), now = store.now();
    const proposals = evaluateRules(settings.knobs, signals, settings.tuning.minSamples).filter(proposal => {
      if (snapshot.pinned[proposal.key] !== undefined) return false;
      const last = store.db.prepare("SELECT at FROM tavern_setting_changes WHERE by='tavern' AND EXISTS (SELECT 1 FROM json_each(changes) WHERE json_extract(value,'$.key')=?) ORDER BY at DESC LIMIT 1")
        .get(`tuned.${proposal.key}`) as { at: number } | undefined;
      return last === undefined || now - last.at >= settings.tuning.cooldownDays * LIMITS.dayMs;
    });
    if (settings.tuning.mode === "apply") {
      for (const proposal of proposals) store.applyTuned({ [proposal.key]: proposal.value }, proposal.reason, proposal.evidence);
      store.saveSuggestions([]);
    } else store.saveSuggestions(proposals.map(proposal => ({ ...proposal, at: now, revision: snapshot.revision })));
    store.db.prepare("INSERT INTO tavern_tuning_runs(id,at) VALUES(?,?)").run(trigger, now);
    return proposals;
  })();
}
export const dailyTuningId = (at: number) => `daily:${new Date(at).toISOString().slice(0, 10)}`;
export const TUNING_KEYS = TUNABLE_KEYS;
