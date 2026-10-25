// Review threads: a preset's prompt, filled in for one PR, in a new thread or an existing one.
import { presetById, type Preset } from "./config";
import type { ReviewInput } from "./contract";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { matchProject } from "./projects";
import { linkPr, requirePr, shortKey } from "./prs";
import { sendToReviewThread } from "./review-threads";
import { inert, renderTemplate } from "./templates";
import { workspaceFor } from "./workspaces";

export { renderTemplate };

/** A server's link goes into prompts only as one plain http(s) URL; anything else is quoted server text. */
export function promptUrl(url: string): string {
  return /^https?:\/\/[^\s`<>"']{1,1000}$/u.test(url) ? url : `"${inert(url, 300)}"`;
}

export function promptVars(ctx: Ctx, pr: PrRow, extra: { skill?: string; note?: string } = {}): Record<string, string> {
  const server = ctx.server(pr.server);
  const skill = extra.skill?.trim() ?? "";
  const note = extra.note?.trim() ?? "";
  return {
    url: promptUrl(pr.url),
    key: pr.key,
    server: server?.name ?? pr.server,
    repo: pr.repo,
    number: String(pr.number),
    sep: server?.sep ?? "#",
    display: shortKey(ctx, pr),
    head: pr.head ? pr.head.slice(0, 12) : "unknown",
    base: pr.base ?? "unknown",
    // Server text: one bounded line, so a title can't pose as more of the prompt.
    title: inert(pr.title, 300),
    author: inert(pr.author, 100),
    skill,
    skill_line: skill ? `Use the \`${skill}\` skill for this review.\n` : "",
    view_command: ctx.adapter(pr.server).readCommand(pr.repo, pr.number, pr.url),
    note: note ? `\n\nNote from me: ${note}` : "",
  };
}

export async function projectFor(ctx: Ctx, pr: PrRow, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const projectId = matchProject(pr.repo, await ctx.projects(), ctx.settings().defaultProject || null);
  if (!projectId) throw new ShuttleError(`no bb project matches ${pr.repo}; pick one, or set "Project for review threads" in Shuttle's settings`);
  return projectId;
}

export interface ReviewStarted {
  threadId: string;
  preset: Preset;
  /** The review went to a thread Shuttle brought back from the archive. */
  revived: boolean;
}

