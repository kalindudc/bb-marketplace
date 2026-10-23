// The texts agents read. Plain prose; every message the plugin sends starts with "[loom]".
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type { CheckRun } from "./checks";
import type { PostRow, ProjectRow, ReviewRow, SpecReviewRow, TicketRow } from "./db/store";
import { its, plural } from "./format";
import { isMultiRepo, repoSettings, type RepoSettings } from "./repos";
import type { Finding } from "./review";
import type { Spec } from "./spec";
import type { SpecNote } from "./spec-paths";
import type { SpecFinding } from "./spec-review";
import { SPEC_REVIEW_ROUNDS, type MergeChoice, type TicketState } from "./states";

const minute = (at: number) => `${new Date(at).toISOString().slice(0, 16)}Z`;

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

const bullets = (items: readonly string[]) => items.map((item) => `- ${JSON.stringify(item)}`).join("\n");

function inThreadOrder(posts: readonly PostRow[]): Array<{ post: PostRow; depth: number }> {
  const children = new Map<number | null, PostRow[]>();
  for (const post of posts) children.set(post.parent_id, [...(children.get(post.parent_id) ?? []), post]);
  const ordered: Array<{ post: PostRow; depth: number }> = [];
  const walk = (parent: number | null, depth: number) => {
    for (const post of children.get(parent) ?? []) {
      ordered.push({ post, depth });
      walk(post.id, depth + 1);
    }
  };
  walk(null, 0);
  return ordered;
}

/** The ticket thread as text, replies indented by depth. Over the limit, the oldest posts go first; the brief and the last block post always stay. */
export function renderThread(posts: PostRow[], maxChars: number): string {
  const ordered = inThreadOrder(posts);
  const chunks = ordered.map(({ post, depth }) => {
    const indent = "  ".repeat(depth);
    const body = post.body.split("\n").map((line) => (line === "" ? "" : `${indent}${line}`));
    return [`${indent}#${post.id} ${post.author_kind} ${post.kind} ${minute(post.at)}`, ...body].join("\n");
  });
  if (chunks.join("\n\n").length <= maxChars) return chunks.join("\n\n");

  const keep = new Set<number>();
  const brief = ordered.findIndex(({ post }) => post.kind === "brief");
  if (brief !== -1) keep.add(brief);
  const lastBlock = ordered.map(({ post }) => post.kind).lastIndexOf("block");
  if (lastBlock !== -1) keep.add(lastBlock);
  let used = [...keep].reduce((sum, index) => sum + chunks[index]!.length + 2, 0);
  for (let index = chunks.length - 1; index >= 0; index--) {
    if (keep.has(index)) continue;
    if (used + chunks[index]!.length + 2 > maxChars) break;
    keep.add(index);
    used += chunks[index]!.length + 2;
  }
  const out: string[] = [];
  let omitted = 0;
  chunks.forEach((chunk, index) => {
    if (keep.has(index)) {
      if (omitted > 0) out.push(`[${omitted} earlier ${omitted === 1 ? "post" : "posts"} left out to keep this short]`);
      omitted = 0;
      out.push(chunk);
    } else omitted += 1;
  });
  return out.join("\n\n");
}

export const THREAD_LIMIT = 30_000;

/** The first non-blank line of the composer's text, which names the planning conversation; "" when there is none. */
export function planningTitle(input: NewThreadRequest["input"]): string {
  for (const part of input) {
    if (part.type !== "text") continue;
    const line = part.text.split("\n").map((text) => text.trim()).find((text) => text !== "");
    if (line !== undefined) return clip(line, 80);
  }
  return "";
}

/** How many repos the human can pick for a new project, besides the composer's own. */
export const MAX_PLANNING_REPOS = 10;

/** A bb project the human picked in the New project composer. */
export interface PickedRepo {
  id: string;
  name: string;
}

function pickedReposLines(repos: readonly PickedRepo[]): string[] {
  return [
    `The human picked ${repos.length === 1 ? "this repo" : "these repos"} for the work, besides this thread's own project: ${repos.map((repo) => `${repo.name} (${repo.id})`).join(", ")}.`,
    "List each repo the work changes in its own [[repo]] table, with its bb project id as project, and include this thread's own project when the work changes it too.",
    "Every repo needs a checkout on this machine, where the workers run: `bb project list --json` shows each project's checkouts by machine, and `bb status` names this machine. For a repo with no checkout here, offer to clone it with `bb project source add <id> --clone --machine <this machine>`, and run that once the human agrees.",
    "The picked repos are a starting point, not a limit: you may find other repos with `bb project list` and `bb project discover`, and add any the work also changes.",
  ];
}

