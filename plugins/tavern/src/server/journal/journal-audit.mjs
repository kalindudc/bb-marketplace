#!/usr/bin/env node
// Measures how well bb agents keep their journal current. It samples recent bb threads,
// replays each thread's event log and reports whether the agent planned with a journal, how long
// it worked without touching the log, whether it closed entries as it went or all at the end,
// and whether follow-up requests from the user led to a log update.
//
// Ported from pi-quests 0.11.2; see LICENSE.pi-quests.md. Offline --logs never contacts bb.
// Run: node src/server/journal/journal-audit.mjs [--logs DIR] [--json] (see --help)

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WORK_ITEMS = new Set(["commandExecution", "fileChange", "fileRead", "imageView", "toolCall"]);
const MUTATING_ACTIONS = new Set([
  "add",
  "split",
  "add_step",
  "toggle",
  "update",
  "delete",
  "clear",
  "reparent",
  "undo",
  "redo",
  "reorder", "start", "done", "reopen", "block", "verify", "reject", "note", "link",
]);
// Only these change what the journal says about the work. update, note, reorder and reparent are activity, not currency:
// a thread that rewrites one entry every ten minutes is still silent about what got done.
const STATE_ACTIONS = new Set(["add", "split", "add_step", "start", "done", "block", "reopen", "verify", "reject", "toggle", "delete", "clear"]);
const CLOSE_ACTIONS = new Set(["done", "toggle", "verify"]);
const JOURNAL_NOTE = /^\[(?:Journal|Quests)\]/;
const STALE_REMINDER = /You have not updated the (?:journal|quests)/;
const REMINDER_FOLLOW_MS = 5 * 60_000;
const DEFAULT_PROVIDERS = ["pi", "claude-code", "codex"];
const TOGGLED_DONE = /^(?:Quest )?\[[0-9a-f]+\] done$/gm;
const TOGGLED_UNDONE = /^(?:Quest )?\[[0-9a-f]+\] undone$/gm;
const TAIL_SHARE = 0.15;
const FOLLOW_UP_WINDOW = 10;
const DOWNLOADS_AT_ONCE = 8;
const MAX_LOG_BYTES = 512 * 1024 * 1024;

const USAGE = `Usage: node src/server/journal/journal-audit.mjs [options]

Samples bb threads and measures how well their agents kept the journal current.

Options:
  --since YYYY-MM-DD   only threads created on or after this date (default: 7 days ago)
  --until YYYY-MM-DD   only threads created before this date (default: no end)
  --limit N            sample at most N threads (default: 120)
  --seed N             seed for the random sample, so reruns pick the same threads (default: 7)
  --min-work N         leave threads with fewer work actions out of the summary (default: 20)
  --providers LIST     comma-separated provider ids (default: ${DEFAULT_PROVIDERS.join(",")})
  --logs DIR           read <thread id>.json logs from DIR instead of downloading them
  --save DIR           write each downloaded log to DIR/<thread id>.json
  --json               print the per-thread metrics and the summary as one JSON object
  --help               show this help
`;

function localDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDate(date);
}

function wholeNumber(name, text) {
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) {
    throw new Error(`--${name} must be a whole number, got "${text}"`);
  }
  return value;
}

function dateMs(name, text) {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!date) throw new Error(`--${name} must look like YYYY-MM-DD, got "${text}"`);
  const [, year, month, day] = date.map(Number);
  return new Date(year, month - 1, day).getTime();
}

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: "string", default: daysAgo(7) },
      until: { type: "string" },
      limit: { type: "string", default: "120" },
      seed: { type: "string", default: "7" },
      "min-work": { type: "string", default: "20" },
      providers: { type: "string", default: DEFAULT_PROVIDERS.join(",") },
      logs: { type: "string" },
      save: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  return {
    help: values.help,
    since: values.since,
    sinceMs: dateMs("since", values.since),
    until: values.until ?? null,
    untilMs: values.until === undefined ? Number.POSITIVE_INFINITY : dateMs("until", values.until),
    limit: wholeNumber("limit", values.limit),
    seed: wholeNumber("seed", values.seed),
    minWork: wholeNumber("min-work", values["min-work"]),
    providers: values.providers
      .split(",")
      .map((provider) => provider.trim())
      .filter(Boolean),
    logs: values.logs,
    save: values.save,
    json: values.json,
  };
}

