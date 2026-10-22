// A project's record, built from its board, and its delivery to the done hook the user sets in Loom's settings.
// Loom only runs the user's command; what the command does with the record is the user's choice.
import type { PluginSettingDescriptors } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { EventRow, PostRow, ProjectRow, RecordRow, Store, TicketRow } from "./db/store";
import { plural } from "./format";
import { checkoutOf } from "./merge";
import { SpawnRefusedError, type ThreadInfo } from "./ports";
import { clip, recordPrompt } from "./prompts";
import { LoomError, landsOf, repoOverviews, type RepoOverview } from "./projects";
import { freshBaseOf, isMultiRepo, repoSettings } from "./repos";
import type { Spec } from "./spec";
import { LOOM_ACTOR } from "./states";
import { specOf, type EngineCtx } from "./workers";

export const SETTINGS = {
  doneHook: {
    type: "string",
    label: "Done hook",
    description:
      "A shell command Loom runs once when a project finishes, in the project's checkout on its machine, with a 2-minute limit. It reads the project's record (or its summary) on standard input and gets LOOM_PROJECT_SLUG, LOOM_PROJECT_NAME, LOOM_PROJECT_KEY, LOOM_PROJECT_URL (its pull request; on a multi-repo project, the first repo's that has one), LOOM_PROJECT_URLS (every repo's pull request, one per line) and LOOM_RECORD (summary or full). Empty turns it off. `bb loom report <slug> --send` runs it again for a finished project.",
    default: "",
    experimental_schema: z.string().max(4000),
  },
  doneRecord: {
    type: "select",
    label: "What the done hook reads",
    description:
      "A summary starts one agent on the project's reviewer model, only when a done hook is set; if it cannot finish in 30 minutes, the hook reads the full record instead.",
    options: ["summary", "full"],
    default: "summary",
    experimental_optionLabels: { summary: "A summary an agent writes from the record", full: "The full record" },
  },
} satisfies PluginSettingDescriptors;

export type DoneSettings = { doneHook: string; doneRecord: string };
export const NO_HOOK: DoneSettings = { doneHook: "", doneRecord: "summary" };

export const RECORD_MAX = 300_000;
export const HOOK_TIMEOUT_MS = 120_000;
export const SUMMARY_TIMEOUT_MS = 30 * 60_000;

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const minute = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")}Z`;
/** The posts a person needs later: what was handed in, judged and merged, what blocked it, and what the planner and the human said. */
const KEPT: ReadonlySet<PostRow["kind"]> = new Set(["submit", "review", "merge", "block"]);
const keep = (post: PostRow) => KEPT.has(post.kind) || ((post.kind === "reply" || post.kind === "system") && (post.author_kind === "human" || post.author_kind === "planner"));

/** The spec in force, or the latest proposal of a project not yet approved. */
function specFor(store: Store, project: ProjectRow): Spec {
  const version = project.approved_version ?? store.latestSpecVersion(project.id)?.version ?? null;
  const row = version === null ? null : store.specVersion(project.id, version);
  if (row === null) throw new LoomError("loom_invalid_state", `Project ${project.slug} has no spec.`);
  return JSON.parse(row.spec_json) as Spec;
}

type Landed = { repo?: string; direct?: boolean; pushed?: string; sha?: string; url?: string };

/** Where one project.landed event put the work, in lower case and with no full stop. */
function landing(event: EventRow): string {
  const data = JSON.parse(event.data_json) as Landed;
  return data.direct === true ? `pushed to ${data.pushed} at ${String(data.sha).slice(0, 12)}, ${minute(event.at)}` : `landed as ${data.url}, ${minute(event.at)}`;
}

const PER_TICKET = "One pull request per ticket; each ticket below names its own.";

