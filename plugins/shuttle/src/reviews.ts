// Review threads: a preset's prompt, filled in for one PR, in a new thread or an existing one.
import { presetById, type Preset } from "./config";
import type { ReviewInput } from "./contract";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { matchProject } from "./projects";
import { linkPr, requirePr, shortKey } from "./prs";
import { renderTemplate } from "./templates";

export { renderTemplate };

export function promptVars(ctx: Ctx, pr: PrRow, extra: { skill?: string; note?: string } = {}): Record<string, string> {
  const server = ctx.server(pr.server);
  const skill = extra.skill?.trim() ?? "";
  const note = extra.note?.trim() ?? "";
  return {
    url: pr.url,
    key: pr.key,
    server: server?.name ?? pr.server,
    repo: pr.repo,
    number: String(pr.number),
    sep: server?.sep ?? "#",
    display: shortKey(ctx, pr),
    head: pr.head ? pr.head.slice(0, 12) : "unknown",
    base: pr.base ?? "unknown",
    title: pr.title,
    author: pr.author,
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
}

export async function startReview(ctx: Ctx, input: ReviewInput, trigger: "auto" | "manual"): Promise<ReviewStarted> {
  const pr = requirePr(ctx, input.key);
  const config = ctx.config();
  const preset = presetById(config, input.presetId ?? (trigger === "auto" ? config.autoReview.preset : undefined));
  const skill = input.skill ?? preset.skill;
  const prompt = renderPromptFor(ctx, pr, preset, { skill, note: input.note });
  let threadId: string;
  if (input.threadId) {
    await ctx.port.send(input.threadId, prompt);
    threadId = input.threadId;
  } else {
    const providerId = input.providerId ?? preset.providerId;
    const model = input.model ?? preset.model;
    const reasoningLevel = input.reasoningLevel ?? preset.reasoningLevel;
    const sectionId = await reviewSectionId(ctx, pr);
    threadId = await ctx.port.spawnThread({
      projectId: await projectFor(ctx, pr, input.projectId),
      title: `Review ${shortKey(ctx, pr)}`,
      ...(sectionId ? { sectionId } : {}),
      prompt,
      workspace: preset.workspace,
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
      ...(reasoningLevel ? { reasoningLevel } : {}),
      metadata: { shuttle: { pr: pr.key, role: "review" } },
    });
  }
  const role = ctx.store.linkRole(pr.id, threadId) ?? "review";
  await linkPr(ctx, pr, threadId, role, { watch: false });
  ctx.store.addReview({ pr_id: pr.id, thread_id: threadId, preset: preset.name, trigger, head: pr.head });
  ctx.store.setDismissed(pr.id, null);
  const why = trigger === "auto" ? "Auto review" : "Review";
  ctx.store.addEvent("review", `${why} of ${shortKey(ctx, pr)} started with ${preset.name}${skill ? ` (${skill})` : ""} in \u201c${ctx.store.threadTitle(threadId)}\u201d.`, pr.id, threadId);
  ctx.port.publish();
  return { threadId, preset };
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

export function renderPromptFor(ctx: Ctx, pr: PrRow, preset: Preset, extra: { skill?: string; note?: string }): string {
  return renderTemplate(preset.prompt, promptVars(ctx, pr, extra));
}

export const OWN_PROMPT =
  "You own the pull request {url} ({display}): {title}.\nRead it with: {view_command}\nShuttle has linked it to this thread; when it is watched, new reviews arrive here. Read it now and summarize its state in a few lines, then wait for instructions.";

export async function startOwnerThread(ctx: Ctx, key: string, projectId?: string): Promise<string> {
  const pr = requirePr(ctx, key);
  const threadId = await ctx.port.spawnThread({
    projectId: await projectFor(ctx, pr, projectId),
    title: `${shortKey(ctx, pr)}: ${pr.title}`.slice(0, 120),
    prompt: renderTemplate(OWN_PROMPT, promptVars(ctx, pr)),
    workspace: "project-default",
    metadata: { shuttle: { pr: pr.key, role: "owner" } },
  });
  await linkPr(ctx, pr, threadId, "owner");
  return threadId;
}
