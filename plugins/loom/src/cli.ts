import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { Store } from "./db/store";
import type { Engine } from "./engine";
import { formatDuration, noTokenUsage, readyToLand } from "./format";
import type { ProjectMetrics } from "./metrics";
import { LoomError, type ApproveResult, type ProjectOverview, type Projects, type SpecView, type TicketSummary, type TicketView } from "./projects";
import { projectFeed, projectMetrics } from "./reports";
import { HUMAN_ACTOR, TICKET_STATES } from "./states";

const json = { type: "boolean", description: "Print machine-readable JSON." } as const;
const version = { type: "integer", min: 1, max: 1_000_000, description: "A spec version number." } as const;
const toJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const minute = (at: number) => `${new Date(at).toISOString().slice(0, 16)}Z`;

const SLUG = { name: "slug", description: "The project's slug, from `bb loom list`.", required: true } as const;
const KEY = { name: "key", description: "A ticket key such as CSV-1.", required: true } as const;

type HumanActionData = { slug?: string; key?: string; [extra: string]: unknown };

// Every command that changes state runs through here, so the human-only rule and the intervention record live in one place.
export async function humanAction<T>(
  deps: { projects: Projects; store: Store },
  ctx: { threadId?: string },
  action: string,
  data: HumanActionData,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (ctx.threadId !== undefined && deps.projects.roleOf(ctx.threadId) !== null) {
    throw new PluginCliError(`"${action}" is for the human: Loom planner, worker and reviewer threads cannot run it.`, {
      code: "loom_human_only",
      hint: "Tell the human what you need and let them run the command.",
    });
  }
  const result = await fn();
  const ticket = data.key === undefined ? null : deps.store.ticketByKey(data.key);
  const project = data.slug !== undefined ? deps.store.projectBySlug(data.slug) : ticket === null ? null : deps.store.project(ticket.project_id);
  if (project !== null) deps.store.event(project.id, ticket?.id ?? null, "human.action", HUMAN_ACTOR, { action, ...data, slug: project.slug });
  return result;
}

async function guarded(fn: () => Promise<PluginCliResult> | PluginCliResult): Promise<PluginCliResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LoomError) throw new PluginCliError(error.message, { code: error.code, hint: error.hint });
    throw error;
  }
}

const out = (stdout: string): PluginCliResult => ({ exitCode: 0, stdout });

function nextStep(project: ProjectOverview): string {
  const { slug } = project;
  if (readyToLand(project)) return `Every ticket is finished. Land it with \`bb loom land ${slug}\`, which pushes the integration branch and opens one pull request.`;
  switch (project.state) {
    case "draft":
      return `Read the spec with \`bb loom spec ${slug}\`, then approve it with \`bb loom approve ${slug}\`.`;
    case "ready":
      return `Start it with \`bb loom start ${slug}\`.`;
    case "running":
      return `Pause it with \`bb loom pause ${slug}\`.`;
    case "paused":
      return `Resume it with \`bb loom resume ${slug}\`.`;
    default:
      return "";
  }
}

function formatList(projects: ProjectOverview[]): string {
  if (projects.length === 0) return "No Loom projects yet. Open Loom in bb's left navigation and press New project, or ask a thread to plan one.\n";
  const width = Math.max(...projects.map((project) => project.slug.length));
  const rows = projects.map((project) => `${project.slug.padEnd(width)}  ${project.state.padEnd(8)}  ${project.key.padEnd(8)}  ${String(project.ticketCount).padStart(3)} tickets  ${project.name}`);
  return `${rows.join("\n")}\n`;
}

