// The one thing to do next on a project, worked out on the server so the page only draws it. The app imports STAGES,
// so this file imports nothing that pulls zod or smol-toml into the app's bundle.
import type { BoardCard, ControlAction } from "./contract";
import { isMultiRepoProject, its, mergeRetryText, plural, readyToLand, reposHave } from "./format";
import type { ProjectOverview } from "./projects";
import type { SpecReviewStatus } from "./spec-review";
import { PAUSE_NOW_REASON, SPEC_REVIEW_ROUNDS } from "./states";

export const STAGES = ["Plan", "Review draft", "Approve", "Start", "Work", "Land"] as const;

export interface NextStep {
  /** The index of the current stage in STAGES; STAGES.length when every stage is done. */
  stage: number;
  tone: "normal" | "warning";
  title: string;
  text: string;
  action: { control: ControlAction; version?: number; label: string; confirm: string } | null;
}

export interface NextStepInput {
  overview: ProjectOverview;
  board: BoardCard[];
  /** The approved spec version, or the draft's. */
  version: number;
  maxWorkers: number;
  triage: boolean;
  /** The blocked tickets whose worker never started. */
  startFailed: string[];
  /** The blocked tickets whose reviewer bb refused to start. */
  reviewRefused: string[];
  /** The automatic spec review of the draft or the pending version; left out, there is none to wait for. */
  specReview?: SpecReviewStatus;
}

