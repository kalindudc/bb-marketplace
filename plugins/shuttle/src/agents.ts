// A PR's agent: the one thread that gets its new reviews, comments and failed checks. It is the
// PR's owner link, and its watch mode is what the agent does: act (fix it) or forward (just tell it).
import type { WatchMode } from "./config";
import type { AgentMode, AgentTarget } from "./contract";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import type { ThreadInfo } from "./ports";
import { exactProject } from "./projects";
import { linkPr, requirePr, setWatch, shortKey } from "./prs";
import { startOwnerThread } from "./reviews";
import { agentMode } from "./views";

const WATCH_OF: Record<AgentMode, WatchMode | null> = { fix: "act", notify: "forward", off: null };
const THREAD_IN_BRANCH = /thr_[a-z0-9]{6,}/u;

export const hasFeedback = (pr: PrRow) => pr.review === "changes" || pr.checks === "failed";
const removedKey = (pr: PrRow) => `agent_removed:${pr.id}`;

export function defaultMode(ctx: Ctx): AgentMode {
  return ctx.config().watch.mode === "act" ? "fix" : "notify";
}

/** What the caller must do next: send the PR's current feedback to the new agent when `backlog`. */
export interface AgentChange {
  threadId: string | null;
  backlog: boolean;
}

export async function setAgent(ctx: Ctx, key: string, target: AgentTarget, mode?: AgentMode, options: { auto?: boolean } = {}): Promise<AgentChange> {
  const pr = requirePr(ctx, key);
  const before = ctx.store.ownerLink(pr.id);
  const beforeMode = agentMode(ctx.store.watch(pr.id)?.mode ?? null);
  if (target.kind === "none") {
    ctx.store.demoteOwners(pr.id, null);
    setWatch(ctx, pr, null);
    // Auto agent would otherwise give it straight back.
    ctx.store.setKv(removedKey(pr), String(ctx.now()));
    if (before) ctx.store.addEvent("linked", `\u201c${ctx.store.threadTitle(before.thread_id) ?? before.thread_id}\u201d is no longer the agent of ${shortKey(ctx, pr)}; it stays linked for reference.`, pr.id, before.thread_id);
    ctx.port.publish();
    return { threadId: null, backlog: false };
  }
  let threadId: string;
  if (target.kind === "new") {
    threadId = await startOwnerThread(ctx, key, target.projectId);
  } else {
    await linkPr(ctx, pr, target.threadId, "owner", { watch: false, auto: options.auto === true });
    threadId = target.threadId;
  }
  ctx.store.setKv(removedKey(pr), "");
  const next = mode ?? (before && beforeMode !== "off" ? beforeMode : defaultMode(ctx));
  const changedThread = before?.thread_id !== threadId;
  const backlog = next !== "off" && (changedThread || beforeMode === "off") && hasFeedback(pr);
  // Items still queued go to the new agent. With a backlog, what the old agent saw is not what the
  // new one has, so it starts again from what it has been sent itself.
  if (changedThread && backlog) ctx.store.forgetSeen(pr.id);
  setWatch(ctx, pr, WATCH_OF[next], { backlog });
  ctx.port.publish();
  return { threadId, backlog };
}

export function setAgentMode(ctx: Ctx, key: string, mode: AgentMode): AgentChange {
  const pr = requirePr(ctx, key);
  const owner = ctx.store.ownerLink(pr.id);
  if (!owner) throw new ShuttleError(`${shortKey(ctx, pr)} has no agent; pick a thread first`);
  const beforeMode = agentMode(ctx.store.watch(pr.id)?.mode ?? null);
  const backlog = mode !== "off" && beforeMode === "off" && hasFeedback(pr);
  setWatch(ctx, pr, WATCH_OF[mode], { backlog });
  return { threadId: owner.thread_id, backlog };
}

export async function askAgent(ctx: Ctx, key: string, text: string): Promise<void> {
  const pr = requirePr(ctx, key);
  const owner = ctx.store.ownerLink(pr.id);
  if (!owner || owner.archived === 1) throw new ShuttleError(`${shortKey(ctx, pr)} has no agent to ask`);
  await ctx.port.send(owner.thread_id, `[shuttle] About ${pr.key} (${pr.url}), from me:\n\n${text}`);
  ctx.store.addEvent("asked_agent", `Asked \u201c${ctx.store.threadTitle(owner.thread_id) ?? owner.thread_id}\u201d about ${shortKey(ctx, pr)}.`, pr.id, owner.thread_id);
  ctx.port.publish();
}

/**
 * The bb thread that opened the PR: the one whose id is in its branch name, or one working on its
 * branch, and in both cases in the project whose remote is exactly the PR's repository. A thread
 * elsewhere never becomes, or is offered as, the agent.
 */
export async function findOpener(ctx: Ctx, pr: PrRow, threads: () => Promise<ThreadInfo[]>): Promise<{ thread: ThreadInfo; why: string } | null> {
  if (!pr.head_ref) return null;
  const project = exactProject(pr.repo, await ctx.projects());
  if (!project) return null;
  const named = pr.head_ref.match(THREAD_IN_BRANCH)?.[0];
  if (named) {
    const thread = await ctx.port.getThread(named);
    if (thread && !thread.archived && thread.projectId === project) return { thread, why: "Opened this PR: its id is in the branch name" };
  }
  const onBranch = (await threads())
    .filter((t) => !t.archived && t.branch === pr.head_ref && t.projectId === project)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  return onBranch ? { thread: onBranch, why: "Works on this PR's branch" } : null;
}

/**
 * For each open PR of yours without an agent: find the thread that opened it. With auto agent on,
 * that thread becomes the agent; otherwise it is offered as a suggestion.
 */
export async function runAutoAgent(ctx: Ctx, signal?: AbortSignal): Promise<Array<{ key: string; change: AgentChange }>> {
  const on = ctx.settings().autoAgent && !ctx.settings().pauseAutomations;
  let listed: ThreadInfo[] | null = null;
  const threads = async () => (listed ??= await ctx.port.listThreads(200));
  const out: Array<{ key: string; change: AgentChange }> = [];
  const enabled = new Set(ctx.config().servers.filter((s) => s.enabled).map((s) => s.id));
  for (const pr of ctx.store.allPrs()) {
    if (signal?.aborted) break;
    if (pr.mine !== 1 || !enabled.has(pr.server) || (pr.state !== "open" && pr.state !== "draft")) continue;
    if (ctx.store.ownerLink(pr.id)) {
      if (pr.suggested_thread) ctx.store.setSuggestion(pr.id, null, null);
      continue;
    }
    try {
      const found = await findOpener(ctx, pr, threads);
      if (!found) {
        if (pr.suggested_thread) ctx.store.setSuggestion(pr.id, null, null);
        continue;
      }
      ctx.store.saveThread(found.thread.id, found.thread.title, found.thread.archived, { status: found.thread.status, waiting: found.thread.waiting });
      if (on && !ctx.store.kv(removedKey(pr))) {
        const change = await setAgent(ctx, pr.key, { kind: "existing", threadId: found.thread.id }, undefined, { auto: true });
        ctx.store.addEvent("auto_agent", `Auto agent made \u201c${found.thread.title}\u201d the agent of ${shortKey(ctx, pr)}: it opened the PR.`, pr.id, found.thread.id);
        out.push({ key: pr.key, change });
      } else {
        ctx.store.setSuggestion(pr.id, found.thread.id, found.why);
      }
    } catch (error) {
      ctx.port.log("warn", `auto agent for ${pr.key}: ${errText(error)}`);
    }
  }
  if (out.length) ctx.port.publish();
  return out;
}