function formatShow(project: ProjectOverview): string {
  const merge = project.strategy === "integration" ? `integration branch ${project.branch}` : "one pull request per ticket";
  const counts = Object.entries(project.ticketCounts).map(([state, count]) => `${state} ${count}`);
  const specLine =
    project.approvedVersion === null
      ? "Spec: not approved yet."
      : `Spec: approved v${project.approvedVersion}${project.pendingVersion === null ? "" : `, pending v${project.pendingVersion} (read it with \`bb loom spec ${project.slug} --version ${project.pendingVersion}\`)`}.`;
  const lines = [
    `${project.name} (${project.slug}) · ${project.state}`,
    `Goal: ${project.goal}`,
    `Key ${project.key} · base ${project.base} · ${merge}`,
    specLine,
    `Tickets: ${project.ticketCount}${counts.length > 0 ? ` (${counts.join(", ")})` : ""}`,
  ];
  if (project.plannerThreadId !== null) lines.push(`Planner thread: ${project.plannerThreadId}`);
  if (project.reason !== null) lines.push(`Reason: ${project.reason}`);
  const next = nextStep(project);
  if (next !== "") lines.push(`Next: ${next}`);
  return `${lines.join("\n")}\n`;
}

function formatSpec(spec: SpecView): string {
  return `# ${spec.slug} · spec v${spec.version} (${spec.status}) · proposed by ${spec.proposedBy} · ${minute(spec.createdAt)}\n${spec.toml}${spec.toml.endsWith("\n") ? "" : "\n"}`;
}

function formatTickets(tickets: TicketSummary[]): string {
  if (tickets.length === 0) return "No tickets.\n";
  const rows = tickets.map((ticket) => {
    const after = ticket.deps.length > 0 ? `  (after ${ticket.deps.join(", ")})` : "";
    return `${ticket.key}  ${ticket.state.padEnd(9)}  P${ticket.priority}  ${ticket.title}${after}`;
  });
  return `${rows.join("\n")}\n`;
}