const list = (keys: readonly string[]) => (keys.length <= 1 ? keys.join("") : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`);

/** What approving a fixed spec does to blocked tickets: "queues CSV-1 again" and "sends CSV-2 back to review", with the reasons when `why`. */
function approvalMoves(input: NextStepInput, why: boolean): string[] {
  const { startFailed, reviewRefused } = input;
  return [
    ...(startFailed.length === 0 ? [] : [`queues ${list(startFailed)} again${why ? `, because bb never started ${its(startFailed.length, "worker")}` : ""}`]),
    ...(reviewRefused.length === 0 ? [] : [`sends ${list(reviewRefused)} back to review${why ? `, because bb refused to start ${its(reviewRefused.length, "reviewer")}` : ""}`]),
  ];
}

function blockedText(cards: BoardCard[], input: NextStepInput): string {
  const groups = new Map<string | null, string[]>();
  for (const card of cards) groups.set(card.blockedReason, [...(groups.get(card.blockedReason) ?? []), card.key]);
  const [reason, keys] = [...groups].reduce((largest, group) => (group[1].length > largest[1].length ? group : largest));
  const others = cards.length - keys.length;
  const moves = approvalMoves(input, false);
  return [
    `${list(keys)}: ${reason === null ? "no reason recorded" : reason.replace(/\.+$/, "")}.`,
    ...(others > 0 ? [`${others} more for other reasons.`] : []),
    input.triage ? `Loom tells the planner in a triage round; it can requeue, change or split ${cards.length === 1 ? "the ticket" : "them"}.` : "Triage is off, so open a ticket to requeue or cancel it.",
    ...(moves.length > 0 ? [`If the planner proposes a fixed spec, approving it ${moves.join(" and ")}.`] : []),
  ].join(" ");
}

/** The open pull requests whose CI is failing or pending, on repos that rely on it. */
function ciText(board: readonly BoardCard[]): string {
  const counts = (count: number, what: string) => (count === 0 ? [] : [`${plural(count, "check")} ${what}`]);
  const lines = board.flatMap((card) => {
    const parts = card.ci === null ? [] : [...counts(card.ci.failed, "failing"), ...counts(card.ci.pending, "pending")];
    return parts.length === 0 ? [] : [`${card.key} has ${parts.join(" and ")}`];
  });
  if (lines.length === 0) return "";
  return ` CI on the pull requests: ${lines.join("; ")}. Loom sends a failing check back to its worker as a fix round once no pending check holds it.`;
}

/** A multi-repo project names the repos with merged work that is not landed yet; landing with none left finishes the project. */
function landStep(overview: ProjectOverview): NextStep {
  const step = { stage: 5, tone: "normal" as const, title: "Next: land the project." };
  const confirm = "Click again to land";
  if (!isMultiRepoProject(overview)) {
    return {
      ...step,
      text: "Every ticket is finished. Read what lands on the Changes tab; landing pushes the integration branch and opens its pull request, or updates the one already open.",
      action: { control: "land", label: "Land · open the pull request", confirm },
    };
  }
  const toLand = overview.repos.flatMap((repo) => (repo.toLand ? [repo.name!] : []));
  if (toLand.length === 0) {
    return { ...step, text: "Every ticket is finished, and every repo with merged work is landed. Read what lands on the Changes tab; landing again finishes the project.", action: { control: "land", label: "Land · finish the project", confirm } };
  }
  const pushes = toLand.length === 1 ? "its integration branch" : "each one's integration branch";
  return {
    ...step,
    text: `Every ticket is finished, and ${reposHave(toLand)} merged work that is not landed yet. Read what lands on the Changes tab; landing pushes ${pushes} and opens its pull request, or updates the one already open.`,
    action: { control: "land", label: `Land · ${plural(toLand.length, "repo")}`, confirm },
  };
}

/**
 * A version whose spec review has not passed waits with no button: the planner is still at work. A draft waits in the Plan
 * stage, a pending version in the project's own stage (`pending`).
 */
function reviewStep(slug: string, version: number, review: SpecReviewStatus | undefined, pending: { stage: number } | null = null): NextStep | null {
  const override = `bb loom approve ${slug}${pending === null ? "" : ` --version ${version}`} --skip-review`;
  const stage = pending?.stage ?? 0;
  switch (review?.kind) {
    case "reviewing":
      return {
        stage,
        tone: "normal",
        title: `Loom is reviewing ${pending === null ? "draft " : ""}v${version}.`,
        text: `${review.waiting === undefined ? "A separate reviewer checks it" : `Its reviewer could not start (${review.waiting.reason}), and Loom tries again by itself; the reviewer then checks it`} against your request and for work the goal does not need. The planner revises it for each finding, and this bar asks you to approve once a review passes. To approve it now anyway, run \`${override}\`.`,
        action: null,
      };
    case "changes":
      return {
        stage,
        tone: "normal",
        title: `The spec review found ${plural(review.findings.length, "problem")} in v${version}.`,
        text: `The planner is revising it (round ${review.round} of ${SPEC_REVIEW_ROUNDS} done). To approve it now anyway, run \`${override}\`.`,
        action: null,
      };
    case "failed":
      return {
        stage,
        tone: "warning",
        title: `The spec review of v${version} did not finish.`,
        text: `${review.reason[0]!.toUpperCase()}${review.reason.slice(1)}. Ask the planner to propose again to restart it, or approve without a passed review with \`${override}\`.`,
        action: null,
      };
    default:
      return null;
  }
}

function reviewedNote(review: SpecReviewStatus | undefined): string {
  switch (review?.kind) {
    case "approved":
      return "Loom's spec review passed it. ";
    case "limit":
      return `Loom stopped reviewing it after ${SPEC_REVIEW_ROUNDS} rounds; the planner's chat lists the findings it left open. `;
    case "skipped":
      return `Loom skipped its spec review, because against v${review.against} it changes only operational settings: ${review.paths.join(", ")}. `;
    default:
      return "";
  }
}