/** The agent-only note after the human's goal in a planner thread started from the Loom page. With no `repos` it says nothing about repos. */
export function planningKickoff(a: { merge: MergeChoice; reviewer: string; repos?: readonly PickedRepo[] }): string {
  const reviewer = a.reviewer.trim();
  const repos = a.repos ?? [];
  return [
    "[loom] The human started this thread from the Loom page to plan a new project, and the goal is the message above.",
    "Plan it with the loom-plan skill: one round of questions here, then read the code, run the checks, and call loom_propose.",
    "The human reviews, approves and starts the draft on the Loom page, so point them there when you hand over.",
    ...(a.merge === "ask" ? [] : [`The merge plan is already chosen: strategy = "${a.merge}" in [merge], so do not ask about it.`]),
    ...(reviewer === "" ? [] : [`The human asked for this reviewer model: ${JSON.stringify(reviewer)}. Write it into [agents.reviewer] as provider and model; ask only if it is unclear.`]),
    ...(repos.length === 0 ? [] : pickedReposLines(repos)),
  ].join("\n");
}

/** The human's notes from the Loom page, for the planner. `version` and `status` are the newest version's. */
export function notesMessage(a: { slug: string; version: number; status: string; notes: readonly SpecNote[] }): string {
  const count = a.notes.length === 1 ? "1 note" : `${a.notes.length} notes`;
  const notes = a.notes.map((note, index) => {
    const older = note.version < a.version ? ` (written on v${note.version})` : "";
    const body = note.body.split("\n").map((line) => (line === "" ? "" : `   ${line}`));
    return [`${index + 1}. ${note.paths.join(", ")}${older}`, ...body].join("\n");
  });
  return [
    `[loom] The human reviewed spec v${a.version} (${a.status}) of ${a.slug} on the Loom page and left ${count}.`,
    "Revise the spec for each note, or answer it in your reply, then call loom_propose again with the whole spec.",
    "A path names a ticket by its ref and counts list items from 0, for example ticket[csv-export].acceptance[1].",
    "",
    notes.join("\n\n"),
  ].join("\n");
}

/** The ticket's repo on a multi-repo project: which one it is, and that the scope is relative to its root. */
function repositorySection(project: ProjectRow, repo: RepoSettings): string[] {
  return [
    "## Repository",
    `This ticket is in the repo ${JSON.stringify(repo.name)}, the bb project ${repo.bbProjectId ?? project.bb_project_id}, and this worktree is a checkout of it. The scope globs and protected paths below are relative to this repo's root.`,
    "",
  ];
}

/** The project's other repos, read only, with their checkout paths on this machine; empty when the ticket's repo is the only one. */
function otherReposSection(spec: Spec, repo: RepoSettings, checkouts: ReadonlyMap<string, string>): string[] {
  const others = (spec.repo ?? []).filter((entry) => entry.name !== repo.name);
  if (others.length === 0) return [];
  return [
    "## Other repositories (read only)",
    "This project also works in these repos. You may read them for context, but never edit them: changes there belong to their own tickets.",
    ...others.map((entry) => {
      const path = checkouts.get(entry.name);
      return `- ${JSON.stringify(entry.name)} (bb project ${entry.project}): ${path === undefined ? "no checkout was found on this machine" : path}`;
    }),
    ...(repo.branch === null ? [] : [`This project's merged work in them is on the branch ${JSON.stringify(repo.branch)}. Read a file from it with \`git -C <path> show ${repo.branch}:<file>\`.`]),
    "",
  ];
}

