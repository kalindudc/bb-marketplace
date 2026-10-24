import { AUTO_TRIGGERS, CHANGE_OPERATIONS, OPERATIONS, WATCH_MODES, WORKSPACES } from "../config";
import { LINK_ROLES, SECTIONS, type Section } from "../contract";

export { AUTO_TRIGGERS, LINK_ROLES, OPERATIONS, SECTIONS, WATCH_MODES, WORKSPACES };

export const PANEL_ACTION_ID = "shuttle";
export const PANEL_PATH = "shuttle";

interface SectionMeta {
  label: string;
  icon: string;
  description: string;
  group: "inbox" | "mine";
  /** A count in this section asks for attention. */
  hot?: boolean;
}

export const SECTION_META: Record<Section, SectionMeta> = {
  needs: { label: "Needs you", icon: "BellDot", group: "inbox", hot: true, description: "Waiting on a decision from you: a finished auto review, or your own PR ready to merge." },
  requested: { label: "Requested of me", icon: "UserRound", group: "inbox", description: "Open PRs that ask for your review by name." },
  team: { label: "My teams", icon: "UserRoundPlus", group: "inbox", description: "Open PRs that ask one of your teams for a review." },
  mentioned: { label: "Mentioned", icon: "Mail", group: "inbox", description: "Open PRs where someone @mentioned you." },
  watching: { label: "Watching", icon: "Eye", group: "inbox", description: "Other people's PRs you watch. New reviews go to the linked thread." },
  inflight: { label: "In flight", icon: "GitPullRequest", group: "mine", description: "Your open and draft PRs on every server." },
  done: { label: "Done", icon: "Archive", group: "mine", description: "Your merged and closed PRs." },
};

export const ROLE_LABELS: Record<(typeof LINK_ROLES)[number], { short: string; long: string }> = {
  owner: { short: "Owner", long: "Owner: watched reviews go to this thread" },
  review: { short: "Review", long: "Review thread" },
  reference: { short: "Reference", long: "Reference only" },
};

export const WATCH_MODE_LABELS: Record<(typeof WATCH_MODES)[number], string> = {
  act: "Send it and ask the thread to act",
  forward: "Send it only",
};

export const OPERATION_LABELS: Record<(typeof OPERATIONS)[number], string> = {
  whoami: "Who you are on the server",
  authored: "Your PRs",
  review_requested: "PRs that request your review",
  team_requested: "PRs that request one of your teams",
  mentioned: "PRs that mention you",
  view: "One PR by repo and number",
  activity: "A PR's reviews, comments and checks",
  ready: "Mark ready for review",
  draft: "Convert to draft",
  close: "Close a PR",
  reopen: "Reopen a PR",
  edit_labels: "Add or remove labels",
  edit_reviewers: "Request or withdraw reviewers",
  edit_options: "Labels and reviewers to offer",
};

/** The optional commands that change the user's own PRs, shown apart from the ones that read. */
export const MANAGE_OPERATIONS: readonly (typeof OPERATIONS)[number][] = [...CHANGE_OPERATIONS, "edit_options"];
export const READ_OPERATIONS = OPERATIONS.filter((op) => !MANAGE_OPERATIONS.includes(op));
