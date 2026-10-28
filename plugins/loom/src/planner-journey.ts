// The Planner page's "What happened": Loom's planner steps and bb's question rounds in one order, cut into chapters, one
// per draft version and one for the running project. Page-safe: it imports only types.
import type { PlannerStep, PlannerView, TurnStep, VersionChange } from "./planner-view";

/** One Ask User Question round of the planner, read from its thread in bb. */
export interface QuestionRound {
  id: string;
  title: string;
  askedAt: number;
  /** Open while it waits for the human; ended when bb closed it without answers, such as an interrupted turn. */
  status: "open" | "answered" | "ended";
  /** When it was answered or ended; null while open. */
  answeredAt: number | null;
  /** The questions and the human's answers; empty while it waits, or when bb did not say. */
  answers: Array<{ header: string; question: string; answer: string }>;
}

export type JourneyStep = PlannerStep | { kind: "questions"; at: number; round: QuestionRound };

export interface Chapter {
  id: string;
  title: string;
  /** The draft version the chapter ends with; null for the running project and for work before a version. */
  version: number | null;
  running: boolean;
  steps: JourneyStep[];
  summary: string;
}

export type JourneyFilter = "all" | "you" | "spec" | "triage";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const proposalOf = (step: JourneyStep) => (step.kind === "turn" ? step.actions.filter((action) => action.kind === "proposed").at(-1) : undefined);

/** True when the step shows under `filter`. */
export function stepMatches(step: JourneyStep, filter: JourneyFilter): boolean {
  if (filter === "all") return true;
  switch (step.kind) {
    case "started":
    case "message":
    case "questions":
      return filter === "you";
    case "notes":
      return filter === "you" || filter === "spec";
    case "control":
      return filter === "you" || (filter === "spec" && step.action === "approve");
    case "review":
      return filter === "spec";
    case "turn":
      return filter === "spec" && proposalOf(step) !== undefined;
    case "triage":
      return filter === "triage";
  }
}

/** "4 tickets, +1 −3, 2 changed" for a proposal. */
export function changeLine(tickets: number, change: VersionChange | null): string {
  const parts = [plural(tickets, "ticket")];
  if (change !== null) {
    const moved = [change.added.length > 0 ? `+${change.added.length}` : "", change.removed.length > 0 ? `−${change.removed.length}` : ""].filter((part) => part !== "").join(" ");
    if (moved !== "") parts.push(moved);
    if (change.changed.length > 0) parts.push(`${change.changed.length} changed`);
    const other = change.settings + change.guardrails;
    if (moved === "" && change.changed.length === 0) parts.push(other === 0 ? "tickets unchanged" : `tickets unchanged, ${plural(other, "other change")}`);
  }
  return parts.join(", ");
}

function summaryOf(chapter: Omit<Chapter, "summary">, view: Pick<PlannerView, "pendingVersion" | "triageRounds">): string {
  const { steps } = chapter;
  if (chapter.running) {
    const rounds = steps.filter((step) => step.kind === "triage").length;
    const parts = [rounds === 0 ? "No triage rounds" : plural(rounds, "triage round")];
    if (view.pendingVersion !== null) parts.push(`v${view.pendingVersion} waits for you`);
    return `${parts.join(". ")}.`;
  }
  const comments = steps.reduce((sum, step) => sum + (step.kind === "notes" ? step.notes.length : 0), 0);
  const answers = steps.reduce((sum, step) => sum + (step.kind === "questions" ? step.round.answers.length : 0), 0);
  const messages = steps.filter((step) => step.kind === "message").length;
  const inputs = [comments > 0 ? plural(comments, "comment") : "", answers > 0 ? plural(answers, "answer") : "", messages > 0 ? plural(messages, "message") : ""].filter((part) => part !== "");
  const proposal = steps.map(proposalOf).filter((action) => action !== undefined).at(-1);
  const review = steps.filter((step) => step.kind === "review" && step.version === chapter.version).at(-1);
  const sentences: string[] = [];
  if (proposal !== undefined) sentences.push(`${inputs.length === 0 ? "" : `From ${inputs.join(" and ")}: `}${changeLine(proposal.tickets, proposal.change)}.`);
  else if (inputs.length > 0) sentences.push(`${inputs.join(" and ")} so far.`.replace(/^./, (first) => first.toUpperCase()));
  else sentences.push("The planner is reading the goal and the code.");
  if (review?.kind === "review") {
    sentences.push(
      review.state === "approved"
        ? `Loom's review passed it in round ${review.round}.`
        : review.state === "changes_requested"
          ? `Loom's review found ${plural(review.findings.length, "problem")} in round ${review.round}.`
          : review.state === "failed"
            ? "Loom's review did not finish."
            : review.state === "skipped"
              ? "Loom skipped its review: it changes only operational settings."
              : `Loom is reviewing it (round ${review.round}).`,
    );
  }
  return sentences.join(" ");
}

