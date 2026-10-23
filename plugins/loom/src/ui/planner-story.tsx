import { useState, type ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { PlannerAction, TurnStep } from "../contract";
import { changeLine, leadOf, proposalOf, stepMatches, type Chapter, type JourneyFilter, type JourneyStep } from "../planner-journey";
import { SPEC_REVIEW_ROUNDS } from "../states";
import { HEADING, plural } from "./common";
import { ActorMark, timeLabel, type Actor } from "./planner-kit";
import { labelOf } from "./spec-review-kit";

export interface StoryActions {
  onSpec?(version: number): void;
  onTicket?(key: string): void;
  /** Absent when Needs you has no card for an open question, which then can only be answered in the thread. */
  onNeeds?(): void;
}

const FILTERS: ReadonlyArray<{ id: JourneyFilter; label: string }> = [
  { id: "all", label: "Everything" },
  { id: "you", label: "Your input" },
  { id: "spec", label: "Spec versions" },
  { id: "triage", label: "Triage" },
];

const SEGMENT = "cursor-pointer rounded px-2 py-0.5 text-xs";
const LINK = "cursor-pointer text-xs text-primary hover:underline";
const QUOTE = "mt-1 rounded-r-md border-l-2 border-primary bg-card px-2.5 py-1.5 text-sm [overflow-wrap:anywhere]";

function More({ label, text }: { label: string; text: string }) {
  return (
    <details className="mt-1.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">{label}</summary>
      <div className="mt-1 max-h-96 overflow-auto rounded-md border border-border-seam bg-card p-2.5 text-foreground">
        <Markdown content={text} className="text-sm [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap" />
      </div>
    </details>
  );
}

function Entry({ actor, title, at, now, live = false, pending = false, children }: { actor: Actor; title: ReactNode; at: number; now: number; live?: boolean; pending?: boolean; children?: ReactNode }) {
  return (
    <li data-story-step className={`grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5 py-2 ${pending ? "-mx-2 rounded-md bg-warning/10 px-2" : ""}`}>
      <ActorMark actor={actor} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className={`text-sm font-medium ${live ? "text-primary" : ""}`}>
            {live && <span aria-hidden className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-primary align-middle" />}
            {title}
          </span>
          <span className="ml-auto text-[11px] whitespace-nowrap text-subtle-foreground">{live ? "now" : timeLabel(at, now)}</span>
        </div>
        {children}
      </div>
    </li>
  );
}

function ActionLine({ action, on }: { action: PlannerAction; on: StoryActions }) {
  const ticket = (key: string) =>
    on.onTicket === undefined ? (
      <b>{key}</b>
    ) : (
      <button type="button" className="cursor-pointer font-medium text-primary hover:underline" onClick={() => on.onTicket!(key)}>
        {key}
      </button>
    );
  const [icon, body]: [string, ReactNode] = (() => {
    switch (action.kind) {
      case "proposed":
        return [
          "◆",
          <>
            Proposed <b>v{action.version}</b>: {changeLine(action.tickets, action.change)}.{" "}
            {on.onSpec !== undefined && (
              <button type="button" className={LINK} onClick={() => on.onSpec!(action.version)}>
                Open v{action.version} on the Spec tab
              </button>
            )}
          </>,
        ];
      case "post":
        return ["↩", <>{action.reply ? "Replied on" : "Posted on"} {ticket(action.key)} (#{action.postId}): “{action.text}”</>];
      case "requeue":
        return ["↻", <>Requeued {ticket(action.key)}.</>];
      case "cancel":
        return ["✕", <>Cancelled {ticket(action.key)}.</>];
      case "edit":
        return ["✎", <>Edited {ticket(action.key)}{action.fields.length === 0 ? "" : `: ${action.fields.join(", ")}`}.</>];
      case "add":
        return ["+", <>Added {ticket(action.key)}.</>];
      case "ask":
        return ["→", action.steps.length === 0 ? <>Cleared its asks.</> : <>Asked you to: {action.steps.map((step) => step.text).join(" ")}</>];
    }
  })();
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-1.5">
      <span aria-hidden className="text-center text-muted-foreground">
        {icon}
      </span>
      <span className="[overflow-wrap:anywhere]">{body}</span>
    </li>
  );
}

const Actions = ({ actions, on }: { actions: readonly PlannerAction[]; on: StoryActions }) =>
  actions.length === 0 ? null : (
    <ul data-planner-actions className="mt-1 space-y-0.5 text-sm">
      {actions.map((action, index) => (
        <ActionLine key={index} action={action} on={on} />
      ))}
    </ul>
  );

function turnTitle(step: TurnStep): string {
  const proposal = proposalOf(step);
  if (proposal !== undefined) return `Proposed v${proposal.version}`;
  if (step.actions.length > 0) return step.actions.every((action) => action.kind === "ask") ? "Asked you to act" : "Changed the board";
  return step.text === null ? "Replied" : leadOf(step.text);
}

function StepRow({ step, now, repos, on }: { step: JourneyStep; now: number; repos: readonly string[]; on: StoryActions }) {
  switch (step.kind) {
    case "started":
      return (
        <Entry actor="you" title="You started planning" at={step.at} now={now}>
          <p className={QUOTE}>{step.text}</p>
        </Entry>
      );
    case "message":
      return (
        <Entry actor="you" title="You wrote to the planner" at={step.at} now={now}>
          <p className={`${QUOTE} whitespace-pre-wrap`}>{step.text}</p>
        </Entry>
      );
    case "questions": {
      const { round } = step;
      if (round.status === "open") {
        return (
          <Entry actor="planner" title={`The planner asks: ${round.title}`} at={step.at} now={now} pending>
            <p className="text-sm text-muted-foreground">
              Waiting for your answer.{" "}
              {on.onNeeds === undefined ? (
                "Answer it in the Conversation view."
              ) : (
                <button type="button" className={LINK} onClick={on.onNeeds}>
                  Answer it under Needs you
                </button>
              )}
            </p>
          </Entry>
        );
      }
      if (round.status === "ended") return <Entry actor="planner" title={`The planner's question “${round.title}” ended without an answer`} at={round.answeredAt ?? step.at} now={now} />;
      return (
        <Entry actor="you" title={round.answers.length === 0 ? `You answered “${round.title}”` : `You answered ${round.answers.length === 1 ? "a question" : `${round.answers.length} questions`}`} at={round.answeredAt ?? step.at} now={now}>
          {round.answers.length > 0 && (
            <dl className="mt-1 grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
              {round.answers.map((answer) => (
                <div key={answer.question} className="contents">
                  <dt className="text-xs leading-5 text-muted-foreground" title={answer.question}>
                    {answer.header}
                  </dt>
                  <dd className="[overflow-wrap:anywhere]">{answer.answer}</dd>
                </div>
              ))}
            </dl>
          )}
        </Entry>
      );
    }
    case "turn":
      return <TurnRow step={step} now={now} on={on} />;
    case "notes":
      return (
        <Entry actor="you" title={`You sent ${plural(step.notes.length, "comment")} on v${step.version}`} at={step.at} now={now}>
          <ul className="mt-1 space-y-0.5 text-sm">
            {step.notes.map((note, index) => (
              <li key={index} className="[overflow-wrap:anywhere]">
                <span className="text-xs text-muted-foreground">{note.paths.map((path) => labelOf(path, repos)).join(", ")}: </span>
                {note.body}
                {note.suggest !== undefined && (
                  <span className="text-muted-foreground">
                    {" "}
                    (suggested “{note.suggest.to}” for “{note.suggest.from}”)
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Entry>
      );
    case "review": {
      const title =
        step.state === "approved"
          ? `Loom's spec review passed v${step.version} in round ${step.round}`
          : step.state === "changes_requested"
            ? `Loom's spec review found ${plural(step.findings.length, "problem")} in v${step.version}`
            : step.state === "failed"
              ? `Loom's spec review of v${step.version} did not finish`
              : `Loom is reviewing v${step.version}`;
      return (
        <Entry actor="reviewer" title={title} at={step.at} now={now} live={step.state === "reviewing"}>
          <p className="text-xs text-muted-foreground">
            Round {step.round} of {SPEC_REVIEW_ROUNDS}
            {step.state === "failed" && step.reason !== null ? ` · ${step.reason}` : ""}
            {on.onSpec !== undefined && (
              <>
                {" · "}
                <button type="button" className={LINK} onClick={() => on.onSpec!(step.version)}>
                  {step.findings.length > 0 ? "See the findings on the Spec tab" : `Open v${step.version} on the Spec tab`}
                </button>
              </>
            )}
          </p>
          {step.findings.length > 0 && (
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm">
              {step.findings.map((finding, index) => (
                <li key={index} className="[overflow-wrap:anywhere]">
                  {finding.path !== undefined && <span className="text-xs text-muted-foreground">{labelOf(finding.path, repos)}: </span>}
                  {finding.title}
                </li>
              ))}
            </ol>
          )}
          {step.summary !== null && step.summary !== "" && <More label="The reviewer's summary" text={step.summary} />}
        </Entry>
      );
    }
    case "control": {
      const text =
        step.action === "approve"
          ? `You approved ${step.version === null ? "the spec" : `v${step.version}`}${step.skipReview ? " without a passed spec review" : ""}`
          : step.action === "start"
            ? "You started the project"
            : step.action === "pause"
              ? "You paused the project"
              : step.action === "resume"
                ? "You resumed the project"
                : step.action === "land"
                  ? "You landed the project"
                  : "You archived the project";
      return <Entry actor="you" title={text} at={step.at} now={now} />;
    }
    case "triage":
      return (
        <Entry actor="loom" title={`Triage round ${step.round}: ${plural(step.blocked.length, "ticket")} blocked`} at={step.at} now={now}>
          <ul className="mt-1 space-y-1">
            {step.blocked.map((ticket) => (
              <li key={ticket.key} className="rounded-md border border-border-seam bg-card px-2.5 py-1.5 text-sm">
                {on.onTicket === undefined ? (
                  <b className="mr-1.5 text-destructive-text">{ticket.key}</b>
                ) : (
                  <button type="button" className="mr-1.5 cursor-pointer font-semibold text-destructive-text hover:underline" onClick={() => on.onTicket!(ticket.key)}>
                    {ticket.key}
                  </button>
                )}
                {ticket.title}
                {ticket.reason !== "" && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{ticket.reason}</p>}
              </li>
            ))}
          </ul>
          {step.response === null ? (
            <p className="mt-1.5 text-xs text-muted-foreground">The planner has not answered yet.</p>
          ) : (
            <div className="mt-1.5">
              <p className={HEADING}>What the planner did</p>
              {step.response.actions.length === 0 && step.response.text !== null && <p className="text-sm">{leadOf(step.response.text)}</p>}
              <Actions actions={step.response.actions} on={on} />
              {step.response.text !== null && <More label="The planner's message" text={step.response.text} />}
            </div>
          )}
        </Entry>
      );
  }
}

function TurnRow({ step, now, on }: { step: TurnStep; now: number; on: StoryActions }) {
  const title = turnTitle(step);
  const lead = step.text === null ? null : leadOf(step.text);
  return (
    <Entry actor="planner" title={title} at={step.at} now={now}>
      {lead !== null && lead !== title && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{lead}</p>}
      <Actions actions={step.actions} on={on} />
      {step.text !== null && <More label="The planner's message" text={step.text} />}
    </Entry>
  );
}

/** What happened: the planner's work in chapters, one per draft version and one for the running project, newest first by default. */
export function PlannerStory({ chapters, now, repos, working, on }: { chapters: Chapter[]; now: number; repos: readonly string[]; working: string | null | false; on: StoryActions }) {
  const [filter, setFilter] = useState<JourneyFilter>("all");
  const [oldestFirst, setOldestFirst] = useState(false);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const last = chapters.at(-1)?.id;
  const shown = oldestFirst ? chapters : [...chapters].reverse();
  return (
    <section data-planner-story aria-label="What happened" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={HEADING}>What happened</h2>
        <div role="group" aria-label="Show" className="ml-auto flex flex-wrap gap-1">
          {FILTERS.map((entry) => (
            <button key={entry.id} type="button" aria-pressed={filter === entry.id} onClick={() => setFilter(entry.id)} className={`${SEGMENT} border ${filter === entry.id ? "border-foreground bg-foreground text-background" : "border-border-seam text-muted-foreground hover:bg-state-hover"}`}>
              {entry.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Order" className="flex gap-0.5 rounded-md border border-border-seam p-0.5">
          <button type="button" aria-pressed={!oldestFirst} onClick={() => setOldestFirst(false)} className={`${SEGMENT} ${oldestFirst ? "text-muted-foreground" : "bg-surface-selected font-medium"}`}>
            Newest first
          </button>
          <button type="button" aria-pressed={oldestFirst} onClick={() => setOldestFirst(true)} className={`${SEGMENT} ${oldestFirst ? "bg-surface-selected font-medium" : "text-muted-foreground"}`}>
            Oldest first
          </button>
        </div>
      </div>
      {shown.every((chapter) => !chapter.steps.some((step) => stepMatches(step, filter))) && <p className="text-xs text-muted-foreground">Nothing here matches this filter yet.</p>}
      {shown.map((chapter) => {
        // Keyed by place in the chapter, so switching the order keeps each row, and its open details, mounted.
        const steps = chapter.steps.map((step, index) => ({ step, key: `${chapter.id}:${index}` })).filter(({ step }) => stepMatches(step, filter));
        const live = chapter.id === last && working !== false;
        if (steps.length === 0 && !live) return null;
        const open = opened[chapter.id] ?? chapter.id === last;
        const ordered = oldestFirst ? steps : [...steps].reverse();
        const workingRow = live ? (
          <Entry key="working" actor="planner" title={`Working${working === null ? "" : ` on ${working}`}`} at={now} now={now} live />
        ) : null;
        return (
          <section key={chapter.id} data-chapter={chapter.title} className="rounded-md border border-border-seam bg-card">
            <button type="button" aria-expanded={open} onClick={() => setOpened({ ...opened, [chapter.id]: !open })} className="flex w-full cursor-pointer flex-wrap items-baseline gap-x-2.5 gap-y-0.5 rounded-md px-3 py-2 text-left hover:bg-state-hover">
              <span aria-hidden className="w-3 text-[10px] text-muted-foreground">
                {open ? "▾" : "▸"}
              </span>
              <span className="text-sm font-semibold">{chapter.title}</span>
              {chapter.id === last && <span className="rounded-full border border-primary/50 px-1.5 text-[10.5px] text-primary">current</span>}
              <span className="ml-auto text-xs text-muted-foreground">{filter === "all" ? plural(chapter.steps.length, "step") : `${steps.length} of ${plural(chapter.steps.length, "step")}`}</span>
              {!open && <span className="basis-full pl-5 text-xs text-muted-foreground">{chapter.summary}</span>}
            </button>
            {open && (
              <ol className="divide-y divide-border-seam/60 px-3 pb-1">
                {!oldestFirst && workingRow}
                {ordered.map(({ step, key }) => (
                  <StepRow key={key} step={step} now={now} repos={repos} on={on} />
                ))}
                {oldestFirst && workingRow}
              </ol>
            )}
          </section>
        );
      })}
    </section>
  );
}
