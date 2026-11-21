import { insightsSchema, type InsightsView } from "../../shared/insights";
import { TUNABLES, TUNABLE_KEYS, settingsSchema, settingsViewSchema, type SettingsView, type TunableKey } from "../../shared/settings";

const NOW = Date.UTC(2026, 10, 14, 9, 0);
const DAY = 86_400_000;
const days = (n: number) => Array.from({ length: n }, (_, i) => new Date(NOW - (n - 1 - i) * DAY).toISOString().slice(0, 10));
const wave = (n: number, base: number, amp: number, seed = 1) => days(n).map((x, i) => ({ x, y: Math.max(0, Math.round(base + amp * Math.sin((i + seed) / 2.3))) }));

const effective = settingsSchema.parse({
  attention: { reviewBudget: 4, notify: "consequential", quietHours: { start: "22:00", end: "07:30", timeZone: "America/Toronto" } },
  tuning: { mode: "suggest" },
  classes: { smith: { provider: "codex", model: "gpt-6.1-sol", reasoning: "high" } },
  knobs: { ...Object.fromEntries(TUNABLE_KEYS.map((k) => [k, TUNABLES[k].default])), staleMinutes: 30, tickSeconds: 90, rangerTimeboxMaxMinutes: 12 },
});

const row = (key: TunableKey, over: Partial<SettingsView["rows"][number]> = {}) => ({ key, label: TUNABLES[key].label, value: effective.knobs[key], default: TUNABLES[key].default, min: TUNABLES[key].min, max: TUNABLES[key].max, unit: TUNABLES[key].unit, source: "default" as const, pinned: false, lastChange: null, ...over });

export const settingsView: SettingsView = settingsViewSchema.parse({
  revision: 12,
  effective,
  user: { attention: { reviewBudget: 4, quietHours: { start: "22:00", end: "07:30", timeZone: "America/Toronto" } }, tuning: { mode: "suggest" }, classes: { smith: { provider: "codex", model: "gpt-6.1-sol", reasoning: "high" } } },
  pinned: { staleMinutes: 30 },
  tuned: { tickSeconds: 90 },
  rows: TUNABLE_KEYS.map((key) => key === "tickSeconds"
    ? row(key, { source: "tavern", lastChange: { id: "d-tick", at: NOW - 2 * DAY, from: 60, to: 90, by: "tavern", reason: "Ticks were held while you typed on 41% of ticks; a longer interval keeps the Keeper from interrupting you.", evidence: { section: "reliability", chart: "ticks", figure: 0.41 }, undoable: true } })
    : key === "staleMinutes"
      ? row(key, { source: "user", pinned: true, lastChange: { id: "d-stale", at: NOW - 6 * DAY, from: 20, to: 30, by: "user", reason: "Builds run long on this repo.", evidence: null, undoable: true } })
      : row(key)),
  history: [
    { id: "d-tick", at: NOW - 2 * DAY, by: "tavern", reason: "Ticks were held while you typed on 41% of ticks.", evidence: { section: "reliability", chart: "ticks", figure: 0.41 }, questId: null, threadId: null, changes: [{ key: "knobs.tickSeconds", from: 60, to: 90, kind: "set" }], undoable: true, undoneAt: null },
    { id: "d-stale", at: NOW - 6 * DAY, by: "user", reason: "Builds run long on this repo.", evidence: null, questId: null, threadId: null, changes: [{ key: "knobs.staleMinutes", from: 20, to: 30, kind: "pin" }], undoable: true, undoneAt: null },
    { id: "d-batch", at: NOW - 9 * DAY, by: "keeper", reason: "Vault cutover reports arrive in bursts during the DNS window.", evidence: { section: "reliability", chart: "reports" }, questId: "vault", threadId: "keeper", changes: [{ key: "knobs.reportBatchSeconds", from: 60, to: 120, kind: "set" }], undoable: false, undoneAt: NOW - 8 * DAY },
  ],
  suggestions: [{ key: "typingHoldSeconds", value: 75, reason: "A tick landed within 45 s of your typing 9 times this week.", evidence: { section: "reliability", chart: "ticks", figure: 9 }, at: NOW - DAY, revision: 12 }],
  file: { path: "~/.agents/tavern/settings.toml", exists: true, differs: true, error: null, changedKeys: ["attention.review_budget", "tuning.pinned.stale_minutes"], hash: "a1b2c3" },
});

