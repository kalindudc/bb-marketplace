// Which of a project's pull requests stay drafts. With merge.draft, Loom opens each one as a draft; a ticket that sets
// keep_draft stays one until the human releases it, and Loom marks every other one ready for review, once per pull
// request: right after it opens when no after_open command may do it, else at the first read that still finds a draft.
// A stacked pull request waits until it targets its repo's base. Loom never makes a pull request a draft again, and never
// marks a held one ready by itself. The planner can only ask the human to release one.
import type { EventRow, ProjectRow, Store, TicketRow } from "./db/store";
import { repoCheckout, type RepoCheckout } from "./checkouts";
import { hostCallTransient } from "./forge-waits";
import type { HostOutput } from "./host-contract";
import { writeSub } from "./sub-state";
import { metaOf } from "./pr-meta";
import { LoomError } from "./projects";
import { canReady, repoSettings } from "./repos";
import type { Spec } from "./spec";
import { HUMAN_ACTOR, LOOM_ACTOR } from "./states";
import { specOf, type EngineCtx } from "./workers";

/** Loom marked the pull request at `url` ready for review, or tried and was refused; it never tries again for that pull request. */
export const MARKED_READY = "ticket.pr_marked_ready";
/** The human released a held draft. */
export const DRAFT_RELEASED = "ticket.draft_released";
/** The planner asked the human to release a held draft; it releases nothing. */
export const RELEASE_REQUESTED = "ticket.release_requested";

const parse = (event: EventRow) => JSON.parse(event.data_json) as Record<string, unknown>;
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How a draft pull request shows: "held" while the human holds it, "marking" while Loom is to mark it ready; null when it is not a draft, or Loom does not say. */
export type DraftState = "held" | "marking" | null;

/** From the ticket row alone, so the board and the Merge order tab can say it: a draft the last read saw, held or not. */
export function draftStateOf(ticket: Pick<TicketRow, "state" | "pr_url" | "keep_draft" | "pr_meta_json">): DraftState {
  if (ticket.state !== "pr_open" || ticket.pr_url === null) return null;
  if (ticket.keep_draft === 1) return "held";
  return metaOf(ticket)?.draft === true ? "marking" : null;
}

/** The planner's open request that the human release the held draft of the ticket's pull request now; null when there is none. */
export function releaseRequestOf(store: Store, ticket: TicketRow): { at: number; note: string } | null {
  if (ticket.keep_draft !== 1 || ticket.pr_url === null) return null;
  const event = store.ticketEvents(ticket.id, [RELEASE_REQUESTED]).filter((each) => parse(each).url === ticket.pr_url).at(-1);
  return event === undefined ? null : { at: event.at, note: String(parse(event).note ?? "") };
}

const markedFor = (store: Store, ticket: TicketRow) => store.ticketEvents(ticket.id, [MARKED_READY]).some((event) => parse(event).url === ticket.pr_url);

function addPost(ctx: EngineCtx, ticket: TicketRow, body: string, data: object): void {
  ctx.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "merge", body, data_json: JSON.stringify(data) });
  ctx.store.changed(ticket.project_id);
}

/** The forge call that marks `url` ready, through a checkout looked up before it. */
async function dispatchReady(ctx: EngineCtx, checkout: RepoCheckout, url: string): Promise<HostOutput<"prReady">> {
  const { forge } = checkout.settings;
  try {
    return await ctx.host.call(checkout.hostId, "prReady", { repo: checkout.path, url, forge: forge.kind === "command" ? { kind: "command", ready: forge.ready! } : { kind: "gh" } });
  } catch (error) {
    return { outcome: "unavailable", message: errText(error), ...hostCallTransient(error) };
  }
}

/** The stored read says the pull request is no draft any more, so this pass's reviewer request and merge see it so. */
function notDraft(ctx: EngineCtx, ticket: TicketRow): void {
  const meta = metaOf(ticket);
  if (meta !== null) ctx.store.updateTicket(ticket.id, writeSub("pr_meta_json", { ...meta, draft: false }));
}

// The tickets whose pull request this process is marking ready or releasing now, claimed in the same synchronous stretch
// as the checks that allow it, so the opening, a read and a release never dispatch two for one pull request.
const marking = new WeakMap<Store, Set<number>>();
const markingOf = (store: Store) => marking.get(store) ?? marking.set(store, new Set()).get(store)!;

