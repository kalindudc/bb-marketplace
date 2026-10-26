// The Planner page's account of a planner's work, from what Loom keeps itself: the spec versions it proposed, Loom's
// reviews of them, the human's comments and controls, triage rounds, the planner's board changes, and the planner's last
// words in each turn, which bb hands over when its thread goes idle. Question rounds live in bb's thread; the page adds them.
import { plannerAsk, type AskStep, type PlannerAsk } from "./asks";
import type { EventRow, ProjectRow, Store } from "./db/store";
import type { Projects, SpecView } from "./projects";
import { clip } from "./prompts";
import type { Spec } from "./spec";
import { specDiff } from "./spec-diff";
import type { SpecNote } from "./spec-paths";
import { specReviewStatus, type SpecFinding, type SpecReviewStatus } from "./spec-review";
import type { ProjectState } from "./states";

const TURN_TEXT_LIMIT = 20_000;
const POST_TEXT_LIMIT = 400;
const CONTROLS = ["approve", "start", "pause", "resume", "land", "archive"] as const;

/** Keeps the planner's last words of a turn; an empty turn leaves nothing. */
export function recordPlannerTurn(store: Store, threadId: string, projectId: number | null, text: string | null): void {
  const trimmed = text?.trim() ?? "";
  if (trimmed !== "") store.addPlannerLog({ thread_id: threadId, author: "planner", text: clip(trimmed, TURN_TEXT_LIMIT) }, projectId);
}

/** What a version changed from the one before it, counted for a one-line summary. */
export interface VersionChange {
  added: string[];
  removed: string[];
  /** The refs of kept tickets with a changed part. */
  changed: string[];
  settings: number;
  guardrails: number;
}

export type PlannerAction =
  | { kind: "proposed"; version: number; tickets: number; change: VersionChange | null }
  | { kind: "post"; key: string; postId: number; text: string; reply: boolean }
  | { kind: "requeue"; key: string }
  | { kind: "cancel"; key: string }
  | { kind: "edit"; key: string; fields: string[] }
  | { kind: "add"; key: string }
  | { kind: "ask"; why: string; steps: AskStep[] };

/** One turn of the planner: what it changed, and its last words, which are null for a turn bb did not hand over yet. */
export interface TurnStep {
  kind: "turn";
  at: number;
  text: string | null;
  actions: PlannerAction[];
}

export type PlannerStep =
  | { kind: "started"; at: number; text: string }
  | { kind: "message"; at: number; text: string }
  | TurnStep
  | { kind: "notes"; at: number; version: number; notes: SpecNote[] }
  | { kind: "review"; at: number; version: number; round: number; state: "reviewing" | "approved" | "changes_requested" | "failed"; summary: string | null; findings: SpecFinding[]; reason: string | null; startedAt: number; endedAt: number | null }
  | { kind: "control"; at: number; action: (typeof CONTROLS)[number]; version: number | null; pending: boolean; skipReview: boolean }
  | { kind: "triage"; at: number; round: number; blocked: Array<{ key: string; title: string; reason: string }>; response: TurnStep | null };

export interface PlannerVersion {
  version: number;
  status: SpecView["status"];
  createdAt: number;
  tickets: number;
  change: VersionChange | null;
  /** Its project.summary; null for a version written before summaries were required. */
  summary: string | null;
  /** It writes or rewrites the summary of the version before it; always true for a first version with one. */
  summaryChanged: boolean;
  /** The newest review of the version that was not replaced. */
  review: { state: "reviewing" | "approved" | "changes_requested" | "failed"; round: number; findings: number } | null;
}

export interface PlannerView {
  threadId: string;
  title: string;
  startedAt: number;
  slug: string | null;
  projectState: ProjectState | null;
  approvedVersion: number | null;
  pendingVersion: number | null;
  steps: PlannerStep[];
  ask: PlannerAsk | null;
  versions: PlannerVersion[];
  review: SpecReviewStatus;
  triageRounds: number;
  now: number;
}

export function versionChange(before: Spec, after: Spec): VersionChange {
  const changes = specDiff(before, after);
  const added = changes.flatMap((change) => (change.kind === "ticket-added" ? [change.ref] : []));
  const removed = changes.flatMap((change) => (change.kind === "ticket-removed" ? [change.ref] : []));
  const changed = [...new Set(changes.flatMap((change) => (change.ref !== null && change.kind !== "ticket-added" && change.kind !== "ticket-removed" ? [change.ref] : [])))];
  return { added, removed, changed, settings: changes.filter((change) => change.section === "settings").length, guardrails: changes.filter((change) => change.section === "guardrails").length };
}

