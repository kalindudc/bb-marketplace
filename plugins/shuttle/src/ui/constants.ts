import { AUTO_TRIGGERS, CHANGE_OPERATIONS, OPERATIONS, WATCH_MODES, WORKSPACES, WRITE_OPERATIONS } from "../config";
import { AREAS, LINK_ROLES, type AgentMode, type NextKind } from "../contract";
import type { Area, InboxTab, InsightsTab, Source } from "./route";

export { AREAS, AUTO_TRIGGERS, LINK_ROLES, OPERATIONS, WATCH_MODES, WORKSPACES };

export const PANEL_ACTION_ID = "shuttle";
export const PANEL_PATH = "shuttle";

export const AREA_META: Record<Area, { label: string; icon: string }> = {
  inbox: { label: "Inbox", icon: "BellDot" },
  mine: { label: "My PRs", icon: "GitPullRequest" },
  reviews: { label: "Reviews", icon: "UserRound" },
  boards: { label: "Boards", icon: "LayoutGrid" },
  insights: { label: "Insights", icon: "ChartColumn" },
};

export const INBOX_TAB_LABELS: Record<InboxTab, string> = { snoozed: "Snoozed", dismissed: "Dismissed" };

export const INSIGHTS_TAB_LABELS: Record<InsightsTab, string> = { overview: "Overview", log: "Automation log", sync: "Sync" };

export const SOURCE_META: Record<Source, { label: string; chip: string }> = {
  all: { label: "Everything", chip: "Everything" },
  asked: { label: "Asked me", chip: "Asked me" },
  team: { label: "My teams", chip: "My teams" },
  mentioned: { label: "Mentioned me", chip: "Mentioned" },
  tracked: { label: "Tracked", chip: "Tracked" },
};

export interface Group {
  title: string;
  kinds: readonly NextKind[];
  description: string;
}

export const MINE_GROUPS: readonly Group[] = [
  { title: "Needs you", kinds: ["agent_waiting", "nobody", "yours"], description: "Feedback nobody is handling, or an agent waiting on your answer" },
  { title: "Ready to merge", kinds: ["ready_to_merge", "auto_merge", "approved_pending"], description: "Approved with green checks" },
  { title: "Agent on it", kinds: ["agent_on_it"], description: "Its agent has the feedback and is working" },
  { title: "Waiting for review", kinds: ["waiting_review"], description: "Nothing to do but wait, or nudge" },
  { title: "Drafts", kinds: ["draft"], description: "Reviewers are not notified yet" },
];

export const REVIEW_GROUPS: readonly Group[] = [
  { title: "Ready to post", kinds: ["post", "review_done", "review_failed"], description: "An AI review drafted findings; you choose what goes out" },
  { title: "Updated since your review", kinds: ["rereview"], description: "The author pushed or replied" },
  { title: "AI review running", kinds: ["running"], description: "Findings land here when it finishes" },
  { title: "Not reviewed yet", kinds: ["new_request", "not_reviewed", "looked_up"], description: "Oldest request first" },
  { title: "Reviewed, waiting on the author", kinds: ["reviewed"], description: "Comes back when they push or reply" },
];

/** The icon a next step shows beside its label; the server owns the words. */
export const NEXT_ICONS: Record<NextKind, string> = {
  merged: "GitMerge",
  closed: "GitPullRequestClosed",
  agent_waiting: "Bot",
  nobody: "AlertTriangle",
  yours: "UserRound",
  agent_on_it: "Bot",
  draft: "GitPullRequestDraft",
  auto_merge: "GitMerge",
  ready_to_merge: "GitMerge",
  approved_pending: "GitMerge",
  waiting_review: "Clock",
  post: "Check",
  review_done: "Bot",
  review_failed: "AlertTriangle",
  running: "Bot",
  rereview: "RotateCcw",
  reviewed: "Clock",
  new_request: "UserRound",
  not_reviewed: "UserRound",
  looked_up: "Search",
};

export const AGENT_MODE_META: Record<AgentMode, { label: string; icon: string; sentence: string }> = {
  fix: {
    label: "Fix it",
    icon: "Bot",
    sentence: "New reviews, comments and failed checks go to the thread, and it is asked to fix them. It asks you before it pushes, replies or resolves.",
  },
  notify: { label: "Just tell it", icon: "Sent", sentence: "New reviews, comments and failed checks go to the thread. It is not asked to act." },
  off: { label: "Off", icon: "X", sentence: "Nothing is sent. New feedback waits in your Inbox." },
};

export const ROLE_LABELS: Record<(typeof LINK_ROLES)[number], { short: string; long: string }> = {
  owner: { short: "Agent", long: "Agent: it gets the PR's feedback" },
  review: { short: "Review", long: "Review thread" },
  reference: { short: "Reference", long: "Reference only: it gets nothing sent" },
};

export const OPERATION_LABELS: Record<(typeof OPERATIONS)[number], string> = {
  whoami: "Who you are on the server",
  authored: "Your PRs",
  review_requested: "PRs that request your review",
  team_requested: "PRs that request one of your teams",
  mentioned: "PRs that mention you",
  reviewed: "PRs you reviewed",
  view: "One PR by repo and number",
  activity: "A PR's reviews, comments and checks",
  ready: "Mark ready for review",
  draft: "Convert to draft",
  close: "Close a PR",
  reopen: "Reopen a PR",
  edit_labels: "Add or remove labels",
  edit_reviewers: "Request or withdraw reviewers",
  edit_options: "Labels and reviewers to offer",
  merge: "Merge a PR",
  merge_options: "How a PR can merge",
  comment: "Comment on a PR",
  review: "Post a review",
  reply: "Reply in a review thread",
  resolve: "Resolve or reopen a review thread",
};

type Operation = (typeof OPERATIONS)[number];
/** The optional commands that change the user's own PRs, shown apart from the ones that read. */
export const MANAGE_OPERATIONS: readonly Operation[] = [...CHANGE_OPERATIONS, "edit_options"];
/** The optional commands that write to a PR's conversation or merge it. */
export const CONVERSATION_OPERATIONS: readonly Operation[] = ["merge", "merge_options", ...WRITE_OPERATIONS.filter((op) => op !== "merge")];
export const READ_OPERATIONS = OPERATIONS.filter((op) => !MANAGE_OPERATIONS.includes(op) && !CONVERSATION_OPERATIONS.includes(op));
