// Triage rounds and the planner's board tools: how a blocked ticket gets back into the queue, and how the
// planner answers, edits, splits or cancels tickets after approval.
import type { PostRow, ProjectRow, ThreadRow, TicketRow } from "./db/store";
import { briefBody, LoomError } from "./projects";
import { clip, triageDigest } from "./prompts";
import { isMultiRepo, repoSettings } from "./repos";
import { dependencyCycle, fallsUnder, numberErrors, ticketEnvironmentErrors, type Spec, type TicketPatch, type TicketSpec } from "./spec";
import { HUMAN_ACTOR, LOOM_ACTOR, TICKET_STATES, canMoveTicket, type TicketState } from "./states";
import { endLiveRows, specOf, type EngineCtx } from "./workers";

const ROUND_LIMIT_MS = 30 * 60_000;
const DIGEST_POSTS = 3;
const TRIAGE_REASON_LIMIT = 600;

/** Sends the planner one batched message about every blocked ticket, when a round is due. True when it sent one. */
export async function maybeSendTriage(ctx: EngineCtx, project: ProjectRow): Promise<boolean> {
  const { store } = ctx;
  const fresh = store.project(project.id);
  if (fresh === null || fresh.triage_pending !== 1) return false;
  if (!specOf(store, fresh).agents.triage) return false;
  if (fresh.triage_sent_at !== null && ctx.now() - fresh.triage_sent_at <= ROUND_LIMIT_MS) return false;
  const planner = store.threads({ projectId: fresh.id, role: "planner", states: ["active"] })[0];
  if (planner?.thread_id == null) return false;
  if ((await ctx.bb.getThread(planner.thread_id))?.status !== "idle") return false;

  const tickets = store.tickets(fresh.id);
  const blocked = tickets.filter((ticket) => ticket.state === "blocked");
  if (blocked.length === 0 && fresh.state !== "paused") {
    store.updateProject(fresh.id, { triage_pending: 0 });
    return false;
  }
  const counts = Object.fromEntries(TICKET_STATES.map((state) => [state, tickets.filter((ticket) => ticket.state === state).length])) as Record<TicketState, number>;
  const lastPosts = new Map<number, PostRow[]>(blocked.map((ticket) => [ticket.id, store.posts(ticket.id).slice(-DIGEST_POSTS)]));
  const round = fresh.triage_round + 1;
  const detail = triageDigest({ project: fresh, round, counts, blocked, lastPosts });
  const summary = `[loom] Triage round ${round} for ${fresh.slug}: ${blocked.length === 1 ? "1 ticket is" : `${blocked.length} tickets are`} blocked.`;
  await ctx.bb.send(planner.thread_id, { summary, detail });
  store.updateProject(fresh.id, { triage_pending: 0, triage_round: round, triage_sent_at: ctx.now() });
  store.event(fresh.id, null, "triage.sent", LOOM_ACTOR, {
    round,
    blocked: blocked.map((ticket) => ({ key: ticket.key, title: ticket.title, reason: clip(ticket.blocked_reason ?? "", TRIAGE_REASON_LIMIT) })),
    paused: fresh.state === "paused",
  });
  return true;
}

/** The planner finished its turn: the round it was answering is over. */
export function onPlannerIdle(ctx: EngineCtx, row: ThreadRow): void {
  ctx.store.updateProject(row.project_id, { triage_sent_at: null });
  ctx.kick();
}

// ---------------------------------------------------------------- the planner's board tools

/** Why a ticket cannot run in `repo` on this project, or null when it can. */
const repoError = (spec: Spec, label: string, repo: string | null): string | null => {
  const names = (spec.repo ?? []).map((entry) => entry.name);
  if (names.length === 0) {
    return repo === null ? null : `${label}.repo: "${repo}" names a repo, but this project has no [[repo]] table, so every ticket runs in the project's own repository. Remove repo from the ticket.`;
  }
  if (repo === null) return `${label}.repo: is required, because this project lists [[repo]] tables. Set it to one of: ${names.join(", ")}.`;
  return names.includes(repo) ? null : `${label}.repo: "${repo}" is not one of this project's repos. Use one of: ${names.join(", ")}.`;
};

