// What each project tab's badge counts, how it clears, and the items behind it, for the badge in the tab bar and the
// notice at the top of the tab. A badge is for something that needs the human: it stays until Loom sees the thing
// resolved, and a badge Loom cannot see resolved (Merge order, Rollout) can be acknowledged instead.
import type { AckTab, ProjectView } from "../contract";
import { plural, readyToLand } from "../format";

export type BadgeTab = "board" | "spec" | "planner" | "changes" | "merge" | "rollout";

/** One thing a badge counts, with where it leads: a ticket on the page, a pull request, or the planner's thread. */
export interface BadgeItem {
  id: string;
  text: string;
  ticket?: string;
  url?: string;
  thread?: string;
}

export interface TabBadge {
  text: string;
  /** What the badge counts, as a sentence: the tab's tooltip and the notice's first line. */
  label: string;
  tone: "destructive" | "warning";
  /** What makes the badge go away. */
  clears: string;
  items: BadgeItem[];
  /** Set on a badge the human can acknowledge: the item ids the acknowledgement records. */
  ack?: { tab: AckTab; items: string[] };
}

/** A pull request that merged into the branch of a ticket that has not merged, so its change is not on the base. */
export const wrongMerges = (view: ProjectView) => (view.mergeOrder?.entries ?? []).filter((entry) => entry.verdict === "merged_elsewhere" && entry.mergedIntoState !== "done");

/** The rollout warnings that call for care before a merge or a deploy; info-tone ones are left to the tab. */
export const rolloutWarnings = (view: ProjectView) => (view.rollout?.warnings ?? []).filter((warning) => warning.tone === "warning");

/** Whether the human's newest acknowledgement covers every item: a new item shows the badge again, one that went away does not. */
export const acknowledged = (acked: readonly string[], items: readonly string[]) => items.length > 0 && items.every((item) => acked.includes(item));

/**
 * The badge of each tab that needs the human. `unviewed` counts the files of a project ready to land that the human has
 * not marked viewed; `plannerWaiting` is bb's word that the planner's thread has an interaction waiting on the human.
 */
export function tabBadges(view: ProjectView, unviewed: number | null = null, plannerWaiting = false): Partial<Record<BadgeTab, TabBadge>> {
  const { overview, spec } = view;
  const badges: Partial<Record<BadgeTab, TabBadge>> = {};
  const onBoard = new Set(view.board.map((card) => card.key));

  const blocked = view.board.filter((card) => card.state === "blocked");
  if (blocked.length > 0) {
    badges.board = {
      text: String(blocked.length),
      label: `${plural(blocked.length, "ticket")} ${blocked.length === 1 ? "is" : "are"} blocked`,
      tone: "destructive",
      clears: "A ticket leaves the count once it is requeued, by you or by the planner in a triage round, or cancelled.",
      items: blocked.map((card) => ({ id: card.key, text: `${card.key}: ${card.title}`, ticket: card.key })),
    };
  }

  const waiting = overview.state === "draft" ? { version: spec.version, label: `Draft v${spec.version} waits for your review` } : overview.state !== "archived" && overview.pendingVersion !== null ? { version: overview.pendingVersion, label: `Spec v${overview.pendingVersion} waits for your approval` } : null;
  if (waiting !== null) {
    badges.spec = {
      text: "1",
      label: waiting.label,
      tone: "warning",
      clears: `It clears when you approve v${waiting.version}. To change it instead, comment on it: the planner then proposes a new version, which waits for you in its place.`,
      items: [],
    };
  }

  if (plannerWaiting && overview.plannerThreadId !== null) {
    badges.planner = {
      text: "?",
      label: "The planner's thread waits for your answer in its chat",
      tone: "warning",
      clears: "It clears once the question or approval is answered, here under Needs you or in the thread, or the planner's turn is stopped. Reading the thread does not clear it.",
      items: [{ id: "thread", text: "Open the planner's thread", thread: overview.plannerThreadId }],
    };
  } else if (view.askSteps.length > 0) {
    badges.planner = {
      text: String(view.askSteps.length),
      label: `The planner asks you to do ${plural(view.askSteps.length, "thing")}`,
      tone: "warning",
      clears: "Each step leaves the count once Loom sees you take it, such as an approval, a requeue, a reply or a live mark, or once you mark it Done under Needs you. Set aside hides the whole ask until the planner asks again.",
      items: view.askSteps.map((step) => ({ id: String(step.index), text: `Step ${step.index + 1}: ${step.text}`, ...(step.key !== null && onBoard.has(step.key) ? { ticket: step.key } : {}) })),
    };
  }

  if (unviewed !== null && unviewed > 0 && readyToLand(overview)) {
    badges.changes = {
      text: String(unviewed),
      label: `${plural(unviewed, "file")} to land you have not marked viewed`,
      tone: "warning",
      clears: "A file leaves the count once you mark it Viewed below. Viewed marks are kept in this browser only.",
      items: [],
    };
  }

  const wrong = wrongMerges(view);
  const wrongIds = wrong.map((entry) => entry.key);
  if (wrong.length > 0 && !acknowledged(view.badgeAcks.merge, wrongIds)) {
    badges.merge = {
      text: String(wrong.length),
      label: `${plural(wrong.length, "pull request")} merged into another ticket's branch, so ${wrong.length === 1 ? "its change is" : "their changes are"} not on the base`,
      tone: "destructive",
      clears: "A pull request leaves the count once the ticket whose branch it went into merges too. If you put the change on the base another way, acknowledge the badge: it stays hidden until another pull request merges the wrong way.",
      items: wrong.map((entry) => ({ id: entry.key, text: `${entry.key} merged into ${entry.mergedInto ?? "another ticket"}'s branch`, ticket: entry.key, ...(entry.prUrl === null ? {} : { url: entry.prUrl }) })),
      ack: { tab: "merge", items: wrongIds },
    };
  }

  const warnings = rolloutWarnings(view);
  // The text names what is particular to the warning, such as a freeze window's title and dates, so two warnings of one kind on one ticket differ.
  const warningId = (warning: (typeof warnings)[number]) => `${warning.kind}:${warning.keys.join(",")}:${warning.text}`;
  const warningIds = [...new Set(warnings.map(warningId))];
  if (warnings.length > 0 && !acknowledged(view.badgeAcks.rollout, warningIds)) {
    badges.rollout = {
      text: String(warnings.length),
      label: `${plural(warnings.length, "rollout warning")} before you merge or deploy`,
      tone: "warning",
      clears: "A warning goes away once what it waits for is live or its step is live. Loom does not hold anything back for them, so once you have read them, acknowledge the badge: it stays hidden until a new warning appears.",
      items: warnings.map((warning, index) => ({ id: `${warningId(warning)}:${index}`, text: warning.text, ...(warning.keys[0] !== undefined && onBoard.has(warning.keys[0]) ? { ticket: warning.keys[0] } : {}) })),
      ack: { tab: "rollout", items: warningIds },
    };
  }
  return badges;
}
