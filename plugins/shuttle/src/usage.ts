// What AI reviews cost. The Burn plugin reads what every thread used; Shuttle reads each review thread and every thread
// under it, such as critics, from Burn, keeps each turn it sees, and counts each turn toward the review that was running
// in its thread when the turn started. A thread that hosts several reviews is split between them that way.
import { USAGE_OUTCOMES, type UsageOutcome, type UsageRange, type UsageView } from "./contract";
import { errText, type Ctx } from "./ctx";
import type { DraftRow, ReviewRow, UsageThreadRow, UsageTurnRow } from "./db/store";
import { median } from "./insights";
import { UsageUnavailableError } from "./ports";
import { addDays, dayOf, dayStart, RANGE_DAYS } from "./period";
import { shortKey } from "./prs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How far back Shuttle reads: the longest range, and a day to spare. */
const HORIZON_MS = 91 * DAY;
/** A thread is read again until one read comes this long after anything last happened in its reviews. */
export const SETTLE_MS = HOUR;
/** How often a thread whose figures may still change is read again. */
export const REREAD_MS = 5 * MINUTE;
/** Burn calls in one pass; the first pass over 90 days of reviews spreads over a few ticks. */
export const PASS_CALLS = 40;
/** The turn a review's prompt starts can begin a moment before Shuttle records the run. */
const LEAD_MS = MINUTE;
/** How long Shuttle waits to ask again after bb said Burn is not there. */
export const MISSING_RETRY_MS = 10 * MINUTE;
/** Failed reads in a row that end a pass: Burn is likely down. The next pass waits REREAD_MS. */
const FAILS_PER_PASS = 3;
/** While reads keep failing, the failure is logged at most this often. */
const WARN_EVERY_MS = HOUR;
const REVIEWS_SHOWN = 300;

/** How Burn answered the last pass. Kept in memory, not the database, so a pass changes no PR's view; the next pass after a restart says. */
interface Source {
  state: "ok" | "missing" | "error";
  message: string | null;
  at: number;
  warnedAt?: number;
}
const sources = new WeakMap<object, Source>();

/** Read an hour after the last thing that happened, by the review's runs and by Burn's own figures, so nothing more will come. */
const settled = (row: UsageThreadRow, activeAt: number) => row.read_at - Math.max(row.updated_at ?? 0, activeAt) >= SETTLE_MS;

/**
 * The last time anything happened in each review thread's runs of the last 91 days, a running review happening now, and
 * when its latest run started.
 */
function activity(ctx: Ctx, now: number): Map<string, { at: number; started: number }> {
  const out = new Map<string, { at: number; started: number }>();
  for (const run of ctx.store.reviewsSince(now - HORIZON_MS)) {
    const last = run.state === "running" ? now : Math.max(run.created_at, run.finished_at ?? 0, run.active_at ?? 0);
    const seen = out.get(run.thread_id);
    out.set(run.thread_id, { at: Math.max(seen?.at ?? 0, last), started: Math.max(seen?.started ?? 0, run.created_at) });
  }
  return out;
}

/**
 * Reads from Burn the review threads whose figures may still change, most recently active first, at most PASS_CALLS
 * calls; the next pass takes the rest. A review thread counts as read only once every thread under it was, so one that
 * failed is read again. Returns how many threads' figures changed.
 */