/** `checkouts` holds the checkout path of each other repo on a multi-repo project, by repo name; a repo missing from it is listed without a path. */
export function workerBrief(a: { project: ProjectRow; spec: Spec; ticket: TicketRow; posts: PostRow[]; resume: boolean; checkouts?: ReadonlyMap<string, string> }): string {
  const { project, spec, ticket, posts, resume } = a;
  const multi = isMultiRepo(spec);
  const repo = repoSettings(spec, ticket.repo);
  const acceptance = JSON.parse(ticket.acceptance_json) as string[];
  const scope = JSON.parse(ticket.scope_json) as string[];
  const verify = JSON.parse(ticket.verify_json) as string[];
  const commands = [...verify, ...repo.checks];
  const enforce =
    spec.scope.enforce === "reject"
      ? "A change outside your scope makes loom_submit fail until you undo it."
      : "A change outside your scope does not stop your submit, but it is flagged to the reviewer, so keep to the scope.";
  const lines = [
    `You are a Loom worker on ${ticket.key} in the project ${JSON.stringify(project.name)} (${project.slug}). Loom is a plugin that runs this project with agents: you do this one ticket in this worktree, and the plugin decides when it is done.`,
    "",
    "## Ticket",
    `${ticket.key} · ${JSON.stringify(ticket.title)}`,
    ticket.body,
    "",
    "## Acceptance criteria",
    ...acceptance.map((line, index) => `${index + 1}. ${line}`),
    "",
    ...(multi ? repositorySection(project, repo) : []),
    "## Scope",
    "You may change files matching:",
    bullets(scope),
    "Protected paths you must never edit:",
    repo.protected.length > 0 ? bullets(repo.protected) : "- none",
    enforce,
    "",
    "## Checks the plugin runs when you submit",
    commands.length > 0 ? bullets(commands) : "- none",
    "They run in this worktree, in this order, and stop at the first failure. They must not write tracked files, and you must not edit files while they run.",
    "",
    ...(multi ? otherReposSection(spec, repo, a.checkouts ?? new Map()) : []),
    "## Rules",
    "- Work only in this worktree. Never push, merge, or edit a protected path.",
    "- Call loom_note({ text }) once for each milestone, so the human can follow along on the ticket.",
    "- Call loom_submit({ summary }) when every acceptance criterion holds, then end your turn. The plugin commits your work and runs the checks; you get the result as a message.",
    "- Call loom_block({ reason, needs }) when you cannot continue without something from the human or the planner: say what is wrong and exactly what you need. Then end your turn.",
    "- Do not commit yourself; the plugin does it. Do not run bb loom commands.",
  ];
  if (resume) {
    lines.push("", "## Earlier work");
    lines.push(
      ticket.branch === null
        ? "An earlier worker started this ticket, but no branch was kept, so this worktree starts from the base."
        : `An earlier worker already worked on this ticket. This worktree starts from its branch ${JSON.stringify(ticket.branch)}, so continue from what is there instead of starting again.`,
    );
    lines.push("Read the ticket thread below first: the human's replies and the planner's answers are instructions, and the last block post says why work stopped.", "", renderThread(posts, THREAD_LIMIT));
  }
  return lines.join("\n");
}

/** The newest changes-requested review the worker has not answered with a new submit, or null. */
export function latestChangesRequested(posts: readonly PostRow[]): PostRow | null {
  const submit = posts.map((post) => post.kind).lastIndexOf("submit");
  for (let index = posts.length - 1; index > submit; index -= 1) {
    const post = posts[index]!;
    if (post.kind === "review" && (JSON.parse(post.data_json) as { verdict?: string }).verdict === "changes_requested") return post;
  }
  return null;
}

export function nudgeText(key: string, latestChanges?: PostRow | null): string {
  const lines = [`[loom] ${key}: your turn ended without loom_submit or loom_block. Call loom_submit({ summary }) when every acceptance criterion holds, or loom_block({ reason, needs }) with what you need, then end your turn.`];
  if (latestChanges) lines.push("", "The newest review of this ticket asked for changes, and it may not have reached you:", latestChanges.body);
  return lines.join("\n");
}

const CHECK_TAIL = 4000;

export function checkFailedText(key: string, result: CheckRun): { summary: string; detail: string } {
  const how = result.timedOut ? "timed out" : `exited with ${result.exitCode}`;
  return {
    summary: `[loom] ${key}: the check ${JSON.stringify(result.command)} ${how}. Fix it and call loom_submit again.`,
    detail: `Output of ${JSON.stringify(result.command)}, the last ${CHECK_TAIL} characters at most:\n${result.output.slice(-CHECK_TAIL)}`,
  };
}

