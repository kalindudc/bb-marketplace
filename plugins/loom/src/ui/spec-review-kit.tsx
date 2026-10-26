import { Fragment, createContext, useContext, useMemo, type ElementType, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { textSteps, touches, type SpecChange } from "../spec-diff";
import { isUnder } from "../spec-paths";
import type { DraftNote } from "./spec-notes";

/** What the comment box offers for a part: a choice, a number or a switch can take a suggested value; the rest take quick picks. */
export type CommentKind = "enum" | "number" | "bool" | "text" | "ticket" | "criterion" | "file" | "command" | "deps";
export type SpecValue = string | number | boolean;

export interface CommentTarget {
  /** The note's path first, then any other spec path the part shows. */
  paths: string[];
  label: string;
  kind: CommentKind;
  /** The part's value now; a suggestion needs it. */
  value?: SpecValue;
  options?: readonly SpecValue[];
  /** Names for the options, when their values read badly. */
  names?: Readonly<Record<string, string>>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** A value to suggest at once: the option the human clicked. */
  preset?: SpecValue;
}

/** A finding of Loom's spec review on the version on screen, numbered as the review lists them. */
export interface ReviewFinding {
  n: number;
  path: string | null;
  title: string;
  detail: string;
}

export interface Review {
  version: number;
  /** What this version changed from the version it is compared with. */
  changes: readonly SpecChange[];
  /** Only what changed, and what carries a note, is shown. */
  only: boolean;
  notes: readonly DraftNote[];
  /** The open findings of Loom's spec review of this version; empty when it passed or none ran. */
  findings?: readonly ReviewFinding[];
  /** Absent when the page takes no comments. */
  onComment?(target: CommentTarget, anchor: HTMLElement): void;
}

export const ReviewContext = createContext<Review>({ version: 0, changes: [], only: false, notes: [] });
export const useReview = () => useContext(ReviewContext);

const related = (a: string, b: string) => a === b || isUnder(a, b) || isUnder(b, a);
export const changeAt = (review: Review, path: string) => review.changes.find((change) => change.path === path);
export const changedAt = (review: Review, path: string) => review.changes.some((change) => touches(change, path));
export const notedAt = (review: Review, path: string) => review.notes.some((note) => note.paths.some((one) => related(one, path)));
/** Whether a finding of Loom's review is about the part, a part inside it, or the part it sits in. */
export const foundAt = (review: Review, path: string) => (review.findings ?? []).some((finding) => finding.path !== null && related(finding.path, path));
/** Whether a part stays in view while only what changed is shown: it changed, or it carries a note or a finding. */
export const kept = (review: Review, paths: readonly string[]) => !review.only || paths.some((path) => changedAt(review, path) || notedAt(review, path) || foundAt(review, path));
/** The findings on exactly `path`. */
export const findingsAt = (review: Review, path: string) => (review.findings ?? []).filter((finding) => finding.path === path);
/** The tray numbers, from 1, of the notes on exactly `path`. */
export const pinsAt = (review: Review, path: string) => review.notes.flatMap((note, index) => (note.paths[0] === path ? [index + 1] : []));

export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** A value as TOML, the form a suggestion reaches the planner in. */
export const tomlLiteral = (value: SpecValue) => (typeof value === "string" ? JSON.stringify(value) : String(value));

const LABELS: Record<string, string> = {
  merge: "Merging",
  "merge.strategy": "Merge strategy",
  "merge.branch": "Integration branch",
  "merge.remote": "Remote",
  "merge.draft": "Draft pull requests",
  "merge.describe": "Who writes the pull request",
  "merge.squash": "One commit per pull request",
  "merge.max_fix_rounds": "Fix rounds",
  "merge.checks_queued_minutes": "Stop waiting for queued checks",
  "merge.checks_near_done_percent": "Wait for running checks this far along",
  "merge.forge": "Pull request server",
  "merge.worktree": "Integration worktree",
  "project.base": "Base branch",
  "project.goal": "Goal",
  "project.summary": "Summary",
  "project.done_when": "Done when",
  "project.non_goals": "Non-goals",
  "project.open_questions": "Open questions",
  "project.name": "Project name",
  "project.key": "Project key",
  "project.slug": "Project slug",
  agents: "Agents",
  "agents.worker": "Workers",
  "agents.worker.provider": "Worker provider",
  "agents.worker.model": "Worker model",
  "agents.worker.reasoning": "Worker reasoning",
  "agents.worker.permission_mode": "Worker permissions",
  "agents.reviewer": "Reviewers",
  "agents.reviewer.provider": "Reviewer provider",
  "agents.reviewer.model": "Reviewer model",
  "agents.reviewer.reasoning": "Reviewer reasoning",
  "agents.reviewer.permission_mode": "Reviewer permissions",
  "agents.max_workers": "Workers at the same time",
  "agents.max_reviewers": "Reviewers at the same time",
  "agents.ticket_timeout_minutes": "Time per ticket",
  "agents.triage": "Triage",
  review: "Review",
  "review.approvals": "Approvals needed",
  "review.max_rounds": "Review rounds",
  "review.rubric": "Reviewer rubric",
  checks: "Checks",
  "checks.commands": "Ticket checks",
  "checks.after_merge": "After-merge checks",
  "checks.timeout_minutes": "Check time limit",
  scope: "Scope guard",
  "scope.enforce": "Scope enforcement",
  "scope.protected": "Protected paths",
  budget: "Limits",
  "budget.max_attempts": "Attempts per ticket",
  "budget.max_check_failures": "Failed check runs",
  "budget.max_tokens": "Token budget",
  "budget.deadline": "Deadline",
  environment: "Environment",
  repo: "Repos",
};
const TICKET_PARTS: Record<string, [one: string, many: string]> = {
  title: ["title", "title"],
  body: ["brief", "brief"],
  acceptance: ["criterion", "criteria"],
  scope: ["file", "files"],
  verify: ["verify command", "verify"],
  depends_on: ["dependency", "waits for"],
  merge_after: ["merges after", "merges after"],
  priority: ["priority", "priority"],
  repo: ["repo", "repo"],
};
const ITEM_NOUNS: Record<string, [one: string, many: string]> = {
  acceptance: ["criterion", "criteria"],
  scope: ["file", "files"],
  verify: ["command", "commands"],
  depends_on: ["dependency", "dependencies"],
  merge_after: ["ticket", "tickets"],
  done_when: ["line", "lines"],
  commands: ["command", "commands"],
  after_merge: ["command", "commands"],
  checks: ["command", "commands"],
  protected: ["path", "paths"],
  non_goals: ["non-goal", "non-goals"],
  rubric: ["rubric line", "rubric lines"],
  open_questions: ["question", "questions"],
};
const humanize = (path: string) => path.replace(/\./g, " › ").replace(/_/g, " ");

/** A part's name for a person, such as "Merge strategy", "csv-export › criterion 2" or "web › checks". `repos` names each [[repo]] by index. */
export function labelOf(path: string, repos: readonly string[] = []): string {
  const ticket = /^ticket\[([^\]]+)\](?:\.(\w+)(?:\[(\d+)\])?)?(.*)$/.exec(path);
  if (ticket !== null) {
    const [, ref, part, index, rest] = ticket;
    if (part === undefined) return ref!;
    const [one, many] = TICKET_PARTS[part] ?? [part.replace(/_/g, " "), part.replace(/_/g, " ")];
    return `${ref} › ${index === undefined ? many : `${one} ${Number(index) + 1}`}${rest === "" ? "" : humanize(rest!)}`;
  }
  const repo = /^repo\[(\d+)\](?:\.(.+))?$/.exec(path);
  if (repo !== null) {
    const name = repos[Number(repo[1])] ?? `repo ${Number(repo[1]) + 1}`;
    return repo[2] === undefined ? `Repo ${name}` : `${name} › ${humanize(repo[2])}`;
  }
  const item = /^(.+)\[(\d+)\]$/.exec(path);
  if (item !== null) {
    const noun = ITEM_NOUNS[item[1]!.split(".").at(-1)!]?.[0] ?? "item";
    return `${LABELS[item[1]!] ?? humanize(item[1]!)} › ${noun} ${Number(item[2]) + 1}`;
  }
  return LABELS[path] ?? humanize(path);
}

