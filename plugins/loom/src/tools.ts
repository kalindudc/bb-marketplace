// Agent tools, gated by role twice: bb.agents.configure selects them from the
// plugin's own threads table, and every call re-checks the role there too.
// Thread metadata never grants a role: any client can write it.
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ASK_ACTIONS, recordAsk } from "./asks";
import { submit } from "./checks";
import { formatTicket } from "./cli";
import { StoreError, type ThreadRow, type TicketRow } from "./db/store";
import { discoverText, gatherFacts, type RepoTarget } from "./discover";
import type { Engine } from "./engine";
import { LoomError, type ProposeResult, type Projects } from "./projects";
import { specReviewBlocks } from "./format";
import { handInPrText } from "./pull-requests";
import { approve, requestChanges } from "./review";
import { ticketPatchSchema, ticketSpecSchema } from "./spec";
import { ensureSpecReview, specReviewerOf, specVerdict, type SpecReviewStatus } from "./spec-review";
import { SPEC_REVIEW_ROUNDS, TICKET_STATES } from "./states";
import { addTickets, boardText, editTicket } from "./triage";
import { blockTicket, requeueTicket } from "./workers";

export const PLANNER_TOOLS = ["loom_propose", "loom_discover", "loom_board", "loom_ticket", "loom_requeue", "loom_add_tickets", "loom_edit_ticket", "loom_cancel_ticket", "loom_post", "loom_ask_human"] as const;
export const WORKER_TOOLS = ["loom_note", "loom_submit", "loom_block", "loom_pr"] as const;
export const REVIEWER_TOOLS = ["loom_note", "loom_approve", "loom_request_changes"] as const;
export const ORDINARY_TOOLS = ["loom_propose", "loom_discover"] as const;
export const SPEC_REVIEWER_TOOLS = ["loom_spec_approve", "loom_spec_request_changes"] as const;
export const SKILLS = { plan: "loom-plan", usage: "loom" } as const;

const MAX_OUTPUT = 12_000;

const findingSchema = z.object({
  severity: z.enum(["blocking", "should-fix"]).describe("blocking stops the ticket from merging; should-fix is worth doing but does not stop it."),
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(2000).describe("What is wrong and how to fix it."),
  file: z.string().min(1).max(500).optional(),
  line: z.number().int().min(1).optional(),
});

const specFindingSchema = z.object({
  path: z.string().min(1).max(200).optional().describe("The part of the spec, such as ticket[csv-export] or ticket[csv-export].acceptance[1]: tickets by ref, list items counted from 0."),
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(2000).describe("What is wrong, and the smaller or right alternative."),
});

const askStepSchema = z.object({
  action: z.enum(ASK_ACTIONS).describe("approve a spec version, requeue or reply on a ticket, start, resume or land the project, or other for anything else."),
  version: z.number().int().positive().optional().describe("For approve: the version that waits for approval."),
  key: z.string().min(1).max(40).optional().describe("For requeue and reply: the ticket key, such as CSV-1."),
  text: z.string().min(1).max(500).describe("One sentence the human reads: what to do and why."),
});

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function run(fn: () => Promise<string> | string): Promise<PluginAgentToolResult> {
  try {
    return clip(await fn(), MAX_OUTPUT);
  } catch (error) {
    return { content: [{ type: "text", text: clip(errText(error), 4000) }], isError: true };
  }
}

/** What the planner reads about the draft's spec review; empty when there is none to wait for. */
function reviewLines(version: number, review: SpecReviewStatus | null): string[] {
  switch (review?.kind) {
    case "reviewing":
      if (review.waiting !== undefined) return [`Spec review: its reviewer for v${version} could not start (${review.waiting.reason}); Loom tries again by itself. Do not hand over yet: end your turn; Loom sends the verdict to this thread.`];
      return [`Spec review: a separate reviewer now checks v${version} against the human's request and for work the goal does not need (round ${review.round} of ${SPEC_REVIEW_ROUNDS}). Do not hand over yet: end your turn; Loom sends the verdict to this thread.`];
    case "changes":
      return [`Spec review: v${version} has ${review.findings.length === 1 ? "1 open finding" : `${review.findings.length} open findings`} from round ${review.round}. Revise the spec for them and call loom_propose again; do not hand over yet.`];
    case "failed":
      return [`Spec review: it did not finish: ${review.reason}. Call loom_propose again with the same spec to retry; do not hand over until a review passes.`];
    case "approved":
      return [`Spec review: v${version} passed.`];
    case "limit":
      return [`Spec review: Loom stopped reviewing after ${SPEC_REVIEW_ROUNDS} rounds; tell the human which findings you left open.`];
    default:
      return [];
  }
}