/** The newest failed check, host error, changes-requested review or merge conflict on a ticket that the worker has not answered with a new submit, or null. */
export function heldCheckResult(posts: readonly PostRow[]): PostRow | null {
  const lastOf = (kind: PostRow["kind"]) => posts.map((post) => post.kind).lastIndexOf(kind);
  const submit = lastOf("submit");
  if (submit < 0 || lastOf("claim") > submit) return null;
  for (let index = posts.length - 1; index > submit; index -= 1) {
    const post = posts[index]!;
    if (post.kind === "system") return post;
    if (post.kind === "check" && (JSON.parse(post.data_json) as { passed?: boolean }).passed === false) return post;
    if (post.kind === "review" && (JSON.parse(post.data_json) as { verdict?: string }).verdict === "changes_requested") return post;
    if (post.kind === "merge" && (JSON.parse(post.data_json) as { outcome?: string }).outcome === "conflict") return post;
  }
  return null;
}

/** What a worker that pause --now stopped reads when the project resumes; a failed check that came in meanwhile rides along as detail. */
export function resumeText(key: string, held: PostRow | null): string | { summary: string; detail: string } {
  const summary = `[loom] The project resumed; continue ${key}.`;
  if (held === null) return summary;
  return { summary, detail: `The last result of the checks on ${key} came in while the project was paused, so you may not have seen it:\n${clip(held.body, CHECK_TAIL + 500)}` };
}

export function triageDigest(a: { project: ProjectRow; round: number; counts: Record<TicketState, number>; blocked: TicketRow[]; lastPosts: Map<number, PostRow[]> }): string {
  const { project, round, counts, blocked, lastPosts } = a;
  const board = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${state} ${count}`)
    .join(", ");
  const lines = [
    `[loom] Triage round ${round} for ${project.slug}`,
    `The project is ${project.state}${project.system_reason === null ? "" : ` (${project.system_reason})`}. Board: ${board === "" ? "empty" : board}.`,
    "",
  ];
  if (blocked.length === 0) lines.push("No ticket is blocked.");
  for (const ticket of blocked) {
    const posts = lastPosts.get(ticket.id) ?? [];
    const block = [...posts].reverse().find((post) => post.kind === "block");
    const needs = block === undefined ? null : (JSON.parse(block.data_json) as { needs?: string }).needs;
    lines.push(`${ticket.key} · ${JSON.stringify(ticket.title)}`, `  Reason: ${ticket.blocked_reason ?? "none recorded"}`);
    if (needs) lines.push(`  Needs: ${needs}`);
    lines.push(`  Attempts: ${ticket.attempt}, failed attempts: ${ticket.failures}, failed check runs: ${ticket.check_failures}`);
    if (posts.length > 0) {
      lines.push("  Last posts:");
      for (const post of posts) lines.push(`  #${post.id} ${post.author_kind} ${post.kind}: ${clip(post.body.replace(/\s+/g, " "), 400)}`);
    }
    lines.push("");
  }
  lines.push(
    "What you can do, only through the tools: loom_ticket to read a ticket, loom_post to answer on it, loom_requeue to send a blocked ticket back to the queue after you answered, loom_edit_ticket to change a queued or blocked ticket, loom_add_tickets to split work or add a dependency, loom_cancel_ticket to drop one, loom_board for the whole board.",
    "Answer only through the tools; the human reads the board, not this message. Never start, pause or approve the project.",
  );
  return lines.join("\n");
}

/** What the planner reads when the human approves its pending spec version. */
export function approvedText(a: { slug: string; version: number; requeued: string[]; backToReview: string[]; stillBlocked: string[] }): { summary: string; detail: string } {
  const moved: string[] = [];
  if (a.requeued.length > 0) {
    const after = a.requeued.length === 1 ? "Its failure count starts over, and a worker picks it up by itself." : "Their failure counts start over, and workers pick them up by themselves.";
    moved.push(`Loom queued ${a.requeued.join(", ")} again, because bb never started ${its(a.requeued.length, "worker")}. ${after}`);
  }
  if (a.backToReview.length > 0) moved.push(`Loom sent ${a.backToReview.join(", ")} back to review, because bb refused to start ${its(a.backToReview.length, "reviewer")}; new reviewers start for the same commit.`);
  const requeued = moved.length === 0 ? "No ticket needed to be queued again." : moved.join(" ");
  const blocked = a.stillBlocked.length === 0 ? "" : ` Still blocked: ${a.stillBlocked.join(", ")}. Requeue one with loom_requeue when v${a.version} fixes what blocked it.`;
  return { summary: `[loom] Spec v${a.version} of ${a.slug} is approved.`, detail: `${requeued}${blocked}` };
}