const nounsOf = (path: string) => ITEM_NOUNS[path.replace(/\[\d+\]$/, "").split(".").at(-1)!] ?? ["item", "items"];

/** One line on what a change did, for the "What changed" list: "2 → 3", "+2 files, −1", "brief rewritten", "new ticket". */
export function changeText(change: SpecChange): string {
  switch (change.kind) {
    case "value":
      return `${formatValue(change.before)} → ${formatValue(change.after)}`;
    case "list": {
      const [one, many] = nounsOf(change.path);
      if (change.added === 1 && change.removed === 1) return `1 ${one} rewritten`;
      const parts = [change.added > 0 ? `+${change.added} ${change.added === 1 ? one : many}` : "", change.removed > 0 ? `−${change.removed} ${change.removed === 1 ? one : many}` : ""].filter((part) => part !== "");
      return parts.length === 0 ? "changed" : parts.join(", ");
    }
    case "text":
      return change.before === "" ? "written" : change.after === "" ? "removed" : "rewritten";
    case "ticket-added":
      return change.from.length === 0 ? "new ticket" : `new ticket · takes over files from ${change.from.join(", ")}`;
    case "ticket-removed":
      return change.into.length === 0 ? "removed" : `removed · its files go to ${change.into.join(", ")}`;
  }
}

