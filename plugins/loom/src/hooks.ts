// The spec's [[hook]] tables: when a project event happens, Loom tells the planner what a hook says. Loom only delivers
// them, once each, from the project's events; they move no ticket and block nothing, and a failure is an event in the feed.
import type { EventRow, HookFiringRow, ProjectRow, Store } from "./db/store";
import { clip, hookTellText, type HookFacts } from "./prompts";
import { readSpec, type HookEvent, type HookSpec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { type EngineCtx } from "./ctx";

/** How many sends to the planner a tell gets before it fails. */
export const HOOK_TELL_TRIES = 3;
const EVENT_BATCH = 500;
const REASON_MAX = 600;

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
const dataOf = (event: EventRow) => JSON.parse(event.data_json) as Record<string, unknown>;

type Occurrence = { on: HookEvent; ticketId: number | null; facts: HookFacts };

/**
 * The hook event an event is, or null. A ticket starts once, at its first claim; a pull request opens once per URL;
 * a ticket blocks each time it moves to blocked.
 */
function occurrenceOf(store: Store, event: EventRow): Occurrence | null {
  const data = dataOf(event);
  switch (event.kind) {
    case "spec.approved": {
      const version = typeof data.version === "number" ? data.version : undefined;
      const what = `The human approved spec version ${version ?? "?"}${data.pending === true ? ", a change to the approved project" : ""}.`;
      return { on: "spec.approved", ticketId: null, facts: { what, ...(version === undefined ? {} : { version }) } };
    }
    case "project.state":
      if (data.from === "ready" && data.to === "running") return { on: "project.started", ticketId: null, facts: { what: "The human started the project." } };
      if (data.to === "done") return { on: "project.done", ticketId: null, facts: { what: "Every ticket is done or cancelled, so the project is done." } };
      return null;
    case "project.landed": {
      const url = text(data.url);
      if (data.created !== true || url === undefined) return null;
      const repo = text(data.repo);
      return { on: "pr.opened", ticketId: null, facts: { what: `Loom opened the pull request ${url} that lands the integration branch${repo === undefined ? "" : ` of the repo ${JSON.stringify(repo)}`}.`, url, ...(repo === undefined ? {} : { repo }) } };
    }
    case "ticket.state": {
      const ticket = event.ticket_id === null ? null : store.ticket(event.ticket_id);
      if (ticket === null) return null;
      const name = `${ticket.key} ${JSON.stringify(ticket.title)}`;
      const facts = { key: ticket.key, title: ticket.title, ...(ticket.repo === null ? {} : { repo: ticket.repo }) };
      const earlier = (match: (data: Record<string, unknown>) => boolean) =>
        store.ticketEvents(ticket.id, ["ticket.state"]).some((other) => other.id < event.id && match(dataOf(other)));
      if (data.from === "queued" && data.to === "working") {
        if (earlier((other) => other.from === "queued" && other.to === "working")) return null;
        return { on: "ticket.started", ticketId: ticket.id, facts: { ...facts, what: `A worker started on ${name}.` } };
      }
      const url = text(data.url);
      if (data.to === "pr_open" && data.opened === true && url !== undefined) {
        if (earlier((other) => other.to === "pr_open" && other.opened === true && other.url === url)) return null;
        return { on: "pr.opened", ticketId: ticket.id, facts: { ...facts, url, what: `Loom opened the pull request ${url} for ${name}.` } };
      }
      if (data.to === "blocked") {
        const reason = blockReason(store, ticket.id, event, data);
        return { on: "ticket.blocked", ticketId: ticket.id, facts: { ...facts, what: `${name} is blocked${reason === undefined ? "." : `: ${reason}`}`, ...(reason === undefined ? {} : { reason }) } };
      }
      if (data.to === "done") {
        const pr = ticket.pr_url ?? undefined;
        return { on: "ticket.done", ticketId: ticket.id, facts: { ...facts, what: `${name} is done${pr === undefined ? "." : `: its pull request ${pr} merged.`}`, ...(pr === undefined ? {} : { url: pr }) } };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Why a ticket blocked, from what was written when it did, never from the ticket as it is now, which a requeue clears.
 * A block that moves with the bare reason "blocked" (the worker's own, or Loom's after its checks or reviewers) wrote
 * its words in a block post just before the move, after the ticket's state before it.
 */
function blockReason(store: Store, ticketId: number, event: EventRow, data: Record<string, unknown>): string | undefined {
  const own = text(data.reason);
  if (own !== undefined && own !== "blocked") return clip(own, REASON_MAX);
  const before = store.ticketEvents(ticketId, ["ticket.state"]).filter((other) => other.id < event.id).at(-1)?.id ?? 0;
  const post = store
    .ticketEvents(ticketId, ["post.added"])
    .filter((other) => other.id > before && other.id < event.id && dataOf(other).kind === "block")
    .at(-1);
  if (post === undefined) return undefined;
  const id = dataOf(post).post;
  const body = store.posts(ticketId).find((row) => row.id === id)?.body;
  return body === undefined || body.trim() === "" ? undefined : clip(body.trim(), REASON_MAX);
}

/** The [[hook]] tables of spec version `version`, read once per pass; none before the first approval. */
function hooksOf(store: Store, project: ProjectRow, version: number | null, cache: Map<number, HookSpec[]>): HookSpec[] {
  if (version === null) return [];
  let hooks = cache.get(version);
  if (hooks === undefined) {
    const row = store.specVersion(project.id, version);
    hooks = row === null ? [] : ((readSpec(row.spec_json, store)).hook ?? []);
    cache.set(version, hooks);
  }
  return hooks;
}

const approvedVersion = (event: EventRow | null): number | null => {
  const version = event === null ? undefined : dataOf(event).version;
  return typeof version === "number" ? version : null;
};

/**
 * Queues the hooks of the project's events since its cursor and moves the cursor past them in the same transaction, so
 * each event queues each hook once. Each event follows the hooks of the version in force when it happened: the one the
 * newest spec.approved at or before it approved, so a version's own approval follows its hooks and an event from before
 * it does not. A draft waits: its approval is the first event a hook can follow. An archived project queues nothing more.
 */
function queueHooks(ctx: EngineCtx, project: ProjectRow): void {
  const { store } = ctx;
  if (project.state === "draft") return;
  const cache = new Map<number, HookSpec[]>();
  let after = project.hook_event_id;
  let version = approvedVersion(store.lastEventOfKind(project.id, "spec.approved", after));
  for (;;) {
    const events = store.events(project.id, after, EVENT_BATCH);
    if (events.length === 0) return;
    const archived = store.project(project.id)!.state === "archived";
    const last = events.at(-1)!.id;
    store.tx(() => {
      for (const event of events) {
        if (event.kind === "spec.approved") version = approvedVersion(event) ?? version;
        const hooks = archived ? [] : hooksOf(store, project, version, cache);
        if (hooks.length === 0) continue;
        const occurrence = occurrenceOf(store, event);
        if (occurrence === null) continue;
        hooks.forEach((hook, index) => {
          if (hook.on !== occurrence.on) return;
          // A version stored before hook.run was retired may hold a hook with run and no tell; Loom runs no command for it.
          const tell: string | undefined = hook.tell;
          if (tell === undefined) {
            ctx.bb.log("warn", `Skipped hook[${index}] of project ${project.slug} on ${hook.on}: it has only run, a key Loom no longer reads, and no tell.`);
            return;
          }
          const base = { project_id: project.id, event_id: event.id, hook: index, hook_on: hook.on, ticket_id: occurrence.ticketId, facts_json: JSON.stringify(occurrence.facts) };
          if ((hook.to ?? "planner") === "planner") store.addHookFiring({ ...base, kind: "tell", text: tell });
        });
      }
      store.setHookCursor(project.id, last);
    });
    after = last;
    if (events.length < EVENT_BATCH) return;
  }
}

/** Ends a firing that is still in the state it was read in, with its event; one another path already ended stays as it is. */
function settle(ctx: EngineCtx, row: HookFiringRow, outcome: { state: "done" | "failed" | "skipped"; reason?: string }): void {
  const { store } = ctx;
  const facts = JSON.parse(row.facts_json) as HookFacts;
  store.tx(() => {
    if (!store.moveHookFiring(row.id, row.state, { state: outcome.state, reason: outcome.reason ?? null })) return;
    if (outcome.state === "skipped") return;
    const data = { hook: row.hook, on: row.hook_on, kind: row.kind, ...(facts.key === undefined ? {} : { key: facts.key }), ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) };
    if (outcome.state === "failed") store.event(row.project_id, null, "hook.failed", LOOM_ACTOR, data);
  });
}

// ---------------------------------------------------------------- tell

/**
 * Sends each project's planner its queued tells in one message, once its thread is idle, as a triage round waits. The
 * rows move to running before the send, so a tell an earlier process was sending when it stopped fails and is not sent
 * again. A send that fails goes back to the queue for the next pass, HOOK_TELL_TRIES sends in all, and then fails; a
 * project with no planner thread left fails them at once.
 */
async function tellPlanners(ctx: EngineCtx): Promise<void> {
  const { store } = ctx;
  // The pass is serialized and waits for every send, so a tell running now was left by an earlier process.
  for (const row of store.hookFirings(null, ["running"], "tell")) settle(ctx, row, { state: "failed", reason: "Loom restarted while it told the planner, so it does not tell it again" });
  const byProject = new Map<number, HookFiringRow[]>();
  for (const row of store.hookFirings(null, ["pending"], "tell")) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
  for (const [projectId, rows] of byProject) {
    const project = store.project(projectId);
    if (project === null || project.state === "archived") {
      for (const row of rows) settle(ctx, row, { state: "skipped", reason: "the project was archived" });
      continue;
    }
    const planner = store.threads({ projectId, role: "planner", states: ["active"] })[0];
    const thread = planner?.thread_id == null ? null : await ctx.bb.getThread(planner.thread_id);
    if (planner?.thread_id == null || thread === null || thread.archivedAt !== null || thread.deletedAt !== null) {
      for (const row of rows) settle(ctx, row, { state: "failed", reason: "the project has no planner thread to tell" });
      continue;
    }
    if (thread.status !== "idle") continue;
    const claimed = store.tx(() => rows.filter((row) => store.moveHookFiring(row.id, "pending", { state: "running" })).map((row) => ({ ...row, state: "running" as const })));
    if (claimed.length === 0) continue;
    const tells = claimed.map((row) => ({ hook: row.hook, on: row.hook_on, text: row.text, facts: JSON.parse(row.facts_json) as HookFacts }));
    try {
      await ctx.bb.send(planner.thread_id, hookTellText(project.slug, tells));
    } catch (error) {
      const why = errText(error);
      ctx.bb.log("warn", `Could not tell the planner ${planner.thread_id} about ${project.slug}'s hooks: ${why}`);
      for (const row of claimed) {
        if (row.tries + 1 >= HOOK_TELL_TRIES) settle(ctx, row, { state: "failed", reason: `bb refused ${HOOK_TELL_TRIES} sends to the planner: ${why}` });
        else store.moveHookFiring(row.id, "running", { state: "pending", tries: row.tries + 1 });
      }
      continue;
    }
    store.tx(() => {
      for (const row of claimed) store.moveHookFiring(row.id, "running", { state: "done" });
      store.event(projectId, null, "hook.told", LOOM_ACTOR, { hooks: tells.map((tell) => ({ hook: tell.hook, on: tell.on, ...(tell.facts.key === undefined ? {} : { key: tell.facts.key }) })) });
    });
  }
}

/** One step of every project's hooks: queue what the new events fire, and tell idle planners. */
export async function followHooks(ctx: EngineCtx): Promise<void> {
  for (const project of ctx.store.projects()) {
    try {
      queueHooks(ctx, project);
    } catch (error) {
      ctx.bb.log("warn", `Could not read the hooks of project ${project.slug}: ${errText(error)}`);
    }
  }
  await tellPlanners(ctx);
}
