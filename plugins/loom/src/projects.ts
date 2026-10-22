// The project service: proposals, approval, lifecycle, the board's posts, and
// role lookup. Every state change goes through the store, which appends the event.
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type { PlanningRow, PostRow, ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import { StoreError } from "./db/store";
import { SectionNameConflictError, type BbPort } from "./ports";
import { notesMessage, planningKickoff, planningTitle } from "./prompts";
import { numberErrors, parseSpec, specHash, type Spec } from "./spec";
import type { SpecNote } from "./spec-paths";
import { PAUSE_NOW_REASON, TICKET_STATES, type AuthorKind, type MergeChoice, type ProjectState, type Role, type TicketState } from "./states";

export type LoomErrorCode = "loom_not_found" | "loom_invalid_state" | "loom_invalid_spec" | "loom_invalid_input" | "loom_forbidden" | "loom_no_checkout" | "loom_unavailable";

export class LoomError extends Error {
  constructor(
    readonly code: LoomErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "LoomError";
  }
}

export interface Ctx {
  store: Store;
  bb: BbPort;
  now: () => number;
}

export interface ProposeResult {
  slug: string;
  version: number;
  state: ProjectState;
  warnings: string[];
  pending: boolean;
  change: "created" | "revised" | "pending" | "unchanged";
}

export interface ApproveResult {
  slug: string;
  state: ProjectState;
  version: number;
  applied: "draft" | "pending";
  tickets: string[];
}

export interface ProjectOverview {
  slug: string;
  name: string;
  key: string;
  state: ProjectState;
  goal: string;
  base: string;
  strategy: Spec["merge"]["strategy"];
  branch: string | null;
  approvedVersion: number | null;
  pendingVersion: number | null;
  plannerThreadId: string | null;
  sectionId: string | null;
  hostId: string | null;
  reason: string | null;
  ticketCount: number;
  ticketCounts: Partial<Record<TicketState, number>>;
  createdAt: number;
  updatedAt: number;
}

export interface SpecView {
  slug: string;
  version: number;
  status: "draft" | "approved" | "pending" | "superseded";
  toml: string;
  hash: string;
  proposedBy: string;
  createdAt: number;
}

export interface TicketSummary {
  key: string;
  ref: string;
  title: string;
  state: TicketState;
  priority: number;
  deps: string[];
  attempt: number;
  blockedReason: string | null;
}

export interface TicketView extends TicketSummary {
  slug: string;
  body: string;
  acceptance: string[];
  verify: string[];
  scope: string[];
  posts: Array<PostRow & { depth: number }>;
}

/** A conversation started from the Loom page. `slug` and `projectState` are null until its thread proposes a spec. */
export interface PlanningSession {
  threadId: string;
  title: string;
  startedAt: number;
  slug: string | null;
  projectState: ProjectState | null;
}

const MAX_POST_LENGTH = 20_000;

/** The text of a ticket's first post: its body and the numbered acceptance criteria. */
export function briefBody(ticket: { body: string; acceptance: readonly string[] }): string {
  return `${ticket.body}\n\nAcceptance criteria:\n${ticket.acceptance.map((line, n) => `${n + 1}. ${line}`).join("\n")}`;
}

const rejected = (errors: string[]) => new LoomError("loom_invalid_spec", `Spec not saved. Fix these and call loom_propose again:\n${numberErrors(errors)}`);
const sectionNameOf = (name: string, slug: string) => `Loom · ${name} (${slug})`;
const parseList = (json: string) => JSON.parse(json) as string[];

export class Projects {
  readonly store: Store;
  private readonly bb: BbPort;
  private readonly now: () => number;

  constructor(ctx: Ctx) {
    this.store = ctx.store;
    this.bb = ctx.bb;
    this.now = ctx.now;
  }

  // ---------------------------------------------------------------- propose

  async propose(args: { toml: string; threadId: string; bbProjectId: string; hostId: string | null }): Promise<ProposeResult> {
    const parsed = parseSpec(args.toml);
    if (!parsed.ok || parsed.spec === null) throw rejected(parsed.errors);
    const errors = [...this.proposalErrors(args.threadId, parsed.spec), ...(await this.providerErrors(parsed.spec))];
    if (errors.length > 0) throw rejected(errors);
    const existing = this.store.projectBySlug(parsed.spec.project.slug);
    return existing === null ? await this.createDraft(args, parsed.spec, parsed.warnings) : await this.revise(existing, args, parsed.spec, parsed.warnings);
  }

  private proposalErrors(threadId: string, spec: Spec): string[] {
    const errors: string[] = [];
    const { slug, key } = spec.project;
    const row = this.store.threadByThreadId(threadId);
    const problem = this.proposerProblem(row, slug);
    if (problem !== null) errors.push(problem);

    const project = this.store.projectBySlug(slug);
    if (project !== null && !(row?.role === "planner" && row.project_id === project.id)) {
      errors.push(`project.slug: "${slug}" is already a Loom project and this thread is not its planner. Choose another slug.`);
    }
    const keyOwner = this.store.projectByKey(key);
    if (keyOwner !== null && keyOwner.id !== project?.id) errors.push(`project.key: "${key}" is used by project ${keyOwner.slug}. Choose another key.`);

    if (project?.state === "archived") errors.push(`Project ${slug} is archived. Propose a new project with another slug.`);
    else if (project?.approved_version != null) errors.push(...this.lockedFieldErrors(project, spec));
    return errors;
  }

  /** bb refuses to start a thread with a provider it does not have, so the spec is refused now. A list bb cannot read blocks no proposal. */
  private async providerErrors(spec: Spec): Promise<string[]> {
    const set = (["worker", "reviewer"] as const).flatMap((role) => {
      const provider = spec.agents[role].provider;
      return provider === undefined ? [] : [{ role, provider }];
    });
    if (set.length === 0) return [];
    let known: string[];
    try {
      known = (await this.bb.providerIds()).sort();
    } catch (error) {
      this.bb.log("warn", `Could not read bb's providers, so the spec's providers are not checked: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    // bb always has a provider, so an empty list is one it could not fill yet, not a reason to refuse every provider.
    if (known.length === 0) return [];
    return set
      .filter(({ provider }) => !known.includes(provider))
      .map(({ role, provider }) => `agents.${role}.provider: bb has no provider "${provider}". Use one of: ${known.join(", ")}.`);
  }

  private lockedFieldErrors(project: ProjectRow, spec: Spec): string[] {
    const approved = this.specOf(project.id, project.approved_version!);
    const errors: string[] = [];
    if (project.key !== spec.project.key) {
      errors.push(`project.key: cannot change from "${project.key}" to "${spec.project.key}" after approval, because ticket keys already use it. Keep the key.`);
    }
    if (approved.merge.strategy !== spec.merge.strategy) {
      errors.push(`merge.strategy: cannot change from "${approved.merge.strategy}" to "${spec.merge.strategy}" after approval, because the integration branch and its worktree may already exist. Keep the strategy, or archive this project and propose a new one.`);
    }
    if (approved.merge.branch !== spec.merge.branch) {
      errors.push(`merge.branch: cannot change from "${approved.merge.branch ?? "(none)"}" to "${spec.merge.branch ?? "(none)"}" after approval, because the integration branch and its worktree may already exist. Keep the branch, or archive this project and propose a new one.`);
    }
    return errors;
  }

  private async createDraft(args: { toml: string; threadId: string; bbProjectId: string; hostId: string | null }, spec: Spec, warnings: string[]): Promise<ProposeResult> {
    const { slug, name, key } = spec.project;
    let sectionId: string;
    try {
      sectionId = await this.bb.ensureSection(null, sectionNameOf(name, slug));
    } catch (error) {
      if (error instanceof SectionNameConflictError) {
        throw rejected([`A sidebar section named "${error.sectionName}" already exists. Rename it, or choose another slug.`]);
      }
      throw error;
    }

    let version: number;
    try {
      version = this.store.tx(() => {
        // Another proposal may have won while the section was being created.
        const errors = this.proposalErrors(args.threadId, spec);
        if (errors.length > 0) throw rejected(errors);
        const project = this.store.createProject({ slug, name, key, bb_project_id: args.bbProjectId, host_id: args.hostId, section_id: sectionId, planner_thread_id: args.threadId }, args.threadId);
        this.store.addThread({ thread_id: args.threadId, project_id: project.id, role: "planner", state: "active" });
        return this.store.addSpecVersion(project.id, args.toml, JSON.stringify(spec), specHash(spec), args.threadId);
      });
    } catch (error) {
      await this.tolerate("delete section after a failed proposal", () => this.bb.deleteSection(sectionId));
      throw error;
    }

    await this.tolerate("move the planner thread into its section", () => this.bb.moveThread(args.threadId, sectionId));
    await this.tolerate("mark the planner thread", () => this.bb.setMetadata(args.threadId, { project: slug, role: "planner" }));
    this.store.changed(this.require(slug).id);
    return { slug, version, state: "draft", warnings, pending: false, change: "created" };
  }

  private async revise(stored: ProjectRow, args: { toml: string; threadId: string }, spec: Spec, warnings: string[]): Promise<ProposeResult> {
    await this.ensureProjectSection(stored);
    const project = this.store.project(stored.id)!;
    const slug = project.slug;
    const hash = specHash(spec);
    const latest = this.store.latestSpecVersion(project.id)!;
    if (latest.hash === hash) {
      return { slug, version: latest.version, state: project.state, warnings, pending: latest.version === project.pending_version, change: "unchanged" };
    }

    if (project.approved_version === null) {
      const draft = this.store.tx(() => {
        const added = this.store.addSpecVersion(project.id, args.toml, JSON.stringify(spec), hash, args.threadId);
        this.store.updateProject(project.id, { name: spec.project.name, key: spec.project.key });
        return added;
      });
      if (project.name !== spec.project.name) await this.renameSection(project, spec.project.name);
      this.store.changed(project.id);
      return { slug, version: draft, state: project.state, warnings, pending: false, change: "revised" };
    }

    const version = this.store.tx(() => {
      const added = this.store.addSpecVersion(project.id, args.toml, JSON.stringify(spec), hash, args.threadId);
      this.store.updateProject(project.id, { pending_version: added });
      return added;
    });
    this.store.changed(project.id);
    return { slug, version, state: project.state, warnings: [...warnings, "Ticket changes after approval go through the planner's board tools."], pending: true, change: "pending" };
  }

  // ---------------------------------------------------------------- approve and lifecycle

  async approve(slug: string, actor: string, version?: number): Promise<ApproveResult> {
    const project = this.require(slug);
    if (project.state === "archived") throw new LoomError("loom_invalid_state", `Project ${slug} is archived.`);

    if (project.state === "draft") {
      const draft = this.store.latestSpecVersion(project.id)!;
      this.guardVersion(slug, version, draft.version);
      const spec = JSON.parse(draft.spec_json) as Spec;
      const keys = this.store.tx(() => {
        this.store.updateProject(project.id, { approved_version: draft.version });
        this.store.event(project.id, null, "spec.approved", actor, { version: draft.version });
        const created = this.createTickets(project, spec, actor);
        this.store.setProjectState(project.id, "ready", actor);
        return created;
      });
      this.store.changed(project.id);
      return { slug, state: "ready", version: draft.version, applied: "draft", tickets: keys };
    }

    if (project.pending_version === null) {
      throw new LoomError("loom_invalid_state", `Project ${slug} is ${project.state} and has no spec version waiting for approval.`);
    }
    this.guardVersion(slug, version, project.pending_version);
    const pending = this.specOf(project.id, project.pending_version);
    this.store.tx(() => {
      this.store.updateProject(project.id, { approved_version: project.pending_version, pending_version: null, name: pending.project.name });
      this.store.event(project.id, null, "spec.approved", actor, { version: project.pending_version, pending: true });
    });
    if (project.name !== pending.project.name) await this.renameSection(project, pending.project.name);
    this.store.changed(project.id);
    return { slug, state: project.state, version: project.pending_version, applied: "pending", tickets: [] };
  }

  private guardVersion(slug: string, requested: number | undefined, waiting: number): void {
    if (requested === undefined || requested === waiting) return;
    throw new LoomError("loom_invalid_state", `Spec version ${requested} is not the one waiting for approval (version ${waiting}). Run \`bb loom spec ${slug}\` to read it.`);
  }

  private createTickets(project: ProjectRow, spec: Spec, actor: string): string[] {
    const keyOf = new Map(spec.ticket.map((ticket, index) => [ticket.ref, `${project.key}-${index + 1}`]));
    return spec.ticket.map((ticket, index) => {
      const row = this.store.createTicket(
        {
          project_id: project.id,
          seq: index + 1,
          key: keyOf.get(ticket.ref)!,
          ref: ticket.ref,
          title: ticket.title,
          body: ticket.body,
          acceptance_json: JSON.stringify(ticket.acceptance),
          verify_json: JSON.stringify(ticket.verify),
          scope_json: JSON.stringify(ticket.scope),
          deps_json: JSON.stringify(ticket.depends_on.map((ref) => keyOf.get(ref)!)),
          priority: ticket.priority,
        },
        actor,
      );
      this.store.addPost({
        project_id: project.id,
        ticket_id: row.id,
        parent_id: null,
        author_kind: "planner",
        author_thread_id: project.planner_thread_id,
        kind: "brief",
        body: briefBody(ticket),
        data_json: JSON.stringify({ ref: ticket.ref }),
      });
      return row.key;
    });
  }

  async start(slug: string, actor: string): Promise<ProjectRow> {
    const project = this.expectState(slug, "start", "ready", { draft: `Run \`bb loom approve ${slug}\` first.`, paused: `Run \`bb loom resume ${slug}\` instead.` });
    const started = this.moveProject(project, "running", actor);
    await this.ensureProjectSection(started);
    return this.store.project(started.id)!;
  }

  async pause(slug: string, actor: string, opts: { now?: boolean } = {}): Promise<ProjectRow> {
    const project = this.expectState(slug, "pause", "running", {});
    return this.moveProject(project, "paused", actor, opts.now === true ? PAUSE_NOW_REASON : undefined);
  }

  async resume(slug: string, actor: string): Promise<ProjectRow> {
    const project = this.expectState(slug, "resume", "paused", { ready: `Run \`bb loom start ${slug}\` instead.` });
    const resumed = this.moveProject(project, "running", actor);
    await this.ensureProjectSection(resumed);
    return this.store.project(resumed.id)!;
  }

  async archive(slug: string, actor: string): Promise<ProjectRow> {
    const project = this.require(slug);
    if (project.state === "archived") throw new LoomError("loom_invalid_state", `Project ${slug} is archived.`);
    const archived = this.store.tx(() => {
      for (const ticket of this.store.tickets(project.id)) {
        if (ticket.state !== "done" && ticket.state !== "cancelled") this.store.setTicketState(ticket.id, "cancelled", actor, { reason: "project archived" });
      }
      return this.store.setProjectState(project.id, "archived", actor);
    });
    await this.removeFinishedSection(archived);
    this.store.changed(project.id);
    return this.store.project(archived.id)!;
  }

  private expectState(slug: string, verb: string, expected: ProjectState, hints: Partial<Record<ProjectState, string>>): ProjectRow {
    const project = this.require(slug);
    if (project.state !== expected) {
      throw new LoomError("loom_invalid_state", `Project ${slug} is ${project.state}; ${verb} needs a ${expected} project.`, hints[project.state]);
    }
    return project;
  }

  private moveProject(project: ProjectRow, to: ProjectState, actor: string, reason?: string): ProjectRow {
    try {
      const moved = this.store.setProjectState(project.id, to, actor, reason);
      this.store.changed(project.id);
      return moved;
    } catch (error) {
      if (error instanceof StoreError) throw new LoomError("loom_invalid_state", error.message);
      throw error;
    }
  }

  // ---------------------------------------------------------------- board

  post(key: string, args: { body: string; parentId?: number; author: AuthorKind; threadId?: string | null }): PostRow {
    const ticket = this.requireTicket(key);
    const body = args.body.trim();
    if (body === "") throw new LoomError("loom_invalid_input", "The post text is empty.");
    if (body.length > MAX_POST_LENGTH) throw new LoomError("loom_invalid_input", `The post is ${body.length} characters; the limit is ${MAX_POST_LENGTH}.`);
    try {
      const post = this.store.addPost({
        project_id: ticket.project_id,
        ticket_id: ticket.id,
        parent_id: args.parentId ?? null,
        author_kind: args.author,
        author_thread_id: args.threadId ?? null,
        kind: "reply",
        body,
      });
      this.store.changed(ticket.project_id);
      return post;
    } catch (error) {
      if (error instanceof StoreError) throw new LoomError("loom_not_found", error.message);
      throw error;
    }
  }

  block(key: string, reason: string, actor: string): TicketRow {
    const ticket = this.requireTicket(key);
    const text = reason.trim();
    if (text === "") throw new LoomError("loom_invalid_input", "The block reason is empty.");
    const blocked = this.store.tx(() => {
      try {
        this.store.setTicketState(ticket.id, "blocked", actor, { reason: text });
      } catch (error) {
        if (error instanceof StoreError) throw new LoomError("loom_invalid_state", error.message);
        throw error;
      }
      this.store.updateTicket(ticket.id, { blocked_reason: text });
      this.store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: null, author_kind: "human", author_thread_id: null, kind: "block", body: text });
      return this.store.ticket(ticket.id)!;
    });
    this.store.changed(ticket.project_id);
    return blocked;
  }

  // ---------------------------------------------------------------- roles

  // Metadata never grants a role; it can only carry the single-use spawn token that binds a thread id to a row.
  roleOf(threadId: string, metadata: Readonly<Record<string, unknown>> = {}): ThreadRow | null {
    const row = this.store.threadByThreadId(threadId);
    if (row !== null) return row;
    const token = typeof metadata.spawnToken === "string" ? metadata.spawnToken : null;
    if (token === null) return null;
    return this.store.tx(() => {
      const spawning = this.store.threadBySpawnToken(token);
      if (spawning === null || spawning.state !== "spawning" || spawning.thread_id !== null) return null;
      this.store.updateThread(spawning.id, { thread_id: threadId });
      return this.store.threadByThreadId(threadId);
    });
  }

  requireRole(threadId: string, role: Role, metadata?: Readonly<Record<string, unknown>>): ThreadRow {
    const row = this.roleOf(threadId, metadata);
    if (row === null || row.role !== role) throw new LoomError("loom_forbidden", `This tool is for Loom ${role} threads.`);
    return row;
  }

  requireProposer(threadId: string, slug: string): void {
    const problem = this.proposerProblem(this.store.threadByThreadId(threadId), slug);
    if (problem !== null) throw new LoomError("loom_forbidden", problem);
  }

  private proposerProblem(row: ThreadRow | null, slug: string): string | null {
    if (row === null) return null;
    if (row.role !== "planner") return "Workers and reviewers cannot propose projects.";
    if (row.state !== "active") return "This planner thread has ended.";
    const own = this.store.project(row.project_id);
    if (own !== null && own.slug !== slug) return `This thread already plans ${own.slug}; a revision must keep that slug.`;
    return null;
  }

  projectOf(row: ThreadRow): ProjectRow | null {
    return this.store.project(row.project_id);
  }

  hostOf(threadId: string): Promise<string | null> {
    return this.bb.threadHostId(threadId);
  }

  threadGone(threadId: string, reason: string): void {
    const row = this.store.threadByThreadId(threadId);
    if (row?.role === "planner" && row.state !== "ended") {
      this.store.updateThread(row.id, { state: "ended", ended_at: this.now(), end_reason: reason });
    }
  }

  /** Sends the human's notes on the spec to the planner as one message. Notes written on an older version than the newest need `includeOlder`. */
  async sendNotes(slug: string, notes: readonly SpecNote[], includeOlder: boolean): Promise<void> {
    const project = this.require(slug);
    if (project.state === "archived") throw new LoomError("loom_invalid_state", `Project ${slug} is archived.`);
    const newest = this.store.latestSpecVersion(project.id)!.version;
    const missing = notes.find((note) => note.version > newest);
    if (missing !== undefined) throw new LoomError("loom_invalid_state", `Project ${slug} has no spec version ${missing.version}.`);
    const older = notes.filter((note) => note.version < newest);
    if (older.length > 0 && !includeOlder) {
      const versions = [...new Set(older.map((note) => `v${note.version}`))].join(", ");
      const one = older.length === 1;
      throw new LoomError("loom_invalid_state", `${one ? "1 note was" : `${older.length} notes were`} written on ${versions}, and v${newest} is newer. Read v${newest}, then send ${one ? "it" : "them"} again or confirm.`);
    }
    const planner = project.planner_thread_id === null ? null : this.store.threadByThreadId(project.planner_thread_id);
    if (planner?.role !== "planner" || planner.state !== "active" || planner.thread_id === null) {
      throw new LoomError("loom_invalid_state", `Project ${slug} has no planner thread to send notes to.`);
    }
    await this.bb.send(planner.thread_id, notesMessage({ slug, version: newest, status: this.specStatus(project, newest), notes }));
  }

  // ---------------------------------------------------------------- planning conversations

  /** Starts a planner thread from the page's composer request. It is an ordinary thread until its first loom_propose binds it as the planner. */
  async startPlanning(a: { request: NewThreadRequest; merge: MergeChoice; reviewer: string }): Promise<{ threadId: string }> {
    const title = planningTitle(a.request.input);
    if (title === "") throw new LoomError("loom_invalid_input", "Describe what should exist when the project is done.");
    if ((await this.bb.projectKind(a.request.projectId)) !== "standard") {
      throw new LoomError("loom_no_checkout", "Loom needs a bb project with a git checkout. Pick a project in the composer.");
    }
    const threadId = await this.bb.spawnPlanner({ request: a.request, title: `Loom plan: ${title}`, kickoff: planningKickoff(a) });
    this.store.addPlanning({ thread_id: threadId, bb_project_id: a.request.projectId, title });
    return { threadId };
  }

  /** The open conversations, newest first. */
  planningSessions(): PlanningSession[] {
    return this.store.openPlanning().map((row) => this.sessionOf(row));
  }

  planningSession(threadId: string): PlanningSession | null {
    const row = this.store.planning(threadId);
    return row === null ? null : this.sessionOf(row);
  }

  planningGone(threadId: string, reason: string): void {
    this.store.endPlanning(threadId, reason);
  }

  private sessionOf(row: PlanningRow): PlanningSession {
    const planner = this.store.threadByThreadId(row.thread_id);
    const project = planner?.role === "planner" ? this.store.project(planner.project_id) : null;
    return { threadId: row.thread_id, title: row.title, startedAt: row.started_at, slug: project?.slug ?? null, projectState: project?.state ?? null };
  }

  // ---------------------------------------------------------------- views

  list(): ProjectOverview[] {
    return this.store.projects().map((project) => this.overviewOf(project));
  }

  overview(slug: string): ProjectOverview {
    return this.overviewOf(this.require(slug));
  }

  spec(slug: string, version?: number): SpecView {
    const project = this.require(slug);
    const row = version === undefined ? this.store.specVersion(project.id, project.approved_version ?? this.store.latestSpecVersion(project.id)!.version) : this.store.specVersion(project.id, version);
    if (row === null) throw new LoomError("loom_not_found", `Project ${slug} has no spec version ${version}.`, `Run \`bb loom show ${slug}\` to see its versions.`);
    const status = this.specStatus(project, row.version);
    return { slug, version: row.version, status, toml: row.toml, hash: row.hash, proposedBy: row.proposed_by, createdAt: row.created_at };
  }

  specStatus(project: ProjectRow, version: number): SpecView["status"] {
    if (version === project.approved_version) return "approved";
    if (version === project.pending_version) return "pending";
    if (project.approved_version === null && version === this.store.latestSpecVersion(project.id)?.version) return "draft";
    return "superseded";
  }

  tickets(slug: string, states?: readonly TicketState[]): TicketSummary[] {
    const project = this.require(slug);
    for (const state of states ?? []) {
      if (!TICKET_STATES.includes(state)) throw new LoomError("loom_invalid_input", `Unknown ticket state "${state}". Use one of: ${TICKET_STATES.join(", ")}.`);
    }
    return this.store.tickets(project.id, states).map(summaryOf);
  }

  ticketView(key: string): TicketView {
    const ticket = this.requireTicket(key);
    const posts = this.store.posts(ticket.id);
    const children = new Map<number | null, PostRow[]>();
    for (const post of posts) children.set(post.parent_id, [...(children.get(post.parent_id) ?? []), post]);
    const ordered: Array<PostRow & { depth: number }> = [];
    const walk = (parent: number | null, depth: number) => {
      for (const post of children.get(parent) ?? []) {
        ordered.push({ ...post, depth });
        walk(post.id, depth + 1);
      }
    };
    walk(null, 0);
    return {
      ...summaryOf(ticket),
      slug: this.slugOf(ticket),
      body: ticket.body,
      acceptance: parseList(ticket.acceptance_json),
      verify: parseList(ticket.verify_json),
      scope: parseList(ticket.scope_json),
      posts: ordered,
    };
  }

  // ---------------------------------------------------------------- helpers

  private overviewOf(project: ProjectRow): ProjectOverview {
    const spec = this.specOf(project.id, project.approved_version ?? this.store.latestSpecVersion(project.id)!.version);
    const tickets = this.store.tickets(project.id);
    const ticketCounts: Partial<Record<TicketState, number>> = {};
    for (const ticket of tickets) ticketCounts[ticket.state] = (ticketCounts[ticket.state] ?? 0) + 1;
    return {
      slug: project.slug,
      name: project.name,
      key: project.key,
      state: project.state,
      goal: spec.project.goal,
      base: spec.project.base,
      strategy: spec.merge.strategy,
      branch: spec.merge.branch ?? null,
      approvedVersion: project.approved_version,
      pendingVersion: project.pending_version,
      plannerThreadId: project.planner_thread_id,
      sectionId: project.section_id,
      hostId: project.host_id,
      reason: project.system_reason,
      ticketCount: tickets.length,
      ticketCounts,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
    };
  }

  private specOf(projectId: number, version: number): Spec {
    const row = this.store.specVersion(projectId, version);
    if (row === null) throw new LoomError("loom_not_found", `Spec version ${version} is missing.`);
    return JSON.parse(row.spec_json) as Spec;
  }

  require(slug: string): ProjectRow {
    const project = this.store.projectBySlug(slug);
    if (project === null) throw new LoomError("loom_not_found", `No Loom project named "${slug}".`, "Run `bb loom list` to see the projects.");
    return project;
  }

  private requireTicket(key: string): TicketRow {
    const ticket = this.store.ticketByKey(key);
    if (ticket === null) throw new LoomError("loom_not_found", `No ticket ${key}.`, "Run `bb loom tickets <slug>` to see the ticket keys.");
    return ticket;
  }

  private slugOf(ticket: TicketRow): string {
    return this.store.project(ticket.project_id)!.slug;
  }

  /** Makes sure the project's sidebar section exists. Recreates a deleted one, stores its new id and moves the planner thread into it. Returns the stored id when bb refuses, and gives a done or archived project none. */
  async ensureProjectSection(project: ProjectRow): Promise<string | null> {
    if (project.state === "done" || project.state === "archived") return project.section_id;
    let sectionId = project.section_id;
    await this.tolerate("repair the project's section", async () => {
      sectionId = await this.bb.ensureSection(project.section_id, sectionNameOf(project.name, project.slug));
    });
    if (sectionId === project.section_id || sectionId === null) return project.section_id;

    const repaired = sectionId;
    this.store.updateProject(project.id, { section_id: repaired });
    const planner = project.planner_thread_id;
    if (planner !== null) await this.tolerate("move the planner thread into its new section", () => this.bb.moveThread(planner, repaired));
    this.store.changed(project.id);
    return repaired;
  }

  /** A done or archived project keeps no sidebar section; bb unassigns its threads. A refused delete keeps the id, so the next engine pass tries again. */
  async removeFinishedSection(project: ProjectRow): Promise<void> {
    if ((project.state !== "done" && project.state !== "archived") || project.section_id === null) return;
    const sectionId = project.section_id;
    await this.tolerate("delete the project's section", async () => {
      await this.bb.deleteSection(sectionId);
      this.store.updateProject(project.id, { section_id: null });
      this.store.changed(project.id);
    });
  }

  private async renameSection(project: ProjectRow, name: string): Promise<void> {
    if (project.section_id === null) return;
    const sectionId = project.section_id;
    await this.tolerate("rename the project's section", () => this.bb.renameSection(sectionId, sectionNameOf(name, project.slug)));
  }

  // Sidebar changes are cosmetic: when bb refuses one, the saved state still stands.
  private async tolerate(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.bb.log("warn", `Could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function summaryOf(ticket: TicketRow): TicketSummary {
  return {
    key: ticket.key,
    ref: ticket.ref,
    title: ticket.title,
    state: ticket.state,
    priority: ticket.priority,
    deps: parseList(ticket.deps_json),
    attempt: ticket.attempt,
    blockedReason: ticket.blocked_reason,
  };
}