/** What the planner reads when the human answers on a blocked ticket, which no worker holds. */
export function blockedReplyText(key: string, reply: string): { summary: string; detail: string } {
  return {
    summary: `[loom] The human replied on ${key}, which is blocked. Read it with loom_ticket and answer with your board tools: loom_post, then loom_requeue, loom_edit_ticket or loom_cancel_ticket if the reply settles it.`,
    detail: reply,
  };
}

export function startRequeueNote(version: number): string {
  return `Spec v${version} is approved, so Loom queued this ticket again: bb never started its worker.`;
}

export function reviewRequeueNote(version: number): string {
  return `Spec v${version} is approved, so Loom sent this ticket back to review: bb refused to start its reviewer, and its work had already passed the checks.`;
}

// ---------------------------------------------------------------- review and merge

const PATCH_LIMIT = 60_000;
const where = (finding: Finding) => (finding.file === undefined ? "" : ` (${finding.file}${finding.line === undefined ? "" : `:${finding.line}`})`);

/** The findings as a numbered list: severity, title, location, then the detail indented. */
export function findingsList(findings: readonly Finding[]): string {
  return findings.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.title}${where(finding)}\n${finding.detail.split("\n").map((line) => `   ${line}`).join("\n")}`).join("\n");
}

/** The ticket's repo on a multi-repo project, for its reviewer: which one it is, and the repo's own checks. */
function reviewerRepositorySection(project: ProjectRow, repo: RepoSettings): string[] {
  return [
    "## Repository",
    `This ticket is in the repo ${JSON.stringify(repo.name)}, the bb project ${repo.bbProjectId ?? project.bb_project_id}, and this worktree is a checkout of it. The changes, the scope report and the check results below are about this repo only.`,
    "The checks of this repo, which ran after the ticket's verify commands:",
    repo.checks.length > 0 ? bullets(repo.checks) : "- none",
    "",
  ];
}

export function reviewerBrief(a: {
  project: ProjectRow;
  spec: Spec;
  ticket: TicketRow;
  round: number;
  diff: { stat: string; patch: string; truncated: boolean };
  checkPost: PostRow | null;
  earlierReviews: ReviewRow[];
}): string {
  const { project, spec, ticket, round, diff, checkPost, earlierReviews } = a;
  const repo = repoSettings(spec, ticket.repo);
  const acceptance = JSON.parse(ticket.acceptance_json) as string[];
  const scope = checkPost === null ? null : (JSON.parse(checkPost.data_json) as { outside?: string[]; protectedHits?: string[] });
  const outside = scope?.outside ?? [];
  const protectedHits = scope?.protectedHits ?? [];
  const lines = [
    `You are a Loom reviewer for ${ticket.key}, round ${round}, in the project ${JSON.stringify(project.name)} (${project.slug}). A worker finished this ticket and the plugin's checks passed. You judge the work; you do not change it.`,
    "",
    "## First step",
    `Run \`git checkout --detach ${ticket.head_sha}\` in this worktree. That is the exact commit that passed the checks and the one that will merge; the worker's branch may have moved since. Your verdict tools refuse until this worktree is on that commit.`,
    "",
    "## Ticket",
    `${ticket.key} · ${JSON.stringify(ticket.title)}`,
    ticket.body,
    "",
    "## Acceptance criteria",
    ...acceptance.map((line, index) => `${index + 1}. ${line}`),
    "",
    ...(isMultiRepo(spec) ? reviewerRepositorySection(project, repo) : []),
    "## Rubric",
    spec.review.rubric.length > 0 ? bullets(spec.review.rubric) : "- none; the acceptance criteria are the whole standard",
    "",
    "## Scope report",
    ...(outside.length === 0 && protectedHits.length === 0 ? ["Every changed file is inside the ticket's scope."] : []),
    ...(outside.length > 0 ? [`Changed files outside the ticket's scope: ${outside.join(", ")}`] : []),
    ...(protectedHits.length > 0 ? [`Changed protected files: ${protectedHits.join(", ")}`] : []),
    "",
    "## Check results",
    checkPost === null ? "No check result was recorded." : checkPost.body,
    "",
    "## Changes",
    diff.stat === "" ? "No changes against the base." : diff.stat,
    "",
    clip(diff.patch, PATCH_LIMIT),
    ...(diff.truncated || diff.patch.length > PATCH_LIMIT ? ["", `[The patch was clipped at ${PATCH_LIMIT} characters. Read the rest with git diff.]`] : []),
  ];
  const earlier = earlierReviews.filter((review) => review.verdict !== "pending" && review.round < round);
  if (earlier.length > 0) {
    lines.push("", "## Earlier rounds");
    for (const review of earlier) {
      const found = JSON.parse(review.findings_json) as Finding[];
      lines.push(`Round ${review.round} · ${review.verdict === "approved" ? "approved" : "changes requested"}: ${review.summary ?? ""}`);
      if (found.length > 0) lines.push(findingsList(found));
    }
  }
  lines.push(
    "",
    "## Rules",
    "Rules: read and run anything, change nothing, commit nothing; judge each acceptance criterion; approve only when every one holds and no blocking finding remains; call exactly one verdict tool, then end your turn.",
    "- loom_approve({ summary }) approves.",
    "- loom_request_changes({ summary, findings }) sends the ticket back; each finding has a severity (blocking or should-fix), a title, a detail, and where you can, a file and a line.",
  );
  return lines.join("\n");
}