export async function startReview(ctx: Ctx, input: ReviewInput, trigger: "auto" | "manual"): Promise<ReviewStarted> {
  const pr = requirePr(ctx, input.key);
  const config = ctx.config();
  const preset = presetById(config, input.presetId ?? (trigger === "auto" ? config.autoReview.preset : undefined));
  const skill = input.skill ?? preset.skill;
  const prompt = renderPromptFor(ctx, pr, preset, { skill, note: input.note });
  const providerId = input.providerId ?? preset.providerId;
  const model = input.model ?? preset.model;
  const reasoningLevel = input.reasoningLevel ?? preset.reasoningLevel;
  const run = { ...(model ? { model } : {}), ...(reasoningLevel ? { reasoningLevel } : {}) };
  let threadId: string | null = null;
  let revived = false;
  let ownThread = false;
  if (input.threadId) {
    // A thread the user picked keeps its own model unless they changed it for this run.
    const picked = { ...(input.model ? { model: input.model } : {}), ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}) };
    ({ revived } = await sendToReviewThread(ctx, input.threadId, prompt, picked));
    threadId = input.threadId;
    ownThread = ctx.store.reviewsOf(pr.id).some((review) => review.thread_id === threadId && review.own_thread === 1);
  } else if (!input.newThread) {
    // The PR's next review goes to the thread of its last one, which already knows the PR.
    const last = ctx.store.reviewThreadOf(pr.id);
    if (last && ctx.store.linkRole(pr.id, last.thread_id) === "review") {
      try {
        ({ revived } = await sendToReviewThread(ctx, last.thread_id, prompt, { ...run, ...(providerId ? { providerId } : {}) }));
        threadId = last.thread_id;
        ownThread = true;
      } catch (error) {
        const title = ctx.store.threadTitle(last.thread_id) ?? last.thread_id;
        ctx.store.addEvent("revive_failed", `The review of ${shortKey(ctx, pr)} went to a new thread: “${title}” could not take it (${errText(error)}).`, pr.id, last.thread_id);
      }
    }
  }
  if (threadId === null) {
    ownThread = true;
    const sectionId = await reviewSectionId(ctx, pr);
    threadId = await ctx.port.spawnThread({
      projectId: await projectFor(ctx, pr, input.projectId),
      title: `Review ${shortKey(ctx, pr)}`,
      ...(sectionId ? { sectionId } : {}),
      prompt,
      workspace: await workspaceFor(preset, ctx.server(pr.server)?.workspace, pr, ctx.run),
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
      ...(reasoningLevel ? { reasoningLevel } : {}),
      metadata: { shuttle: { pr: pr.key, role: "review" } },
    });
  }
  const role = ctx.store.linkRole(pr.id, threadId) ?? "review";
  await linkPr(ctx, pr, threadId, role, { watch: false });
  ctx.store.addReview({ pr_id: pr.id, thread_id: threadId, preset: preset.name, trigger, head: pr.head, own_thread: ownThread ? 1 : 0 });
  // A new review makes the last one's unposted draft out of date.
  const stale = ctx.store.liveDraft(pr.id);
  if (stale) ctx.store.setDraftState(stale.id, "discarded");
  ctx.store.setDismissed(pr.id, null);
  const why = trigger === "auto" ? "Auto review" : "Review";
  const back = revived ? ", brought back from the archive" : "";
  ctx.store.addEvent("review", `${why} of ${shortKey(ctx, pr)} started with ${preset.name}${skill ? ` (${skill})` : ""} in \u201c${ctx.store.threadTitle(threadId)}\u201d${back}.`, pr.id, threadId);
  ctx.port.publish();
  return { threadId, preset, revived };
}

/** A review still starts when its section cannot be made; the Activity list says why it is unfiled. */
async function reviewSectionId(ctx: Ctx, pr: PrRow): Promise<string | null> {
  const name = ctx.settings().reviewSection;
  if (!name) return null;
  try {
    return await ctx.port.ensureSection(name);
  } catch (error) {
    ctx.store.addEvent("section_failed", `Could not put the review of ${shortKey(ctx, pr)} in the section \u201c${name}\u201d: ${errText(error)}`, pr.id);
    return null;
  }
}

/** Added to every review prompt, whatever the preset says, so the draft comes back to Shuttle to post. */
export const DRAFT_PROMPT =
  "When your review is ready, call the shuttle_review_draft tool for {key} with a short summary, the verdict you suggest (comment, approve or changes) and each finding: its severity (high, medium, low or nit), the file path, the line in the new version of the file, and the comment as you would post it. Shuttle shows the draft to me to choose what to post; do not post anything on the pull request yourself.";

export function renderPromptFor(ctx: Ctx, pr: PrRow, preset: Preset, extra: { skill?: string; note?: string }): string {
  const vars = promptVars(ctx, pr, extra);
  return `${renderTemplate(preset.prompt, vars)}\n\n${renderTemplate(DRAFT_PROMPT, vars)}`;
}

export const OWN_PROMPT =
  "You are the agent of the pull request {url} ({display}): {title}.\nRead it with: {view_command}\nShuttle sends new reviews, comments and failed checks on it to this thread. Read it now and summarize its state in a few lines, then wait for instructions.";

export async function startOwnerThread(ctx: Ctx, key: string, projectId?: string): Promise<string> {
  const pr = requirePr(ctx, key);
  const threadId = await ctx.port.spawnThread({
    projectId: await projectFor(ctx, pr, projectId),
    title: `${shortKey(ctx, pr)}: ${pr.title}`.slice(0, 120),
    prompt: renderTemplate(OWN_PROMPT, promptVars(ctx, pr)),
    workspace: { kind: "project-default" },
    metadata: { shuttle: { pr: pr.key, role: "owner" } },
  });
  await linkPr(ctx, pr, threadId, "owner");
  return threadId;
}