export const settingsToml = `[tavern]
voice = "full"

[attention]
review_budget = 4
notify = "consequential"
quiet_hours = { start = "22:00", end = "07:30", time_zone = "America/Toronto" }

[classes.smith]
provider = "codex"
model = "gpt-6.1-sol"
reasoning = "high"

[tuning]
mode = "suggest"
pinned = { stale_minutes = 30 }
`;

export const insightsView: InsightsView = insightsSchema.parse({
  range: "30d", from: NOW - 30 * DAY, to: NOW, collectingSince: NOW - 41 * DAY,
  wardenQuality: {
    from: NOW - 30 * DAY, to: NOW, rejectedWaypointsWaived: 1,
    rows: [
      { classId: "warden", providerId: "codex", model: "gpt-6.1-sol", verified: 10, reopened: 2, rejected: 3 },
      { classId: "warden", providerId: "pi", model: "example-labs/reviewer-large-2026-11-14-preview-with-a-long-model-identifier", verified: 2, reopened: 0, rejected: 1 },
    ],
  },
  headline: [
    { id: "returned", label: "Quests returned", value: 7, unit: "count", previous: 4 },
    { id: "goal-to-return", label: "Median goal to return", value: 5.2 * 3600, unit: "s", previous: 7.9 * 3600 },
    { id: "ask-wait", label: "Median ask wait for you", value: 22 * 60, unit: "s", previous: 14 * 60 },
    { id: "first-verify", label: "Verified first time", value: 0.82, unit: "ratio", previous: 0.74 },
  ],
  ideas: [
    { id: "hold", title: "Hold ticks longer while you type", detail: "A tick landed within 45 s of your typing 9 times this week. 75 s would have held all but one.", severity: "act", action: { kind: "apply-tuned", key: "typingHoldSeconds", value: 75 }, evidence: { section: "reliability", chart: "ticks" } },
    { id: "budget", title: "Your review queue is often full", detail: "Keepers paused new work on 6 of 30 days because 4 items waited on you.", severity: "act", action: { kind: "open-setting", key: "attention.reviewBudget" }, evidence: { section: "attention", chart: "review-load" } },
    { id: "vault", title: "Vault cutover waits on outside gates", detail: "38% of its time went to the release train and the SRE sign-off.", severity: "info", action: { kind: "open-quest", questId: "vault" }, evidence: { section: "phases", chart: "phase-time" } },
  ],
  reliability: { caption: "How well Keepers keep the thread: steers read right, why they re-anchored, and what happened to each tick.", series: [
    { id: "steers-right", label: "Steers read correctly", unit: "ratio", value: 0.93 },
    { id: "facts-clipped", label: "Tick facts clipped", unit: "count", value: 3 },
    { id: "interrupted", label: "Interrupted turns", unit: "count", value: 2 },
    { id: "reanchor-session", label: "Re-anchors: session start", unit: "count", points: [{ x: "Session start", y: 14 }, { x: "Compaction", y: 6 }, { x: "Reload", y: 3 }, { x: "Failed turn", y: 1 }] },
    { id: "ticks", label: "Ticks", unit: "count", points: [{ x: "Sent", y: 412 }, { x: "Held", y: 171 }, { x: "Deferred", y: 38 }] },
    { id: "restatement", label: "Restatement size, against the 28 000 byte limit", unit: "bytes", points: wave(30, 19_000, 4_000) },
  ] },
  phases: { caption: "Where quests spend their time, as the median time per quest in each phase.", series: [
    { id: "phase-time", label: "Median time in phase", unit: "s", points: [{ x: "Scouting", y: 0.6 * 3600 }, { x: "Greenlight wait", y: 1.4 * 3600 }, { x: "Building", y: 2.1 * 3600 }, { x: "In review", y: 0.8 * 3600 }, { x: "Outside gates", y: 1.9 * 3600 }] },
  ] },
  attention: { caption: "What reached you: asks per day, how they ended, and your review load against the budget of 4.", series: [
    { id: "asks-per-day", label: "Asks per day", unit: "count", points: wave(30, 4, 3) },
    { id: "asks-ended", label: "How asks ended", unit: "count", points: [{ x: "You answered", y: 96 }, { x: "Default applied", y: 21 }, { x: "Expired", y: 4 }] },
    { id: "answer-time", label: "Median time to answer", unit: "s", value: 22 * 60 },
    { id: "review-load", label: "Review items waiting, daily peak", unit: "count", points: wave(30, 3, 2, 4) },
  ] },
  party: { caption: "Who was hired and how they did: hires per class, Warden verdicts and stale strikes.", series: [
    { id: "hires", label: "Hires per class", unit: "count", points: [{ x: "Smith", y: 18 }, { x: "Ranger", y: 11 }, { x: "Warden", y: 9 }, { x: "Wanderer", y: 4 }] },
    { id: "verified", label: "Verified wins", unit: "count", value: 31 },
    { id: "rejected", label: "Warden rejections", unit: "count", value: 7 },
    { id: "stale", label: "Stale strikes", unit: "count", value: 5 },
    { id: "failed-spawns", label: "Failed spawns", unit: "count", value: 0 },
  ] },
  guardrails: { caption: "What the scopes stopped: blocks by rule, and widening asks you granted or refused.", series: [
    { id: "blocks", label: "Scope blocks by rule", unit: "count", points: [{ x: "push to main", y: 6 }, { x: "edit outside repo", y: 3 }, { x: "network write", y: 1 }] },
    { id: "widen-asked", label: "Widening asks", unit: "count", value: 4 },
    { id: "widen-granted", label: "Granted", unit: "count", value: 3 },
  ] },
  tuningHistory: settingsView.history,
  cost: { caption: "Cost and time per returned quest, from bb's thread usage.", estimated: true, threadsKnown: 41, threadsTotal: 44, series: [
    { id: "cost-total", label: "Total cost", unit: "usd", value: 38.4 },
    { id: "cost-median", label: "Median per quest", unit: "usd", value: 4.9 },
  ], quests: [
    { questId: "sfe", title: "Pick SFE migration candidates", cost: 6.2, tokens: 1_900_000, seconds: 4.1 * 3600, complete: true },
    { questId: "readme", title: "README missing plugins", cost: 1.1, tokens: 310_000, seconds: 0.4 * 3600, complete: true },
    { questId: "ts", title: "TS lines per plugin", cost: null, tokens: null, seconds: 0.3 * 3600, complete: false },
  ] },
});

export const emptyInsights: InsightsView = insightsSchema.parse({
  range: "7d", from: NOW - 7 * DAY, to: NOW, collectingSince: NOW - 2 * DAY,
  wardenQuality: { from: NOW - 7 * DAY, to: NOW, rejectedWaypointsWaived: 0, rows: [] },
  headline: [{ id: "returned", label: "Quests returned", value: null, unit: "count" }],
  ideas: [], reliability: { caption: "How well Keepers keep the thread.", series: [] }, phases: { caption: "Where quests spend their time.", series: [] },
  attention: { caption: "What reached you.", series: [] }, party: { caption: "Who was hired and how they did.", series: [] },
  guardrails: { caption: "What the scopes stopped.", series: [] }, tuningHistory: [], cost: null,
});
