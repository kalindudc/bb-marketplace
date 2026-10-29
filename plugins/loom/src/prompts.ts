// The texts agents read. Plain prose; every message the plugin sends starts with "[loom]".
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type { Skipped } from "./check-wait";
import type { CheckRun } from "./checks";
import type { PostRow, ProjectRow, ReviewRow, SpecReviewRow, TicketRow } from "./db/store";
import { its, plural } from "./format";
import type { PrApplied, PrProposal } from "./pull-requests";
import { canEdit, canReply, followsFeedback, isMultiRepo, prSettings, repoSettings, type RepoSettings } from "./repos";
import type { Finding } from "./review";
import { rolloutFacts } from "./rollout";
import type { ForgeSpec, Spec } from "./spec";
import { specDiff, type SpecChange } from "./spec-diff";
import { restackOf, stacking, stackOf, upstreamOf } from "./stack";
import type { SpecNote } from "./spec-paths";
import type { SpecFinding } from "./spec-review";
import { SPEC_REVIEW_ROUNDS, type MergeChoice, type TicketState } from "./states";
import type { ForeignTip } from "./tips";

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

/**
 * The human's standing instructions from Loom's settings, for a planner: what they are and how a spec carries them out.
 * Empty without instructions. The kickoff and loom_discover both show them, so a planner started anywhere sees them.
 */
export function standingInstructionsLines(instructions: string): string[] {
  const text = instructions.trim();
  if (text === "") return [];
  return [
    "## The human's standing instructions",
    "The human set these planner instructions in Loom's settings, for every project. Carry them out in this spec as far as they apply to it. Where they ask for something to happen when a project event happens (the spec is approved, the project starts, a worker starts a ticket, Loom opens a pull request, a ticket is blocked or done, the project is done), write a [[hook]] table for it: tell for what you, the planner, do then with your own tools, to = \"worker\" on ticket.started for what each worker does, and run for a command. Confirm in your question round any hook the goal leaves unclear, and leave out an instruction that does not apply to this project. Loom's spec reviewer checks the spec against them. The loom skill's references/spec.md describes [[hook]].",
    '"""',
    text,
    '"""',
  ];
}

/** The agent-only note after the human's goal in a planner thread started from the Loom page. With no `repos` it says nothing about repos. */
export function planningKickoff(a: { merge: MergeChoice; reviewer: string; repos?: readonly PickedRepo[]; instructions?: string }): string {
  const reviewer = a.reviewer.trim();
  const repos = a.repos ?? [];
  const standing = standingInstructionsLines(a.instructions ?? "");
  return [
    "[loom] The human started this thread from the Loom page to plan a new project, and the goal is the message above.",
    "Plan it with the loom-plan skill: one round of questions here, then read the code, run the checks, and call loom_propose.",
    "The human reviews, approves and starts the draft on the Loom page, so point them there when you hand over.",
    ...(a.merge === "ask" ? [] : [`The merge plan is already chosen: strategy = "${a.merge}" in [merge], so do not ask about it.`]),
    ...(reviewer === "" ? [] : [`The human asked for this reviewer model: ${JSON.stringify(reviewer)}. Write it into [agents.reviewer] as provider and model; ask only if it is unclear.`]),
    ...(repos.length === 0 ? [] : pickedReposLines(repos)),
    ...(standing.length === 0 ? [] : ["", ...standing]),
  ].join("\n");
}

