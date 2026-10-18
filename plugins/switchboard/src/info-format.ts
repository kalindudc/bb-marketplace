import type { PluginBrowserBbSdk, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { countStates, rowState, STATE_ORDER } from "./status";

export type ExecutionOptions = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["defaultExecutionOptions"]>>;
export type Usage = NonNullable<Awaited<ReturnType<PluginBrowserBbSdk["threads"]["context"]>>["usage"]>;
export type Outline = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["conversationOutline"]>>;
export type Interactions = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["interactions"]["list"]>>;
export type WorkspaceStatus = Awaited<ReturnType<PluginBrowserBbSdk["environments"]["status"]>>;
export interface Stat { insertions: number; deletions: number; files: number }
export interface Changes { committed: Stat | null; uncommitted: Stat | null; ahead: number; behind: number; base: string | null }

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

export function tokens(count: number): string {
  if (count < 1_000) return String(count);
  const thousands = Math.round(count / 1_000);
  if (thousands < 1_000) return `${thousands}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function usageSummary(usage: Usage): { percent: number; text: string } {
  const ratio = usage.modelContextWindow > 0 ? usage.usedTokens / usage.modelContextWindow : 0;
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  return { percent, text: `${tokens(usage.usedTokens)} / ${tokens(usage.modelContextWindow)} · ${percent}%` };
}

export function costLabel(usage: Usage): string | null {
  if (!usage.cost) return null;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: usage.cost.currency }).format(usage.cost.amount);
}

export function modelLabel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

const PERMISSION_LABEL = { "accept-edits": "Accept Edits", auto: "Approve for me", full: "Full Access" } as const;
export function permissionLabel(mode: NonNullable<ExecutionOptions>["permissionMode"]): string {
  return PERMISSION_LABEL[mode];
}

const plainText = (text: string): string | null =>
  text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim() || null;

export function outlineSummary(outline: Outline): { asked: string | null; latest: string | null; prompts: number; replies: number } {
  const prompts = outline.items.filter((item) => item.role === "user");
  const replies = outline.items.filter((item) => item.role === "assistant");
  const first = prompts[0], last = replies[replies.length - 1];
  return { asked: first ? plainText(first.preview) : null, latest: last ? plainText(last.preview) : null,
    prompts: prompts.length, replies: replies.length };
}

export function askSummary(list: Interactions): string | null {
  const pending = list.find((entry) => entry.status === "pending");
  if (!pending) return null;
  const { payload } = pending;
  if (payload.kind === "approval") {
    const { subject } = payload;
    switch (subject.kind) {
      case "command": return `Approve command: ${subject.command}`;
      case "file_change": return "Approve file changes";
      case "permission_grant": return `Grant permissions${subject.toolName ? ` for ${subject.toolName}` : ""}`;
      case "plan": return "Approve the plan";
      case "tool_use": return subject.presentation.title ?? subject.presentation.label.pending;
    }
  }
  if (payload.kind === "user_question") {
    const [first, ...rest] = payload.questions;
    if (!first) return null;
    return rest.length ? `${first.prompt} (+${rest.length} more)` : first.prompt;
  }
  return "title" in payload ? payload.title : null;
}

const stat = (entry: { insertions: number; deletions: number; fileCount: number } | null): Stat | null =>
  entry && entry.fileCount > 0 ? { insertions: entry.insertions, deletions: entry.deletions, files: entry.fileCount } : null;

export function changesSummary(status: WorkspaceStatus): Changes | null {
  if (status.outcome !== "available") return null;
  const { mergeBase, workingTree } = status.workspace;
  return { committed: stat(mergeBase), uncommitted: stat(workingTree),
    ahead: mergeBase?.aheadCount ?? 0, behind: mergeBase?.behindCount ?? 0, base: mergeBase?.mergeBaseBranch ?? null };
}

export function changesLabel(changes: Changes): string {
  const { committed, uncommitted } = changes;
  const shown = committed ?? uncommitted;
  if (!shown) return "No changes";
  const label = `+${shown.insertions.toLocaleString()} −${shown.deletions.toLocaleString()} · ${plural(shown.files, "file")}`;
  if (!committed) return `${label} uncommitted`;
  return uncommitted ? `${label} · ${uncommitted.files.toLocaleString()} uncommitted` : label;
}

export function backgroundLabels(thread: PluginSidebarThread): string[] {
  const { activity, queuedWork } = thread;
  return [
    activity.backgroundAgents > 0 && plural(activity.backgroundAgents, "agent"),
    activity.backgroundCommands > 0 && plural(activity.backgroundCommands, "command"),
    activity.workflows > 0 && plural(activity.workflows, "workflow"),
    activity.planMode > 0 && "Plan mode",
    activity.goals > 0 && "Goal",
    queuedWork === "waiting" && "Message queued",
    queuedWork === "failed" && "Queued message failed",
  ].filter((label): label is string => typeof label === "string");
}

// Matches the list's tree: a thread whose parent is missing or hidden is a root.
export function rootThread(threads: readonly PluginSidebarThread[], thread: PluginSidebarThread): PluginSidebarThread {
  const byId = new Map(threads.filter((entry) => !entry.isHidden).map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  let cursor = thread;
  while (cursor.parentThreadId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parent = byId.get(cursor.parentThreadId);
    if (!parent) break;
    cursor = parent;
  }
  return cursor;
}

const CHILD_STATE_WORD = { failed: "failed", needs: "needs you", running: "running", unread: "unread" } as const;
export function childrenLabel(threads: readonly PluginSidebarThread[], threadId: string): string | null {
  const children = threads.filter((thread) => thread.parentThreadId === threadId && !thread.isArchived && !thread.isHidden);
  if (!children.length) return null;
  const counts = countStates(children.map(rowState));
  const states = STATE_ORDER.flatMap((state) => state !== "idle" && counts[state] > 0 ? [` · ${counts[state]} ${CHILD_STATE_WORD[state]}`] : []);
  return `${plural(children.length, "child", "children")}${states.join("")}`;
}