/** The after_open commands of the pull request at `url` started, with how many there are; and that they all ended, ran or failed. */
export const AFTER_OPEN_STARTED = "ticket.after_open_started";
export const AFTER_OPEN_ENDED = "ticket.after_open_ended";
/** How long one after_open command may run; a run a restart cut short counts as over once its commands' time is up. */
export const AFTER_OPEN_MS = 5 * 60_000;

/**
 * Whether the pull request's after_open commands are over, so they cannot mark it ready, or anything else, while Loom does:
 * none started for it (none are set, or it opened before Loom kept this), they ended, or their time is up, as after a
 * restart that lost the run.
 */
export function afterOpenOver(store: Store, ticket: TicketRow, now: number): boolean {
  const started = store.ticketEvents(ticket.id, [AFTER_OPEN_STARTED]).filter((event) => parse(event).url === ticket.pr_url).at(-1);
  if (started === undefined) return true;
  if (store.ticketEvents(ticket.id, [AFTER_OPEN_ENDED]).some((event) => parse(event).url === ticket.pr_url && event.id > started.id)) return true;
  return now - started.at >= Number(parse(started).commands ?? 1) * AFTER_OPEN_MS + 60_000;
}

/** Why Loom may not mark the ticket's pull request at `url` ready now, from the store alone; null when it may. */
function mayNotMark(ctx: EngineCtx, spec: Spec, ticket: TicketRow | null, url: string, sha: string | null, base: string | null): string | null {
  if (ticket === null || ticket.state !== "pr_open" || ticket.pr_url !== url || ticket.pushed_sha !== sha) return "the ticket's pull request changed";
  if (ticket.keep_draft === 1) return "the human holds it as a draft";
  const settings = repoSettings(spec, ticket.repo);
  if ((base ?? ticket.pr_base ?? settings.base) !== settings.base) return "it does not target its base";
  if (!canReady(settings.forge)) return "its forge cannot mark it ready";
  if (markedFor(ctx.store, ticket)) return "Loom marked it ready already";
  if (!afterOpenOver(ctx.store, ticket, ctx.now())) return "its after_open commands are still running";
  return null;
}

/**
 * Marks the ticket's draft pull request ready for review, once, unless the human holds it, it does not target its base,
 * or its after_open commands are still running. `draft`: whether it is a draft now, from a read or because Loom just
 * opened it as one. The ticket is claimed before the first await and judged again, from the store, right before the
 * forge is called and when its answer comes, so a hold added or a pull request replaced meanwhile stops it. Returns
 * whether it is no draft now, for the read that called it. A temporary failure is tried again at a later read; any other
 * is posted once, and the pull request stays a draft for the human.
 */
export async function followDraft(ctx: EngineCtx, project: ProjectRow, ticketId: number, draft: boolean | null, base: string | null): Promise<boolean> {
  const { store } = ctx;
  const seen = store.ticket(ticketId);
  if (draft !== true || seen === null || seen.pr_url === null) return false;
  const spec = specOf(store, project);
  const url = seen.pr_url;
  const sha = seen.pushed_sha;
  const claims = markingOf(store);
  if (claims.has(ticketId) || mayNotMark(ctx, spec, seen, url, sha, base) !== null) return false;
  claims.add(ticketId);
  try {
    const checkout = await repoCheckout(ctx, project, spec, seen.repo);
    if (mayNotMark(ctx, spec, store.ticket(ticketId), url, sha, base) !== null) return false;
    const answer = await dispatchReady(ctx, checkout, url);
    const now = store.ticket(ticketId);
    // The answer is about `url`; a ticket whose pull request is another one now records nothing for it.
    if (now === null || now.pr_url !== url) return false;
    if (answer.outcome === "ok") {
      store.event(project.id, ticketId, MARKED_READY, LOOM_ACTOR, { url });
      notDraft(ctx, now);
      const held = now.keep_draft === 1 ? " The human held it as a draft while Loom did so, so it is ready for review now anyway; make it a draft again on the forge if it must wait." : "";
      addPost(ctx, now, `Marked ${url} ready for review: the ticket does not keep its pull request a draft.${held}`, { outcome: "pr_marked_ready", url });
      return true;
    }
    if (answer.transient !== undefined) {
      ctx.bb.log("warn", `Marking ${url} ready for review failed with what looks like a temporary error; Loom tries again at its next read: ${answer.message}`);
      return false;
    }
    store.event(project.id, ticketId, MARKED_READY, LOOM_ACTOR, { url, failed: true });
    addPost(ctx, now, `Loom could not mark ${url} ready for review: ${answer.message}. It stays a draft until someone marks it ready on the forge.`, { outcome: "pr_not_marked_ready", url });
    return false;
  } finally {
    claims.delete(ticketId);
  }
}

