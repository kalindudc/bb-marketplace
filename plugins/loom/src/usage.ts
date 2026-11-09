// What each thread used, in tokens. bb's usage events are added up as each turn ends, about once a minute while the thread
// works, and once more after it ends; a usage command, when the human sets one, runs in the background and can only raise
// a figure.
import type { EngineCtx } from "./ctx";
import type { ThreadRow } from "./db/store";
import type { ThreadUsage } from "./ports";

export const TOKEN_REFRESH_MS = 60_000;
/** An ended thread is read once more this long after its end, after any event its last turn sends late. */
export const SETTLE_MS = 2 * 60_000;
/** Ended threads read in one pass; after an update, every ended thread is read again, a few each pass. */
export const ENDED_READS_PER_PASS = 10;
export const USAGE_COMMAND_TIMEOUT_MS = 30_000;
/** After the usage command fails on a machine, Loom runs it there again only this much later. */
export const USAGE_COMMAND_HOLD_MS = 10 * 60_000;
/** The waits before an ended thread whose last read failed is read again; after the last, Loom keeps what it has. */
export const SETTLE_RETRY_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000];

/**
 * UsageMark, kept in `threads.usage_json`: `sum` is what bb's usage events add up to, and `session`, `seq` and `total` the
 * newest event counted in it. A row from before Loom added events up has only `sum`, its old figure.
 */
export interface UsageMark {
  sum: number;
  session?: string;
  seq?: number;
  total?: number;
}

type Usage = Pick<ThreadRow, "tokens" | "usage_json">;

/** Each engine's reads in flight, background commands and waits; in memory only. */
interface UsageState {
  reads: Map<number, Promise<unknown>>;
  commands: Promise<void>;
  queued: Set<number>;
  hostHeld: Map<string, number>;
  retries: Map<number, { until: number; failures: number }>;
  /** Rows whose failed read was logged, so an outage logs once per thread rather than every minute. */
  warned: Set<number>;
  stopped: boolean;
}

const states = new WeakMap<EngineCtx, UsageState>();
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const markOf = (json: string | null): UsageMark | null => (json === null ? null : (JSON.parse(json) as UsageMark));
const commandOf = (ctx: EngineCtx) => ctx.usageCommand?.() ?? "";

function stateOf(ctx: EngineCtx): UsageState {
  let state = states.get(ctx);
  if (state === undefined) {
    state = { reads: new Map(), commands: Promise.resolve(), queued: new Set(), hostHeld: new Map(), retries: new Map(), warned: new Set(), stopped: false };
    states.set(ctx, state);
  }
  return state;
}

/**
 * The row after a read. bb keeps only a thread's newest usage event, and its total runs per provider session, starting
 * again when the provider process does, so each new event adds what its session used since the last one counted. A total
 * that fell, or grew by less than its own latest call, is a session that started again, so all of it is new. The usage
 * command's figure only ever sits in `tokens`, never in the sum, so the two are never added together. "never-ran" means 0
 * only for a thread that has stopped, since a working thread may still start its first turn.
 */
export function foldedUsage(row: Usage, read: ThreadUsage | null, stopped: boolean): Usage {
  const same = { tokens: row.tokens, usage_json: row.usage_json };
  if (read === null) return same;
  if (read.kind === "never-ran") return stopped ? { tokens: row.tokens ?? 0, usage_json: row.usage_json } : same;
  const mark = markOf(row.usage_json);
  if (mark?.seq !== undefined && read.seq <= mark.seq) return same;
  let sum: number;
  if (mark === null || mark.seq === undefined || mark.total === undefined) sum = Math.max(mark?.sum ?? 0, read.total);
  else {
    const grew = read.total - mark.total;
    sum = mark.sum + (read.session === mark.session && grew >= 0 && grew >= read.last ? grew : read.total);
  }
  const next: UsageMark = { sum, session: read.session, seq: read.seq, total: read.total };
  return { tokens: Math.max(row.tokens ?? 0, sum), usage_json: JSON.stringify(next) };
}