/** The steps and question rounds in time order, then cut into chapters. */
export function journey(view: Pick<PlannerView, "steps" | "pendingVersion" | "triageRounds"> & { approvedVersion?: number | null }, rounds: readonly QuestionRound[]): Chapter[] {
  const merged: JourneyStep[] = [...view.steps];
  for (const round of rounds) {
    const step: JourneyStep = { kind: "questions", at: round.askedAt, round };
    const index = merged.findIndex((entry) => entry.at > round.askedAt && entry.kind !== "started");
    if (index < 0) merged.push(step);
    else merged.splice(index, 0, step);
  }

  const chapters: Array<Omit<Chapter, "summary">> = [];
  let current: Omit<Chapter, "summary"> = { id: "c0", title: "", version: null, running: false, steps: [] };
  chapters.push(current);
  let lastVersion: number | null = null;
  const open = (running: boolean) => {
    current = { id: `c${chapters.length}`, title: "", version: null, running, steps: [] };
    chapters.push(current);
  };
  for (const step of merged) {
    // A review belongs to the chapter of the version it reviewed, which a message sent meanwhile may have closed.
    if (step.kind === "review" && !current.running && current.version !== step.version) {
      const own = [...chapters].reverse().find((chapter) => !chapter.running && chapter.version === step.version);
      if (own !== undefined) {
        own.steps.push(step);
        continue;
      }
    }
    if (!current.running) {
      if (step.kind === "control" && step.action === "approve" && !step.pending) open(true);
      else if ((step.kind === "notes" || step.kind === "message" || step.kind === "questions") && current.version !== null) open(false);
      else {
        const proposal = proposalOf(step);
        if (proposal !== undefined) {
          if (current.version !== null) open(false);
          current.version = proposal.version;
        }
      }
    }
    current.steps.push(step);
    // Named for the version in force now, which pending versions approved since may have moved on from the first one.
    if (current.running && current.title === "") {
      const inForce = view.approvedVersion ?? (step.kind === "control" ? step.version : null);
      current.title = inForce === null || inForce === undefined ? "Running" : `Running on v${inForce}`;
    }
  }
  for (const chapter of chapters) {
    if (chapter.running) continue;
    chapter.title = chapter.version !== null ? `Draft v${chapter.version}` : lastVersion === null ? "Planning" : `Since v${lastVersion}`;
    if (chapter.version !== null) lastVersion = chapter.version;
  }
  return chapters.filter((chapter) => chapter.steps.length > 0).map((chapter) => ({ ...chapter, summary: summaryOf(chapter, view) }));
}

/** What a working planner is on: the newest thing that reached it since its last words. Null when that is not known. */
export function workingOn(steps: readonly JourneyStep[]): string | null {
  let lastWords = -1;
  steps.forEach((step, index) => {
    if (step.kind === "turn" && step.text !== null) lastWords = index;
  });
  const since = steps.slice(lastWords + 1).filter((step) => step.kind !== "turn");
  const latest = since.at(-1);
  switch (latest?.kind) {
    case "started":
      return "your request";
    case "message":
      return "your message";
    case "questions":
      return latest.round.status === "answered" ? "your answers" : null;
    case "notes":
      return `your ${latest.notes.length === 1 ? "comment" : "comments"} on v${latest.version}`;
    case "review":
      return latest.state === "changes_requested"
        ? `the spec review's findings on v${latest.version}`
        : latest.state === "approved"
          ? `the passed review of v${latest.version}`
          : latest.state === "skipped"
            ? `the skipped review of v${latest.version}`
            : null;
    case "triage":
      return latest.response?.text != null ? null : `triage round ${latest.round}`;
    case "control":
      return latest.action === "approve" && latest.version !== null ? `your approval of v${latest.version}` : null;
    default:
      return null;
  }
}

/** The first sentence or line of the planner's words, for a step's title line. */
export function leadOf(text: string, max = 200): string {
  const plain = text.replace(/\*\*|`|^#+\s*/gm, "").trim();
  const line = plain.split("\n").find((entry) => entry.trim() !== "")?.trim() ?? "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

export type { TurnStep };
