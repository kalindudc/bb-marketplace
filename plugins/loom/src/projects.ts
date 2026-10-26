// The project service: proposals, approval, lifecycle, the board's posts, and
// role lookup. Every state change goes through the store, which appends the event.
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type { EventRow, PlanningRow, PostRow, ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import { StoreError } from "./db/store";
import { aboutOf, pendingAboutOf, type PendingAbout, type ProjectAbout } from "./about";
import { gatherFacts, reachErrors, specTargets } from "./discover";
import { SectionNameConflictError, type BbPort, type BbProjectInfo, type HostPort } from "./ports";
import { MAX_PLANNING_REPOS, notesMessage, planningKickoff, planningTitle, type PickedRepo } from "./prompts";
import { isMultiRepo, repoSettings } from "./repos";
import { numberErrors, parseSpec, proposalErrorsOf, specHash, type Spec } from "./spec";
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
  host: HostPort;
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
  /** What the project is about, from the approved spec, or the draft's before approval. */
  about: ProjectAbout;
  /** The pending version's summary and done_when, while it waits for approval and changes them; null otherwise and in a rewound view. */
  aboutPending: PendingAbout | null;
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
  /** One entry per repo, in the spec's order; a single-repo project has one, named null. */
  repos: RepoOverview[];
  createdAt: number;
  updatedAt: number;
}

/** One repository of a project, as `bb loom show` and the page list it. */
export interface RepoOverview {
  /** The [[repo]] name; null for a single-repo project's own repository. */
  name: string | null;
  bbProjectId: string;
  /** bb's name for the bb project; null when bb cannot tell, and in a view that has not asked bb yet. */
  bbProjectName: string | null;
  base: string;
  /** The integration branch; null on the pull request strategy. */
  branch: string | null;
  /** The pull request a land opened; a direct land opens none and keeps an earlier one. */
  prUrl: string | null;
  landedAt: number | null;
  /** A ticket in the repo merged after its last land, so landing pushes new work. Always false on the pull request strategy. */
  toLand: boolean;
}

/** A repo's last land. */
export interface RepoLand {
  prUrl: string | null;
  landedAt: number | null;
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
  /** The ticket's [[repo]] name; null on a single-repo project. */
  repo: string | null;
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

/** A standard bb project the New project composer offers as a repo. */
export interface BbProjectChoice {
  id: string;
  name: string;
  /** The machines with a checkout of it, by host id; empty when no machine has one. */
  hostIds: string[];
}

const MAX_POST_LENGTH = 20_000;
const MAX_LISTED_PROJECTS = 20;

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
  private readonly host: HostPort;
  private readonly now: () => number;

  constructor(ctx: Ctx) {
    this.store = ctx.store;
    this.bb = ctx.bb;
    this.host = ctx.host;
    this.now = ctx.now;
  }

  // ---------------------------------------------------------------- propose