const problemsOf = (spec: Spec, label: string, scope: readonly string[], verify: readonly string[], repo: string | null): string[] => {
  const problems: string[] = [];
  const wrongRepo = repoError(spec, label, repo);
  if (wrongRepo !== null) problems.push(wrongRepo);
  // A ticket whose repo is wrong is still checked against the top-level settings, as parseSpec does.
  const settings = wrongRepo === null ? repoSettings(spec, repo) : null;
  for (const glob of scope) {
    const guard = (settings?.protected ?? spec.scope.protected).find((protectedGlob) => fallsUnder(glob, protectedGlob));
    if (guard === undefined) continue;
    const owner = spec.scope.protected.includes(guard) ? "" : ` of repo "${repo}"`;
    problems.push(`${label}.scope: "${glob}" falls under the protected path "${guard}"${owner}. Take it out of the scope.`);
  }
  if (verify.length === 0 && (settings?.checks ?? spec.checks.commands).length === 0) {
    const ownChecks = spec.repo?.find((entry) => entry.name === repo)?.checks !== undefined;
    const empty = ownChecks ? `the checks of repo "${repo}", which replace checks.commands, are empty` : "checks.commands is empty";
    problems.push(`${label}.verify: nothing would check this ticket, because it has no verify commands and ${empty}. Add a verify command.`);
  }
  return problems;
};

// A repo the spec does not list has its own error from problemsOf.
const environmentProblems = (spec: Spec, at: string, environment: { inputs: Record<string, unknown> } | undefined, repo: string | null): string[] => {
  if (environment === undefined || repoError(spec, at, repo) !== null) return [];
  return ticketEnvironmentErrors(environment, repoSettings(spec, repo).environment, at);
};

const refused = (errors: string[], what: string) => new LoomError("loom_invalid_input", `${what}:\n${numberErrors(errors)}`);

function requireTicket(ctx: EngineCtx, key: string): TicketRow {
  const ticket = ctx.store.ticketByKey(key);
  if (ticket === null) throw new LoomError("loom_not_found", `No ticket ${key}.`, "Use loom_board to see the ticket keys.");
  return ticket;
}

/** New tickets after approval. A dependency may name a ref in the batch or a key or ref already on the board; the cycle check covers the batch. */
export function addTickets(ctx: EngineCtx, projectId: number, tickets: TicketSpec[], actor: string): TicketRow[] {
  const { store } = ctx;
  const project = store.project(projectId);
  if (project === null || project.state === "archived") throw new LoomError("loom_invalid_state", "The project is archived; tickets cannot be added.");
  const spec = specOf(store, project);
  const existing = store.tickets(projectId);
  const known = new Map(existing.flatMap((ticket) => [[ticket.key, ticket.key] as const, [ticket.ref, ticket.key] as const]));
  const first = existing.reduce((top, ticket) => Math.max(top, ticket.seq), 0) + 1;
  const keyOf = new Map(tickets.map((ticket, index) => [ticket.ref, `${project.key}-${first + index}`]));

  const errors: string[] = [];
  tickets.forEach((ticket, index) => {
    const label = `tickets[${index}]`;
    if (tickets.findIndex((other) => other.ref === ticket.ref) !== index) errors.push(`${label}.ref: "${ticket.ref}" is used twice in this batch.`);
    if (known.has(ticket.ref)) errors.push(`${label}.ref: "${ticket.ref}" is already a ticket on this board.`);
    for (const dep of ticket.depends_on) {
      if (!keyOf.has(dep) && !known.has(dep)) errors.push(`${label}.depends_on: "${dep}" is not a ref in this batch or a ticket on this board.`);
    }
    errors.push(...problemsOf(spec, label, ticket.scope, ticket.verify, ticket.repo ?? null));
    errors.push(...environmentProblems(spec, `${label}.environment`, ticket.environment, ticket.repo ?? null));
  });
  const cycle = dependencyCycle(tickets);
  if (cycle !== null) errors.push(`tickets: dependency cycle ${cycle.join(" -> ")}. Remove one depends_on entry.`);
  if (errors.length > 0) throw refused(errors, "Tickets not added. Fix these and call loom_add_tickets again");

  const created = store.tx(() =>
    tickets.map((ticket, index) => {
      const row = store.createTicket(
        {
          project_id: projectId,
          seq: first + index,
          key: keyOf.get(ticket.ref)!,
          ref: ticket.ref,
          title: ticket.title,
          body: ticket.body,
          acceptance_json: JSON.stringify(ticket.acceptance),
          verify_json: JSON.stringify(ticket.verify),
          scope_json: JSON.stringify(ticket.scope),
          deps_json: JSON.stringify(ticket.depends_on.map((dep) => keyOf.get(dep) ?? known.get(dep)!)),
          priority: ticket.priority,
          repo: ticket.repo ?? null,
          environment_json: ticket.environment === undefined ? null : JSON.stringify(ticket.environment.inputs),
        },
        actor,
      );
      store.addPost({ project_id: projectId, ticket_id: row.id, parent_id: null, author_kind: "planner", author_thread_id: actor, kind: "brief", body: briefBody(ticket), data_json: JSON.stringify({ ref: ticket.ref }) });
      return row;
    }),
  );
  store.changed(project.id);
  ctx.kick();
  return created;
}