export async function readUsage(ctx: Ctx, signal?: AbortSignal): Promise<number> {
  const now = ctx.now();
  const source = sources.get(ctx.store);
  if (source?.state === "missing" && now - source.at < MISSING_RETRY_MS) return 0;
  if (source?.state === "error" && now - source.at < REREAD_MS) return 0;
  const rows = new Map(ctx.store.usageThreads().map((row) => [row.thread_id, row]));
  const due = [...activity(ctx, now)]
    .filter(([threadId, { at }]) => {
      const row = rows.get(threadId);
      return row === undefined || (!settled(row, at) && now - row.read_at >= REREAD_MS);
    })
    .sort((a, b) => b[1].at - a[1].at || b[1].started - a[1].started)
    .map(([threadId, { at }]) => [threadId, at] as const);
  let calls = 0;
  let fails = 0;
  let changed = 0;
  let next: Omit<Source, "at"> | null = null;
  let lastError: string | null = null;
  for (const [rootId, activeAt] of due) {
    if (signal?.aborted || calls >= PASS_CALLS) break;
    try {
      calls += 1;
      const root = await ctx.port.threadUsage(rootId);
      let complete = true;
      for (const childId of root.descendants) {
        const row = rows.get(childId);
        if ((row !== undefined && row.read_at >= now - REREAD_MS) || (row !== undefined && settled(row, activeAt))) continue;
        // A thread with more threads under it than a pass reads, such as one you picked, goes on in the next pass.
        if (signal?.aborted || calls >= PASS_CALLS) {
          complete = false;
          break;
        }
        calls += 1;
        const child = await ctx.port.threadUsage(childId);
        if (ctx.store.saveUsage(childId, rootId, child.usage)) changed += 1;
      }
      if (!complete) break;
      if (ctx.store.saveUsage(rootId, rootId, root.usage)) changed += 1;
      fails = 0;
      next = { state: "ok", message: null };
    } catch (error) {
      if (error instanceof UsageUnavailableError) {
        next = { state: "missing", message: error.message };
        break;
      }
      fails += 1;
      lastError = `${rootId}: ${errText(error)}`;
      next = { state: "error", message: errText(error) };
      if (fails >= FAILS_PER_PASS) break;
    }
  }
  // One failure in a pass keeps its message for the page even when later reads came through.
  if (lastError !== null && next?.state === "ok") next = { state: "error", message: lastError.slice(lastError.indexOf(": ") + 2) };
  if (next !== null) {
    const warnedAt = source?.warnedAt;
    const warn = lastError !== null && (warnedAt === undefined || ctx.now() - warnedAt >= WARN_EVERY_MS);
    if (warn) ctx.port.log("warn", `reading review usage from Burn failed: ${lastError}`);
    sources.set(ctx.store, { ...next, at: ctx.now(), ...(warn ? { warnedAt: ctx.now() } : warnedAt !== undefined ? { warnedAt } : {}) });
  }
  if (changed > 0 || (next !== null && next.state !== source?.state)) ctx.port.publish(["usage"]);
  return changed;
}

interface Amounts {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** One turn counted toward one review. */
interface Piece extends Amounts {
  run: ReviewRow;
  threadId: string;
  at: number;
  model: string;
  critic: boolean;
  estimated: boolean;
}

const tokensOf = (a: Amounts) => a.input + a.output + a.cacheRead + a.cacheWrite;
const amountsOf = (t: Pick<UsageTurnRow, "calls" | "input" | "output" | "cache_read" | "cache_write" | "cost">): Amounts => ({
  calls: t.calls, input: t.input, output: t.output, cacheRead: t.cache_read, cacheWrite: t.cache_write, cost: t.cost,
});

/**
 * The review a moment in its thread counts toward: the last one started by then. A review in a thread Shuttle did not
 * start for it, such as one the user picked, ends when it does, since the thread's work after it is not the review's.
 */
export function runAt(runs: readonly ReviewRow[], at: number, now: number): ReviewRow | null {
  let found: ReviewRow | null = null;
  for (const run of runs) {
    if (run.created_at - LEAD_MS > at) break;
    found = run;
  }
  if (found === null || found.own_thread === 1) return found;
  return at <= (found.finished_at ?? now) ? found : null;
}

/**
 * Every turn since `from`, counted toward its review: a review thread's own turns by when they started, and a thread
 * under it, such as a critic, by when that thread started. What a thread's kept turns leave out of its totals, the turns
 * Burn had stopped listing before Shuttle read it, counts when the thread started.
 */
function pieces(ctx: Ctx, from: number, now: number): { pieces: Piece[]; rows: Map<string, UsageThreadRow> } {
  const rows = new Map(ctx.store.usageThreads().map((row) => [row.thread_id, row]));
  const runs = new Map<string, ReviewRow[]>();
  for (const run of ctx.store.reviewsOfUsageThreads()) runs.set(run.thread_id, [...(runs.get(run.thread_id) ?? []), run]);
  const turns: Array<Amounts & { threadId: string; at: number; model: string | null }> = ctx.store.usageTurnsSince(from).map((t) => ({ ...amountsOf(t), threadId: t.thread_id, at: t.at, model: t.model }));
  const sums = new Map(ctx.store.usageTurnSums().map((s) => [s.thread_id, amountsOf(s)]));
  for (const row of rows.values()) {
    if (row.started_at === null || row.started_at < from) continue;
    const kept = sums.get(row.thread_id);
    const rest: Amounts = {
      calls: Math.max(0, row.calls - (kept?.calls ?? 0)),
      input: Math.max(0, row.input - (kept?.input ?? 0)),
      output: Math.max(0, row.output - (kept?.output ?? 0)),
      cacheRead: Math.max(0, row.cache_read - (kept?.cacheRead ?? 0)),
      cacheWrite: Math.max(0, row.cache_write - (kept?.cacheWrite ?? 0)),
      // Burn sums dollars in floating point; a rounding difference is not a missing turn.
      cost: Math.max(0, row.cost - (kept?.cost ?? 0)),
    };
    if (tokensOf(rest) > 0) turns.push({ ...rest, threadId: row.thread_id, at: row.started_at, model: row.model });
  }
  const out: Piece[] = [];
  for (const turn of turns) {
    const row = rows.get(turn.threadId);
    if (row === undefined) continue;
    const critic = row.root_id !== row.thread_id;
    const run = runAt(runs.get(row.root_id) ?? [], critic ? (row.started_at ?? turn.at) : turn.at, now);
    if (run === null) continue;
    out.push({ ...turn, run, critic, model: turn.model ?? row.model ?? "unknown", estimated: row.estimated === 1 });
  }
  return { pieces: out, rows };
}

const startOfHour = (at: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
};

/** The draft each review handed back; a draft from before Shuttle kept which review made it goes to the last review of its PR in its thread. */
function draftsByRun(drafts: readonly DraftRow[], runs: readonly ReviewRow[]): Map<number, DraftRow[]> {
  const out = new Map<number, DraftRow[]>();
  for (const draft of drafts) {
    const runId = draft.review_id ?? runs.filter((r) => r.pr_id === draft.pr_id && r.thread_id === draft.thread_id && r.created_at <= draft.created_at).at(-1)?.id;
    if (runId !== undefined) out.set(runId, [...(out.get(runId) ?? []), draft]);
  }
  return out;
}

export function outcomeOf(run: ReviewRow, drafts: readonly DraftRow[]): UsageOutcome {
  if (drafts.some((d) => d.state === "posted")) return "posted";
  if (drafts.some((d) => d.state === "draft")) return "waiting";
  if (drafts.some((d) => d.discard_reason === "user")) return "discarded";
  if (drafts.length > 0 || run.ended_by === "replaced") return "replaced";
  if (run.state === "running") return "running";
  return run.state === "failed" ? "failed" : "no_draft";
}

interface Tally {
  tokens: number;
  cost: number;
  calls: number;
  runs: Set<number>;
}
const tally = (): Tally => ({ tokens: 0, cost: 0, calls: 0, runs: new Set() });
function add(t: Tally, p: Piece): void {
  t.tokens += tokensOf(p);
  t.cost += p.cost;
  t.calls += p.calls;
  t.runs.add(p.run.id);
}
function group<K>(items: readonly Piece[], keyOf: (p: Piece) => K): Map<K, Tally> {
  const out = new Map<K, Tally>();
  for (const p of items) {
    const key = keyOf(p);
    const t = out.get(key) ?? tally();
    add(t, p);
    out.set(key, t);
  }
  return out;
}
const byCost = <T extends { cost: number; tokens: number }>(a: T, b: T) => b.cost - a.cost || b.tokens - a.tokens;

function percentile(values: number[], share: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]!;
}