function outcome(store: Store, project: ProjectRow, spec: Spec): string {
  if (spec.merge.strategy === "pr") return PER_TICKET;
  const landed = store.eventsOfKind(project.id, "project.landed").at(-1);
  if (landed === undefined) return `Not landed yet: the work is on the integration branch ${spec.merge.branch}.`;
  const text = landing(landed);
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

const repoLine = (repo: RepoOverview) => `- ${repo.name}: bb project ${repo.bbProjectId}, base ${repo.base}${repo.branch === null ? "" : `, integration branch ${repo.branch}`}.`;

/** One line per repo of a multi-repo project, in [[repo]] order: its last land, the merged work it has not landed, or none. */
function repoOutcomes(spec: Spec, repos: readonly RepoOverview[], events: readonly EventRow[]): string[] {
  if (spec.merge.strategy === "pr") return [PER_TICKET];
  const last = new Map<string, EventRow>();
  for (const event of events) {
    const name = (JSON.parse(event.data_json) as Landed).repo;
    if (typeof name === "string") last.set(name, event);
  }
  return repos.map((repo) => {
    const landed = last.get(repo.name!);
    if (repo.toLand) return `- ${repo.name}: not landed yet; its merged work is on the integration branch ${repo.branch}${landed === undefined ? "" : ` (before that, ${landing(landed)})`}.`;
    return landed === undefined ? `- ${repo.name}: no merged work.` : `- ${repo.name}: ${landing(landed)}.`;
  });
}

function ticketSection(store: Store, ticket: TicketRow, multi: boolean): string[] {
  const acceptance = JSON.parse(ticket.acceptance_json) as string[];
  const lines = [`### ${ticket.key} · ${ticket.title} (${ticket.state})`, ""];
  if (multi && ticket.repo !== null) lines.push(`Repo: ${ticket.repo}`, "");
  lines.push(ticket.body, "");
  if (ticket.pr_url !== null) lines.push(`Pull request: ${ticket.pr_url}`, "");
  if (acceptance.length > 0) lines.push("Acceptance criteria:", ...acceptance.map((line, index) => `${index + 1}. ${line}`), "");
  for (const post of store.posts(ticket.id).filter(keep)) lines.push(`#### ${post.kind} · ${post.author_kind} · ${minute(post.at)}`, "", post.body.trim(), "");
  return lines;
}

/** The project's record as Markdown, from its spec, tickets, posts and events; it works in any project state. */
export function projectRecord(store: Store, project: ProjectRow): string {
  const spec = specFor(store, project);
  const multi = isMultiRepo(spec);
  const tickets = store.tickets(project.id);
  const counts = new Map<string, number>();
  for (const ticket of tickets) counts.set(ticket.state, (counts.get(ticket.state) ?? 0) + 1);
  const tally = [...counts].map(([state, count]) => `${count} ${state}`).join(", ");
  const events = multi ? store.eventsOfKind(project.id, "project.landed") : [];
  const repos = multi ? repoOverviews(project, spec, tickets, landsOf(events)) : [];
  // A multi-repo project's top-level base is only a default its repos may override, so the Repos section names each one's.
  const where = multi ? `in ${plural(repos.length, "repo")}` : `base branch ${spec.project.base}`;
  const lines = [
    `# ${project.name} (${project.slug})`,
    "",
    `Loom project ${project.key}, ${project.state}, ${where}. ${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"}${tally === "" ? "" : `: ${tally}`}.`,
    "",
    "## Goal",
    "",
    spec.project.goal,
    "",
    ...(multi ? ["## Repos", "", ...repos.map(repoLine), ""] : []),
    "## Outcome",
    "",
    ...(multi ? repoOutcomes(spec, repos, events) : [outcome(store, project, spec)]),
    "",
    "## Tickets",
    "",
    ...tickets.flatMap((ticket) => ticketSection(store, ticket, multi)),
  ];
  return clip(`${lines.join("\n").trimEnd()}\n`, RECORD_MAX);
}

// ---------------------------------------------------------------- delivery

const inflightByStore = new WeakMap<Store, Map<number, Promise<void>>>();
const inflightOf = (store: Store) => inflightByStore.get(store) ?? inflightByStore.set(store, new Map()).get(store)!;

/** Waits for every delivery in flight. For tests. */
export async function settleRecords(ctx: EngineCtx): Promise<void> {
  const running = inflightOf(ctx.store);
  while (running.size > 0) await Promise.all([...running.values()]);
}

/** Moves each open record one step on, without waiting: a slow hook or summary never holds up the engine's pass. */
export function sendRecords(ctx: EngineCtx, settings: DoneSettings): void {
  const running = inflightOf(ctx.store);
  for (const row of ctx.store.openRecords()) {
    if (running.has(row.project_id)) continue;
    const run = deliver(ctx, row, settings)
      .catch((error) => ctx.bb.log("error", `The record of project ${row.project_id} failed: ${errText(error)}`))
      .finally(() => running.delete(row.project_id));
    running.set(row.project_id, run);
  }
}

async function deliver(ctx: EngineCtx, row: RecordRow, settings: DoneSettings): Promise<void> {
  const { store } = ctx;
  const project = store.project(row.project_id)!;
  if (row.state === "sending") {
    // Nothing in this process is sending it, so an earlier process was, and its hook may or may not have finished.
    return settle(ctx, row.id, project, { kind: "unknown", reason: `Loom restarted while the done hook ran, so it may not have finished; run \`bb loom report ${project.slug} --send\` to send it again` });
  }
  if (settings.doneHook.trim() === "") {
    if (row.thread_id !== null) await endAgent(ctx, await ctx.bb.getThread(row.thread_id));
    store.updateRecord(row.id, { state: "skipped" });
    store.changed(project.id);
    return;
  }
  if (row.state === "pending") {
    if (settings.doneRecord === "full") return runHook(ctx, row.id, project, settings, "full", projectRecord(store, project));
    return startSummary(ctx, row, project, settings);
  }
  return pollSummary(ctx, row, project, settings);
}

async function startSummary(ctx: EngineCtx, row: RecordRow, project: ProjectRow, settings: DoneSettings): Promise<void> {
  const { store } = ctx;
  const spec = specOf(store, project);
  // Marked before the spawn, so a restart during it sends the full record instead of starting a second agent.
  store.updateRecord(row.id, { state: "summarizing", started_at: ctx.now() });
  const agent = spec.agents.reviewer;
  const hostId = project.host_id;
  // A multi-repo project's agent starts in its first repo; it only reads the record, so any of them would do.
  const repo = isMultiRepo(spec) ? spec.repo![0]!.name : null;
  const spawn = async (sectionId: string | null) => {
    if (hostId === null) throw new Error("the project has no machine");
    return ctx.bb.spawnThread({
      bbProjectId: repoSettings(spec, repo).bbProjectId ?? project.bb_project_id,
      hostId,
      baseBranch: freshBaseOf(spec, repo),
      title: `${project.key} · record`,
      prompt: recordPrompt(project),
      detail: projectRecord(store, project),
      sectionId,
      metadata: { project: project.slug, role: "record" },
      providerId: agent.provider,
      model: agent.model,
      reasoningLevel: agent.reasoning,
      permissionMode: agent.permission_mode,
    });
  };
  let threadId: string;
  try {
    try {
      ({ threadId } = await spawn(project.section_id));
    } catch (error) {
      // A finished project's sidebar section is often deleted, and bb refuses a spawn into it; the agent does not need it.
      if (project.section_id === null || !(error instanceof SpawnRefusedError)) throw error;
      ({ threadId } = await spawn(null));
    }
  } catch (error) {
    return fullRecord(ctx, row.id, project, settings, `the summary agent could not start: ${errText(error)}`);
  }
  store.updateRecord(row.id, { thread_id: threadId });
  store.changed(project.id);
}

async function pollSummary(ctx: EngineCtx, row: RecordRow, project: ProjectRow, settings: DoneSettings): Promise<void> {
  if (row.thread_id === null) return fullRecord(ctx, row.id, project, settings, "Loom restarted before the summary agent started");
  const thread = await ctx.bb.getThread(row.thread_id);
  if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) return fullRecord(ctx, row.id, project, settings, "the summary agent's thread is gone");
  if (thread.status === "error") {
    await endAgent(ctx, thread);
    return fullRecord(ctx, row.id, project, settings, "the summary agent failed");
  }
  if (thread.status === "idle") {
    const summary = ((await ctx.bb.threadOutput(thread.id)) ?? "").trim();
    if (summary !== "") {
      await endAgent(ctx, thread);
      return runHook(ctx, row.id, project, settings, "summary", summary);
    }
  }
  if (ctx.now() - (row.started_at ?? 0) > SUMMARY_TIMEOUT_MS) {
    await endAgent(ctx, thread);
    return fullRecord(ctx, row.id, project, settings, "the summary agent took longer than 30 minutes");
  }
}