type Item = { at: number; order: number } & ({ type: "event"; event: EventRow } | { type: "log"; author: "planner" | "human"; text: string } | { type: "step"; step: PlannerStep });

/** The steps of the planner's work in order, with each run of planner actions grouped into the turn that ended it. */
function stepsOf(store: Store, project: ProjectRow | null, threadId: string, start: { at: number; text: string }, now: number): PlannerStep[] {
  const items: Item[] = [{ type: "step", step: { kind: "started", at: start.at, text: start.text }, at: start.at, order: 0 }];
  for (const row of store.plannerLog(threadId)) items.push({ type: "log", author: row.author, text: row.text, at: row.at, order: 2 });
  const events = project === null ? [] : store.events(project.id, 0, 1_000_000);
  for (const event of events) items.push({ type: "event", event, at: event.at, order: 1 });
  if (project !== null) {
    for (const row of store.specReviews(project.id)) {
      if (row.state === "superseded") continue;
      const step: PlannerStep = { kind: "review", at: row.ended_at ?? now, version: row.version, round: row.round, state: row.state, summary: row.summary, findings: JSON.parse(row.findings_json) as SpecFinding[], reason: row.reason, startedAt: row.started_at, endedAt: row.ended_at };
      items.push({ type: "step", step, at: step.at, order: 1 });
    }
  }
  items.sort((a, b) => a.at - b.at || a.order - b.order);

  const planner = new Set([threadId]);
  const specs = new Map<number, Spec>();
  const specAt = (version: number) => {
    if (!specs.has(version)) specs.set(version, JSON.parse(store.specVersion(project!.id, version)!.spec_json) as Spec);
    return specs.get(version)!;
  };
  const keyOf = (event: EventRow) => (event.ticket_id === null ? null : (store.ticket(event.ticket_id)?.key ?? null));

  const steps: PlannerStep[] = [];
  let turn: TurnStep | null = null;
  const attach = (done: TurnStep) => {
    const last = steps.at(-1);
    if (last?.kind === "triage" && last.response === null) last.response = done;
    else steps.push(done);
  };
  const flush = () => {
    if (turn !== null) attach(turn);
    turn = null;
  };
  const act = (at: number, action: PlannerAction) => {
    // Each version gets its own turn even with no turn recorded between them, as in a project from before turns were kept.
    if (action.kind === "proposed" && turn?.actions.some((one) => one.kind === "proposed") === true) flush();
    turn ??= { kind: "turn", at, text: null, actions: [] };
    turn.actions.push(action);
    turn.at = at;
  };
  const external = (step: PlannerStep) => {
    flush();
    steps.push(step);
  };

  for (const item of items) {
    if (item.type === "log") {
      if (item.author === "human") external({ kind: "message", at: item.at, text: item.text });
      else {
        const done: TurnStep = turn ?? { kind: "turn", at: item.at, text: null, actions: [] };
        done.text = item.text;
        done.at = item.at;
        turn = null;
        attach(done);
      }
      continue;
    }
    if (item.type === "step") {
      if (item.step.kind === "started") steps.push(item.step);
      else external(item.step);
      continue;
    }
    const { event } = item;
    const data = JSON.parse(event.data_json) as Record<string, unknown>;
    const byPlanner = planner.has(event.actor);
    switch (event.kind) {
      case "spec.proposed": {
        const version = Number(data.version);
        const spec = specAt(version);
        act(event.at, { kind: "proposed", version, tickets: spec.ticket.length, change: version > 1 && store.specVersion(project!.id, version - 1) !== null ? versionChange(specAt(version - 1), spec) : null });
        break;
      }
      case "post.added": {
        const key = keyOf(event);
        if (data.author !== "planner" || data.kind === "brief" || key === null) break;
        const post = store.posts(event.ticket_id!).find((row) => row.id === data.post);
        act(event.at, { kind: "post", key, postId: Number(data.post), text: clip(post?.body ?? "", POST_TEXT_LIMIT), reply: data.parent !== null && data.parent !== undefined });
        break;
      }
      case "ticket.state": {
        const key = keyOf(event);
        if (!byPlanner || key === null) break;
        if (data.from === "blocked" && data.to === "queued") act(event.at, { kind: "requeue", key });
        else if (data.to === "cancelled") act(event.at, { kind: "cancel", key });
        break;
      }
      case "ticket.edited": {
        const key = keyOf(event);
        if (byPlanner && key !== null) act(event.at, { kind: "edit", key, fields: Array.isArray(data.fields) ? (data.fields as string[]) : [] });
        break;
      }
      case "ticket.created": {
        const key = keyOf(event);
        if (byPlanner && key !== null) act(event.at, { kind: "add", key });
        break;
      }
      case "planner.asked":
        act(event.at, { kind: "ask", why: String(data.why ?? ""), steps: (data.steps as AskStep[] | undefined) ?? [] });
        break;
      case "triage.sent":
        external({ kind: "triage", at: event.at, round: Number(data.round), blocked: (data.blocked as Array<{ key: string; title: string; reason: string }> | undefined) ?? [], response: null });
        break;
      case "human.action": {
        if (data.action === "notes") {
          const notes = (data.notes as SpecNote[] | undefined) ?? [];
          if (notes.length > 0) external({ kind: "notes", at: event.at, version: notes[0]!.version, notes });
          break;
        }
        const action = CONTROLS.find((control) => control === data.action);
        if (action === undefined) break;
        const approved = action === "approve" ? events.filter((row) => row.kind === "spec.approved" && row.id < event.id).at(-1) : undefined;
        const version = approved === undefined ? null : Number((JSON.parse(approved.data_json) as { version: number }).version);
        external({ kind: "control", at: event.at, action, version, pending: data.pending === true, skipReview: data.skipReview === true });
        break;
      }
    }
  }
  flush();
  return steps;
}

