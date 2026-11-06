// What the engine does with a stored value that does not match its schema: block that one ticket with a post that names
// the column and what is wrong, end its threads, and leave the value as it is, so the rest of the project keeps moving.
// Each value is logged once per process and posted once per ticket.
import { createHash } from "node:crypto";
import type { EngineCtx } from "./ctx";
import type { TicketRow } from "./db/store";
import { canTake, tryMoveTicket } from "./moves";
import { loomPost } from "./posts";
import { LOOM_ACTOR } from "./states";
import { SubStateError, takeNoticed } from "./sub-state";
import { endThread } from "./workers";

const logged = new Set<string>();
const hashOf = (json: string | null) => createHash("sha256").update(json ?? "null").digest("hex").slice(0, 16);

/** Why the ticket is blocked, in the words of its post and its blocked reason. */
export const unreadableText = (error: SubStateError) =>
  `Loom cannot read ${error.key ?? "this ticket"}'s ${error.column}: it ${error.detail.replace(/[.\s]+$/u, "")}. Loom keeps the stored value as it is and blocks the ticket, so the rest of the project keeps moving; the value needs repairing before the ticket can go on.`;

/**
 * Contains a SubStateError on its ticket, and returns whether `error` was one. `busy` says whether the ticket's own merge
 * runs now; a ticket in that state is left to the merge, whose own failure contains it.
 */
export async function containUnreadable(ctx: EngineCtx, error: unknown, busy: (ticket: TicketRow) => boolean = () => false): Promise<boolean> {
  if (!(error instanceof SubStateError)) return false;
  const hash = hashOf(error.json);
  const id = `${error.ticketId ?? error.key}:${error.column}:${hash}`;
  if (!logged.has(id)) {
    logged.add(id);
    ctx.bb.log("warn", error.message);
  }
  const { store } = ctx;
  const ticket = error.ticketId === null ? null : store.ticket(error.ticketId);
  if (ticket === null) return true;
  const posted = store.posts(ticket.id).some((post) => {
    const data = JSON.parse(post.data_json) as { unreadable?: string; hash?: string };
    return data.unreadable === error.column && data.hash === hash;
  });
  const blocks = canTake("block", ticket.state);
  if (!blocks && posted) return true;
  if (blocks && busy(ticket)) return true;
  const reason = unreadableText(error);
  const wasAtWork = ticket.state === "working" || ticket.state === "checking";
  store.tx(() => {
    loomPost(store, ticket, { kind: "block", body: reason, data: { reason, needs: "", unreadable: error.column, hash } });
    if (blocks) tryMoveTicket(store, ticket.id, { name: "block", set: { blocked_reason: reason } }, LOOM_ACTOR, { reason: `its ${error.column} is unreadable` });
  });
  store.changed(ticket.project_id);
  // The move comes first, so the ticket rests and its threads end without reading the value again.
  if (blocks) {
    for (const row of store.threads({ ticketId: ticket.id, states: ["active"] })) {
      await endThread(ctx, row, "blocked", { commit: row.role === "worker" && wasAtWork, move: null });
    }
  }
  ctx.kick();
  return true;
}

/** The engine pass's step: each malformed value a read let through as absent is contained on its ticket. */
export async function containNoticed(ctx: EngineCtx, busy: (ticket: TicketRow) => boolean): Promise<void> {
  for (const error of takeNoticed()) await containUnreadable(ctx, error, busy);
}
