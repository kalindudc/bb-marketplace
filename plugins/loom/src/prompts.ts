// The texts agents read. Plain prose; every message the plugin sends starts with "[loom]".
import type { CheckRun } from "./checks";
import type { PostRow, ProjectRow, ReviewRow, TicketRow } from "./db/store";
import type { Finding } from "./review";
import type { Spec } from "./spec";
import type { TicketState } from "./states";

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

export function workerBrief(a: { project: ProjectRow; spec: Spec; ticket: TicketRow; posts: PostRow[]; resume: boolean }): string {
  const { project, spec, ticket, posts, resume } = a;
  const acceptance = JSON.parse(ticket.acceptance_json) as string[];
  const scope = JSON.parse(ticket.scope_json) as string[];
  const verify = JSON.parse(ticket.verify_json) as string[];
  const commands = [...verify, ...spec.checks.commands];
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
    "## Scope",
    "You may change files matching:",
    bullets(scope),
    "Protected paths you must never edit:",
    spec.scope.protected.length > 0 ? bullets(spec.scope.protected) : "- none",
    enforce,
    "",
    "## Checks the plugin runs when you submit",
    commands.length > 0 ? bullets(commands) : "- none",
    "They run in this worktree, in this order, and stop at the first failure. They must not write tracked files, and you must not edit files while they run.",
    "",
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

// ---------------------------------------------------------------- review and merge

const PATCH_LIMIT = 60_000;
const where = (finding: Finding) => (finding.file === undefined ? "" : ` (${finding.file}${finding.line === undefined ? "" : `:${finding.line}`})`);

/** The findings as a numbered list: severity, title, location, then the detail indented. */
export function findingsList(findings: readonly Finding[]): string {
  return findings.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.title}${where(finding)}\n${finding.detail.split("\n").map((line) => `   ${line}`).join("\n")}`).join("\n");
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

export function landBody(a: { project: ProjectRow; spec: Spec; done: TicketRow[] }): string {
  const { project, spec, done } = a;
  return [spec.project.goal, "", "Merged tickets:", ...done.map((ticket) => `- ${ticket.key} ${ticket.title}`), "", `Opened by Loom (project ${project.slug}).`].join("\n");
}