export function Pin({ n }: { n: number }) {
  return (
    <span data-pin={n} title="Your comment" className="ml-1.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-warning px-1 align-[1px] text-[10px] leading-none font-semibold text-black">
      {n}
    </span>
  );
}

/** A finding of Loom's spec review on the part, numbered as the review lists them; its title shows on hover. */
export function FindingPin({ finding }: { finding: ReviewFinding }) {
  return (
    <span data-finding-pin={finding.n} title={`Loom's spec review: ${finding.title}`} className="ml-1.5 inline-flex h-4 shrink-0 items-center justify-center rounded-full border border-attention bg-attention/15 px-1 align-[1px] text-[10px] leading-none font-semibold text-foreground">
      R{finding.n}
    </span>
  );
}

export function WasBadge({ before }: { before: unknown }) {
  return (
    <span data-was className="ml-1.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 align-[1px] text-[10.5px] leading-4 whitespace-nowrap text-primary">
      <span aria-hidden className="size-1.5 rounded-full bg-primary" />
      was {formatValue(before)}
    </span>
  );
}

export const CHANGED_TAG = "rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground";
export const NEW_TAG = "rounded bg-success px-1 text-[10px] leading-4 font-semibold text-success-foreground";
export const REMOVED_TAG = "rounded bg-destructive px-1 text-[10px] leading-4 font-semibold text-destructive-foreground";

/**
 * One part of the spec that takes a comment: a click or Enter opens the comment box on it. It shows the numbers of the
 * notes on it, and the old value when the version it is compared with had another one.
 */