function versionsOf(store: Store, projects: Projects, project: ProjectRow): PlannerVersion[] {
  const latest = store.latestSpecVersion(project.id)!.version;
  const reviews = store.specReviews(project.id).filter((row) => row.state !== "superseded");
  const out: PlannerVersion[] = [];
  let before: Spec | null = null;
  for (let version = 1; version <= latest; version++) {
    const row = store.specVersion(project.id, version);
    if (row === null) continue;
    const spec = JSON.parse(row.spec_json) as Spec;
    const review = reviews.filter((entry) => entry.version === version).at(-1);
    out.push({
      version,
      status: projects.specStatus(project, version),
      createdAt: row.created_at,
      tickets: spec.ticket.length,
      change: before === null ? null : versionChange(before, spec),
      summary: spec.project.summary ?? null,
      summaryChanged: spec.project.summary !== undefined && spec.project.summary !== before?.project.summary,
      review: review === undefined ? null : { state: review.state as "reviewing" | "approved" | "changes_requested" | "failed", round: review.round, findings: (JSON.parse(review.findings_json) as unknown[]).length },
    });
    before = spec;
  }
  return out;
}

/** The view of a planner thread: a project's planner, or a planning conversation that has not proposed yet. Null for any other thread. */
export function plannerView(deps: { store: Store; projects: Projects }, threadId: string, now: number): PlannerView | null {
  const { store, projects } = deps;
  const row = store.threadByThreadId(threadId);
  const project = row?.role === "planner" ? store.project(row.project_id) : null;
  const planning = store.planning(threadId);
  if (project === null && planning === null) return null;
  const created = project === null ? undefined : store.eventsOfKind(project.id, "project.created")[0];
  const start = planning !== null ? { at: planning.started_at, text: planning.title } : { at: created?.at ?? project!.created_at, text: project!.name };
  return {
    threadId,
    title: planning?.title ?? project!.name,
    startedAt: start.at,
    slug: project?.slug ?? null,
    projectState: project?.state ?? null,
    approvedVersion: project?.approved_version ?? null,
    pendingVersion: project?.pending_version ?? null,
    steps: stepsOf(store, project, threadId, start, now),
    ask: project === null || project.state === "archived" ? null : plannerAsk(store, project),
    versions: project === null ? [] : versionsOf(store, projects, project),
    review: project === null ? { kind: "none" } : specReviewStatus(store, project),
    triageRounds: project?.triage_round ?? 0,
    now,
  };
}