/** Stops a live summary agent and archives it, so none keeps running after its record is sent. Cleanup never blocks the send. */
async function endAgent(ctx: EngineCtx, thread: ThreadInfo | null): Promise<void> {
  if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) return;
  try {
    if (thread.status !== "idle" && thread.status !== "error") await ctx.bb.stop(thread.id);
    await ctx.bb.archive(thread.id);
  } catch (error) {
    ctx.bb.log("warn", `Could not end the summary agent ${thread.id}: ${errText(error)}`);
  }
}

const fullRecord = (ctx: EngineCtx, rowId: number, project: ProjectRow, settings: DoneSettings, why: string) =>
  runHook(ctx, rowId, project, settings, "full", projectRecord(ctx.store, project), why);

async function runHook(ctx: EngineCtx, rowId: number, project: ProjectRow, settings: DoneSettings, kind: "summary" | "full", text: string, fallback?: string): Promise<void> {
  const { store } = ctx;
  const command = settings.doneHook.trim();
  store.updateRecord(rowId, { state: "sending" });
  store.changed(project.id);
  let reason: string | null;
  try {
    const urls = pullRequests(store, project);
    const env = { LOOM_PROJECT_SLUG: project.slug, LOOM_PROJECT_NAME: project.name, LOOM_PROJECT_KEY: project.key, LOOM_PROJECT_URL: urls[0] ?? "", LOOM_PROJECT_URLS: urls.join("\n"), LOOM_RECORD: kind };
    const { hostId, repo } = await checkoutOf(ctx, project);
    const result = await ctx.host.call(hostId, "exec", { cwd: repo, command, timeoutMs: HOOK_TIMEOUT_MS, stdin: clip(text, RECORD_MAX), env });
    const output = result.output.trim() === "" ? "" : `: ${clip(result.output.trim().slice(-300), 300)}`;
    reason = result.timedOut ? "it timed out after 2 minutes" : result.exitCode === 0 ? null : result.exitCode === null ? `it was killed${output}` : `it exited with ${result.exitCode}${output}`;
  } catch (error) {
    reason = errText(error);
  }
  settle(ctx, rowId, project, reason === null ? { kind, fallback } : { kind, reason });
}

/** The project's landed pull requests: a single-repo project's one, or each repo's in [[repo]] order on a multi-repo project. */
function pullRequests(store: Store, project: ProjectRow): string[] {
  const spec = specFor(store, project);
  if (!isMultiRepo(spec)) return project.pr_url === null ? [] : [project.pr_url];
  const byName = new Map(store.projectRepos(project.id).map((row) => [row.name, row.pr_url]));
  return spec.repo!.flatMap((repo) => byName.get(repo.name) ?? []);
}

function settle(ctx: EngineCtx, rowId: number, project: ProjectRow, result: { kind: string; fallback?: string; reason?: string }): void {
  const { store } = ctx;
  store.tx(() => {
    if (result.reason === undefined) {
      store.updateRecord(rowId, { state: "sent" });
      store.event(project.id, null, "record.sent", LOOM_ACTOR, { kind: result.kind, ...(result.fallback === undefined ? {} : { fallback: result.fallback }) });
    } else {
      store.updateRecord(rowId, { state: "failed" });
      store.event(project.id, null, "record.failed", LOOM_ACTOR, { kind: result.kind, reason: result.reason });
    }
  });
}
