// Worker slots for work that goes back to a worker. agents.max_workers bounds the worker threads that run at once, so
// a fix round, a review's changes or a merge that did not land moves its ticket to working with the message stored
// (HandBack), and the message goes out only once a worker slot is free. Waiting hand-backs take free slots before new
// workers start, priority 0 first, then the longest waiting. A worker or reviewer that waits for the human holds no slot.
import { delivers } from "./checks";
import type { Store, ThreadRow, TicketRow } from "./db/store";
import { plural } from "./format";
import { advanceWake, isReleased, isWaking, wakeRow } from "./release";
import { NOT_PARKED, freeReviewerSlots, freeWorkerSlots, handBackOf, slotTurns, toLite, type HandBack, type Parked, type WorkerMessage } from "./scheduler";
import type { Spec } from "./spec";
import { startWaits } from "./starts";
import { specOf, toWorking, type EngineCtx } from "./workers";

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Moves the ticket to working for its worker and stores the message, waiting for a worker slot. Runs inside the caller's
 * transaction; deliverHandBacks gives it a slot and sends it. `row` is the live worker row, or null for a released one.
 */
export function handBack(ctx: EngineCtx, ticket: TicketRow, row: ThreadRow | null, thread: string, text: WorkerMessage, data: object = {}): void {
  toWorking(ctx, ticket, row, data);
  ctx.store.updateTicket(ticket.id, { handback_json: JSON.stringify({ thread, text, waiting: ctx.now() } satisfies HandBack) });
}

/**
 * The tick's step, and the step that follows each handBack at once: gives the free worker slots to the waiting hand-backs,
 * starts the worker's timeout clock again, brings a released worker back, and sends every hand-back that has a slot. One
 * still waiting says so on its ticket once. `parked` comes from the tick; without it a worker waiting for the human still
 * counts, so a hand-back never takes a slot the tick would not give it.
 */
export async function deliverHandBacks(ctx: EngineCtx, projectId: number, parked: Parked = NOT_PARKED): Promise<void> {
  const { store } = ctx;
  if (store.project(projectId)?.state !== "running") return;
  const { waking, changed } = store.tx(() => grantSlots(ctx, projectId, parked));
  if (changed) store.changed(projectId);
  for (const row of waking) await advanceWake(ctx, row);
  for (const ticket of store.tickets(projectId)) if (ticket.handback_json !== null) await deliver(ctx, ticket);
}

function grantSlots(ctx: EngineCtx, projectId: number, parked: Parked): { waking: ThreadRow[]; changed: boolean } {
  const { store } = ctx;
  const spec = specOf(store, store.project(projectId)!);
  const tickets = store.tickets(projectId);
  const turns = new Set(slotTurns(spec.agents.max_workers, tickets.map(toLite), parked.workers).map((lite) => lite.id));
  const waking: ThreadRow[] = [];
  let changed = false;
  for (const ticket of tickets) {
    const pending = handBackOf(ticket);
    if (pending?.waiting === undefined || ticket.state !== "working") continue;
    if (!turns.has(ticket.id)) {
      if (pending.noticed !== true) {
        notice(ctx, ticket, pending, spec);
        changed = true;
      }
      continue;
    }
    changed = true;
    store.updateTicket(ticket.id, { handback_json: JSON.stringify({ thread: pending.thread, text: pending.text } satisfies HandBack) });
    const row = store.threadByThreadId(pending.thread);
    if (row?.state === "active") store.updateThread(row.id, { clock_at: ctx.now(), idle_count: 0 });
    // A released worker whose restore failed comes back once its wait is over (advanceWakes), holding the slot meanwhile.
    else if (isReleased(row) && !startWaits(ticket, "worker", ctx.now())) waking.push(wakeRow(ctx, row));
  }
  return { waking, changed };
}

function notice(ctx: EngineCtx, ticket: TicketRow, pending: HandBack, spec: Spec): void {
  const max = spec.agents.max_workers;
  const body = `${ticket.key} waits for a worker slot: the project runs at most ${plural(max, "worker")} at once, and ${max === 1 ? "it is" : "all are"} busy. Its worker gets this as soon as a slot is free.`;
  ctx.store.updateTicket(ticket.id, { handback_json: JSON.stringify({ ...pending, noticed: true } satisfies HandBack) });
  ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "system", body, data_json: JSON.stringify({ slotWait: true }) });
}