/** The human's notes from the Loom page, for the planner. `version` and `status` are the newest version's. */
export function notesMessage(a: { slug: string; version: number; status: string; notes: readonly SpecNote[] }): string {
  const count = a.notes.length === 1 ? "1 note" : `${a.notes.length} notes`;
  const notes = a.notes.map((note, index) => {
    const older = note.version < a.version ? ` (written on v${note.version})` : "";
    const suggest = note.suggest === undefined ? [] : [`   Suggested value: ${note.suggest.to} (now ${note.suggest.from})`];
    const body = note.body === "" ? [] : note.body.split("\n").map((line) => (line === "" ? "" : `   ${line}`));
    return [`${index + 1}. ${note.paths.join(", ")}${older}`, ...suggest, ...body].join("\n");
  });
  const suggests = a.notes.some((note) => note.suggest !== undefined);
  return [
    `[loom] The human reviewed spec v${a.version} (${a.status}) of ${a.slug} on the Loom page and left ${count}.`,
    "Revise the spec for each note, or answer it in your reply, then call loom_propose again with the whole spec.",
    "A path names a ticket by its ref and counts list items from 0, for example ticket[csv-export].acceptance[1].",
    ...(suggests ? ["A suggested value is written as TOML; use it unless it breaks the spec, and then say why."] : []),
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

/** The project's other repos, read only, with their checkout paths on this machine; empty when the ticket's repo is the only one. On a machine of its own (`remote`), none of them is there. */
function otherReposSection(spec: Spec, repo: RepoSettings, checkouts: ReadonlyMap<string, string>, remote = false): string[] {
  const others = (spec.repo ?? []).filter((entry) => entry.name !== repo.name);
  if (others.length === 0) return [];
  return [
    "## Other repositories (read only)",
    "This project also works in these repos. You may read them for context, but never edit them: changes there belong to their own tickets.",
    ...others.map((entry) => {
      const path = remote ? undefined : checkouts.get(entry.name);
      return `- ${JSON.stringify(entry.name)} (bb project ${entry.project}): ${remote ? "it is not on this machine" : path === undefined ? "no checkout was found on this machine" : path}`;
    }),
    ...(repo.branch === null ? [] : [`This project's merged work in them is on the branch ${JSON.stringify(repo.branch)}. Read a file from it with \`git -C <path> show ${repo.branch}:<file>\`.`]),
    "",
  ];
}

const PROPOSE =
  "Propose the pull request's title and description with loom_submit's pr = { title, body }, written as the pull request should read: the reviewers judge them with the work and may ask for changes to them as to the code. Loom adds its own sections after your description, such as the pull requests it depends on and the Rollout section.";

/** What a worker on the pr strategy is told about the pull request Loom opens and follows for its ticket. */
function pullRequestSection(spec: Spec, repo: RepoSettings, signature: string): string[] {
  const pr = prSettings(spec);
  if (repo.forge.kind === "none") {
    return ["## The pull request", `When the reviewers approve, Loom pushes the reviewed work to the ticket's branch and a person opens the pull request.${pr.describe === "worker" ? ` ${PROPOSE} Loom posts them on the ticket for that person.` : ""}`, ""];
  }
  const write =
    pr.describe === "worker"
      ? `${PROPOSE} When the reviewers approve, Loom asks you for the commit message with loom_pr, and for the title and description too if you did not propose them.`
      : "When the reviewers approve, Loom writes the pull request from this ticket.";
  const push = pr.squash ? "Loom pushes the reviewed work as one commit and opens the pull request; the human merges it." : "Loom pushes the reviewed branch and opens the pull request; the human merges it.";
  const following = pr.maxFixRounds > 0 && followsFeedback(repo.forge);
  const follows = following ? [`While it is open, Loom follows its checks and reviews and sends you what needs a fix. Each fix goes through the checks and a review again and is pushed as ${pr.squash ? "one more commit" : "more commits"}.`] : [];
  const text =
    pr.describe !== "worker"
      ? []
      : [canEdit(repo.forge) ? "To change its title or description in a fix round, pass pr to loom_submit again; once the reviewers approve, Loom sets it on the pull request." : "This forge cannot change an open pull request's text, so a new title or description you pass to loom_submit in a fix round goes, once approved, on the ticket for the human to set."];
  return ["## The pull request", [write, push, ...follows, ...(following ? text : [])].join(" "), ...(following ? replyRules(repo.forge, signature) : []), ""];
}

/**
 * On the pr strategy, what each of the ticket's dependencies is: merged, or a pull request still open, which this
 * worktree starts on when it is in the same repo and the worker can read from the other repo's checkout when it is not.
 * A worker on a machine of its own (`remote`) reads a dependency in its repo from the dependency's branch on the remote.
 */
function dependenciesSection(spec: Spec, ticket: TicketRow, tickets: readonly TicketRow[], checkouts: ReadonlyMap<string, string>, remote = false): string[] {
  const keys = JSON.parse(ticket.deps_json) as string[];
  if (spec.merge.strategy !== "pr" || keys.length === 0) return [];
  const byKey = new Map(tickets.map((row) => [row.key, row]));
  const stack = stackOf(ticket);
  let crossOpen = false;
  const lines = keys.flatMap((key) => {
    const dep = byKey.get(key);
    if (dep === undefined) return [];
    const elsewhere = dep.repo !== ticket.repo;
    const name = `${dep.key} ${JSON.stringify(dep.title)}${elsewhere ? ` in the repo ${JSON.stringify(dep.repo)}` : ""}`;
    if (dep.state === "done") return [`- ${name}: merged.`];
    if (dep.state === "cancelled") return [`- ${name}: cancelled.`];
    if (dep.pushed_sha === null) return [`- ${name}: not merged, and it has no pull request yet.`];
    const { remote: from } = repoSettings(spec, dep.repo);
    const branch = dep.pr_branch ?? dep.branch ?? "";
    const pr = dep.pr_url ?? `the branch ${from}/${branch}`;
    const open = `- ${name}: its pull request ${pr} is open and not merged yet, at commit ${dep.pushed_sha.slice(0, 12)}.`;
    if (!elsewhere && stack?.deps[dep.key] !== undefined) return [remote ? `${open} This worktree starts on it once loom_resume has put it in.` : `${open} This worktree starts on it, so its changes are already here.`];
    if (!elsewhere && remote) return [`${open} Its branch is ${from}/${branch}: read its files with \`git fetch ${from} ${branch}\` and then \`git show FETCH_HEAD:<file>\`.`];
    if (!elsewhere) return [open];
    crossOpen = true;
    const path = remote ? undefined : checkouts.get(dep.repo ?? "");
    return [path === undefined ? open : `${open} Read its files with \`git -C ${path} show ${dep.pushed_sha}:<file>\`; that checkout's working tree does not have them.`];
  });
  const stacked = Object.keys(stack?.deps ?? {});
  const notes: string[] = [];
  if (stacked.length > 0) {
    const one = stacked.length === 1;
    const changes = one ? "that pull request changes or merges" : "those pull requests change or merge";
    notes.push(
      remote
        ? `This worktree starts from the pull request ${one ? "commit" : "commits"} of ${andList(stacked)}, which loom_resume puts in as its first commit. Those changes are not yours: do not change or redo them. The plugin measures your scope, and your reviewers' diff, from that commit, so keep it: do not rebase, reset or squash over it, and do not merge or rebase onto the base branch yourself. When ${changes}, Loom merges the new commits on the project's machine and puts the result in this worktree as commits of its own, then runs your checks; a conflict or a failing check comes back to you as a message, a conflict with conflict markers in its files.`
        : `This worktree starts from the pull request ${one ? "commit" : "commits"} of ${andList(stacked)}. Those changes are not yours: do not change or redo them. The plugin measures your scope, and your reviewers' diff, from that commit. When ${changes}, Loom merges the new commits into your branch and runs your checks; a conflict or a failing check comes back to you as a message.`,
    );
  }
  if (stacked.length > 1) notes.push(`A pull request builds on one other branch, so yours opens once all but one of ${andList(stacked)} have merged, on top of the one still open.`);
  if (crossOpen) notes.push("A pull request in another repo may still change in review. Loom posts each new commit of it on this ticket and tells you while you work, so build against what it has now.");
  return ["## Dependencies", ...lines, ...(notes.length > 0 ? ["", ...notes] : []), ""];
}

/** The lines a pull request's description gets for the pull requests it depends on: the one it is stacked on, and those in other repos. */
export function dependsOnLines(spec: Spec, tickets: readonly TicketRow[], ticket: TicketRow): string[] {
  const up = upstreamOf(tickets, ticket);
  const lines: string[] = [];
  const only = up.open.length === 1 ? up.open[0]! : null;
  if (only?.pr_url != null) lines.push(`Stacked on ${only.pr_url} (${only.key}): merge that one first. Loom moves this pull request to ${repoSettings(spec, ticket.repo).base} when it merges.`);
  for (const dep of up.cross) if (dep.state !== "done" && dep.state !== "cancelled" && dep.pr_url !== null) lines.push(`Depends on ${dep.pr_url} (${dep.key}) in the repo ${JSON.stringify(dep.repo)}: merge that one first.`);
  const byKey = new Map(tickets.map((row) => [row.key, row]));
  for (const key of JSON.parse(ticket.merge_after_json) as string[]) {
    const before = byKey.get(key);
    if (before === undefined || before.state === "done" || before.state === "cancelled") continue;
    lines.push(before.pr_url !== null ? `Merge after ${before.pr_url} (${before.key}).` : `Merge after ${before.key}, which has no pull request yet.`);
  }
  return lines;
}

/** `checkouts` holds the checkout path of each other repo on a multi-repo project, by repo name; a repo missing from it is listed without a path. */
export function workerBrief(a: {
  project: ProjectRow;
  spec: Spec;
  ticket: TicketRow;
  posts: PostRow[];
  resume: boolean;
  checkouts?: ReadonlyMap<string, string>;
  tickets?: readonly TicketRow[];
  signature?: string;
  /** The bb threads of the ticket's earlier workers, oldest first. */
  earlierThreads?: readonly string[];
  /** The worker runs on a machine of its own, away from the project's checkout. */
  remote?: boolean;
  /** Work brought home from earlier workers waits for loom_resume. */
  resumePending?: boolean;
}): string {
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
  const stackedOn = stackOf(ticket)?.base == null ? [] : Object.keys(stackOf(ticket)!.deps);
  const resumed =
    stackedOn.length === 0
      ? "It puts the work earlier workers left on this ticket in this worktree, as one commit on the base, carried from the project's machine; loom_submit is refused until you have."
      : `It puts the pull ${stackedOn.length === 1 ? "request" : "requests"} of ${andList(stackedOn)}, which this ticket builds on, in this worktree as one commit on the base${resume ? ", with the work earlier workers left on this ticket as one more on top" : ""}, carried from the project's machine; loom_submit is refused until you have.`;
  const lines = [
    `You are a Loom worker on ${ticket.key} in the project ${JSON.stringify(project.name)} (${project.slug}). Loom is a plugin that runs this project with agents: you do this one ticket in this worktree, and the plugin decides when it is done.`,
    "",
    ...(a.resumePending === true ? ["## First step", `Call loom_resume before anything else. ${resumed}`, ""] : []),
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
    ...ciLines(spec, repo, WORKER_CI),
    "",
    ...(multi ? otherReposSection(spec, repo, a.checkouts ?? new Map(), a.remote) : []),
    ...dependenciesSection(spec, ticket, a.tickets ?? [], a.checkouts ?? new Map(), a.remote),
    ...(spec.merge.strategy === "pr" ? pullRequestSection(spec, repo, a.signature ?? COMMENT_SIGNATURE) : []),
    ...rolloutBriefSection(spec, a.tickets ?? [ticket], ticket, WORKER_ROLLOUT),
    ...workerHooksSection(spec),
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
      a.remote === true
        ? a.resumePending === true
          ? "An earlier worker already worked on this ticket, on another machine. loom_resume, your first step, brings its work here, so continue from it instead of starting again."
          : "An earlier worker started this ticket, but none of its work was kept, so this worktree starts from the base."
        : ticket.branch === null
          ? "An earlier worker started this ticket, but no branch was kept, so this worktree starts from the base."
          : `An earlier worker already worked on this ticket. This worktree starts from its branch ${JSON.stringify(ticket.branch)}, so continue from what is there instead of starting again.`,
    );
    if (ticket.pushed_sha !== null) {
      const replies = ticket.pr_url !== null && canReply(repo.forge) ? " Answer its reviews and comments with loom_pr_reply, by the keys that post gives them." : "";
      lines.push(`This ticket's pull request${ticket.pr_url === null ? "" : ` ${ticket.pr_url}`} is open. Address what Loom's newest feedback post on the ticket lists; Loom pushes your fix to it as one more commit.${replies}`);
    }
    if (ticket.pushed_sha !== null && stacking(spec) && restackOf(a.tickets ?? [], ticket) !== null) {
      lines.push("Loom must bring this pull request up to date with its dependencies' new commits before it pushes again. Unless a post since the last push asks for a fix, check that the work still holds and call loom_submit with it as it is; after review, Loom merges those commits in, runs the checks and pushes.");
    }
    const earlier = a.earlierThreads ?? [];
    if (earlier.length > 0) {
      lines.push(
        `The earlier ${earlier.length === 1 ? "worker's conversation is" : "workers' conversations are"} still in bb: ${andList(earlier.map((id) => `\`${id}\``))}. When you need ${earlier.length === 1 ? "its" : "their"} reasoning, read the newest with \`bb thread log ${earlier.at(-1)} --all\`; the ticket thread below has what ${earlier.length === 1 ? "it" : "they"} handed in.`,
      );
    }
    lines.push("Read the ticket thread below first: the human's replies and the planner's answers are instructions, and the last block post says why work stopped.", "", renderThread(posts, THREAD_LIMIT));
  }
  return lines.join("\n");
}