  async propose(args: { toml: string; threadId: string; bbProjectId: string; hostId: string | null }): Promise<ProposeResult> {
    const parsed = parseSpec(args.toml);
    if (!parsed.ok || parsed.spec === null) throw rejected(parsed.errors);
    const errors = [...proposalErrorsOf(parsed.spec), ...this.proposalErrors(args.threadId, parsed.spec), ...(await this.providerErrors(parsed.spec)), ...(await this.repoErrors(parsed.spec, args.hostId))];
    if (errors.length === 0) errors.push(...(await this.reachErrorsOf(parsed.spec, args)));
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

  /** Every [[repo]] must be a standard bb project with a checkout on the proposer's machine, where the project's workers run. Unlike providers, a list bb cannot read refuses the spec: the project could not start without its checkouts. */
  private async repoErrors(spec: Spec, hostId: string | null): Promise<string[]> {
    const repos = spec.repo ?? [];
    if (repos.length === 0) return [];
    if (hostId === null) {
      return ["repo: bb did not say which machine this thread runs on, so Loom cannot check that every repo has a checkout there. Call loom_propose again in a moment."];
    }
    let known: BbProjectInfo[];
    try {
      known = await this.bb.listProjects();
    } catch (error) {
      return [
        `repo: Loom could not read bb's projects to check the [[repo]] tables (${error instanceof Error ? error.message : String(error)}), and the project could not start without a checkout of every repo. Call loom_propose again in a moment.`,
      ];
    }
    const standard = known.filter((project) => project.kind === "standard");
    const listed =
      standard.length === 0
        ? "bb lists no standard projects. Add the repository to bb as a project first."
        : `Use the id of one of bb's projects: ${standard.slice(0, MAX_LISTED_PROJECTS).map((project) => `${project.name} (${project.id})`).join(", ")}${standard.length > MAX_LISTED_PROJECTS ? `, and ${standard.length - MAX_LISTED_PROJECTS} more` : ""}.`;
    return repos.flatMap((repo, index) => {
      const at = `repo[${index}].project`;
      const project = known.find((entry) => entry.id === repo.project);
      if (project === undefined) return [`${at}: bb has no project "${repo.project}". ${listed}`];
      if (project.kind !== "standard") return [`${at}: "${repo.project}" is bb's personal project, which has no git checkout. ${listed}`];
      if (project.sources.some((source) => source.hostId === hostId)) return [];
      return [
        `${at}: bb project ${project.name} (${project.id}) has no checkout on this machine (${hostId}), where the project's workers run. Clone it here with \`bb project source add ${project.id} --clone --machine ${hostId}\`, then call loom_propose again.`,
      ];
    });
  }

  /**
   * How the spec reaches each repo on the proposer's machine: its remote, its forge, its environment provider and its
   * integration worktree. Without a machine there is nothing to check, as for a single repo's checkout in repoErrors.
   */
  private async reachErrorsOf(spec: Spec, args: { bbProjectId: string; hostId: string | null }): Promise<string[]> {
    if (args.hostId === null) return [];
    try {
      return reachErrors(await gatherFacts({ bb: this.bb, host: this.host }, specTargets(spec, args.bbProjectId), args.hostId));
    } catch (error) {
      return [`merge: Loom could not check how the repositories are reached on this machine (${error instanceof Error ? error.message : String(error)}), and the project could not start without that. Call loom_propose again in a moment.`];
    }
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
    errors.push(...lockedRepoErrors(approved, spec), ...lockedReachErrors(approved, spec));
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
          merge_after_json: JSON.stringify((ticket.merge_after ?? []).map((ref) => keyOf.get(ref)!)),
          priority: ticket.priority,
          repo: ticket.repo ?? null,
          environment_json: ticket.environment === undefined ? null : JSON.stringify(ticket.environment.inputs),
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
  async startPlanning(a: { request: NewThreadRequest; merge: MergeChoice; reviewer: string; repos?: readonly string[] }): Promise<{ threadId: string }> {
    const title = planningTitle(a.request.input);
    if (title === "") throw new LoomError("loom_invalid_input", "Describe what should exist when the project is done.");
    if ((await this.bb.projectKind(a.request.projectId)) !== "standard") {
      throw new LoomError("loom_no_checkout", "Loom needs a bb project with a git checkout. Pick a project in the composer.");
    }
    const repos = await this.pickedRepos(a.request.projectId, a.repos ?? []);
    const threadId = await this.bb.spawnPlanner({ request: a.request, title: `Loom plan: ${title}`, kickoff: planningKickoff({ merge: a.merge, reviewer: a.reviewer, repos }) });
    this.store.addPlanning({ thread_id: threadId, bb_project_id: a.request.projectId, title });
    return { threadId };
  }

  /** The picked repos with bb's names, in the order picked, leaving out repeats and the composer's own project. Each must be a standard bb project. */
  private async pickedRepos(ownProjectId: string, ids: readonly string[]): Promise<PickedRepo[]> {
    if (ids.length > MAX_PLANNING_REPOS) throw new LoomError("loom_invalid_input", `Pick at most ${MAX_PLANNING_REPOS} repos; ${ids.length} were picked.`);
    const wanted = [...new Set(ids)].filter((id) => id !== ownProjectId);
    if (wanted.length === 0) return [];
    const known = await this.readBbProjects("check the picked repos");
    const found = wanted.map((id) => ({ id, project: known.find((entry) => entry.id === id) }));
    const problems = found.flatMap(({ id, project }) => {
      if (project === undefined) return [`bb has no project "${id}".`];
      return project.kind === "standard" ? [] : [`"${id}" is bb's personal project, which has no git checkout.`];
    });
    if (problems.length > 0) throw new LoomError("loom_invalid_input", `${problems.join(" ")} Pick the repos from bb's standard projects.`);
    return found.map(({ id, project }) => ({ id, name: project!.name }));
  }

  /** bb's standard projects by name, each with the machines that have a checkout of it, for the New project composer's repo picker. */
  async bbProjectChoices(): Promise<BbProjectChoice[]> {
    const known = await this.readBbProjects("list the repos");
    return known
      .filter((project) => project.kind === "standard")
      .map((project) => ({ id: project.id, name: project.name, hostIds: [...new Set(project.sources.map((source) => source.hostId))] }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  private async readBbProjects(why: string): Promise<BbProjectInfo[]> {
    try {
      return await this.bb.listProjects();
    } catch (error) {
      throw new LoomError("loom_unavailable", `Loom could not read bb's projects to ${why}: ${error instanceof Error ? error.message : String(error)}. Try again in a moment.`);
    }
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

  /** The overview with bb's name for each repo's bb project. */
  async namedOverview(slug: string): Promise<ProjectOverview> {
    const overview = this.overview(slug);
    return withRepoNames(overview, await this.bbProjectNames());
  }

  async namedList(): Promise<ProjectOverview[]> {
    const names = await this.bbProjectNames();
    return this.list().map((overview) => withRepoNames(overview, names));
  }

  /** bb's project names by id. When bb cannot list its projects there are none, and the views show the ids instead. */
  async bbProjectNames(): Promise<ReadonlyMap<string, string>> {
    try {
      return new Map((await this.bb.listProjects()).map((project) => [project.id, project.name]));
    } catch (error) {
      this.bb.log("warn", `Could not read bb's projects, so repos show their bb project id: ${error instanceof Error ? error.message : String(error)}`);
      return new Map();
    }
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
    // A single-repo project keeps its land in projects.pr_url and the project.landed events, with no project_repos row.
    const lands = isMultiRepo(spec)
      ? new Map(this.store.projectRepos(project.id).map((row): [string, RepoLand] => [row.name, { prUrl: row.pr_url, landedAt: row.landed_at }]))
      : landsOf(this.store.eventsOfKind(project.id, "project.landed"));
    return {
      slug: project.slug,
      name: project.name,
      key: project.key,
      state: project.state,
      goal: spec.project.goal,
      about: aboutOf(spec),
      aboutPending: project.pending_version === null || project.state === "archived" ? null : pendingAboutOf(aboutOf(spec), project.pending_version, this.specOf(project.id, project.pending_version)),
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
      repos: repoOverviews(project, spec, tickets, lands),
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

/** A revision after approval may add repos, but every approved repo keeps its name, bb project, base and remote: its tickets, branches and worktrees already use them. */
/** A repo's forge kind and whether it has a [merge.worktree] stay as approved: open pull requests and the integration worktree depend on them. */
function lockedReachErrors(approved: Spec, spec: Spec): string[] {
  const names: Array<string | null> = isMultiRepo(approved) ? approved.repo!.map((repo) => repo.name).filter((name) => spec.repo?.some((entry) => entry.name === name)) : isMultiRepo(spec) ? [] : [null];
  return names.flatMap((name) => {
    const before = repoSettings(approved, name);
    const after = repoSettings(spec, name);
    const at = (key: "forge" | "worktree") => (name === null ? `merge.${key}` : `repo[${spec.repo!.findIndex((entry) => entry.name === name)}].${key}`);
    const where = name === null ? "" : ` for the repo "${name}"`;
    const errors: string[] = [];
    if (before.forge.kind !== after.forge.kind) {
      errors.push(`${at("forge")}.kind: cannot change from "${before.forge.kind}" to "${after.forge.kind}"${where} after approval, because Loom follows open pull requests through the forge that opened them. Keep the kind, or archive this project and propose a new one.`);
    }
    if ((before.worktree === null) !== (after.worktree === null)) {
      errors.push(`${at("worktree")}: cannot be ${after.worktree === null ? "removed" : "added"}${where} after approval, because the integration worktree may already exist. Keep it as approved, or archive this project and propose a new one.`);
    }
    return errors;
  });
}

function lockedRepoErrors(approved: Spec, spec: Spec): string[] {
  const before = approved.repo ?? [];
  const after = spec.repo ?? [];
  if (before.length === 0) {
    if (after.length === 0) return [];
    return [
      "repo: cannot add [[repo]] tables after approval to a project approved without them, because its tickets, branches and worktrees already use the project's own repository. Remove the [[repo]] tables, or archive this project and propose a new one with them.",
    ];
  }
  const errors: string[] = [];
  for (const repo of before) {
    const index = after.findIndex((entry) => entry.name === repo.name);
    if (index < 0) {
      const renamed = after.findIndex((entry) => entry.project === repo.project && !before.some((other) => other.name === entry.name));
      errors.push(
        renamed < 0
          ? `repo: cannot remove repo "${repo.name}" after approval, because its tickets, branches and worktrees already use it. Keep its [[repo]] table; to stop work in it, cancel its tickets with the planner's board tools.`
          : `repo[${renamed}].name: cannot change from "${repo.name}" to "${after[renamed]!.name}" after approval, because its tickets, branches and worktrees already use the name. Keep the name "${repo.name}".`,
      );
      continue;
    }
    const was = repoSettings(approved, repo.name);
    const next = repoSettings(spec, repo.name);
    const why = "after approval, because its tickets, branches and worktrees already use it";
    if (was.bbProjectId !== next.bbProjectId) {
      errors.push(`repo[${index}].project: repo "${repo.name}" cannot change from "${was.bbProjectId}" to "${next.bbProjectId}" ${why}. Keep the project; for work in another repository, add a new [[repo]] table.`);
    }
    if (was.base !== next.base) {
      errors.push(`repo[${index}].base: repo "${repo.name}" cannot change from "${was.base}" to "${next.base}" ${why}. Set repo[${index}].base = "${was.base}" to keep it, or archive this project and propose a new one.`);
    }
    if (was.remote !== next.remote) {
      errors.push(`repo[${index}].remote: repo "${repo.name}" cannot change from "${was.remote}" to "${next.remote}" ${why}. Set repo[${index}].remote = "${was.remote}" to keep it, or archive this project and propose a new one.`);
    }
  }
  return errors;
}

/** One entry per repo of `spec`, in its order. `lands` holds each repo's last land by [[repo]] name, or by null for a single-repo project's own repository. */
export function repoOverviews(project: Pick<ProjectRow, "bb_project_id">, spec: Spec, tickets: readonly TicketRow[], lands: ReadonlyMap<string | null, RepoLand>): RepoOverview[] {
  const names = isMultiRepo(spec) ? spec.repo!.map((repo) => repo.name) : [null];
  return names.map((name) => {
    const settings = repoSettings(spec, name);
    const land = lands.get(name);
    const landedAt = land?.landedAt ?? null;
    // The rule of unlandedRepos in merge.ts, which imports this file.
    const toLand = settings.branch !== null && tickets.some((ticket) => ticket.repo === name && ticket.state === "done" && (landedAt ?? -1) < ticket.state_at);
    return { name, bbProjectId: settings.bbProjectId ?? project.bb_project_id, bbProjectName: null, base: settings.base, branch: settings.branch, prUrl: land?.prUrl ?? null, landedAt, toLand };
  });
}

/** Each repo's last land from the project.landed events, keyed by the repo an event names, or null for none. */
export function landsOf(events: readonly EventRow[]): Map<string | null, RepoLand> {
  const lands = new Map<string | null, RepoLand>();
  for (const event of events) {
    if (event.kind !== "project.landed") continue;
    const data = JSON.parse(event.data_json) as { repo?: unknown; url?: unknown };
    const name = typeof data.repo === "string" ? data.repo : null;
    lands.set(name, { prUrl: typeof data.url === "string" ? data.url : (lands.get(name)?.prUrl ?? null), landedAt: event.at });
  }
  return lands;
}

export function namedRepos<T extends { bbProjectId: string; bbProjectName: string | null }>(repos: readonly T[], names: ReadonlyMap<string, string>): T[] {
  return repos.map((repo) => ({ ...repo, bbProjectName: names.get(repo.bbProjectId) ?? null }));
}

export function withRepoNames<T extends { repos: RepoOverview[] }>(overview: T, names: ReadonlyMap<string, string>): T {
  return { ...overview, repos: namedRepos(overview.repos, names) };
}

function summaryOf(ticket: TicketRow): TicketSummary {
  return {
    key: ticket.key,
    ref: ticket.ref,
    title: ticket.title,
    state: ticket.state,
    repo: ticket.repo,
    priority: ticket.priority,
    deps: parseList(ticket.deps_json),
    attempt: ticket.attempt,
    blockedReason: ticket.blocked_reason,
  };
}