export function reviewerNudgeText(key: string, round: number): string {
  return `[loom] ${key}: your turn ended without a verdict for round ${round}. Call loom_approve({ summary }) or loom_request_changes({ summary, findings }), then end your turn.`;
}

export function changesRequestedText(key: string, round: number, summary: string, findings: Finding[]): { summary: string; detail: string } {
  return {
    summary: `[loom] ${key}: review round ${round} asked for changes (${findings.length} ${findings.length === 1 ? "finding" : "findings"}). Fix them and call loom_submit again.`,
    detail: `The reviewer's summary:\n${summary}\n\nFindings:\n${findingsList(findings)}`,
  };
}

export function conflictText(key: string, integrationBranch: string, files: string[]): { summary: string; detail: string } {
  return {
    summary: `[loom] ${key}: merging into ${integrationBranch} conflicts in ${files.length} ${files.length === 1 ? "file" : "files"}. Merge ${integrationBranch} into your branch, resolve them and call loom_submit again.`,
    detail: `The merge of your reviewed commit into ${integrationBranch} conflicted in:\n${files.map((file) => `- ${file}`).join("\n")}\nThe integration branch was left unchanged. In your worktree run \`git merge ${integrationBranch}\`, resolve those files, run the checks, and call loom_submit({ summary }).`,
  };
}

export function afterMergeFailedText(key: string, run: CheckRun): { summary: string; detail: string } {
  const how = run.timedOut ? "timed out" : `exited with ${run.exitCode}`;
  return {
    summary: `[loom] ${key}: after merging into the integration branch, the check ${JSON.stringify(run.command)} ${how}, so the merge was rolled back. Merge the integration branch into yours, fix it and call loom_submit again.`,
    detail: `Output of ${JSON.stringify(run.command)} on the merged result, the last ${CHECK_TAIL} characters at most:\n${run.output.slice(-CHECK_TAIL)}`,
  };
}

/** An after_merge check that exited 0 but left the merged result different from the commit that was merged. */
export function afterMergeChangedText(key: string, run: CheckRun, changed: string): { summary: string; detail: string } {
  return {
    summary: `[loom] ${key}: after merging into the integration branch, the check ${JSON.stringify(run.command)} passed but changed the branch (${changed}), so the merge was rolled back. An after_merge check must leave the merged result exactly as it found it. Merge the integration branch into yours, make sure it does, and call loom_submit again.`,
    detail: `Output of ${JSON.stringify(run.command)} on the merged result, the last ${CHECK_TAIL} characters at most:\n${run.output.slice(-CHECK_TAIL)}`,
  };
}

export function prBody(a: { ticket: TicketRow; approvals: ReviewRow[] }): string {
  const { ticket, approvals } = a;
  const acceptance = JSON.parse(ticket.acceptance_json) as string[];
  return [
    ticket.body,
    "",
    "Acceptance criteria:",
    ...acceptance.map((line, index) => `${index + 1}. ${line}`),
    "",
    `Review: approved by ${approvals.length} ${approvals.length === 1 ? "reviewer" : "reviewers"}.`,
    ...approvals.map((review) => `- ${review.summary ?? ""}`),
    "",
    `Opened by Loom for ${ticket.key}.`,
  ].join("\n");
}