/** Runs `work` after every earlier read of the same row, so one thread's reads fetch and fold in order. */
function serialized<T>(ctx: EngineCtx, rowId: number, work: () => Promise<T>): Promise<T> {
  const { reads } = stateOf(ctx);
  const next = (reads.get(rowId) ?? Promise.resolve()).then(work);
  const tail = next.catch(() => undefined);
  reads.set(rowId, tail);
  void tail.then(() => {
    if (reads.get(rowId) === tail) reads.delete(rowId);
  });
  return next;
}

/** Adds the thread's newest bb usage event to its row; false when bb could not answer. */
export function foldUsage(ctx: EngineCtx, row: ThreadRow): Promise<boolean> {
  if (row.thread_id === null) return Promise.resolve(true);
  const threadId = row.thread_id;
  return serialized(ctx, row.id, async () => {
    const { warned } = stateOf(ctx);
    let read: ThreadUsage | null;
    try {
      read = await ctx.bb.threadUsage(threadId);
    } catch (error) {
      if (!warned.has(row.id)) ctx.bb.log("warn", `Could not read what ${threadId} used: ${errText(error)}`);
      warned.add(row.id);
      return false;
    }
    warned.delete(row.id);
    const fresh = ctx.store.thread(row.id) ?? row;
    ctx.store.updateThread(row.id, foldedUsage(fresh, read, fresh.state === "ending" || fresh.state === "ended"));
    return true;
  });
}

/** The usage command's answer: `ok` false when it failed or waits out a failure; `tokens` null when it does not know. */
async function commandTokens(ctx: EngineCtx, row: ThreadRow & { thread_id: string }): Promise<{ ok: boolean; tokens: number | null }> {
  const command = commandOf(ctx);
  const project = ctx.store.project(row.project_id);
  if (command === "" || project === null || project.host_id === null) return { ok: true, tokens: null };
  const hostId = project.host_id;
  const { hostHeld } = stateOf(ctx);
  if (ctx.now() < (hostHeld.get(hostId) ?? 0)) return { ok: false, tokens: null };
  const failed = (why: string) => {
    hostHeld.set(hostId, ctx.now() + USAGE_COMMAND_HOLD_MS);
    ctx.bb.log("warn", `The usage command failed for ${row.thread_id}, so Loom runs it on ${hostId} again in 10 minutes: ${why}`);
    return { ok: false, tokens: null };
  };
  try {
    const repo = await ctx.bb.projectCheckout(project.bb_project_id, hostId);
    if (repo === null) return { ok: true, tokens: null };
    const env = { LOOM_THREAD_ID: row.thread_id, LOOM_PROJECT_SLUG: project.slug };
    const result = await ctx.host.call(hostId, "exec", { cwd: repo, command, timeoutMs: USAGE_COMMAND_TIMEOUT_MS, env });
    if (result.timedOut) return failed("it timed out after 30 seconds");
    if (result.exitCode !== 0) return failed(result.exitCode === null ? "it was killed" : `it exited with ${result.exitCode}`);
    // The output holds stderr too, so a warning may follow the figure: the last line that is a whole number is the answer.
    const lines = result.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const figure = [...lines].reverse().find((line) => /^\d{1,15}$/u.test(line));
    if (figure !== undefined) return { ok: true, tokens: Number(figure) };
    return lines.length === 0 ? { ok: true, tokens: null } : failed(`it printed no whole number: ${lines.at(-1)!.slice(0, 80)}`);
  } catch (error) {
    return failed(errText(error));
  }
}

/** An ended thread is read again after a wait; after the last wait, Loom keeps what it has. */
function retryLater(ctx: EngineCtx, rowId: number, why: string): void {
  const { retries } = stateOf(ctx);
  const failures = (retries.get(rowId)?.failures ?? 0) + 1;
  if (failures > SETTLE_RETRY_MS.length) {
    ctx.bb.log("warn", `Loom keeps the tokens it has for thread row ${rowId}: ${why}, ${failures} times.`);
    settle(ctx, rowId);
    return;
  }
  retries.set(rowId, { until: ctx.now() + SETTLE_RETRY_MS[failures - 1]!, failures });
}