function proposeReport(result: ProposeResult, review: SpecReviewStatus | null): string {
  const { slug, version } = result;
  const lines: string[] = [];
  if (result.change === "created") lines.push(`Draft ready: \`${slug}\` · spec v${version}.`);
  else if (result.change === "revised") lines.push(`Draft \`${slug}\` revised · spec v${version}.`);
  else if (result.change === "pending") lines.push(`Spec v${version} of \`${slug}\` is pending: the project keeps its approved spec until the human approves v${version}.`);
  else lines.push(`No change: spec v${version} of \`${slug}\` is already saved${result.pending ? " and pending" : ""}.`);
  if (result.warnings.length > 0) lines.push("Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  if (result.pending) {
    lines.push(...reviewLines(version, review));
    if (!specReviewBlocks(review)) lines.push(`Needs you (human): read it with \`bb loom spec ${slug} --version ${version}\`, then apply it with \`bb loom approve ${slug} --version ${version}\`. Record what else the human should do after approving, such as requeue tickets, with loom_ask_human.`);
  } else if (result.state === "draft") {
    lines.push(...reviewLines(version, review));
    if (!specReviewBlocks(review)) lines.push(`Needs you (human): read the spec with \`bb loom spec ${slug}\`, approve it with \`bb loom approve ${slug}\`, then start the project with \`bb loom start ${slug}\`. You never approve, start or pause a project.`);
  }
  return lines.join("\n");
}