// The tick and a step that just handed work back can deliver at the same time; one send per ticket is in flight.
const sendingNow = new WeakMap<Store, Set<number>>();
const sendingOf = (store: Store) => sendingNow.get(store) ?? sendingNow.set(store, new Set()).get(store)!;

/** Sends a ticket's hand-back once it has a slot; it stays stored, for the next tick, until bb takes it. */
async function deliver(ctx: EngineCtx, ticket: TicketRow): Promise<void> {
  const pending = handBackOf(ticket);
  if (pending === null) return;
  if (ticket.state !== "working" || ticket.worker_thread_id !== pending.thread) {
    ctx.store.updateTicket(ticket.id, { handback_json: null });
    return;
  }
  if (pending.waiting !== undefined || !delivers(ctx, ticket.project_id)) return;
  // A worker coming back from a release reads it once its environment is back.
  const row = ctx.store.threadByThreadId(pending.thread);
  if (isWaking(row) || isReleased(row)) return;
  const sending = sendingOf(ctx.store);
  if (sending.has(ticket.id)) return;
  sending.add(ticket.id);
  try {
    await ctx.bb.send(pending.thread, pending.text);
  } catch (error) {
    ctx.bb.log("warn", `Could not send ${ticket.key}'s work to ${pending.thread}; Loom tries again: ${errText(error)}`);
    return;
  } finally {
    sending.delete(ticket.id);
  }
  if (ctx.store.ticket(ticket.id)?.handback_json === ticket.handback_json) ctx.store.updateTicket(ticket.id, { handback_json: null });
}

/**
 * Keeps a message for a worker whose hand-back is not sent yet with that hand-back, so it neither starts a turn without a
 * slot nor arrives before the work it is about. False when the working ticket has no hand-back, so the caller sends it now.
 */
export function holdForWorker(store: Store, seen: TicketRow, message: WorkerMessage): boolean {
  const ticket = store.ticket(seen.id);
  const pending = ticket?.state === "working" ? handBackOf(ticket) : null;
  if (ticket === null || pending === null) return false;
  const first = typeof pending.text === "string" ? { summary: pending.text, detail: "" } : pending.text;
  const more = typeof message === "string" ? message : `${message.summary}\n${message.detail}`;
  const text = { summary: first.summary, detail: first.detail === "" ? more : `${first.detail}\n\n${more}` };
  store.updateTicket(ticket.id, { handback_json: JSON.stringify({ ...pending, text } satisfies HandBack) });
  return true;
}

/**
 * The project's workers and reviewers that wait for the human (a pending question or approval), which hold no slot. bb is
 * asked only while every slot of a role is held and work waits for one.
 */
export async function parkedThreads(ctx: EngineCtx, projectId: number, spec: Spec): Promise<Parked> {
  const { store, bb } = ctx;
  const tickets = store.tickets(projectId);
  const lites = tickets.map(toLite);
  const asks = spec.merge.strategy === "pr";
  const wantsWorker = lites.some((lite) => lite.waitsSince !== null || lite.state === "queued" || (asks && lite.state === "approved" && !lite.holds));
  const workers = wantsWorker && freeWorkerSlots(spec.agents.max_workers, lites) === 0 ? tickets.filter((ticket, index) => lites[index]!.holds && ticket.worker_thread_id !== null) : [];
  const rows = store.threads({ projectId, role: "reviewer", states: ["spawning", "active"] });
  const wantsReviewer = tickets.some((ticket) => ticket.state === "review");
  const reviewers = wantsReviewer && freeReviewerSlots(spec.agents.max_reviewers, rows) === 0 ? rows.filter((row) => row.state === "active" && row.thread_id !== null) : [];
  const ids = [...workers.map((ticket) => ticket.worker_thread_id!), ...reviewers.map((row) => row.thread_id!)];
  if (ids.length === 0) return NOT_PARKED;
  let waiting: Set<string>;
  try {
    waiting = new Set(await bb.waitingOnUser(ids));
  } catch (error) {
    bb.log("warn", `Could not tell which Loom threads wait for the human, so they keep their slots: ${errText(error)}`);
    return NOT_PARKED;
  }
  return {
    workers: new Set(workers.filter((ticket) => waiting.has(ticket.worker_thread_id!)).map((ticket) => ticket.id)),
    reviewers: new Set(reviewers.filter((row) => waiting.has(row.thread_id!)).map((row) => row.id)),
  };
}