async function bbJson(args) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("bb", args, { maxBuffer: MAX_LOG_BYTES }));
  } catch (error) {
    throw new Error(`bb ${args.join(" ")} failed: ${failureReason(error)}`);
  }
  const parsed = JSON.parse(stdout);
  if (parsed?.ok === false) throw new Error(parsed.error?.message ?? "bb reported an error");
  return { parsed, stdout };
}

function failureReason(error) {
  const text = parseJsonOrNull(error.stdout)?.error?.message ?? (error.stderr || error.message);
  return String(text).trim().split("\n")[0];
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function listThreads() {
  const lists = await Promise.all([
    bbJson(["thread", "list", "--json"]),
    bbJson(["thread", "list", "--json", "--archived"]),
  ]);
  const threads = new Map();
  for (const { parsed } of lists) {
    if (!Array.isArray(parsed)) throw new Error("bb thread list did not return a list");
    for (const thread of parsed) threads.set(thread.id, thread);
  }
  return threads;
}

async function logIdsIn(dir) {
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith(".json")).map((name) => basename(name, ".json"));
}

function inSample(thread, options) {
  if (!thread) return true;
  return (
    options.providers.includes(thread.providerId) &&
    thread.createdAt >= options.sinceMs &&
    thread.createdAt < options.untilMs
  );
}

// Ranking by a seeded hash keeps earlier picks in the sample when new threads appear.
function sample(ids, limit, seed) {
  const ranked = ids.map((id) => ({ id, rank: seededHash(`${seed}:${id}`) }));
  ranked.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  return ranked
    .slice(0, limit)
    .map(({ id }) => id)
    .sort();
}

function seededHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function mapWithLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loadEvents(id, options) {
  let events;
  if (options.logs) {
    events = JSON.parse(await readFile(join(options.logs, `${id}.json`), "utf8"));
  } else {
    const { parsed, stdout } = await bbJson(["thread", "log", id, "--all", "--format", "json"]);
    events = parsed;
    if (options.save) await writeFile(join(options.save, `${id}.json`), stdout);
  }
  if (!Array.isArray(events)) throw new Error("the log is not a list of events");
  return events;
}

function journalArguments(item) {
  let args = item.arguments || item.input || {};
  if (typeof args === "string") args = parseJsonOrNull(args);
  return args && typeof args === "object" && !Array.isArray(args) ? args : {};
}

function resultText(item) {
  const raw = item.result ?? item.output ?? "";
  const result = raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.content) ? raw.content : raw;
  if (Array.isArray(result)) {
    return result
      .map((part) => (part && typeof part === "object" ? (part.text ?? "") : String(part)))
      .join(" ");
  }
  return typeof result === "object" ? JSON.stringify(result) : String(result);
}

function isJournalCall(item) {
  return item.type === "toolCall" && /(?:^|\.|__)(?:journal|quest)$/.test(String(item.tool || item.name || ""));
}

// Positions count non-journal work actions, so a journal call at position 12 came after 12 of them.
function readTimeline(events) {
  let work = 0;
  const timeline = [];
  for (const event of events) {
    const data = event.data || {};
    if (event.type === "item/completed") {
      const item = data.item || {};
      if (!WORK_ITEMS.has(item.type)) continue;
      if (isJournalCall(item)) {
        timeline.push({
          order: timeline.length,
          at: work,
          time: typeof event.createdAt === "number" ? event.createdAt : null,
          kind: "journal",
          args: journalArguments(item),
          result: resultText(item),
        });
      } else {
        work += 1;
      }
    } else if (event.type === "client/turn/requested") {
      const texts = Array.isArray(data.input) ? data.input.filter((p) => p?.type === "text").map((p) => String(p.text ?? "")) : [];
      // Tavern's notes, and pi-quests' before Tavern took over the checklist.
      const note = (data.originPluginId === "tavern" || data.originPluginId === "pi-quests") && texts.some((t) => JOURNAL_NOTE.test(t));
      timeline.push({
        order: timeline.length,
        at: work,
        time: typeof event.createdAt === "number" ? event.createdAt : null,
        kind: "request",
        journalNote: note,
        reminder: note && texts.some((t) => STALE_REMINDER.test(t)),
        initiator: data.initiator === "user" && data.originPluginId == null && data.senderThreadId == null && data.retryOfRequestId == null && Array.isArray(data.input) && data.input.some(p => p?.type === "text" && p.visibility !== "agent-only") ? "user" : "non-user",
      });
    } else if (event.type === "turn/completed") {
      timeline.push({ order: timeline.length, at: work, kind: "turnEnd", status: data.status });
    }
  }
  return { work, timeline };
}