function heldTicket(store: Store, key: string): { project: ProjectRow; ticket: TicketRow } {
  const ticket = store.ticketByKey(key);
  if (ticket === null) throw new LoomError("loom_not_found", `No ticket ${key}.`);
  if (ticket.keep_draft !== 1) throw new LoomError("loom_invalid_state", `${key} is not held as a draft, so there is nothing to release.`);
  if (ticket.state !== "pr_open" || ticket.pr_url === null) throw new LoomError("loom_invalid_state", `${key} has no open pull request yet; it opens as a draft and waits for you to release it then.`);
  return { project: store.project(ticket.project_id)!, ticket };
}

/**
 * The human's release of a held draft: Loom marks the pull request ready for review now, through the forge, and stops
 * holding the ticket. Refused for a ticket that is not held or has no open pull request, and when the forge cannot mark
 * it ready, so the hold stays as it is. The ticket is claimed before the first await, and the hold is cleared only when
 * it is still held, on the same pull request, once the forge answers.
 */
export async function releaseDraft(ctx: EngineCtx, key: string): Promise<string> {
  const { store } = ctx;
  const { project, ticket } = heldTicket(store, key);
  const spec = specOf(store, project);
  const url = ticket.pr_url!;
  if (!canReady(repoSettings(spec, ticket.repo).forge)) throw new LoomError("loom_invalid_state", `${key}'s forge has no ready command, so Loom cannot mark its pull request ready. Mark ${url} ready on the forge, then release it here to stop holding it.`);
  const claims = markingOf(store);
  if (claims.has(ticket.id)) throw new LoomError("loom_unavailable", `Loom is marking ${url} ready or releasing it right now; try again in a moment.`);
  claims.add(ticket.id);
  const stillHeld = () => {
    const now = store.ticket(ticket.id);
    return now !== null && now.state === "pr_open" && now.keep_draft === 1 && now.pr_url === url;
  };
  const changed = () => new LoomError("loom_invalid_state", `${key}'s pull request changed while Loom released it: it is ${store.ticket(ticket.id)?.pr_url ?? "gone"} now, not ${url}. Nothing about its hold changed; look at it and release it again if you want.`);
  try {
    const checkout = await repoCheckout(ctx, project, spec, ticket.repo);
    if (!stillHeld()) throw changed();
    const answer = await dispatchReady(ctx, checkout, url);
    if (answer.outcome !== "ok") throw new LoomError("loom_unavailable", `Loom could not mark ${url} ready for review: ${answer.message}. ${key} stays held; release it again.`);
    if (!stillHeld()) throw changed();
    store.tx(() => {
      store.updateTicket(ticket.id, { keep_draft: 0 });
      store.event(project.id, ticket.id, DRAFT_RELEASED, HUMAN_ACTOR, { url });
      store.event(project.id, ticket.id, MARKED_READY, HUMAN_ACTOR, { url });
      notDraft(ctx, store.ticket(ticket.id)!);
    });
  } finally {
    claims.delete(ticket.id);
  }
  addPost(ctx, ticket, `Released ${url} from draft: it is ready for review, and Loom asks for reviewers at its next read.`, { outcome: "draft_released", url });
  return `Released ${url} from draft; it is ready for review now.`;
}

/** The planner's loom_release_draft: records that it asks the human to release the held draft. It releases nothing. */
export function requestRelease(store: Store, key: string, threadId: string, note: string): string {
  const { project, ticket } = heldTicket(store, key);
  const asked = `Asked the human to release ${key}'s draft pull request. It stays a draft until they release it, on the ticket, its board card or the Planner page.`;
  if (releaseRequestOf(store, ticket) !== null) return asked;
  store.event(project.id, ticket.id, RELEASE_REQUESTED, threadId, { url: ticket.pr_url, note: note.slice(0, 2000) });
  store.addPost({
    project_id: project.id,
    ticket_id: ticket.id,
    parent_id: null,
    author_kind: "planner",
    author_thread_id: threadId,
    kind: "merge",
    body: `The planner asks you to release ${ticket.pr_url} from draft: "${note.slice(0, 500)}". It stays a draft until you release it.`,
    data_json: JSON.stringify({ outcome: "release_requested", url: ticket.pr_url }),
  });
  store.changed(project.id);
  return asked;
}