const repoLocked = (key: string, why: string, repo: string) =>
  new LoomError(
    "loom_invalid_state",
    `${key} ${why}; its repo can change only while it is queued or blocked and has no branch, because a branch lives in one repository. Cancel ${key} with loom_cancel_ticket and add a new ticket in repo "${repo}" with loom_add_tickets.`,
  );

/** Changes a queued or blocked ticket. Only the fields in the patch change; the repo changes only while the ticket has no branch. */
export function editTicket(ctx: EngineCtx, key: string, patch: TicketPatch, actor: string): TicketRow {
  const { store } = ctx;
  const ticket = requireTicket(ctx, key);
  const movesRepo = patch.repo !== undefined && patch.repo !== ticket.repo;
  if (ticket.state !== "queued" && ticket.state !== "blocked") {
    if (movesRepo) throw repoLocked(key, `is ${ticket.state}`, patch.repo!);
    throw new LoomError("loom_invalid_state", `${key} is ${ticket.state}; only a queued or blocked ticket can be edited.`, "A ticket a worker holds changes through a reply on the ticket, or cancel it and add a new one.");
  }
  const spec = specOf(store, store.project(ticket.project_id)!);
  const repo = patch.repo ?? ticket.repo;
  if (movesRepo && ticket.branch !== null && repoError(spec, "patch", repo) === null) throw repoLocked(key, `has the branch ${ticket.branch}`, repo!);
  const board = store.tickets(ticket.project_id);
  const known = new Map(board.flatMap((other) => [[other.key, other.key] as const, [other.ref, other.key] as const]));
  const errors: string[] = [];
  let deps = JSON.parse(ticket.deps_json) as string[];
  if (patch.depends_on !== undefined) {
    deps = [];
    for (const dep of patch.depends_on) {
      const resolved = known.get(dep);
      if (resolved === undefined) errors.push(`depends_on: "${dep}" is not a ticket on this board.`);
      else if (resolved === ticket.key) errors.push("depends_on: a ticket cannot depend on itself.");
      else deps.push(resolved);
    }
    const graph = board.map((other) => ({ ref: other.key, depends_on: other.key === ticket.key ? deps : (JSON.parse(other.deps_json) as string[]) }));
    const cycle = errors.length === 0 ? dependencyCycle(graph) : null;
    if (cycle !== null) errors.push(`depends_on: dependency cycle ${cycle.join(" -> ")}.`);
  }
  const scope = patch.scope ?? (JSON.parse(ticket.scope_json) as string[]);
  const verify = patch.verify ?? (JSON.parse(ticket.verify_json) as string[]);
  // Moving to another repo checks the whole ticket against that repo's protected paths and checks.
  if (movesRepo || patch.scope !== undefined || patch.verify !== undefined) errors.push(...problemsOf(spec, "patch", movesRepo || patch.scope !== undefined ? scope : [], verify, repo));
  if (patch.environment !== undefined || (movesRepo && ticket.environment_json !== null)) {
    const environment = patch.environment ?? { inputs: JSON.parse(ticket.environment_json!) as Record<string, unknown> };
    errors.push(...environmentProblems(spec, "patch.environment", environment, repo));
  }
  if (errors.length > 0) throw refused(errors, `${key} not changed. Fix these and call loom_edit_ticket again`);

  const fields = (Object.keys(patch) as Array<keyof TicketPatch>).filter((field) => patch[field] !== undefined);
  const changes: Partial<TicketRow> = {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.body === undefined ? {} : { body: patch.body }),
    ...(patch.acceptance === undefined ? {} : { acceptance_json: JSON.stringify(patch.acceptance) }),
    ...(patch.verify === undefined ? {} : { verify_json: JSON.stringify(patch.verify) }),
    ...(patch.scope === undefined ? {} : { scope_json: JSON.stringify(patch.scope) }),
    ...(patch.depends_on === undefined ? {} : { deps_json: JSON.stringify(deps) }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.repo === undefined ? {} : { repo: patch.repo }),
    // An empty patch leaves the ticket with its repo's inputs.
    ...(patch.environment === undefined ? {} : { environment_json: Object.keys(patch.environment.inputs).length === 0 ? null : JSON.stringify(patch.environment.inputs) }),
  };
  // The old values let a rewind show the ticket as it was before the edit.
  const before = Object.fromEntries(Object.keys(changes).map((column) => [column, ticket[column as keyof TicketRow]]));
  store.tx(() => {
    store.updateTicket(ticket.id, changes);
    store.event(ticket.project_id, ticket.id, "ticket.edited", actor, { fields, before });
    store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "planner", author_thread_id: actor, kind: "system", body: `The planner edited this ticket: ${fields.join(", ")}.`, data_json: JSON.stringify({ patch }) });
  });
  store.changed(ticket.project_id);
  ctx.kick();
  return store.ticket(ticket.id)!;
}