/** "a", "a and b", "a, b and c". */
export const andList = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** On a multi-repo project `repo` is the repo the pull request is in: the body lists only its merged tickets and names the project's other repos. */
export function landBody(a: { project: ProjectRow; spec: Spec; done: TicketRow[]; repo?: string }): string {
  const { project, spec, repo } = a;
  const done = repo === undefined ? a.done : a.done.filter((ticket) => ticket.repo === repo);
  const others = repo === undefined ? [] : (spec.repo ?? []).map((entry) => entry.name).filter((name) => name !== repo);
  const across =
    others.length === 0
      ? []
      : [`This pull request lands the project's work in the repo ${JSON.stringify(repo)}. The project also changes the ${others.length === 1 ? "repo" : "repos"} ${andList(others.map((name) => JSON.stringify(name)))}, which ${others.length === 1 ? "lands" : "land"} on ${others.length === 1 ? "its" : "their"} own.`, ""];
  return [spec.project.goal, "", ...across, "Merged tickets:", ...done.map((ticket) => `- ${ticket.key} ${ticket.title}`), "", `Opened by Loom (project ${project.slug}).`].join("\n");
}

/** The visible prompt of the agent that summarizes a finished project's record; the record follows as agent-only text. */
export function recordPrompt(project: ProjectRow): string {
  return [
    `[loom] Write the record of the finished Loom project ${project.name} (${project.slug}). Its full record follows as hidden text.`,
    "Reply with only the summary in Markdown, no preamble, about 800 words at most, with these sections in order:",
    "## Goal (one or two sentences), ## Outcome (where the code landed; tickets done and cancelled), ## What was built (one or two sentences per ticket, by key),",
    "## Decisions (choices made while building and why, including the planner's and the human's replies), ## Problems and fixes (review findings, blocks and merge trouble that changed the work),",
    "## Follow-ups (work left, known gaps, risks), ## Files (the main files as backticked repo-relative paths named in the record).",
    "Keep exact names, numbers, commit hashes and links. Do not run tools, change files or ask questions: your reply is passed to a command exactly as written.",
  ].join("\n");
}

// ---------------------------------------------------------------- spec review

/** What the spec reviewer judges a draft against. Each line names what counts as a finding. */
export const SPEC_REVIEW_RUBRIC: readonly string[] = [
  "Fit: every ticket and acceptance criterion serves what the human asked for. Work the human ruled out, or never asked for and the goal does not need, is a finding.",
  "Size: the fewest tickets that deliver the goal. A ticket that only prepares for a later one, or that could join another and still be one reviewable change, is a finding.",
  "No speculation: configuration, flags, settings, abstraction layers, plugin points or generality that nothing in the goal uses now are findings, and so is work for possible future needs.",
  "Reuse: read the code the tickets touch. A ticket that rebuilds what the repository already has, such as a helper, component, command or test fixture, is a finding; name what to reuse.",
  "Completeness: a part of the goal that no ticket delivers, or an acceptance criterion no one could test, is a finding.",
  "Checks and scope: a check command that does not exist in the repository, a scope far wider than the ticket's work, or a depends_on where no order is needed, is a finding.",
];

const SPEC_LIMIT = 60_000;

/** The findings as a numbered list: the spec path and title, then the detail indented. */
export function specFindingsList(findings: readonly SpecFinding[]): string {
  return findings
    .map((finding, index) => `${index + 1}. ${finding.path === undefined ? "" : `${finding.path}: `}${finding.title}\n${finding.detail.split("\n").map((line) => `   ${line}`).join("\n")}`)
    .join("\n");
}