/**
 * The period of `range` days ending on `end`, or today when it is left out or not before today. A period that ends today
 * runs until now and is compared with the same stretch just before it, up to this time of day; an earlier one runs to
 * the end of its last day and is compared with the whole period before it.
 */
export function usageView(ctx: Ctx, range: UsageRange, end: string | null = null): UsageView {
  const now = ctx.now();
  const today = dayOf(now);
  const last = end !== null && end < today ? end : today;
  const latest = last === today;
  const days = RANGE_DAYS[range];
  const from = dayStart(addDays(last, 1 - days));
  const to = latest ? now : dayStart(addDays(last, 1));
  const previousFrom = dayStart(addDays(last, 1 - 2 * days));
  const previousTo = latest ? previousFrom + (now - from) : from;
  const within = (at: number) => at >= from && (latest ? at <= now : at < to);
  const { pieces: all, rows } = pieces(ctx, previousFrom, now);
  const current = all.filter((p) => within(p.at));
  const before = tally();
  for (const p of all) if (p.at >= previousFrom && p.at < previousTo) add(before, p);

  const total = tally();
  const mix = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const critic = tally();
  const criticThreads = new Set<string>();
  for (const p of current) {
    add(total, p);
    mix.input += p.input;
    mix.output += p.output;
    mix.cacheRead += p.cacheRead;
    mix.cacheWrite += p.cacheWrite;
    if (p.critic) {
      add(critic, p);
      criticThreads.add(p.threadId);
    }
  }

  const perRun = group(current, (p) => p.run.id);
  const runs = new Map(current.map((p) => [p.run.id, p.run]));
  const earliest = Math.min(now, ...[...runs.values()].map((r) => r.created_at));
  const drafts = draftsByRun(ctx.store.draftsSince(earliest), ctx.store.reviewsOfUsageThreads());
  const outcome = new Map([...runs.values()].map((run) => [run.id, outcomeOf(run, drafts.get(run.id) ?? [])]));

  const bucket = range === "today" ? "hour" : "day";
  const starts: number[] = [];
  if (bucket === "hour") for (let at = from; within(at); at = startOfHour(at + HOUR + MINUTE)) starts.push(at);
  else for (let back = days - 1; back >= 0; back -= 1) starts.push(dayStart(addDays(last, -back)));
  const slot = (at: number) => (bucket === "hour" ? startOfHour(at) : dayStart(dayOf(at)));
  const series = new Map(starts.map((start) => [start, { start, tokens: 0, cost: 0, critics: 0, reviews: 0 }]));
  for (const p of current) {
    const row = series.get(slot(p.at));
    if (!row) continue;
    row.tokens += tokensOf(p);
    row.cost += p.cost;
    if (p.critic) row.critics += tokensOf(p);
  }
  for (const run of runs.values()) {
    const row = series.get(slot(run.created_at));
    if (row) row.reviews += 1;
  }

  const runCosts = [...perRun.values()].map((t) => t.cost);
  const presets = [...group(current, (p) => p.run.preset)].map(([preset, t]) => ({
    preset,
    reviews: t.runs.size,
    tokens: t.tokens,
    cost: t.cost,
    medianCost: median([...t.runs].map((id) => perRun.get(id)!.cost)),
    posted: [...t.runs].filter((id) => outcome.get(id) === "posted").length,
  })).sort(byCost);
  const models = [...group(current, (p) => p.model)].map(([model, t]) => ({ model, tokens: t.tokens, cost: t.cost, calls: t.calls })).sort(byCost);
  const triggers = [...group(current, (p) => p.run.trigger)].map(([trigger, t]) => ({ trigger, reviews: t.runs.size, tokens: t.tokens, cost: t.cost })).sort(byCost);
  const prs = new Map<number, ReturnType<Ctx["store"]["prById"]>>();
  const prOf = (id: number) => (prs.has(id) ? prs.get(id)! : prs.set(id, ctx.store.prById(id)).get(id)!);
  const repos = [...group(current, (p) => prOf(p.run.pr_id)?.repo ?? "unknown")].map(([repo, t]) => ({ repo, reviews: t.runs.size, tokens: t.tokens, cost: t.cost })).sort(byCost);
  const outcomes = USAGE_OUTCOMES.flatMap((kind) => {
    const t = tally();
    for (const p of current) if (outcome.get(p.run.id) === kind) add(t, p);
    return t.runs.size ? [{ outcome: kind, reviews: t.runs.size, tokens: t.tokens, cost: t.cost }] : [];
  });

  const critics = new Map<number, Set<string>>();
  for (const p of current) if (p.critic) critics.set(p.run.id, (critics.get(p.run.id) ?? new Set()).add(p.threadId));
  const reviews = [...perRun].map(([runId, t]) => {
    const run = runs.get(runId)!;
    const pr = prOf(run.pr_id);
    return {
      runId,
      key: pr?.key ?? "",
      display: pr ? shortKey(ctx, pr) : "a PR Shuttle no longer has",
      title: pr?.title ?? "",
      threadId: run.thread_id,
      preset: run.preset,
      trigger: run.trigger,
      at: run.created_at,
      outcome: outcome.get(runId)!,
      tokens: t.tokens,
      cost: t.cost,
      calls: t.calls,
      critics: critics.get(runId)?.size ?? 0,
    };
  }).sort(byCost).slice(0, REVIEWS_SHOWN);

  const started = ctx.store.reviewsSince(from).filter((run) => within(run.created_at));
  const unread = new Set(started.filter((run) => !rows.has(run.thread_id)).map((run) => run.thread_id)).size;
  const measured = new Set(all.map((p) => p.run.id));
  const unmeasured = started.filter((run) => rows.get(run.thread_id)?.started_at === null && !measured.has(run.id)).length;
  const source = sources.get(ctx.store);

  const first = ctx.store.firstReviewAt();

  return {
    range,
    today,
    end: last,
    latest,
    firstDay: first === null ? null : dayOf(first),
    from,
    to,
    source: { state: source?.state ?? "none", message: source?.message ?? null, at: source?.at ?? null, unread },
    totals: { tokens: total.tokens, cost: total.cost, calls: total.calls, reviews: total.runs.size, mix, estimated: current.some((p) => p.estimated) },
    previous: { tokens: before.tokens, cost: before.cost, reviews: before.runs.size },
    perReview: {
      medianTokens: median([...perRun.values()].map((t) => t.tokens)),
      medianCost: median(runCosts),
      p90Cost: percentile(runCosts, 0.9),
    },
    critics: { tokens: critic.tokens, cost: critic.cost, threads: criticThreads.size },
    bucket,
    series: [...series.values()],
    presets,
    models,
    triggers,
    repos,
    outcomes,
    reviews,
    unmeasured,
  };
}