export function nextStepOf(input: NextStepInput): NextStep | null {
  const { overview, board, version } = input;
  const { state, pendingVersion, reason } = overview;
  const blocked = board.filter((card) => card.state === "blocked");
  if (state === "archived") return null;

  if (state === "draft") {
    const waiting = reviewStep(overview.slug, version, input.specReview);
    if (waiting !== null) return waiting;
    const tickets = plural(board.length, "ticket");
    return {
      stage: 1,
      tone: "normal",
      title: `Next: review draft v${version}.`,
      text: `${reviewedNote(input.specReview)}Read its tickets and checks, and ask the planner in its chat for any change, or approve it as it is. Approving creates ${tickets} on the board; nothing runs until you start.`,
      action: { control: "approve", version, label: `Approve v${version} · create ${tickets}`, confirm: `Click again to approve v${version}` },
    };
  }

  if (pendingVersion !== null) {
    const stage = state === "ready" ? 3 : state === "done" ? STAGES.length : 4;
    const waiting = reviewStep(overview.slug, pendingVersion, input.specReview, { stage });
    if (waiting !== null) return waiting;
    const moves = approvalMoves(input, true);
    const moved = input.startFailed.length + input.reviewRefused.length;
    return {
      stage,
      tone: "normal",
      title: `Next: approve v${pendingVersion}.`,
      text: `The planner proposed spec v${pendingVersion}; it changes the spec, not the tickets on the board. ${reviewedNote(input.specReview)}${moves.length === 0 ? "Approving tells the planner." : `Approving ${moves.join(", ")}, and tells the planner.`}`,
      action: {
        control: "approve",
        version: pendingVersion,
        label: `Approve v${pendingVersion}${moved === 0 ? "" : ` · requeue ${plural(moved, "ticket")}`}`,
        confirm: `Click again to approve v${pendingVersion}`,
      },
    };
  }

  if (state === "paused") {
    const why =
      reason === null ? "You paused the project: running workers finish their turn and no new one starts." : reason === PAUSE_NOW_REASON ? "You paused the project and stopped its workers; Resume continues them." : `Loom paused it: ${reason}`;
    return {
      stage: 4,
      tone: (reason !== null && reason !== PAUSE_NOW_REASON) || blocked.length > 0 ? "warning" : "normal",
      title: "Paused.",
      text: blocked.length === 0 ? why : `${why} ${blockedText(blocked, input)}`,
      action: { control: "resume", label: "Resume", confirm: "Click again to resume" },
    };
  }

  if (blocked.length > 0) {
    return { stage: 4, tone: "warning", title: blocked.length === 1 ? "1 ticket is blocked." : `${blocked.length} tickets are blocked.`, text: blockedText(blocked, input), action: null };
  }

  if (state === "ready") {
    const queued = board.filter((card) => card.state === "queued");
    const starting = queued.filter((card) => card.ready).slice(0, input.maxWorkers);
    const n = starting.length;
    const rest = queued.length - n;
    const waits = rest === 0 ? "" : rest === 1 ? " The other ticket waits for the tickets it depends on or shares files with." : ` The other ${rest} tickets wait for the tickets they depend on or share files with.`;
    return {
      stage: 3,
      tone: "normal",
      title: "Next: start the project.",
      text: n === 0 ? `No ticket is ready to start yet.${waits}` : `Loom starts ${plural(n, "worker")} right away, on ${list(starting.map((card) => card.key))}.${waits}`,
      action: n === 0 ? { control: "start", label: "Start project", confirm: "Click again to start" } : { control: "start", label: `Start project · ${plural(n, "worker")}`, confirm: `Click again to start ${plural(n, "worker")}` },
    };
  }

  if (readyToLand(overview)) return landStep(overview);

  if (state === "running") {
    const working = board.filter((card) => card.state === "working" && !card.waitsForSlot).map((card) => card.key);
    const waiting = board.filter((card) => card.state === "working" && card.waitsForSlot).map((card) => card.key);
    const now = working.length === 0 ? "No worker is running now; tickets in checks, review or the merge queue move by themselves." : `${plural(working.length, "worker")} ${working.length === 1 ? "is" : "are"} on ${list(working)}.`;
    const queue = waiting.length === 0 ? "" : ` ${list(waiting)} ${waiting.length === 1 ? "waits" : "wait"} for a worker slot.`;
    const merges = board.flatMap((card) => (card.mergeWait === null ? [] : [` ${card.key}'s merge waits: ${mergeRetryText(card.mergeWait)}`])).join("");
    return { stage: 4, tone: "normal", title: "Running.", text: `${now}${queue}${merges}${ciText(board)} Nothing needs you now; this bar turns yellow when something does.`, action: null };
  }

  return { stage: STAGES.length, tone: "normal", title: "Done.", text: "Every ticket is done or cancelled.", action: null };
}