function countActions(journalCalls) {
  const actions = {};
  for (const { args } of journalCalls) {
    const action = String(args.action ?? null);
    actions[action] = (actions[action] ?? 0) + 1;
  }
  return actions;
}

function listOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function journalIds(args) {
  if (listOrEmpty(args.ids).length > 0) return args.ids;
  return args.id ? [args.id] : [];
}

function countMatches(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

const NO_PLAN = {
  firstAddAt: null,
  created: null,
  completed: null,
  openAtEnd: null,
  maxSilentStretch: null,
  maxToggleBatch: null,
  tailCompletionShare: null,
  splitThenList: null,
  userRequestsAfterPlan: null,
  requestsFollowedByJournal: null,
};

function planMetrics(work, timeline, journalCalls, firstAddAt) {
  let created = 0;
  let completed = 0;
  let lastDone = 0;
  let open = 0;
  let lastChange = firstAddAt;
  let splitPending = false;
  let splitThenList = 0;
  const silentStretches = [];
  const toggleSizes = [];
  const completionPositions = [];

  for (const { at, args, result } of journalCalls) {
    const action = args.action;
    if (action === "list" && splitPending) {
      splitThenList += 1;
      splitPending = false;
    }
    if (!MUTATING_ACTIONS.has(action) || /(?:^|\n)Error:/.test(result)) continue;
    if (STATE_ACTIONS.has(action)) {
      if (open > 0) silentStretches.push(at - lastChange);
      lastChange = at;
    }

    const snapshot = [...result.matchAll(/^(\d+) of (\d+) done\./gm)].at(-1);
    if (snapshot) {
      const done = Number(snapshot[1]), total = Number(snapshot[2]);
      const newlyDone = Math.max(done - lastDone, 0);
      completed += newlyDone;
      for (let i = 0; i < newlyDone; i++) completionPositions.push(at);
      lastDone = done; created = total; open = total - done;
      if (action === "toggle" || action === "done") toggleSizes.push(journalIds(args).length);
      if (action === "split" || action === "add_step") splitPending = true;
    } else if (result.includes("The journal is empty.") || result.includes("The quest log is empty.")) {
      created = 0; open = 0; lastDone = 0;
    } else if (action === "add" || action === "split" || action === "add_step") {
      const added = listOrEmpty(args.descriptions).length;
      created += added;
      open += added;
      if (action !== "add") splitPending = true;
    } else if (action === "toggle") {
      // Only the toggle's own lines count: "Quest [id] done" or "[id] undone" in a batch. The
      // user's changes and the plan line in newer results also contain "done".
      const done = Math.max(
        countMatches(result, TOGGLED_DONE) - countMatches(result, TOGGLED_UNDONE),
        0,
      );
      toggleSizes.push(journalIds(args).length);
      completed += done;
      open -= done;
      for (let i = 0; i < done; i++) completionPositions.push(at);
    } else if (action === "delete") {
      const deleted = journalIds(args).length;
      open -= deleted;
      created -= deleted;
    }
  }
  if (open > 0) silentStretches.push(work - lastChange);

  const tailStart = work - TAIL_SHARE * Math.max(work - firstAddAt, 1);
  const lateCompletions = completionPositions.filter((at) => at >= tailStart).length;
  const requests = timeline.filter(
    (entry) => entry.kind === "request" && entry.initiator === "user" && entry.at > firstAddAt,
  );
  const followed = requests.filter((request) =>
    journalCalls.some(
      (call) => call.order > request.order && call.at <= request.at + FOLLOW_UP_WINDOW,
    ),
  );

  return {
    firstAddAt,
    created,
    completed,
    openAtEnd: Math.max(open, 0),
    maxSilentStretch: Math.max(0, ...silentStretches),
    maxToggleBatch: Math.max(0, ...toggleSizes),
    tailCompletionShare:
      completionPositions.length > 0 ? lateCompletions / completionPositions.length : null,
    splitThenList,
    userRequestsAfterPlan: requests.length,
    requestsFollowedByJournal: followed.length,
  };
}

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

// The journal-currency measures from the coordinator study (design/journal-gap/report.md, section 7) that a log alone can give.
function currencyMetrics(timeline, journalCalls) {
  const ok = journalCalls.filter((c) => MUTATING_ACTIONS.has(c.args.action) && !/(?:^|\n)Error:/.test(c.result));
  const count = (action) => ok.filter((c) => c.args.action === action).length;
  const stateChanges = ok.filter((c) => STATE_ACTIONS.has(c.args.action));
  const rewrites = count("update");
  const closes = ok.filter((c) => CLOSE_ACTIONS.has(c.args.action)).reduce((n, c) => n + Math.max(1, journalIds(c.args).length), 0);
  const entriesAdded = ok.filter((c) => ["add", "split", "add_step"].includes(c.args.action)).reduce((n, c) => n + listOrEmpty(c.args.descriptions).length, 0);
  const starts = count("start");
  // The longest time with open entries and no close, from the first add.
  let longest = 0, since = null, open = 0;
  for (const c of ok) {
    const snapshot = [...c.result.matchAll(/^(\d+) of (\d+) done\./gm)].at(-1);
    const nowOpen = snapshot ? Number(snapshot[2]) - Number(snapshot[1]) : open;
    if (c.time !== null) {
      if (since === null && nowOpen > 0) since = c.time;
      if (CLOSE_ACTIONS.has(c.args.action) && since !== null) { longest = Math.max(longest, c.time - since); since = nowOpen > 0 ? c.time : null; }
    }
    open = nowOpen;
  }
  const last = timeline.at(-1)?.time ?? null;
  if (since !== null && last !== null && open > 0) longest = Math.max(longest, last - since);
  const requests = timeline.filter((e) => e.kind === "request");
  const inbound = requests.filter((e) => !e.journalNote).length;
  const reminders = requests.filter((e) => e.reminder);
  const heeded = reminders.filter((r) => r.time !== null && stateChanges.some((c) => c.order > r.order && c.time !== null && c.time - r.time <= REMINDER_FOLLOW_MS)).length;
  return {
    stateChanges: stateChanges.length, rewrites, notes: count("note"),
    rewriteShare: ok.length ? rewrites / ok.length : null,
    updatesPerClose: closes ? rewrites / closes : null,
    entriesAdded, starts, startUsage: entriesAdded ? starts / entriesAdded : null,
    longestHoursWithoutClose: round(longest / 3_600_000, 2),
    inbound, reminders: reminders.length,
    remindersPer100Inbound: inbound ? round((reminders.length / inbound) * 100, 1) : null,
    reminderPrecision: ratio(heeded, reminders.length),
  };
}

function threadMetrics(id, events, thread) {
  const { work, timeline } = readTimeline(events);
  const journalCalls = timeline.filter((entry) => entry.kind === "journal");
  const firstAdd = journalCalls.find((call) => call.args.action === "add");
  const failedTurns = timeline.filter(
    (entry) =>
      entry.kind === "turnEnd" && (entry.status === "failed" || entry.status === "interrupted"),
  );
  return {
    thread: id,
    title: thread?.title ?? null,
    providerId: thread?.providerId ?? null,
    child: thread ? thread.parentThreadId != null : null,
    work,
    journalCalls: journalCalls.length,
    actions: countActions(journalCalls),
    adopted: firstAdd !== undefined,
    ...(firstAdd ? planMetrics(work, timeline, journalCalls, firstAdd.at) : NO_PLAN),
    currency: firstAdd ? currencyMetrics(timeline, journalCalls) : null,
    failedTurns: failedTurns.length,
    reportedWithEvidence: journalCalls.filter(c => c.args.action === "done" && listOrEmpty(c.args.evidence).length > 0 && !/(?:^|\n)Error:/.test(c.result)).length,
    doneWithoutEvidence: journalCalls.filter(c => c.args.action === "done" && c.result.includes("done without evidence")).length,
    verified: journalCalls.filter(c => c.args.action === "verify" && !/(?:^|\n)Error:/.test(c.result)).length,
    rejected: journalCalls.filter(c => c.args.action === "reject" && !/(?:^|\n)Error:/.test(c.result)).length,
    blocked: journalCalls.filter(c => c.args.action === "block" && !/(?:^|\n)Error:/.test(c.result)).length,
    evidenceRefusals: journalCalls.filter(c => /Error:.*(?:evidence|Warden)/.test(c.result)).length,
  };
}

async function auditThread(id, options, threads) {
  try {
    return threadMetrics(id, await loadEvents(id, options), threads.get(id));
  } catch (error) {
    warn(`skipping ${id}: ${error.message}`);
    return null;
  }
}

function ratio(count, of) {
  return { count, of };
}

function total(rows, key) {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function currencySummary(rows) {
  const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
  const rewrites = sum("rewrites"), added = sum("entriesAdded"), inbound = sum("inbound"), reminders = sum("reminders");
  const changing = rows.reduce((n, r) => n + r.stateChanges + r.rewrites + r.notes, 0);
  return {
    rewriteShare: changing ? rewrites / changing : null,
    startUsage: added ? sum("starts") / added : null,
    remindersPer100Inbound: inbound ? round((reminders / inbound) * 100, 1) : null,
    medianLongestHoursWithoutClose: median(rows.map((r) => r.longestHoursWithoutClose)),
    reminderPrecision: ratio(rows.reduce((n, r) => n + r.reminderPrecision.count, 0), rows.reduce((n, r) => n + r.reminderPrecision.of, 0)),
  };
}

function summarize(rows) {
  const adopted = rows.filter((row) => row.adopted);
  const completing = adopted.filter((row) => row.completed > 0);
  return {
    threads: rows.length,
    adoption: ratio(adopted.length, rows.length),
    closedMostlyAtEnd: ratio(
      completing.filter((row) => row.tailCompletionShare >= 0.5).length,
      completing.length,
    ),
    silentForHalfOrMore: ratio(
      adopted.filter((row) => row.maxSilentStretch >= row.work / 2).length,
      adopted.length,
    ),
    medianLongestSilentStretch: median(adopted.map((row) => row.maxSilentStretch)),
    followUpsTouchingJournal: ratio(
      total(adopted, "requestsFollowedByJournal"),
      total(adopted, "userRequestsAfterPlan"),
    ),
    evidence: { reportedWithEvidence: total(rows, "reportedWithEvidence"), doneWithoutEvidence: total(rows, "doneWithoutEvidence"), refusals: total(rows, "evidenceRefusals") },
    verdicts: { verified: total(rows, "verified"), rejected: total(rows, "rejected"), blocked: total(rows, "blocked") },
    currency: currencySummary(adopted.map((row) => row.currency).filter(Boolean)),
  };
}

function summaryByKind(rows) {
  const summary = {
    all: summarize(rows),
    topLevel: summarize(rows.filter((row) => row.child === false)),
    child: summarize(rows.filter((row) => row.child === true)),
  };
  const unknown = rows.filter((row) => row.child === null);
  if (unknown.length > 0) summary.unknownKind = summarize(unknown);
  return summary;
}

function formatRatio({ count, of }) {
  const percent = of === 0 ? "n/a" : `${Math.round((100 * count) / of)}%`;
  return `${count}/${of} (${percent})`;
}

function sampleLine(sample) {
  const parts = [
    `Sample: ${sample.analysed} threads created since ${sample.since}${sample.until ? `, before ${sample.until}` : ""}`,
    `providers ${sample.providers.join(", ")}`,
    `seed ${sample.seed}`,
    `${sample.inScope} with at least ${sample.minWork} work actions`,
  ];
  if (sample.skipped > 0) parts.push(`${sample.skipped} skipped`);
  if (sample.unknownMetadata > 0) {
    parts.push(`${sample.unknownMetadata} with unknown metadata, not filtered`);
  }
  return `${parts.join("; ")}.`;
}

function kindLine(label, summary) {
  return [
    `${label} (${summary.threads}):`,
    `adoption ${formatRatio(summary.adoption)},`,
    `closed at the end ${formatRatio(summary.closedMostlyAtEnd)},`,
    `silent half or more ${formatRatio(summary.silentForHalfOrMore)},`,
    `follow-ups ${formatRatio(summary.followUpsTouchingJournal)}`,
  ].join(" ");
}

const TABLE_COLUMNS = [
  ["thread", (row) => row.thread],
  ["provider", (row) => row.providerId ?? "?"],
  ["kind", (row) => (row.child === null ? "?" : row.child ? "child" : "top")],
  ["work", (row) => row.work],
  ["journal", (row) => row.journalCalls],
  ["1st add", (row) => row.firstAddAt],
  ["created", (row) => row.created],
  ["done", (row) => row.completed],
  ["open", (row) => row.openAtEnd],
  ["silent", (row) => row.maxSilentStretch],
  ["batch", (row) => row.maxToggleBatch],
  [
    "late",
    (row) =>
      row.tailCompletionShare === null ? null : `${Math.round(100 * row.tailCompletionShare)}%`,
  ],
  [
    "follow-ups",
    (row) => (row.adopted ? `${row.requestsFollowedByJournal}/${row.userRequestsAfterPlan}` : null),
  ],
  ["failed", (row) => row.failedTurns],
  ["title", (row) => (row.title ?? "").slice(0, 50)],
];

function table(rows) {
  const cells = rows.map((row) => TABLE_COLUMNS.map(([, cell]) => String(cell(row) ?? "-")));
  const header = TABLE_COLUMNS.map(([name]) => name);
  const widths = header.map((name, column) =>
    Math.max(name.length, ...cells.map((line) => line[column].length)),
  );
  return [header, ...cells]
    .map((line) => line.map((cell, column) => cell.padEnd(widths[column])).join("  "))
    .map((line) => line.trimEnd());
}

const pct = (value) => value === null ? "n/a" : `${Math.round(value * 100)}%`;

function textReport({ sample, summary, threads }) {
  const { all } = summary;
  const median = all.medianLongestSilentStretch;
  const lines = [
    sampleLine(sample),
    `adoption:                         ${formatRatio(all.adoption)}`,
    `closed mostly at the end:         ${formatRatio(all.closedMostlyAtEnd)}`,
    `silent for half the thread+:      ${formatRatio(all.silentForHalfOrMore)}`,
    `median longest silent stretch:    ${median === null ? "n/a" : `${median} actions`}`,
    `follow-ups that touched the journal:  ${formatRatio(all.followUpsTouchingJournal)}`,
    `rewrite share (updates of all changes): ${pct(all.currency.rewriteShare)}`,
    `start usage (starts per entry added):   ${pct(all.currency.startUsage)}`,
    `median longest time without a close:    ${all.currency.medianLongestHoursWithoutClose ?? "n/a"} h`,
    `reminders per 100 inbound messages:     ${all.currency.remindersPer100Inbound ?? "n/a"}, followed by a state change ${formatRatio(all.currency.reminderPrecision)}`,
    kindLine("top-level threads", summary.topLevel),
    kindLine("child threads", summary.child),
  ];
  if (summary.unknownKind) lines.push(kindLine("unknown kind", summary.unknownKind));
  lines.push(
    "",
    `Per thread (threads under ${sample.minWork} work actions are left out of the summary):`,
  );
  lines.push(...table(threads));
  return `${lines.join("\n")}\n`;
}

function warn(message) {
  process.stderr.write(`journal-audit: ${message}\n`);
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    warn(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.save) await mkdir(options.save, { recursive: true });

  const threads = options.logs ? new Map() : await listThreads();
  const ids = options.logs ? await logIdsIn(options.logs) : [...threads.keys()];
  const candidates = ids.filter((id) => inSample(threads.get(id), options));
  const chosen = sample(candidates, options.limit, options.seed);
  const audited = await mapWithLimit(chosen, DOWNLOADS_AT_ONCE, (id) =>
    auditThread(id, options, threads),
  );
  const rows = audited.filter((row) => row !== null);
  const inScope = rows.filter((row) => row.work >= options.minWork);

  const report = {
    sample: {
      source: options.logs ? `logs in ${options.logs}` : "bb",
      since: options.since,
      until: options.until,
      providers: options.providers,
      seed: options.seed,
      limit: options.limit,
      minWork: options.minWork,
      candidates: candidates.length,
      sampled: chosen.length,
      analysed: rows.length,
      skipped: chosen.length - rows.length,
      inScope: inScope.length,
      unknownMetadata: rows.filter((row) => row.child === null).length,
    },
    summary: summaryByKind(inScope),
    threads: rows,
  };
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : textReport(report));
}

main().catch((error) => {
  warn(error.message);
  process.exitCode = 1;
});