export function specReviewerBrief(a: { project: ProjectRow; spec: Spec; toml: string; version: number; round: number; earlier: readonly SpecReviewRow[] }): string {
  const { project, spec, toml, version, round } = a;
  const earlier = a.earlier.filter((row) => row.state === "approved" || row.state === "changes_requested");
  const lines = [
    `You are Loom's spec reviewer for version ${version} of the project ${JSON.stringify(project.name)} (${project.slug}), round ${round} of ${SPEC_REVIEW_ROUNDS}. A planner agent wrote this spec from a conversation with the human. Before the human is asked to approve it, you check that it builds what the human asked for, and no more. You judge the spec; you change nothing.`,
    "",
    "## What the human asked for",
    `Read the planning conversation first: \`bb thread log ${project.planner_thread_id} --format minimal --all\`. The User messages are the human's request and answers; messages that start with [loom] come from Loom, not the human. The human's words outrank the spec's goal, which is the planner's summary of them.`,
    "The human's answers to the planner's Ask User Question rounds may be missing from that log. The goal and non-goals below record them, so treat those as the human's words unless the log contradicts them.",
    "",
    `Goal: ${spec.project.goal}`,
    ...(spec.project.non_goals.length === 0 ? [] : ["Non-goals:", bullets(spec.project.non_goals)]),
    "",
    "## Rubric",
    bullets(SPEC_REVIEW_RUBRIC),
    "",
    "## The spec",
    clip(toml, SPEC_LIMIT),
    ...(toml.length > SPEC_LIMIT ? ["", `[The spec was clipped at ${SPEC_LIMIT} characters. Read the rest with \`bb loom spec ${project.slug} --version ${version}\`.]`] : []),
  ];
  if (earlier.length > 0) {
    lines.push("", "## Earlier rounds", "Do not raise again what the planner fixed, or answered in the conversation with a reason you accept.");
    for (const row of earlier) {
      const found = JSON.parse(row.findings_json) as SpecFinding[];
      lines.push(`Round ${row.round} · v${row.version} · ${row.state === "approved" ? "approved" : "changes requested"}: ${row.summary ?? ""}`);
      if (found.length > 0) lines.push(specFindingsList(found));
    }
  }
  lines.push(
    "",
    "## Rules",
    "- This worktree is a checkout of the base branch. Read the code the tickets touch; `bb project list --json` gives the checkouts of the project's other repos. Run anything that writes nothing; change nothing and commit nothing.",
    "- Every finding stops the planner from handing the spec over, so raise only what would make the project build the wrong thing, more than the goal needs, or less. Never raise wording, style or taste. What the human explicitly asked for is in scope, even when it looks like more than the goal needs.",
    "- Call exactly one verdict tool, then end your turn: loom_spec_approve({ summary }) when the spec holds, or loom_spec_request_changes({ summary, findings }). Each finding is { path?, title, detail }: path names the part of the spec, such as ticket[csv-export] or ticket[csv-export].acceptance[1] (tickets by ref, list items counted from 0); detail says what is wrong and the smaller or right alternative.",
  );
  return lines.join("\n");
}

export function specReviewNudgeText(version: number): string {
  return `[loom] Your turn ended without a verdict on spec v${version}. Call loom_spec_approve({ summary }) or loom_spec_request_changes({ summary, findings }), then end your turn.`;
}

/** The verdict for the planner, visible in its chat: no findings is an approval. */
export function specReviewVerdictText(a: { slug: string; version: number; round: number; summary: string; findings: readonly SpecFinding[] }): string {
  const { slug, version, round, summary, findings } = a;
  if (findings.length === 0) {
    return [`[loom] Spec review round ${round} passed v${version} of ${slug}: ${summary}`, "Hand over to the human now: tell them what you proposed and that the draft is ready to approve."].join("\n");
  }
  const next =
    round >= SPEC_REVIEW_ROUNDS
      ? "This was the last automatic round. Revise the spec for the findings you agree with and call loom_propose once more; Loom does not review it again. Then hand over, and tell the human which findings you left open and why."
      : "Revise the spec for each finding and call loom_propose again; a fresh reviewer checks the new version. If a finding is wrong, leave that part as it is and say why in your reply: the next reviewer reads this conversation. Do not hand over yet.";
  return [`[loom] Spec review round ${round} of ${SPEC_REVIEW_ROUNDS} found ${plural(findings.length, "problem")} in v${version} of ${slug}: ${summary}`, "", specFindingsList(findings), "", next].join("\n");
}

export function specReviewFailedText(a: { slug: string; version: number; reason: string }): string {
  return `[loom] The spec review of v${a.version} of ${a.slug} did not finish: ${a.reason}. Call loom_propose again with the same spec to start a new review; do not hand over until a review passes.`;
}