export function registerTools(bb: BbPluginApi, projects: Projects, engine: Engine): void {
  const { store } = projects;
  const ctx = engine.ctx;
  const log = (what: string, error: unknown) => ctx.bb.log("warn", `${what}: ${errText(error)}`);

  // The live worker of a ticket in working, by the plugin's own table.
  const worker = (threadId: string): { row: ThreadRow; ticket: TicketRow } => {
    const row = projects.requireRole(threadId, "worker");
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    if (row.state !== "active" || ticket === null || ticket.state !== "working" || ticket.worker_thread_id !== threadId) {
      throw new LoomError("loom_invalid_state", "You are not the live worker of a ticket in working state, so this tool has nothing to act on.");
    }
    return { row, ticket };
  };

  // An active planner row, and the ticket it names when it names one: both must belong to the same project.
  const planner = (threadId: string, key?: string): { row: ThreadRow; projectId: number; ticket: TicketRow | null } => {
    const row = projects.requireRole(threadId, "planner");
    if (row.state !== "active") throw new LoomError("loom_forbidden", "This planner thread has ended.");
    if (key === undefined) return { row, projectId: row.project_id, ticket: null };
    const ticket = store.ticketByKey(key);
    if (ticket === null) throw new LoomError("loom_not_found", `No ticket ${key}.`, "Use loom_board to see the ticket keys.");
    if (ticket.project_id !== row.project_id) throw new LoomError("loom_forbidden", `${key} belongs to another project than the one this thread plans.`);
    return { row, projectId: row.project_id, ticket };
  };

  bb.agents.registerTool({
    name: "loom_propose",
    description:
      "Submit a Loom project spec (TOML) for validation. Creates the project as a draft, or revises its draft, and binds this thread as the project's planner. An invalid spec is refused with numbered errors and nothing is saved. The human approves and starts the project with `bb loom approve <slug>` and `bb loom start <slug>`.",
    presentation: { label: { pending: "Proposing Loom project", completed: "Proposed Loom project" } },
    parameters: z.object({ spec_toml: z.string().min(50).max(262_144).describe("The full project spec in TOML; see the loom-plan skill.") }),
    execute: ({ spec_toml }, tool) =>
      run(async () => {
        const hostId = await projects.hostOf(tool.threadId);
        const result = await projects.propose({ toml: spec_toml, threadId: tool.threadId, bbProjectId: tool.projectId, hostId });
        return proposeReport(result, result.state === "draft" || result.pending ? await ensureSpecReview(ctx, result.slug) : null);
      }),
  });

  bb.agents.registerTool({
    name: "loom_discover",
    description:
      "Before proposing a Loom spec: for each repo, its git remotes, whether gh can open pull requests there, the environment providers bb offers for it on this machine (with their inputs schemas), and whether Loom can add its own integration worktree. Every choice comes back as found or ask; ask the human about each ask item before you propose.",
    presentation: { label: { pending: "Discovering how the repos are reached", completed: "Discovered how the repos are reached" } },
    parameters: z.object({
      projects: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(10)
        .optional()
        .describe("bb project ids of the repos, in the order of their [[repo]] tables; leave out for this thread's own project"),
    }),
    execute: ({ projects: ids }, tool) =>
      run(async () => {
        const hostId = await projects.hostOf(tool.threadId);
        if (hostId === null) throw new LoomError("loom_unavailable", "bb did not say which machine this thread runs on, so Loom cannot look at its checkouts. Call loom_discover again in a moment.");
        let targets: RepoTarget[] = [{ label: "this thread's repository", index: null, bbProjectId: tool.projectId, settings: null }];
        if (ids !== undefined) {
          const names = new Map((await ctx.bb.listProjects()).map((project) => [project.id, project.name]));
          targets = ids.map((id, index) => ({ label: `the repo of bb project ${names.get(id) ?? id}`, index, bbProjectId: id, settings: null }));
        }
        return discoverText(await gatherFacts(ctx, targets, hostId));
      }),
  });

  // ---- the planner's board tools

  bb.agents.registerTool({
    name: "loom_board",
    description: "The project's board: every ticket with its state, priority, repo on a project with [[repo]] tables, dependencies and how long it has been in that state. Optionally only the tickets in one state.",
    presentation: { label: { pending: "Reading the Loom board", completed: "Read the Loom board" } },
    parameters: z.object({ state: z.enum(TICKET_STATES).optional().describe("Only tickets in this state.") }),
    execute: ({ state }, tool) => run(() => boardText(ctx, planner(tool.threadId).projectId, state === undefined ? undefined : [state])),
  });

  bb.agents.registerTool({
    name: "loom_ticket",
    description: "One ticket and its whole reply thread, indented by reply depth: the brief, claims, notes, check results, reviews, block reasons and replies.",
    presentation: { label: { pending: "Reading a Loom ticket", completed: "Read a Loom ticket" } },
    parameters: z.object({ key: z.string().min(1).max(40).describe("A ticket key such as CSV-1.") }),
    execute: ({ key }, tool) =>
      run(() => {
        planner(tool.threadId, key);
        return formatTicket(projects.ticketView(key));
      }),
  });

  bb.agents.registerTool({
    name: "loom_requeue",
    description: "Send a blocked ticket back to the queue. Post your answer first (loom_post) or pass it as the note: the next worker starts from the previous branch and reads the whole thread.",
    presentation: { label: { pending: "Requeueing a Loom ticket", completed: "Requeued a Loom ticket" } },
    parameters: z.object({ key: z.string().min(1).max(40), note: z.string().max(20_000).describe("Your answer or instruction for the next worker. May be empty when you already posted it.") }),
    execute: ({ key, note }, tool) =>
      run(async () => {
        planner(tool.threadId, key);
        await requeueTicket(ctx, key, { note, actor: tool.threadId, author: "planner", threadId: tool.threadId });
        return `${key} is queued again. A new worker starts from its branch and reads the whole ticket thread.`;
      }),
  });

  bb.agents.registerTool({
    name: "loom_add_tickets",
    description:
      "Add tickets to the board, for example to split a blocked ticket or add a missing dependency. Same fields as the spec's [[ticket]] tables. On a project whose spec has [[repo]] tables, every ticket sets repo to one of those repo names, and its scope and verify are checked against that repo's protected paths and checks; on a single-repo project, leave repo out. depends_on may name refs in this batch or tickets already on the board (key or ref); the cycle check covers the batch. Nothing is added when any ticket is refused.",
    presentation: { label: { pending: "Adding Loom tickets", completed: "Added Loom tickets" } },
    parameters: z.object({ tickets: z.array(ticketSpecSchema).min(1).max(50) }),
    execute: ({ tickets }, tool) =>
      run(() => {
        const { projectId } = planner(tool.threadId);
        const created = addTickets(ctx, projectId, tickets, tool.threadId);
        return `Added ${created.map((ticket) => ticket.key).join(", ")}.`;
      }),
  });

  bb.agents.registerTool({
    name: "loom_edit_ticket",
    description:
      "Change a queued or blocked ticket. Only the fields in the patch change: title, body, acceptance, verify, scope, depends_on, priority, repo. repo moves the ticket to another of the spec's [[repo]] tables, and only while it has no branch, because a branch lives in one repository; otherwise cancel the ticket and add a new one in the other repo. A ticket a worker holds cannot be edited; cancel it or reply on it.",
    presentation: { label: { pending: "Editing a Loom ticket", completed: "Edited a Loom ticket" } },
    parameters: z.object({ key: z.string().min(1).max(40), patch: ticketPatchSchema }),
    execute: ({ key, patch }, tool) =>
      run(() => {
        planner(tool.threadId, key);
        editTicket(ctx, key, patch, tool.threadId);
        return `${key} changed: ${Object.keys(patch).join(", ") || "nothing"}.`;
      }),
  });

  bb.agents.registerTool({
    name: "loom_cancel_ticket",
    description: "Cancel a ticket that should not be done. A live worker or reviewer is stopped. A ticket that is merging cannot be cancelled until the merge finishes.",
    presentation: { label: { pending: "Cancelling a Loom ticket", completed: "Cancelled a Loom ticket" } },
    parameters: z.object({ key: z.string().min(1).max(40), reason: z.string().min(1).max(2000) }),
    execute: ({ key, reason }, tool) =>
      run(async () => {
        planner(tool.threadId, key);
        await engine.cancel(key, reason, tool.threadId);
        return `${key} is cancelled.`;
      }),
  });

  bb.agents.registerTool({
    name: "loom_post",
    description: "Post on a ticket's thread, for example your answer to a blocked ticket before you requeue it. reply_to answers one post by its #id.",
    presentation: { label: { pending: "Posting on a Loom ticket", completed: "Posted on a Loom ticket" } },
    parameters: z.object({ key: z.string().min(1).max(40), text: z.string().min(1).max(20_000), reply_to: z.number().int().positive().optional() }),
    execute: ({ key, text, reply_to }, tool) =>
      run(() => {
        planner(tool.threadId, key);
        const post = projects.post(key, { body: text, parentId: reply_to, author: "planner", threadId: tool.threadId });
        return `Posted #${post.id} on ${key}.`;
      }),
  });

  bb.agents.registerTool({
    name: "loom_ask_human",
    description:
      "Tell the human what you need them to do, as steps the Loom page shows under Needs you with a button for each: approve a spec version, requeue or reply on a ticket, start, resume or land the project, or other for anything else. Each call replaces your earlier asks; call it with no steps once nothing is needed. Say the same in your reply too: the human may read the chat instead.",
    presentation: { label: { pending: "Asking the human", completed: "Asked the human" } },
    parameters: z.object({
      why: z.string().max(2000).describe("One or two sentences: why you need this, for example what blocks the tickets."),
      steps: z.array(askStepSchema).max(10).describe("In the order the human should take them; empty clears your asks."),
    }),
    execute: ({ why, steps }, tool) =>
      run(() => {
        const { projectId } = planner(tool.threadId);
        recordAsk(store, store.project(projectId)!, tool.threadId, { why, steps });
        return steps.length === 0 ? "Your asks are cleared." : `The Loom page now asks the human to: ${steps.map((step) => step.text.trim()).join(" ")}`;
      }),
  });

  // ---- the worker's tools

  // The live reviewer of a ticket in review, for the round its row was started for.
  const reviewer = (threadId: string): { row: ThreadRow; ticket: TicketRow } => {
    const row = projects.requireRole(threadId, "reviewer");
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    if (row.state !== "active" || ticket === null || ticket.state !== "review" || ticket.review_round !== row.review_round) {
      throw new LoomError("loom_invalid_state", "You are not the live reviewer of a ticket in review, so this tool has nothing to act on.");
    }
    return { row, ticket };
  };

  bb.agents.registerTool({
    name: "loom_note",
    description: "Record a milestone on your ticket's thread, so the human and the reviewer can follow your work; a reviewer records what it checked. reply_to answers one post by its #id.",
    presentation: { label: { pending: "Noting progress", completed: "Noted progress" } },
    parameters: z.object({ text: z.string().min(1).max(20_000), reply_to: z.number().int().positive().optional() }),
    execute: ({ text, reply_to }, tool) =>
      run(() => {
        const asReviewer = store.threadByThreadId(tool.threadId)?.role === "reviewer";
        const { ticket } = asReviewer ? reviewer(tool.threadId) : worker(tool.threadId);
        try {
          store.addPost({ project_id: ticket.project_id, ticket_id: ticket.id, parent_id: reply_to ?? null, author_kind: asReviewer ? "reviewer" : "worker", author_thread_id: tool.threadId, kind: "note", body: text.trim() });
        } catch (error) {
          if (error instanceof StoreError) throw new LoomError("loom_not_found", error.message);
          throw error;
        }
        store.changed(ticket.project_id);
        return `Noted on ${ticket.key}.`;
      }),
  });

  bb.agents.registerTool({
    name: "loom_submit",
    description:
      "Hand your work in when every acceptance criterion holds, then end your turn. The plugin commits your worktree, checks the changed files against your scope and the protected paths, and runs the ticket's and the project's checks. You get the result as a message: a failure to fix, or a note that the ticket waits for review.",
    presentation: { label: { pending: "Submitting work", completed: "Submitted work" } },
    parameters: z.object({ summary: z.string().min(1).max(20_000).describe("What you did and how each acceptance criterion holds.") }),
    execute: ({ summary }, tool) => run(() => submit(ctx, tool.threadId, summary)),
  });

  bb.agents.registerTool({
    name: "loom_block",
    description:
      "Say that you cannot continue without something from the human or the planner: what is wrong and exactly what you need. The plugin saves your work on the ticket's branch and blocks the ticket. End your turn after calling it.",
    presentation: { label: { pending: "Blocking the ticket", completed: "Blocked the ticket" } },
    parameters: z.object({ reason: z.string().min(1).max(4000), needs: z.string().min(1).max(4000) }),
    execute: ({ reason, needs }, tool) =>
      run(() => {
        const { ticket } = worker(tool.threadId);
        // Ending the worker stops its own thread, which is busy running this call: do not wait for it.
        void blockTicket(ctx, ticket, { reason, needs, actor: tool.threadId }).catch((error) => log(`block ${ticket.key}`, error));
        return `${ticket.key} is blocked and your work is saved on its branch, so end your turn now. The planner or the human will answer on the ticket.`;
      }),
  });

  bb.agents.registerTool({
    name: "loom_pr",
    description:
      "Hand in the pull request Loom asked you for once your ticket is approved: its title, its description and the message of the one commit Loom pushes. In a fix round, hand in only the commit_message of the fix commit. Write them as you normally write a pull request and commit message. Then end your turn: Loom pushes and opens the pull request.",
    presentation: { label: { pending: "Handing in the pull request", completed: "Handed in the pull request" } },
    parameters: z.object({
      title: z.string().min(1).max(256).optional().describe("The pull request's title. Required unless Loom asked for a fix round's commit message."),
      body: z.string().min(1).max(50_000).optional().describe("The pull request's description, in Markdown. Required unless Loom asked for a fix round's commit message."),
      commit_message: z.string().min(1).max(8000).describe("The commit's message: a subject line, a blank line, then a short body."),
    }),
    execute: (input, tool) => run(() => handInPrText(ctx, tool.threadId, input)),
  });

  // ---- the reviewer's tools

  bb.agents.registerTool({
    name: "loom_approve",
    description:
      "Approve the ticket you review: every acceptance criterion holds and no blocking finding remains. Give one verdict per round, then end your turn. Refused until your worktree is on the commit named in your brief.",
    presentation: { label: { pending: "Approving the ticket", completed: "Approved the ticket" } },
    parameters: z.object({ summary: z.string().min(1).max(4000).describe("How each acceptance criterion holds.") }),
    execute: ({ summary }, tool) => run(() => approve(ctx, tool.threadId, summary)),
  });

  bb.agents.registerTool({
    name: "loom_request_changes",
    description:
      "Send the ticket back to its worker with findings: each has a severity (blocking or should-fix), a title, a detail, and where you can, a file and a line. Give one verdict per round, then end your turn. Refused until your worktree is on the commit named in your brief.",
    presentation: { label: { pending: "Requesting changes", completed: "Requested changes" } },
    parameters: z.object({ summary: z.string().min(1).max(4000).describe("What is wrong, in a few sentences."), findings: z.array(findingSchema).min(1).max(20) }),
    execute: ({ summary, findings }, tool) => run(() => requestChanges(ctx, tool.threadId, summary, findings)),
  });

  // ---- the spec reviewer's tools

  bb.agents.registerTool({
    name: "loom_spec_approve",
    description: "Approve the draft spec you review: it builds what the human asked for, and no more. Give one verdict per review, then end your turn.",
    presentation: { label: { pending: "Approving the spec", completed: "Approved the spec" } },
    parameters: z.object({ summary: z.string().min(1).max(4000).describe("Why the spec builds what the human asked for, and no more.") }),
    execute: ({ summary }, tool) => run(() => specVerdict(ctx, tool.threadId, [], summary)),
  });

  bb.agents.registerTool({
    name: "loom_spec_request_changes",
    description:
      "Send the draft spec back to its planner with findings: each has a title, a detail and, where you can, the spec path it is about. Every finding stops the handover. Give one verdict per review, then end your turn.",
    presentation: { label: { pending: "Requesting spec changes", completed: "Requested spec changes" } },
    parameters: z.object({ summary: z.string().min(1).max(4000).describe("What is wrong, in a few sentences."), findings: z.array(specFindingSchema).min(1).max(20) }),
    execute: ({ summary, findings }, tool) => run(() => specVerdict(ctx, tool.threadId, findings, summary)),
  });

  bb.agents.configure((context) => {
    if (context.origin.kind === "fork" && context.origin.pluginId === "side-chat") return { tools: [], skills: [] };
    let row;
    let review = null;
    try {
      row = projects.roleOf(context.thread.id, context.pluginMetadata);
      if (row === null) review = specReviewerOf(store, context.thread.id, context.pluginMetadata);
    } catch (error) {
      bb.log.warn(`agent configuration: ${errText(error)}`);
      return { tools: [], skills: [] };
    }
    if (review !== null) {
      return { tools: [...SPEC_REVIEWER_TOOLS], skills: [SKILLS.usage], instructions: `You are Loom's spec reviewer for spec v${review.version}; change nothing; follow the brief and call one verdict tool.` };
    }
    if (row === null) return { tools: [...ORDINARY_TOOLS], skills: [SKILLS.plan, SKILLS.usage] };
    if (row.role === "planner") {
      const slug = projects.projectOf(row)?.slug ?? "";
      return {
        tools: [...PLANNER_TOOLS],
        skills: [SKILLS.plan, SKILLS.usage],
        instructions: `This is the planning thread for Loom project ${JSON.stringify(slug)}. Revise its spec with loom_propose, keeping that slug; you never start, pause or approve the project, because those are the human's. After approval, change the board only through the board tools, and answer a triage round only through the tools. Hand a version over to the human only after Loom's spec review of it passes, or after Loom says it stopped reviewing. When the human has to act, such as approve a version and then requeue tickets, record the steps with loom_ask_human as well as in your reply.`,
      };
    }
    if (row.role === "worker") {
      const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
      return { tools: [...WORKER_TOOLS], skills: [SKILLS.usage], instructions: `You are a Loom worker on ${ticket?.key ?? "a ticket"}; follow the brief in your first message.` };
    }
    const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
    return {
      tools: [...REVIEWER_TOOLS],
      skills: [SKILLS.usage],
      instructions: `You are a Loom reviewer for ${ticket?.key ?? "a ticket"}, round ${row.review_round}; change nothing; follow the brief and call one verdict tool.`,
    };
  });
}