/** Cancels a ticket in any non-final state. A live worker or reviewer ends first, so this is async. */
export async function cancelTicket(ctx: EngineCtx, key: string, reason: string, actor: string): Promise<TicketRow> {
  const { store } = ctx;
  const ticket = requireTicket(ctx, key);
  if (ticket.state === "merging") throw new LoomError("loom_invalid_state", `${key} is merging; try again when the merge finishes.`);
  if (!canMoveTicket(ticket.state, "cancelled")) throw new LoomError("loom_invalid_state", `${key} is ${ticket.state}; it cannot be cancelled.`);
  const human = actor === HUMAN_ACTOR;
  store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: human ? "human" : "planner", author_thread_id: human ? null : actor, kind: "system", body: `Cancelled: ${reason.trim()}` });
  await endLiveRows(ctx, ticket, "cancelled");
  store.changed(ticket.project_id);
  ctx.kick();
  return store.ticket(ticket.id)!;
}

/** The board as compact text for the planner: key, state, priority, repo on a multi-repo project, title, dependencies and time in state. */
export function boardText(ctx: EngineCtx, projectId: number, states?: readonly TicketState[]): string {
  const project = ctx.store.project(projectId);
  const tickets = ctx.store.tickets(projectId, states);
  if (tickets.length === 0) return `No tickets${states === undefined ? "" : ` in ${states.join(", ")}`}.`;
  const spec = project?.approved_version == null ? null : specOf(ctx.store, project);
  const repos = spec !== null && isMultiRepo(spec) ? spec.repo!.map((repo) => repo.name) : null;
  const repoOf = (ticket: TicketRow) => `repo ${ticket.repo ?? "-"}`;
  const repoWidth = repos === null ? 0 : Math.max(...tickets.map((ticket) => repoOf(ticket).length));
  const rows = tickets.map((ticket) => {
    const deps = JSON.parse(ticket.deps_json) as string[];
    const age = Math.max(0, Math.round((ctx.now() - ticket.state_at) / 60_000));
    const repo = repos === null ? "" : `${repoOf(ticket).padEnd(repoWidth)}  `;
    return `${ticket.key}  ${ticket.state.padEnd(9)}  P${ticket.priority}  ${repo}${clip(ticket.title, 80)}${deps.length > 0 ? `  (after ${deps.join(", ")})` : ""}  ${age}m in state`;
  });
  const header = `Board for ${project?.slug ?? projectId}${repos === null ? "" : ` (repos ${repos.join(", ")})`}: ${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"}`;
  return [header, ...rows].join("\n");
}