export function Commentable({ target, as: Tag = "div", className = "", showWas = true, children }: { target: CommentTarget; as?: ElementType; className?: string; showWas?: boolean; children: ReactNode }) {
  const review = useReview();
  const path = target.paths[0]!;
  const pins = pinsAt(review, path);
  const found = findingsAt(review, path);
  const change = showWas ? changeAt(review, path) : undefined;
  const open = review.onComment;
  return (
    <Tag
      data-comment-target={path}
      data-comment-paths={target.paths.join(" ")}
      data-noted={pins.length > 0 || undefined}
      data-found={found.length > 0 || undefined}
      tabIndex={open === undefined ? undefined : 0}
      title={open === undefined ? undefined : `Comment on ${target.label}`}
      onClick={
        open === undefined
          ? undefined
          : (event: MouseEvent<HTMLElement>) => {
              if ((event.target as HTMLElement).closest("a") !== null) return;
              event.stopPropagation();
              // An option of a choice inside the part suggests that option at once.
              const preset = (event.target as HTMLElement).closest<HTMLElement>("[data-preset]")?.dataset.preset;
              const option = preset === undefined ? undefined : target.options?.find((one) => String(one) === preset);
              open(option === undefined ? target : { ...target, preset: option }, event.currentTarget);
            }
      }
      onKeyDown={
        open === undefined
          ? undefined
          : (event: KeyboardEvent<HTMLElement>) => {
              if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
              event.preventDefault();
              open(target, event.currentTarget);
            }
      }
      className={`group/comment relative rounded-md ${open === undefined ? "" : "cursor-pointer outline-offset-2 hover:bg-warning/10 hover:outline hover:outline-1 hover:outline-warning-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring"} ${pins.length > 0 ? "outline outline-1 outline-dashed outline-warning-text" : found.length > 0 ? "outline outline-1 outline-dashed outline-attention" : ""} ${className}`}
    >
      {children}
      {change?.kind === "value" && <WasBadge before={change.before} />}
      {found.map((finding) => (
        <FindingPin key={`r${finding.n}`} finding={finding} />
      ))}
      {pins.map((n) => (
        <Pin key={n} n={n} />
      ))}
      {open !== undefined && pins.length === 0 && (
        <span aria-hidden className="pointer-events-none absolute -top-2 right-1 z-10 hidden rounded-full bg-warning px-1.5 text-[10px] leading-4 text-black group-hover/comment:inline-block">
          Comment
        </span>
      )}
    </Tag>
  );
}

export type ListMark = "added" | "removed" | null;

/**
 * A list of the spec against the version it is compared with: added items marked, removed ones shown struck through.
 * While only what changed is shown (or with `compact`), the unchanged items fold into a count.
 */
export function DiffList({ path, items, render, rest, compact }: { path: string; items: readonly string[]; render(item: string, mark: ListMark, index: number): ReactNode; rest?(count: number): ReactNode; compact?: boolean }) {
  const review = useReview();
  const change = changeAt(review, path);
  const fold = rest ?? ((count: number) => <span className="px-1 text-[11px] text-subtle-foreground">… {count} unchanged</span>);
  if (change?.kind !== "list") return <>{items.map((item, index) => <Fragment key={index}>{render(item, null, index)}</Fragment>)}</>;
  const trim = compact ?? review.only;
  const at = (one: string, index: number) => one === path || one === `${path}[${index}]` || isUnder(one, `${path}[${index}]`);
  const noted = (index: number) => review.notes.some((note) => note.paths.some((one) => at(one, index))) || (review.findings ?? []).some((finding) => finding.path !== null && at(finding.path, index));
  const out: ReactNode[] = [];
  let same = 0;
  const flush = (key: string) => {
    if (same > 0) out.push(<Fragment key={key}>{fold(same)}</Fragment>);
    same = 0;
  };
  change.steps.forEach((step, at) => {
    if (step.op === "same" && trim && !noted(step.index)) return void (same += 1);
    flush(`rest-${at}`);
    out.push(<Fragment key={`${step.op}-${at}`}>{render(step.value, step.op === "same" ? null : step.op, step.index)}</Fragment>);
  });
  flush("rest-end");
  return <>{out}</>;
}

/** `before` rewritten as `after`: added words on green, removed ones struck through on red. */
export function WordDiff({ before, after, className = "" }: { before: string; after: string; className?: string }) {
  const steps = useMemo(() => textSteps(before, after), [before, after]);
  return (
    <p data-word-diff className={`text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] ${className}`}>
      {steps.map((step, index) =>
        step.op === "same" ? (
          <span key={index}>{step.text}</span>
        ) : step.op === "added" ? (
          <ins key={index} className="rounded-sm bg-success/15 text-success no-underline">
            {step.text}
          </ins>
        ) : (
          <del key={index} className="rounded-sm bg-destructive-text/10 text-destructive-text">
            {step.text}
          </del>
        ),
      )}
    </p>
  );
}