function settle(ctx: EngineCtx, rowId: number): void {
  stateOf(ctx).retries.delete(rowId);
  ctx.store.updateThread(rowId, { tokens_at: ctx.now() });
}

/**
 * Queues one run of the usage command for the row, one run at a time in the background, so a slow command never holds up
 * the engine. A row already queued is not queued again. With `settleAfter`, the run settles the ended row, or has it read
 * again later when the command failed or waited out a failure.
 */
function queueCommand(ctx: EngineCtx, rowId: number, settleAfter: boolean): void {
  const state = stateOf(ctx);
  if (state.queued.has(rowId)) return;
  state.queued.add(rowId);
  state.commands = state.commands.then(async () => {
    try {
      const row = state.stopped ? null : ctx.store.thread(rowId);
      if (row === null || row.thread_id === null) return;
      const answer = await commandTokens(ctx, { ...row, thread_id: row.thread_id });
      if (state.stopped) return;
      const fresh = ctx.store.thread(rowId);
      if (answer.tokens !== null && fresh !== null && answer.tokens > (fresh.tokens ?? -1)) ctx.store.updateThread(rowId, { tokens: answer.tokens });
      if (settleAfter) {
        if (answer.ok) settle(ctx, rowId);
        else retryLater(ctx, rowId, "the usage command did not answer");
      }
    } catch (error) {
      if (!state.stopped) ctx.bb.log("warn", `Could not run the usage command for thread row ${rowId}: ${errText(error)}`);
    } finally {
      state.queued.delete(rowId);
    }
  });
}

/** Resolves once every usage command queued so far has run. */
export const usageCommandsDone = (ctx: EngineCtx): Promise<void> => stateOf(ctx).commands;

/** Stops the background usage commands, for the engine's disposal. */
export function stopUsage(ctx: EngineCtx): void {
  stateOf(ctx).stopped = true;
}

/** The project's working threads not read in the last minute. */
export async function refreshUsage(ctx: EngineCtx, projectId: number): Promise<void> {
  for (const row of ctx.store.threads({ projectId, states: ["active"] })) {
    if (row.tokens_at !== null && ctx.now() - row.tokens_at <= TOKEN_REFRESH_MS) continue;
    await foldUsage(ctx, row);
    ctx.store.updateThread(row.id, { tokens_at: ctx.now() });
    if (commandOf(ctx) !== "") queueCommand(ctx, row.id, false);
  }
}

/**
 * Reads, in every project, a few threads that ended at least SETTLE_MS ago and were not settled since, newest first. A
 * thread waiting for its command, or for a retry after a failed read, is left for a later pass.
 */
export async function readEndedUsage(ctx: EngineCtx): Promise<void> {
  const state = stateOf(ctx);
  const now = ctx.now();
  const waiting = [...state.queued, ...[...state.retries].filter(([, retry]) => retry.until > now).map(([id]) => id)];
  for (const row of ctx.store.threadsToReadUsage(now - SETTLE_MS, SETTLE_MS, ENDED_READS_PER_PASS, waiting)) {
    if (!(await foldUsage(ctx, row))) retryLater(ctx, row.id, "bb did not answer");
    else if (commandOf(ctx) === "") settle(ctx, row.id);
    else queueCommand(ctx, row.id, true);
  }
}

/** Threads bb started that said nothing about their tokens after a minute or by their end; a row with no thread used nothing. */
export function unreportedThreads(threads: readonly ThreadRow[], now: number): number {
  return threads.filter((thread) => thread.thread_id !== null && thread.tokens === null && (thread.state === "ended" || now - thread.started_at >= TOKEN_REFRESH_MS)).length;
}