export function formatTicket(ticket: TicketView): string {
  const lines = [`${ticket.key} · ${ticket.state} · ${ticket.title}`];
  if (ticket.blockedReason !== null) lines.push(`Blocked: ${ticket.blockedReason}`);
  for (const post of ticket.posts) {
    const indent = "  ".repeat(post.depth);
    lines.push("", `${indent}#${post.id} ${post.author_kind} ${post.kind} ${minute(post.at)}`, ...post.body.split("\n").map((line) => (line === "" ? "" : `${indent}${line}`)));
  }
  return `${lines.join("\n")}\n`;
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function formatMetrics(m: ProjectMetrics): string {
  const counts = TICKET_STATES.filter((state) => m.counts[state] > 0).map((state) => `${state} ${m.counts[state]}`);
  const done = m.throughput.reduce((sum, day) => sum + day.done, 0);
  const pair = (label: string, pct: ProjectMetrics["cycleTime"]) =>
    pct.n === 0 ? `${label} none yet` : `${label} p50 ${formatDuration(pct.p50!)}, p85 ${formatDuration(pct.p85!)} (${plural(pct.n, "ticket")})`;
  const oldest = m.wipAge[0];
  const { tokens } = m;
  return `${[
    `tickets ${counts.length === 0 ? "none" : counts.join(", ")}`,
    `work in progress ${m.wip}`,
    `throughput ${done} done in the last ${plural(m.throughput.length, "day")}, ${(done / Math.max(1, m.throughput.length)).toFixed(1)} per day`,
    pair("cycle time", m.cycleTime),
    pair("lead time", m.leadTime),
    oldest === undefined ? "work item age none in flight" : `work item age oldest ${oldest.key} (${oldest.state}) ${formatDuration(oldest.ageMs)}, ${m.wip} in flight`,
    m.firstPassApproval.rate === null
      ? "first-pass approval none yet"
      : `first-pass approval ${percent(m.firstPassApproval.rate)} (${Math.round(m.firstPassApproval.rate * m.firstPassApproval.n)} of ${plural(m.firstPassApproval.n, "ticket")} with a verdict)`,
    m.reviewRounds.mean === null ? "review rounds none yet" : `review rounds ${m.reviewRounds.mean.toFixed(1)} per done ticket (${m.reviewRounds.n} done)`,
    m.checks.total === 0 ? "checks none run" : `checks ${m.checks.total} run, ${m.checks.failed} failed (${percent(m.checks.failed / m.checks.total)})`,
    `blocks ${m.blocks}`,
    `human interventions ${m.humanInterventions}`,
    `tokens (sampled) ${tokens.total} in all${tokens.perDoneTicket === null ? "" : `, ${Math.round(tokens.perDoneTicket)} per done ticket`}; planner ${tokens.byRole.planner}, worker ${tokens.byRole.worker}, reviewer ${tokens.byRole.reviewer}${tokens.unreported === 0 ? "" : `; ${noTokenUsage(tokens.unreported)}`}`,
    `active time ${formatDuration(m.activeMs)}`,
    ...newMetricLines(m),
  ].join("\n")}\n`;
}

function newMetricLines(m: ProjectMetrics): string[] {
  const { timeInState: time, findings, reliability } = m;
  const total = TICKET_STATES.reduce((sum, state) => sum + time.ms[state], 0);
  const shares = TICKET_STATES.filter((state) => time.ms[state] > 0).map((state) => `${state.replace("_", " ")} ${percent(time.ms[state] / total)}`);
  const checks = m.checksByCommand.map((check) => `${check.command} ${plural(check.runs, "run")}, ${check.failed} failed, p50 ${check.p50Ms === null ? "none" : formatDuration(check.p50Ms)}`);
  return [
    time.n === 0 || time.flowEfficiency === null ? "time in state none yet" : `time in state (${plural(time.n, "done ticket")}) ${shares.join(", ")}; flow efficiency ${percent(time.flowEfficiency)}`,
    `checks by command ${checks.length === 0 ? "none yet" : checks.join("; ")}`,
    `scope flags ${m.scopeFlags.outside} outside scope, ${m.scopeFlags.protectedHits} on protected paths`,
    findings.rounds === 0
      ? "review findings none yet"
      : `review findings ${findings.total} in ${plural(findings.rounds, "round")} (${findings.blocking} blocking, ${findings.shouldFix} should-fix), changes requested in ${findings.changesRequested}`,
    `tokens by ticket ${m.tokensByTicket.length === 0 ? "none yet" : m.tokensByTicket.map((entry) => `${entry.key} ${entry.tokens}`).join(", ")}`,
    `reliability ${plural(reliability.failedAttempts, "failed attempt")}, ${reliability.rateLimitRetries} rate-limit ${reliability.rateLimitRetries === 1 ? "retry" : "retries"}, ${plural(reliability.timeouts, "timeout")}, ${plural(reliability.mergesSentBack, "merge")} sent back`,
  ];
}

function formatApprove(result: ApproveResult): string {
  if (result.applied === "pending") return `Applied spec v${result.version} to ${result.slug}. Its tickets are unchanged.\n`;
  const keys = result.tickets.length <= 8 ? result.tickets.join(", ") : `${result.tickets[0]} to ${result.tickets.at(-1)}`;
  return `Approved ${result.slug}. It is ready with ${result.tickets.length} ${result.tickets.length === 1 ? "ticket" : "tickets"}: ${keys}.\nStart it with \`bb loom start ${result.slug}\`.\n`;
}

export function createCli(projects: Projects, engine: Engine, store: Store, now: () => number): PluginCliRegistration {
  const deps = { projects, store };
  const lifecycle = (summary: string, run: (slug: string, actor: string) => Promise<unknown>, action: string, say: (slug: string) => string) =>
    cliCommand({
      summary,
      positionals: [SLUG],
      options: { json },
      run: ({ options, positionals }, ctx) =>
        guarded(async () => {
          await humanAction(deps, ctx, action, { slug: positionals.slug }, () => run(positionals.slug, HUMAN_ACTOR));
          return out(options.json ? toJson(projects.overview(positionals.slug)) : `${say(positionals.slug)}\n`);
        }),
    });

  return defineCli({
    name: "loom",
    summary: "Run a software project with agents (Loom): specs, a ticket board, and the human's controls",
    commands: {
      list: cliCommand({
        summary: "List Loom projects with their state and ticket count",
        options: { json },
        run: ({ options }) => guarded(() => out(options.json ? toJson(projects.list()) : formatList(projects.list()))),
      }),
      show: cliCommand({
        summary: "Show a project: state, goal, merge setup, spec versions, ticket counts and the next step",
        positionals: [SLUG],
        options: { json },
        run: ({ options, positionals }) =>
          guarded(() => {
            const project = projects.overview(positionals.slug);
            return out(options.json ? toJson(project) : formatShow(project));
          }),
      }),
      spec: cliCommand({
        summary: "Print a project's spec as TOML (the approved version, or the draft)",
        positionals: [SLUG],
        options: { version: { ...version, description: "A spec version; `bb loom show` names the pending one." }, json },
        run: ({ options, positionals }) =>
          guarded(() => {
            const spec = projects.spec(positionals.slug, options.version);
            return out(options.json ? toJson(spec) : formatSpec(spec));
          }),
      }),
      tickets: cliCommand({
        summary: "List a project's tickets, optionally only those in some states",
        positionals: [SLUG],
        options: {
          state: { type: "enum", values: TICKET_STATES, repeatable: true, split: ",", description: "Only tickets in these states, comma-separated." },
          json,
        },
        run: ({ options, positionals }) =>
          guarded(() => {
            const tickets = projects.tickets(positionals.slug, options.state.length > 0 ? options.state : undefined);
            return out(options.json ? toJson(tickets) : formatTickets(tickets));
          }),
      }),
      ticket: cliCommand({
        summary: "Show a ticket and its reply thread, indented by reply depth",
        positionals: [KEY],
        options: { json },
        run: ({ options, positionals }) =>
          guarded(() => {
            const ticket = projects.ticketView(positionals.key);
            return out(options.json ? toJson(ticket) : formatTicket(ticket));
          }),
      }),
      metrics: cliCommand({
        summary: "Print a project's flow and agent metrics, computed from its event log",
        positionals: [SLUG],
        options: { days: { type: "integer", min: 1, max: 90, description: "The window for throughput and cumulative flow, in days (default 14)." }, json },
        run: ({ options, positionals }) =>
          guarded(() => {
            const metrics = projectMetrics(store, projects.require(positionals.slug), now(), options.days);
            return out(options.json ? toJson(metrics) : formatMetrics(metrics));
          }),
      }),
      feed: cliCommand({
        summary: "Print a project's newest events as one sentence each, oldest first",
        positionals: [SLUG],
        options: { after: { type: "integer", min: 0, max: 2_000_000_000, description: "Only events after this event id; `--json` prints the last id as lastId." }, json },
        run: ({ options, positionals }) =>
          guarded(() => {
            const feed = projectFeed(store, projects.require(positionals.slug), options.after);
            if (options.json) return out(toJson(feed));
            return out(feed.rows.length === 0 ? "No events.\n" : `${feed.rows.map((row) => `${minute(row.at)}  ${row.text}`).join("\n")}\n`);
          }),
      }),
      post: cliCommand({
        summary: "Add your reply to a ticket's thread; a worker that holds the ticket gets it as a message (human only)",
        positionals: [KEY, { name: "text", description: "What to say.", required: true, variadic: true }],
        options: { "reply-to": { type: "integer", min: 1, max: 2_147_483_647, description: "Answer this post (its #id from `bb loom ticket`). Without it the post starts a new top-level post." }, json },
        run: ({ options, positionals }, ctx) =>
          guarded(async () => {
            const post = await humanAction(deps, ctx, "post", { key: positionals.key }, () =>
              engine.humanPost(positionals.key, positionals.text.join(" "), options["reply-to"]),
            );
            return out(options.json ? toJson(post) : `Posted #${post.id} on ${positionals.key}.\n`);
          }),
      }),
      block: cliCommand({
        summary: "Block a ticket with a reason; a worker that holds it is stopped and the planner sees it at the next triage round (human only)",
        positionals: [KEY, { name: "reason", description: "Why the ticket is blocked.", required: true, variadic: true }],
        options: { json },
        run: ({ options, positionals }, ctx) =>
          guarded(async () => {
            const reason = positionals.reason.join(" ");
            const ticket = await humanAction(deps, ctx, "block", { key: positionals.key }, () => engine.block(positionals.key, reason, HUMAN_ACTOR));
            return out(options.json ? toJson(projects.ticketView(ticket.key)) : `${ticket.key} is blocked: ${reason}\n`);
          }),
      }),
      requeue: cliCommand({
        summary: "Send a blocked ticket back to the queue, with an optional note for the next worker (human only)",
        positionals: [KEY],
        options: { note: { type: "string", description: "Your answer or instruction; it is added to the ticket's thread and the next worker reads it." }, json },
        run: ({ options, positionals }, ctx) =>
          guarded(async () => {
            const ticket = await humanAction(deps, ctx, "requeue", { key: positionals.key }, () => engine.requeue(positionals.key, options.note ?? "", HUMAN_ACTOR));
            return out(options.json ? toJson(projects.ticketView(ticket.key)) : `${ticket.key} is queued again. A new worker starts from its branch when a slot is free.\n`);
          }),
      }),
      cancel: cliCommand({
        summary: "Cancel a ticket: a worker that holds it is stopped (human only)",
        positionals: [KEY, { name: "reason", description: "Why the ticket is cancelled.", required: true, variadic: true }],
        options: { json },
        run: ({ options, positionals }, ctx) =>
          guarded(async () => {
            const reason = positionals.reason.join(" ");
            const ticket = await humanAction(deps, ctx, "cancel", { key: positionals.key }, () => engine.cancel(positionals.key, reason, HUMAN_ACTOR));
            return out(options.json ? toJson(projects.ticketView(ticket.key)) : `${ticket.key} is cancelled: ${reason}\n`);
          }),
      }),
      land: cliCommand({
        summary: "Land the integration branch: push it and open one pull request to the base branch, or push the new commits to the open one (human only)",
        positionals: [SLUG],
        options: {
          title: { type: "string", description: "The pull request's title; the project's name by default. Used when the pull request is opened." },
          ready: { type: "boolean", description: "Open a ready pull request instead of a draft. Used when the pull request is opened." },
          json,
        },
        run: ({ options, positionals }, ctx) =>
          guarded(async () => {
            const data = options.ready ? { slug: positionals.slug, ready: true } : { slug: positionals.slug };
            const result = await humanAction(deps, ctx, "land", data, () => engine.land(positionals.slug, HUMAN_ACTOR, { title: options.title, ready: options.ready === true }));
            return out(options.json ? toJson(result) : `Landed ${positionals.slug}: ${result.url}\n${result.done ? "Every ticket is done or cancelled, so the project is done.\n" : "Run `bb loom land` again after more tickets merge to push them to the same pull request.\n"}`);
          }),
      }),
      approve: cliCommand({
        summary: "Approve a draft (creates its tickets), or apply a pending spec version (human only)",
        positionals: [SLUG],
        options: { version: { ...version, description: "The version to approve; it must be the one waiting for approval." }, json },
        run: ({ options, positionals }, ctx) =>
          guarded(async () => {
            const project = deps.store.projectBySlug(positionals.slug);
            const pending = project !== null && project.state !== "draft" && project.pending_version !== null;
            const result = await humanAction(deps, ctx, "approve", { slug: positionals.slug, pending }, () => projects.approve(positionals.slug, HUMAN_ACTOR, options.version));
            return out(options.json ? toJson(result) : formatApprove(result));
          }),
      }),
      start: lifecycle("Start an approved project: workers pick up its ready tickets by themselves (human only)", (slug, actor) => engine.start(slug, actor), "start", (slug) => `${slug} is running. Workers start by themselves; follow them with \`bb loom tickets ${slug}\`.`),
      pause: cliCommand({
        summary: "Pause a running project (human only)",
        positionals: [SLUG],
        options: { now: { type: "boolean", description: "Also stop every worker thread right away; resume continues them." }, json },
        run: ({ options, positionals }, ctx) =>
          guarded(async () => {
            const data = options.now ? { slug: positionals.slug, now: true } : { slug: positionals.slug };
            await humanAction(deps, ctx, "pause", data, () => engine.pause(positionals.slug, HUMAN_ACTOR, options.now === true));
            return out(options.json ? toJson(projects.overview(positionals.slug)) : `${positionals.slug} is paused.\n`);
          }),
      }),
      resume: lifecycle("Resume a paused project and continue its stopped workers (human only)", (slug, actor) => engine.resume(slug, actor), "resume", (slug) => `${slug} is running.`),
      archive: lifecycle("Archive a project: stop its workers, cancel its open tickets and remove its sidebar section (human only)", (slug, actor) => engine.archive(slug, actor), "archive", (slug) => `${slug} is archived: its open tickets are cancelled and its sidebar section is removed.`),
    },
  });
}