/** The tell of each [[hook]] for workers: on ticket.started, every worker's brief carries it. */
function workerHooksSection(spec: Spec): string[] {
  const tells = (spec.hook ?? []).flatMap((hook) => (hook.on === "ticket.started" && hook.to === "worker" && hook.tell !== undefined ? [hook.tell] : []));
  if (tells.length === 0) return [];
  return [
    "## The spec's instructions for every worker",
    "The human asked every worker on this project to do this when it starts on a ticket, with its own tools. It adds to the ticket and changes neither its scope nor its acceptance criteria, and Loom does not check it; say in your loom_submit summary what you did.",
    ...tells.map((tell) => `- ${tell.split("\n").join("\n  ")}`),
    "",
  ];
}

/** What happened, for the planner's hook message and a hook command's variables. */
export interface HookFacts {
  /** One sentence. */
  what: string;
  key?: string;
  title?: string;
  url?: string;
  repo?: string;
  version?: number;
  reason?: string;
}

/** One hook's tell for the planner: its index and event in the spec, what it says and what happened. */
export interface HookTell {
  hook: number;
  on: string;
  text: string;
  facts: HookFacts;
}

/** The planner's message when [[hook]] tables fire: a visible line, and each hook with what happened and what to do. */
export function hookTellText(slug: string, tells: readonly HookTell[]): { summary: string; detail: string } {
  const events = [...new Set(tells.map((tell) => tell.on))];
  const summary = `[loom] ${tells.length === 1 ? "A hook" : `${tells.length} hooks`} of ${slug} fired on ${events.join(", ")}. Carry ${tells.length === 1 ? "it" : "them"} out, then end your turn.`;
  const items = tells.map((tell, index) => [`${index + 1}. hook[${tell.hook}], on ${tell.on}: ${tell.facts.what}`, `   Do: ${tell.text.split("\n").join("\n   ")}`].join("\n"));
  const detail = [
    `[loom] These [[hook]] tables of ${slug}'s approved spec fired, oldest first. Each is the human's standing instruction for this project: do what it says with your own tools, in order, then end your turn.`,
    "Loom only delivers them: it checks nothing and waits for nothing, and no ticket moves because of them. Say in your reply what you did for each, or why one could not be done. A hook that asks for something only the human may do, such as approving, starting or landing, goes to loom_ask_human instead.",
    "",
    items.join("\n\n"),
  ].join("\n");
  return { summary, detail };
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

export function triageDigest(a: { project: ProjectRow; round: number; counts: Record<TicketState, number>; blocked: TicketRow[]; lastPosts: Map<number, PostRow[]>; budgetPaused?: boolean }): string {
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
  if (a.budgetPaused === true) {
    lines.push(
      "Loom paused the project for its budget. If the work should go on, propose a new spec version with loom_propose that raises budget.max_tokens or moves budget.deadline, then record with loom_ask_human that the human approves it and resumes the project.",
      "",
    );
  }
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

const WORKER_CI = {
  rely: "These are the cheap checks that run where you are. Every other test of this repository runs in the pull request's CI once Loom opens it, and a check that fails there comes back to you as a fix round. Run what you can here; do not block, fail or loop on a test this environment cannot run, such as one that needs a container runtime, a service that will not start here, or more time than your turn has. Say in your loom_submit summary which tests you did not run, and why.",
  ignore: "These checks are the whole bar: Loom does not read the pull request's CI for this repository, so run every test the ticket needs here before you submit.",
};
const REVIEWER_CI = {
  rely: "Those are the plugin's cheap checks. Every other test runs in the pull request's CI once it opens, and a check that fails there goes back to the worker as a fix round. Do not request changes only because a test was not run here; the worker's summary says which it did not run. Request changes when the work lacks a test the ticket needs, or a test you ran shows a problem.",
  ignore: "Loom does not read this repository's CI, so these checks are the whole bar: request changes when the ticket needs a test they do not run.",
};

/** What the plugin's checks are on the pr strategy: the cheap ones, with CI for the rest, or the whole bar when Loom ignores the repo's CI. */
function ciLines(spec: Spec, repo: RepoSettings, text: { rely: string; ignore: string }): string[] {
  if (spec.merge.strategy !== "pr") return [];
  return [repo.ci ? text.rely : text.ignore];
}

/** A stacked ticket's reviewer sees its dependencies' changes in the worktree, which are not the ticket's to judge. */
function stackedReviewSection(ticket: TicketRow, remote: boolean): string[] {
  const stack = stackOf(ticket);
  const keys = Object.keys(stack?.deps ?? {});
  if (stack?.base == null || keys.length === 0) return [];
  return [
    "## Stacked work",
    `This ticket builds on the open pull ${keys.length === 1 ? "request" : "requests"} of ${andList(keys)}, so ${keys.length === 1 ? "its" : "their"} changes are in this worktree too. They are reviewed on their own tickets: judge only the changes below, which are measured from ${stack.base.slice(0, 12)}, and read the rest for context.`,
    ...(remote ? ["loom_checkout puts their work in as the commit before HEAD, so `git diff HEAD~1` shows the changes to judge."] : []),
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
  /** The fix round's feedback post when this review is of a fix for an open pull request. */
  prFeedback?: PostRow | null;
  /** The checkout path of each other repo of a multi-repo project, by repo name. */
  checkouts?: ReadonlyMap<string, string>;
  /** The reviewer runs on a machine of its own, away from the project's checkout. */
  remote?: boolean;
  /** The project's tickets, for the Rollout section's prerequisites. */
  tickets?: readonly TicketRow[];
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
    `Call loom_checkout first; it puts the reviewed tree ${(ticket.head_tree ?? ticket.head_sha ?? "").slice(0, 12)} in your worktree. That is the exact work that passed the checks and the one that will merge; the worker's branch may have moved since. Your verdict tools refuse until this worktree has it.`,
    ...(repo.environment === null ? [] : ["This worktree may hold only part of the repository. Read any file at that commit, checked out or not, with `git show HEAD:<path>` once loom_checkout has put it in, and list a directory with `git ls-tree --name-only HEAD <path>/`."]),
    "",
    "## Ticket",
    `${ticket.key} · ${JSON.stringify(ticket.title)}`,
    ticket.body,
    "",
    "## Acceptance criteria",
    ...acceptance.map((line, index) => `${index + 1}. ${line}`),
    "",
    ...(isMultiRepo(spec) ? [...reviewerRepositorySection(project, repo), ...otherReposSection(spec, repo, a.checkouts ?? new Map(), a.remote)] : []),
    "## Rubric",
    spec.review.rubric.length > 0 ? bullets(spec.review.rubric) : "- none; the acceptance criteria are the whole standard",
    "",
    ...rolloutBriefSection(spec, a.tickets ?? [ticket], ticket, REVIEWER_ROLLOUT),
    ...prTextReviewSection(spec, repo, ticket),
    ...(a.prFeedback == null
      ? []
      : [
          "## Pull request feedback",
          `This is a fix for the ticket's open pull request${ticket.pr_url === null ? "" : ` ${ticket.pr_url}`}. Judge whether it addresses this feedback, as well as the acceptance criteria; the worker's summary says what it decided not to change and why.`,
          clip(a.prFeedback.body, 12_000),
          "",
        ]),
    ...stackedReviewSection(ticket, a.remote === true),
    "## Scope report",
    ...(outside.length === 0 && protectedHits.length === 0 ? ["Every changed file is inside the ticket's scope."] : []),
    ...(outside.length > 0 ? [`Changed files outside the ticket's scope: ${outside.join(", ")}`] : []),
    ...(protectedHits.length > 0 ? [`Changed protected files: ${protectedHits.join(", ")}`] : []),
    "",
    "## Check results",
    checkPost === null ? "No check result was recorded." : checkPost.body,
    ...ciLines(spec, repo, REVIEWER_CI),
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
    "Rules: read and run anything, change nothing, commit nothing; judge each acceptance criterion, and the pull request's text when this brief shows it; approve only when every one holds and no blocking finding remains; call exactly one verdict tool, then end your turn.",
    "- loom_approve({ summary }) approves.",
    "- loom_request_changes({ summary, findings }) sends the ticket back; each finding has a severity (blocking or should-fix), a title, a detail, and where you can, a file and a line.",
  );
  return lines.join("\n");
}

const shownText = (title: string | null, body: string | null) => [`Title: ${title ?? "(none proposed)"}`, "Description:", body === null ? "(none proposed)" : clip(body, 12_000)];

/**
 * What the reviewer of a ticket on the pr strategy judges of its pull request's text: the title and description as it will
 * open, or in a fix round the text Loom last set beside the one the worker proposes. Nothing on describe = "loom".
 */
function prTextReviewSection(spec: Spec, repo: RepoSettings, ticket: TicketRow): string[] {
  if (spec.merge.strategy !== "pr" || prSettings(spec).describe !== "worker") return [];
  const proposal = ticket.pr_proposal_json === null ? null : (JSON.parse(ticket.pr_proposal_json) as PrProposal);
  const judge = "Judge this text as you judge the code, against the rubric and the ticket: request changes to it with a finding when it is wrong, unclear or leaves out what the rubric asks of a pull request. Loom adds its own sections after the description, such as the Rollout section, so do not ask for those.";
  if (ticket.pushed_sha === null) {
    if (proposal === null) {
      return ["## The pull request as it will open", "The worker proposed no title or description; it writes them after approval, unreviewed. If the rubric asks something of the pull request's description, request changes so the worker proposes it with loom_submit's pr.", ""];
    }
    const where = repo.forge.kind === "none" ? " A person opens it here, with the text Loom posts on the ticket." : "";
    return ["## The pull request as it will open", `The worker proposes this title and description; Loom opens the pull request with them once the reviewers approve.${where}`, ...shownText(proposal.title, proposal.body), judge, ""];
  }
  const applied = ticket.pr_applied_json === null ? null : (JSON.parse(ticket.pr_applied_json) as PrApplied);
  const unknown = repo.forge.kind === "none" ? "Loom opens no pull request on this forge; a person opened it with the text the ticket's posts show." : "Loom has no record of the text it set; read it on the pull request.";
  const current = applied === null ? [unknown] : [`${applied.byHand === true ? "Loom last posted this text on the ticket for the human to set" : "Loom last set"}:`, ...shownText(applied.title, applied.body ?? "(Loom's template from the ticket)")];
  // An approved edit still waiting to be set is what the pull request is to read, so a proposal is judged against it.
  const waiting = applied?.want === undefined ? [] : ["", "An approved text Loom has not set yet, after a failed edit, which it sets unless a newer approved text replaces it:", ...shownText(applied.want.title, applied.want.body ?? "(Loom's template from the ticket)")];
  const target = applied?.want ?? applied;
  const changes = proposal !== null && (target == null || (proposal.title !== null && proposal.title !== target.title) || (proposal.body !== null && proposal.body !== target.body));
  const proposed = changes ? ["The worker proposes:", ...shownText(proposal.title ?? target?.title ?? null, proposal.body ?? target?.body ?? null)] : ["The worker proposes no change to it."];
  const how = canEdit(repo.forge) ? "Once the reviewers approve, Loom sets the proposed text on the pull request." : "This forge cannot change the pull request's text, so once the reviewers approve, Loom posts the proposed text on the ticket for the human to set.";
  return ["## The pull request's text", ...current, ...waiting, "", ...proposed, ...(changes ? [how, judge] : []), ""];
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

/** Loom's template description of a ticket's pull request, followed by Loom's own sections. */
export function prBody(a: { ticket: TicketRow; approvals: ReviewRow[]; dependsOn?: string[]; rollout?: readonly string[] }): string {
  return `${prTemplateText(a.ticket, a.approvals)}\n\n${loomBlock(a.ticket.key, a.dependsOn, a.rollout)}`;
}

/** The part of Loom's template a worker's description takes the place of: the ticket, its criteria and its review. */
export function prTemplateText(ticket: TicketRow, approvals: readonly ReviewRow[]): string {
  const acceptance = JSON.parse(ticket.acceptance_json) as string[];
  return [
    ticket.body,
    "",
    "Acceptance criteria:",
    ...acceptance.map((line, index) => `${index + 1}. ${line}`),
    "",
    `Review: approved by ${approvals.length} ${approvals.length === 1 ? "reviewer" : "reviewers"}.`,
    ...approvals.map((review) => `- ${review.summary ?? ""}`),
  ].join("\n");
}

/** What starts and ends Loom's own sections at the end of a pull request's description, so Loom can find and replace them later. */
export const LOOM_BEGIN = "<!-- loom:begin -->";
export const LOOM_END = "<!-- loom:end -->";

/** Loom's own sections of a description, between its markers: the pull requests it depends on, its Rollout section and who opened it. */
export function loomBlock(key: string, dependsOn: readonly string[] = [], rollout: readonly string[] = []): string {
  return [LOOM_BEGIN, ...(dependsOn.length > 0 ? [...dependsOn, ""] : []), ...(rollout.length > 0 ? [...rollout, ""] : []), `Opened by Loom for ${key}.`, LOOM_END].join("\n");
}

const count = (text: string, part: string) => text.split(part).length - 1;

/**
 * `body` with its Loom block replaced by `block`. Loom replaces only a block it can tell is its own: exactly one pair of
 * markers, in order. "none" when there is no such pair, "several" when the markers appear more than once.
 */
export function replaceLoomBlock(body: string, block: string): { body: string } | { problem: "none" | "several" } {
  const begins = count(body, LOOM_BEGIN);
  const ends = count(body, LOOM_END);
  if (begins > 1 || ends > 1) return { problem: "several" };
  const start = body.indexOf(LOOM_BEGIN);
  const end = body.indexOf(LOOM_END);
  if (begins === 0 || ends === 0 || end < start) return { problem: "none" };
  return { body: `${body.slice(0, start)}${block}${body.slice(end + LOOM_END.length)}` };
}

/** A worker's text with Loom's markers, and anything between a pair of them, taken out: only Loom writes its own sections. */
export function withoutLoomBlocks(text: string): string {
  let rest = text;
  for (;;) {
    const start = rest.indexOf(LOOM_BEGIN);
    const end = start < 0 ? -1 : rest.indexOf(LOOM_END, start);
    if (end < 0) break;
    rest = `${rest.slice(0, start)}${rest.slice(end + LOOM_END.length)}`;
  }
  return rest.split(LOOM_BEGIN).join("").split(LOOM_END).join("").trim();
}

// ---------------------------------------------------------------- the pull request stage

/** A failed check, and a review, review thread, comment or human reply, as a fix round lists them. */
export interface FeedbackCheck {
  name: string;
  url: string | null;
}
export interface FeedbackItem {
  /** The forge's key for it, which loom_pr_reply names it by; none on the human's reply and in older feedback posts. */
  key?: string;
  kind: "review" | "thread" | "comment" | "reply";
  author: string;
  /** Unknown on the human's reply and in older feedback posts. */
  bot?: boolean;
  body: string;
  url: string | null;
  state: string | null;
  path: string | null;
  line: number | null;
}

const ITEM_TEXT = 1500;

function itemLine(item: FeedbackItem): string {
  const where = item.path === null ? "" : ` on ${item.path}${item.line === null ? "" : `:${item.line}`}`;
  const what =
    item.kind === "review"
      ? `Review by ${item.author}${item.state === null ? "" : ` (${item.state.replace(/_/g, " ")})`}`
      : item.kind === "thread"
        ? `Review thread${where}, last from ${item.author}`
        : item.kind === "reply"
          ? "The human's reply on the ticket"
          : `Comment by ${item.author}`;
  const link = item.url === null ? "" : ` (${item.url})`;
  const key = item.key === undefined || item.kind === "reply" ? "" : `, key \`${item.key}\``;
  return `- ${what}${link}${key}:\n${clip(item.body.trim(), ITEM_TEXT).replace(/^/gm, "  > ")}`;
}

function skippedLine(check: Skipped): string {
  const why =
    check.why === "queued"
      ? `still queued after ${plural(check.minutes, "minute")}`
      : check.why === "running"
        ? `running, about ${check.percent}% done`
        : check.why === "overrun"
          ? `running for ${check.percent}% of its usual time`
          : `still pending ${plural(check.minutes, "minute")} after the push`;
  return `- ${check.name}${check.url === null ? "" : ` (${check.url})`}: ${why}`;
}

/** The feedback of one fix round as Markdown: the failed checks and the pending ones Loom did not wait for, then the reviews and comments. */
export function feedbackList(checks: readonly FeedbackCheck[], items: readonly FeedbackItem[], skipped: readonly Skipped[] = []): string {
  const lines: string[] = [];
  if (checks.length > 0) lines.push("Failed checks:", ...checks.map((check) => `- ${check.name}${check.url === null ? "" : ` (${check.url})`}`));
  if (checks.length > 0 && skipped.length > 0) lines.push("", "Still pending; Loom did not wait for them, so their results are not in yet:", ...skipped.map(skippedLine));
  if (items.length > 0) lines.push(...(lines.length > 0 ? [""] : []), "Review feedback:", ...items.map(itemLine));
  return lines.join("\n");
}

/** What a worker's pull request comments end with unless Loom's commentSignature setting says otherwise. */
export const COMMENT_SIGNATURE = "Posted by Loom";

/** How a worker answers the pull request's reviews and comments: through loom_pr_reply, which Loom signs, on every machine. */
function replyRules(forge: ForgeSpec, signature: string): string[] {
  if (!canReply(forge)) return ["Loom cannot reply on this pull request through its forge, so say in your loom_submit summary what you would answer a review or a comment; the human reads it on the ticket."];
  const line = signature.trim();
  const signs = line === "" ? "" : ` Loom ends each reply with a blank line and this line:\n  ${line}`;
  return [`Answer a review, a review thread or a comment on the pull request with loom_pr_reply({ item, text, resolve }), naming it by the key the fix round's message gives it, never with the forge's CLI: Loom posts the reply from the project's machine, so it works wherever you run.${signs}`];
}

const prRules = (forge: ForgeSpec, signature: string) => [
  "Investigate a failed check with your own tools: the CI's CLI, the forge's CLI and the logs behind the links. A check that failed for a reason this change did not cause needs no code change; say so in your summary.",
  ...replyRules(forge, signature),
  `${canReply(forge) ? "Reply, for example, to explain a change, to ask a question, or to resolve a review thread you fixed with resolve: true. " : ""}Never push, merge, close, approve or edit the pull request yourself: Loom does that.`,
  canEdit(forge)
    ? "When the feedback asks for a new title or description, pass pr = { title, body } to loom_submit with what it should read; the reviewers judge it, and Loom sets it on the pull request once they approve."
    : "When the feedback asks for a new title or description, pass pr = { title, body } to loom_submit with what it should read; the reviewers judge it, and since this forge cannot change the pull request's text, Loom posts it on the ticket for the human to set.",
  "If nothing needs to change, call loom_submit with a summary that says why; Loom then pushes nothing and keeps following the pull request. A fix that changes only pr goes to review, and Loom pushes nothing for it.",
  "Otherwise the fix goes through the checks and a review, then you write its commit message and Loom pushes it as one more commit.",
];

/**
 * Loom asks the worker of an approved ticket for its pull request: the commit message, with the title and description it
 * did not propose with loom_submit, or a fix round's commit message. `changes`: the fix round's proposal changes the text.
 */
export function prAskText(a: { key: string; fix: boolean; round: number; url: string | null; limitMinutes: number; proposed?: { title: boolean; body: boolean }; changes?: boolean }): { summary: string; detail: string } {
  const own = "Write it the way you normally do: follow your own instructions and skills for pull request descriptions and commit messages, if you have any.";
  const after = `Change no files: Loom pushes the exact commit the reviewers approved. Do not commit, push or open a pull request yourself. If loom_pr does not come within ${a.limitMinutes} minutes, Loom uses its own template.`;
  const override = "Pass title or body as well only to change them again now; given, they win.";
  if (a.fix) {
    const text = a.changes === true ? ", then sets the title and description you proposed with loom_submit, which the reviewers approved" : ", and keeps the pull request's title and description";
    return {
      summary: `[loom] ${a.key}: fix round ${a.round} is approved. Write its commit message and hand it in with loom_pr({ commit_message }), then end your turn.`,
      detail: [`Loom pushes the approved fix to ${a.url ?? "the pull request's branch"} as one more commit with your message${text}. ${override}`, own, after].join("\n\n"),
    };
  }
  const proposed = a.proposed ?? { title: false, body: false };
  if (proposed.title && proposed.body) {
    return {
      summary: `[loom] ${a.key} is approved. Loom opens its pull request with the title and description the reviewers approved; write the commit message and hand it in with loom_pr({ commit_message }), then end your turn.`,
      detail: ["Loom pushes the reviewed work as one commit with your commit message, and opens the pull request with the title and description you proposed with loom_submit.", override, own, "- commit_message: the message of that one commit: a subject line, a blank line, then a short body.", after].join("\n\n"),
    };
  }
  const fields = [...(proposed.title ? [] : ["title"]), ...(proposed.body ? [] : ["body"]), "commit_message"];
  return {
    summary: `[loom] ${a.key} is approved. Write its pull request and hand it in with loom_pr({ ${fields.join(", ")} }), then end your turn.`,
    detail: [
      proposed.title || proposed.body
        ? `Loom pushes the reviewed work as one commit with your commit message, and opens the pull request with the ${proposed.title ? "title" : "description"} you proposed with loom_submit and the ${proposed.title ? "description" : "title"} you give here.`
        : "Loom pushes the reviewed work as one commit with your commit message, and opens the pull request with your title and description.",
      own,
      [...(proposed.title ? [] : ["- title: the pull request's title."]), ...(proposed.body ? [] : ["- body: its description, in Markdown."]), "- commit_message: the message of that one commit: a subject line, a blank line, then a short body."].join("\n"),
      after,
    ].join("\n\n"),
  };
}

/** `commitOnly`: the text is in, so only the commit message is missing. */
export function prNudgeText(key: string, commitOnly: boolean): string {
  const call = commitOnly ? "loom_pr({ commit_message })" : "loom_pr({ title, body, commit_message })";
  return `[loom] ${key}: your turn ended without loom_pr. Call ${call} now, then end your turn; if your turn ends again without it, Loom uses its own template.`;
}

/** A fix round: what the pull request's checks and reviews, or the human on the ticket, asked for. */
/** What a worker whose environment Loom released, and bb restored, must know before it runs anything. */
export const RESTORED_NOTE =
  "While the pull request waited, Loom released your worktree to free its environment, and bb has now built a new one on your branch: every commit is there, but files git ignores, such as installed dependencies and build output, are gone, and paths from earlier in this conversation may have moved. Set up what the checks need before you run them.";

const CI_FIX = "These checks ran in the pull request's CI, which may run tests you cannot run here: read each one's log at its link, fix the cause, and say in your loom_submit summary which of those tests you could not run here.";

/** What a fix round's worker must know about commits someone else pushed to the pull request's branch. */
function foreignTipLines(foreign: ForeignTip | null): string[] {
  if (foreign === null) return [];
  if (foreign.kind === "merge") return [`The pull request's branch has commits Loom did not push. First run \`git fetch ${foreign.remote} ${foreign.branch}\` and \`git merge FETCH_HEAD\` in this worktree, so your fix builds on them.`];
  if (foreign.kind === "took") {
    return [
      `The pull request's branch had commits Loom did not push (its tip is ${foreign.tip.slice(0, 12)}). Loom merged them into your branch on the project's machine, and your worktree has the result, or gets it from loom_resume when your brief says to call it first. Build your fix on them, and do not fetch or merge the branch yourself.`,
    ];
  }
  return ["The pull request's branch has commits Loom did not push. Do not fetch or merge them yourself: when Loom pushes your fix, it merges them into your branch first and runs your checks on the result, and a conflict comes back to you."];
}

export function prFeedbackText(a: { key: string; url: string | null; round: number; counted: number; max: number; checks: FeedbackCheck[]; items: FeedbackItem[]; skipped?: Skipped[]; foreign: ForeignTip | null; forge?: ForgeSpec; signature?: string; restored?: boolean }): { summary: string; detail: string } {
  const human = a.items.some((item) => item.kind === "reply");
  const what = human ? "The human replied on the ticket about its open pull request" : a.url === null ? "The pull request needs fixes" : `The pull request ${a.url} needs fixes`;
  const merge = foreignTipLines(a.foreign);
  return {
    summary: `[loom] ${a.key}: ${what} (fix round ${a.round}${human ? "" : `; ${a.counted} of the ${a.max} the pull request may start`}). Address it, then call loom_submit({ summary }).`,
    detail: [...(a.restored === true ? [RESTORED_NOTE] : []), feedbackList(a.checks, a.items, a.skipped), ...(a.checks.length === 0 ? [] : [CI_FIX]), ...merge, ...prRules(a.forge ?? { kind: "gh" }, a.signature ?? COMMENT_SIGNATURE).map((rule) => `- ${rule}`)].join("\n\n"),
  };
}

/** A message to a worker whose worktree bb restored since its last submit, with the note on what that means first. */
export function withRestoredNote(text: { summary: string; detail: string }, restored: boolean): { summary: string; detail: string } {
  return restored ? { ...text, detail: `${RESTORED_NOTE}\n\n${text.detail}` } : text;
}

export function prUnchangedText(key: string): string {
  return `[loom] ${key}: nothing changed since the pull request's last commit, so Loom pushes nothing and keeps following the pull request. End your turn and wait for a message.`;
}

/** The pull request's branch kept getting commits Loom did not push while Loom merged them into the worker's branch. */
export function prDivergedText(key: string): { summary: string; detail: string } {
  return {
    summary: `[loom] ${key}: the pull request's branch kept getting commits Loom did not push while Loom merged them into your branch, so Loom did not push your fix. Call loom_submit again.`,
    detail: "Your worktree has the commits Loom merged so far. Run the checks and call loom_submit({ summary }); before it pushes, Loom merges whatever the branch got since. Do not fetch or merge the branch yourself. The fix goes through review again.",
  };
}

/** The worker's description first, then Loom's own sections between its markers. */
export function workerPrBody(key: string, body: string, dependsOn: readonly string[] = [], rollout: readonly string[] = []): string {
  return `${withoutLoomBlocks(body)}\n\n${loomBlock(key, dependsOn, rollout)}`;
}

/** A brief's Rollout section: what the ticket's change is in the deploy order, after the rule for the agent reading it. */
function rolloutBriefSection(spec: Spec, tickets: readonly TicketRow[], ticket: TicketRow, rule: string): string[] {
  const facts = rolloutFacts(spec, tickets, ticket, null, 0);
  return facts.length === 0 ? [] : ["## Rollout", rule, ...facts, ""];
}
const WORKER_ROLLOUT = "Loom writes the rollout order in the pull request's Rollout section; do not write deploy order or prerequisites into the description.";
const REVIEWER_ROLLOUT =
  "Loom tracks the rollout order and shows it in the pull request's Rollout section. Do not request changes to keep the pull request a draft or to describe the deploy order. Never call loom_request_changes for the rollout order: it is advice for the human. If the rollout order in the spec looks wrong, say so with loom_note or in your verdict's summary."; 

/** Loom could not merge what a stacked ticket's branch must take: the worker merges `branch` and resolves the conflict. */
export function restackConflictText(key: string, what: string, branch: string, files: readonly string[]): { summary: string; detail: string } {
  return {
    summary: `[loom] ${key}: Loom could not bring your branch up to date with ${what}: the merge conflicts in ${plural(files.length, "file")}. Merge it yourself, resolve them and call loom_submit again.`,
    detail: [
      `Merging ${what} into your branch conflicted in:`,
      ...files.map((file) => `- ${file}`),
      `Your branch was left unchanged. In your worktree run \`git merge --no-edit ${branch}\`, resolve those files so both sides' changes hold, run the checks, and call loom_submit({ summary }). The plugin commits the merge with your fix, and the work goes through review again before Loom pushes it.`,
    ].join("\n"),
  };
}

/** Loom merged what a stacked ticket's branch must take on the project's machine and put the result, with conflict markers, in the worktree of a worker on another machine. */
export function restackMarkersText(key: string, what: string, files: readonly string[]): { summary: string; detail: string } {
  return {
    summary: `[loom] ${key}: Loom brought your branch up to date with ${what}, and ${plural(files.length, "file")} conflict. Resolve the conflict markers Loom left in them and call loom_submit again.`,
    detail: [
      `Loom merged ${what} into your branch on the project's machine and put the result in your worktree as one commit. These files have conflict markers where both sides changed the same lines:`,
      ...files.map((file) => `- ${file}`),
      "Resolve each so both sides' changes hold, without a merge commit or a rebase, run the checks, and call loom_submit({ summary }). A submit that still has the markers is refused, and the work goes through review again before Loom pushes it.",
    ].join("\n"),
  };
}

/** Loom could not put what a stacked ticket's branch must take in its worker's worktree on another machine, which holds work Loom has not seen. */
export function restackRefusedText(key: string, what: string, why: string): { summary: string; detail: string } {
  return {
    summary: `[loom] ${key}: Loom must bring your branch up to date with ${what}, but left your worktree as it is: ${why}.`,
    detail: "Your worktree holds work that is not the commit the reviewers approved. Keep what belongs to the ticket and discard the rest, then call loom_submit({ summary }); Loom brings the branch up to date once that work passes review.",
  };
}

/** Loom must merge into the worker's worktree, which has a merge the worker began and did not finish. */
export function unfinishedMergeText(key: string, what: string): { summary: string; detail: string } {
  return {
    summary: `[loom] ${key}: Your worktree has a merge you have not finished. Finish it with git commit, or abort it with git merge --abort, then call loom_submit.`,
    detail: `Loom must bring your branch up to date with ${what} before it pushes, and left your worktree as it is, so your resolution is kept. Once the merge is finished or aborted, run the checks and call loom_submit({ summary }); Loom brings the branch up to date once that work passes review.`,
  };
}

/** Loom merged what a stacked ticket's branch must take, and one of the ticket's checks failed or changed the worktree on the result. */
export function restackFailedText(key: string, what: string, run: CheckRun, changed?: string): { summary: string; detail: string } {
  const how = changed !== undefined ? `passed but changed the worktree (${changed})` : run.timedOut ? "timed out" : `exited with ${run.exitCode}`;
  return {
    summary: `[loom] ${key}: Loom merged ${what} into your branch, and then the check ${JSON.stringify(run.command)} ${how}. The merge stays in your branch: fix your work for what changed and call loom_submit again.`,
    detail: `Output of ${JSON.stringify(run.command)} on the merged result, the last ${CHECK_TAIL} characters at most:\n${run.output.slice(-CHECK_TAIL)}`,
  };
}

/** A pull request in another repo that a working ticket depends on has a new commit. */
export function upstreamChangedText(key: string, dep: { key: string; url: string | null; sha: string; repo: string | null }, path: string | null): { summary: string; detail: string } {
  const where = dep.url ?? `its branch in the repo ${JSON.stringify(dep.repo)}`;
  return {
    summary: `[loom] ${key}: ${dep.key}'s pull request ${where} has a new commit, ${dep.sha.slice(0, 12)}. Check that your work still fits it.`,
    detail: path === null ? `${dep.key} is in the repo ${JSON.stringify(dep.repo)}.` : `Read its files with \`git -C ${path} show ${dep.sha}:<file>\`, and its change with \`git -C ${path} show ${dep.sha}\`.`,
  };
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
  "Done when: trace each project.done_when item to the tickets whose acceptance criteria make it true. An item that no ticket delivers is a finding; name the item.",
  "Delivery: a ticket whose acceptance criteria can be met by documenting why the goal cannot be met, such as a change of comments or docs alone where the goal asks for different behaviour, is a finding. Ask for criteria that only the change itself meets.",
  "Checks and scope: a check command that does not exist in the repository, a scope far wider than the ticket's work, or a depends_on or merge_after where no order is needed, is a finding.",
  "Summary: project.summary tells someone who has not read the goal what the project changes and why. A summary that only names an issue or a task, or that promises what no ticket delivers, is a finding.",
  "Hooks: every [[hook]] carries out something the human asked for, in the planning conversation or in the standing instructions from Loom's settings when this brief lists them; a hook no one asked for is a finding. So is a standing instruction that applies to this project when no hook or ticket carries it out: name the instruction and the hook that would.",
  "Rollout: on the pr strategy, depends_on orders the work, merge_after the merges and rollout the deploys. A ticket that changes a running system (a service, infrastructure, or an interface other code calls) with no rollout is a finding, and so is a rollout that breaks these: providers before consumers, dark before exposed, staging before production, a verify or a soak between stages, removal last behind a milestone, and no deploy-on-merge step inside a window.",
];

const SPEC_LIMIT = 60_000;
const CHANGES_LIMIT = 8000;

const shown = (value: unknown) => clip(typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value ?? null), 300);

function describeChange(change: SpecChange): string {
  switch (change.kind) {
    case "value":
      return `${shown(change.before)} → ${shown(change.after)}`;
    case "list":
      return change.steps
        .filter((step) => step.op !== "same")
        .map((step) => `${step.op === "added" ? "+" : "−"} ${clip(step.value, 200)}`)
        .join("; ");
    case "text":
      return "rewritten";
    case "ticket-added":
      return "new ticket";
    case "ticket-removed":
      return "ticket removed";
  }
}

/** What `after` changes from `before`, one spec path per line, for a reviewer of a pending version. */
export function specChangeLines(before: Spec, after: Spec): string {
  const changes = specDiff(before, after);
  if (changes.length === 0) return "- nothing";
  return clip(changes.map((change) => `- ${change.path}: ${describeChange(change)}`).join("\n"), CHANGES_LIMIT);
}

/** The findings as a numbered list: the spec path and title, then the detail indented. */
export function specFindingsList(findings: readonly SpecFinding[]): string {
  return findings
    .map((finding, index) => `${index + 1}. ${finding.path === undefined ? "" : `${finding.path}: `}${finding.title}\n${finding.detail.split("\n").map((line) => `   ${line}`).join("\n")}`)
    .join("\n");
}

export function specReviewerBrief(a: { project: ProjectRow; spec: Spec; toml: string; version: number; round: number; earlier: readonly SpecReviewRow[]; inForce?: { version: number; spec: Spec } | null; instructions?: string }): string {
  const { project, spec, toml, version, round } = a;
  const instructions = (a.instructions ?? "").trim();
  const inForce = a.inForce ?? null;
  const earlier = a.earlier.filter((row) => row.state === "approved" || row.state === "changes_requested");
  const lines = [
    `You are Loom's spec reviewer for version ${version} of the project ${JSON.stringify(project.name)} (${project.slug}), round ${round} of ${SPEC_REVIEW_ROUNDS}. A planner agent wrote this spec from a conversation with the human. Before the human is asked to approve it, you check that it builds what the human asked for, and no more. You judge the spec; you change nothing.`,
    "",
    "## What the human asked for",
    `Read the planning conversation first: \`bb thread log ${project.planner_thread_id} --format minimal --all\`. The User messages are the human's request and answers; messages that start with [loom] come from Loom, not the human. The human's words outrank the spec's goal, which is the planner's summary of them.`,
    "The human's answers to the planner's Ask User Question rounds may be missing from that log. The goal and non-goals below record them, so treat those as the human's words unless the log contradicts them.",
    "",
    `Goal: ${spec.project.goal}`,
    ...(spec.project.summary === undefined ? [] : [`Summary: ${spec.project.summary}`]),
    ...(spec.project.non_goals.length === 0 ? [] : ["Non-goals:", bullets(spec.project.non_goals)]),
    "",
    ...(instructions === ""
      ? []
      : [
          "## The human's standing instructions",
          "The human set these planner instructions in Loom's settings, for every project, and the planner saw them. They are the human's words too, but the human's messages in this conversation outrank them. Check that the spec carries out each one that applies to this project, usually as a [[hook]] table.",
          '"""',
          instructions,
          '"""',
          "",
        ]),
    ...(inForce === null
      ? []
      : [
          "## A change to an approved project",
          `The human approved v${inForce.version} and the project is ${project.state}, so its tickets are already on the board. The planner proposed v${version} after that, usually to unblock tickets in a triage round; its latest messages in the planning conversation say why. Judge what v${version} changes from v${inForce.version}, below, against the rubric; leave the parts it does not change alone. Tickets on the board change only through the planner's board tools, so ticket changes in the spec are a record, not new work.`,
          "",
          "What changes:",
          specChangeLines(inForce.spec, spec),
          "",
        ]),
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

const handOverText = (version: number, pending: boolean) =>
  pending
    ? `Hand over to the human now: tell them what v${version} changes and that it waits for their approval. If they need to do more after approving, such as requeue tickets, record it with loom_ask_human.`
    : "Hand over to the human now: tell them what you proposed and that the draft is ready to approve.";

/** The verdict for the planner, visible in its chat: no findings is an approval. `pending` is a version proposed after approval. */
export function specReviewVerdictText(a: { slug: string; version: number; round: number; summary: string; findings: readonly SpecFinding[]; pending?: boolean }): string {
  const { slug, version, round, summary, findings } = a;
  if (findings.length === 0) return [`[loom] Spec review round ${round} passed v${version} of ${slug}: ${summary}`, handOverText(version, a.pending === true)].join("\n");
  const next =
    round >= SPEC_REVIEW_ROUNDS
      ? "This was the last automatic round. Revise the spec for the findings you agree with and call loom_propose once more; Loom does not review it again. Then hand over, and tell the human which findings you left open and why."
      : "Revise the spec for each finding and call loom_propose again; a fresh reviewer checks the new version. If a finding is wrong, leave that part as it is and say why in your reply: the next reviewer reads this conversation. Do not hand over yet.";
  return [`[loom] Spec review round ${round} of ${SPEC_REVIEW_ROUNDS} found ${plural(findings.length, "problem")} in v${version} of ${slug}: ${summary}`, "", specFindingsList(findings), "", next].join("\n");
}

/** What the planner reads when its version skips the spec review: the hand-over a passed review gives, and why there was none. */
export function specReviewSkippedText(a: { slug: string; version: number; against: number; paths: readonly string[]; pending?: boolean }): string {
  return [`[loom] Loom skipped the spec review of v${a.version} of ${a.slug}: against v${a.against}, it changes only operational settings (${a.paths.join(", ")}).`, handOverText(a.version, a.pending === true)].join("\n");
}

export function specReviewFailedText(a: { slug: string; version: number; reason: string }): string {
  return `[loom] The spec review of v${a.version} of ${a.slug} did not finish: ${a.reason}. Call loom_propose again with the same spec to start a new review; do not hand over until a review passes.`;
}
