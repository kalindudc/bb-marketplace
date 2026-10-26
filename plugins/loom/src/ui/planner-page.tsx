import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ThreadChat, experimental_useSidebarThreads, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { AskStep, ControlAction, PlannerAsk, PlannerVersion, PlannerView, ProjectView, rpcContract } from "../contract";
import { specReviewBlocks } from "../format";
import { changeLine, journey, workingOn, type Chapter, type JourneyStep, type QuestionRound } from "../planner-journey";
import { SPEC_REVIEW_ROUNDS } from "../states";
import { BUTTON, ConfirmButton, HEADING, plural, useRemote, useRun } from "./common";
import { PlannerMark, timeLabel } from "./planner-kit";
import { About, Decisions, MessageBox, Versions } from "./planner-side";
import { PlannerStory } from "./planner-story";
import { PlannerQuestions, questionsOf, usePendingQuestions, useQuestionRounds } from "./questions";

type Status = "working" | "waiting" | "idle" | "missing";

export interface PlannerPageProps {
  threadId: string;
  /** The project the planner planned; null for a conversation that has not proposed yet. */
  project: ProjectView | null;
  busy?: boolean;
  onControl?(action: ControlAction, version?: number): void;
  onSpec?(version: number): void;
  onTicket?(key: string): void;
}

const NEED = "space-y-2 rounded-md border border-l-4 border-warning bg-card p-3";
const CALM = "space-y-1 rounded-md border border-l-4 border-border-seam border-l-success bg-card p-3";

/** The planner's thread status as bb's sidebar shows it. */
function useStatus(threadId: string): Status {
  const thread = experimental_useSidebarThreads().threads.find((entry) => entry.id === threadId);
  if (thread === undefined) return "missing";
  if (thread.hasPendingInteraction) return "waiting";
  return thread.status === "active" || thread.status === "pending" ? "working" : "idle";
}

const PLANNING_STEPS = ["Goal and code", "Questions", "Draft", "Loom's spec review", "Your review"] as const;

/** Whether the human sent comments on the newest version: the next version is then the planner's to write. */
const commentedOnNewest = (view: PlannerView) => {
  const newest = view.versions.at(-1)?.version;
  return newest !== undefined && view.steps.some((step) => step.kind === "notes" && step.version === newest);
};

/** Where a planner stands before approval, as an index into PLANNING_STEPS. */
function planningStep(view: PlannerView, status: Status, steps: readonly JourneyStep[]): number {
  const draft = view.versions.at(-1);
  if (draft === undefined) return status === "waiting" || steps.some((step) => step.kind === "questions") ? 1 : 0;
  if (view.review.kind === "reviewing" || view.review.kind === "failed") return 3;
  if (view.review.kind === "changes" || status === "working" || commentedOnNewest(view)) return 2;
  return 4;
}

function Strip({ view, status, questions, steps }: { view: PlannerView; status: Status; questions: number; steps: readonly JourneyStep[] }) {
  const navigate = useBbNavigate();
  const lastWords = [...steps].reverse().find((step) => step.kind === "turn" && step.text !== null);
  const on = status === "working" ? workingOn(steps) : null;
  const finished = view.projectState === "done" || view.projectState === "archived";
  const [label, tone] =
    status === "working"
      ? ["Working", "border-primary/50 bg-primary/10 text-primary"]
      : status === "waiting"
        ? [questions > 0 ? `Waiting on you · ${plural(questions, "question")}` : "Waiting on you", "border-warning bg-warning/10 text-warning-text"]
        : finished
          ? ["Finished", "border-border-seam text-muted-foreground"]
          : view.approvedVersion !== null
            ? ["Idle · on call for triage", "border-border-seam text-muted-foreground"]
            : view.review.kind === "reviewing"
              ? ["Idle · Loom is reviewing its draft", "border-border-seam text-muted-foreground"]
              : view.review.kind === "failed"
                ? ["Idle · Loom's spec review did not finish", "border-warning bg-warning/10 text-warning-text"]
                : commentedOnNewest(view)
                  ? [`Idle · it has your comments on v${view.versions.at(-1)!.version}`, "border-border-seam text-muted-foreground"]
                  : view.versions.length > 0
                ? [`Idle · v${view.versions.at(-1)!.version} is with you`, "border-border-seam text-muted-foreground"]
                : ["Idle", "border-border-seam text-muted-foreground"];
  const facts = [on === null ? "" : `on ${on}`, lastWords === undefined ? "" : `last turn ${timeLabel(lastWords.at, view.now)}`, status === "missing" ? "bb does not list its thread" : ""].filter((part) => part !== "");
  const current = view.approvedVersion === null && view.projectState !== "archived" ? planningStep(view, status, steps) : null;
  const latest = view.versions.at(-1)?.version;
  // At the Draft step with a version out, the planner writes the next one; past it, the newest one is in review or with you.
  const draftLabel = latest === undefined || current === null || current < 2 ? null : current === 2 ? latest + 1 : latest;
  return (
    <section data-planner-strip aria-label="Planner" className="space-y-2.5 rounded-md border border-border-seam bg-card px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <PlannerMark />
          Planner
        </span>
        <span data-planner-status={status} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${tone}`}>
          <span aria-hidden className={`size-1.5 rounded-full bg-current ${status === "working" ? "animate-pulse" : ""}`} />
          {label}
        </span>
        {facts.length > 0 && <span className="text-xs text-muted-foreground">{facts.join(" · ")}</span>}
        <button type="button" className={`${BUTTON} ml-auto`} onClick={() => navigate.toThread(view.threadId)}>
          Open as thread
        </button>
      </div>
      {current !== null && (
        <ol aria-label="Planning" className="flex flex-wrap items-center gap-1.5 text-xs">
          {PLANNING_STEPS.map((step, index) => {
            const state = index < current ? "done" : index === current ? "current" : "todo";
            return (
              <li key={step} data-planning-step={state} aria-current={state === "current" ? "step" : undefined} className={`inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 ${state === "current" ? "border-border-seam font-semibold text-foreground" : "border-transparent text-muted-foreground"}`}>
                <span aria-hidden className={`inline-flex size-4.5 items-center justify-center rounded-full border text-[10px] ${state === "done" ? "border-success bg-success text-success-foreground" : state === "current" ? "border-primary text-primary" : "border-border-seam"}`}>
                  {state === "done" ? "✓" : index + 1}
                </span>
                {step}
                {step === "Draft" && draftLabel !== null ? ` · v${draftLabel}` : ""}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * The summary a version brings, quoted where the human approves it: a draft's always, a later version's when it writes or
 * rewrites it. The summary is what the project page and the home list say the project is for.
 */
function VersionSummary({ entry, draft }: { entry: PlannerVersion | undefined; draft: boolean }) {
  if (entry?.summary == null || !(draft || entry.summaryChanged)) return null;
  return (
    <span data-version-summary>
      {draft ? "Summary" : "New summary"}: <q className="font-medium">{entry.summary}</q>
    </span>
  );
}

/** The planner's asks from loom_ask_human as a checklist, a button on each step the page can take. */
function AsksCard({ ask, project, versions, busy, onControl, onSpec, onTicket, onDismiss }: { ask: PlannerAsk; project: ProjectView; versions: readonly PlannerVersion[]; busy: boolean; onDismiss(): void } & Pick<PlannerPageProps, "onControl" | "onSpec" | "onTicket">) {
  const rpc = useRpc<typeof rpcContract>();
  const { busy: requeueing, error, run } = useRun();
  const blocked = new Set(project.board.filter((card) => card.state === "blocked").map((card) => card.key));
  // A requeue waits for an approve step listed before it, as the planner ordered them.
  const approveBefore = (index: number) => ask.steps.slice(0, index).find((step) => step.action === "approve" && !step.done);
  const control = (action: ControlAction, version?: number) => onControl?.(action, version);
  const action = (step: AskStep & { done: boolean }, index: number): ReactNode => {
    if (step.done) return <span className="rounded-full border border-success px-2 text-[11px] text-success">Done</span>;
    switch (step.action) {
      case "approve":
        return (
          <>
            {onSpec !== undefined && (
              <button type="button" className={BUTTON} onClick={() => onSpec(step.version!)}>
                See what changed
              </button>
            )}
            {onControl !== undefined && !specReviewBlocks(project.specReview) && <ConfirmButton label={`Approve v${step.version}`} disabled={busy} onConfirm={() => control("approve", step.version)} />}
          </>
        );
      case "requeue": {
        const before = approveBefore(index);
        const waits = before !== undefined ? `Approve v${before.version} first` : !blocked.has(step.key!) ? `${step.key} is not blocked` : null;
        return waits !== null ? (
          <button type="button" className={BUTTON} disabled title={waits}>
            Requeue
          </button>
        ) : (
          <ConfirmButton label="Requeue" confirmLabel={`Click again to requeue ${step.key}`} disabled={busy || requeueing} onConfirm={() => void run(async () => void (await rpc.call("ticketAction", { key: step.key!, action: "requeue", note: `Requeued as the planner asked: ${step.text}`, confirm: true })))} />
        );
      }
      case "reply":
        return onTicket === undefined ? null : (
          <button type="button" className={BUTTON} onClick={() => onTicket(step.key!)}>
            Open {step.key}
          </button>
        );
      case "start":
      case "resume":
      case "land":
        return onControl === undefined ? null : <ConfirmButton label={step.action === "start" ? "Start" : step.action === "resume" ? "Resume" : "Land"} disabled={busy} onConfirm={() => control(step.action as ControlAction)} />;
      case "other":
        return null;
    }
  };
  return (
    <section data-planner-asks aria-label="The planner asks you to" className={NEED}>
      <div className="flex flex-wrap items-center gap-2">
        <PlannerMark />
        <h3 className="text-sm font-semibold">The planner asks you to</h3>
        <span className="text-xs text-muted-foreground">asked {timeLabel(ask.at, project.now)}</span>
        <button type="button" className={`${BUTTON} ml-auto`} title="Hides these asks until the planner asks again" onClick={onDismiss}>
          Set aside
        </button>
      </div>
      {ask.why !== "" && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{ask.why}</p>}
      <ol className="space-y-1.5">
        {ask.steps.map((step, index) => (
          <li key={index} data-ask-step={step.action} data-done={step.done ? "" : undefined} className={`grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-2.5 rounded-md border border-border-seam bg-surface-recessed px-2.5 py-2 ${step.done ? "opacity-60" : ""}`}>
            <span aria-hidden className={`inline-flex size-5 items-center justify-center rounded-full text-[10.5px] font-semibold ${step.done ? "bg-success text-success-foreground" : "bg-surface-selected"}`}>
              {step.done ? "✓" : index + 1}
            </span>
            <span className="text-sm [overflow-wrap:anywhere]">
              {step.text}
              {step.action === "approve" && !step.done && (
                <span className="mt-1 block text-xs text-muted-foreground">
                  <VersionSummary entry={versions.find((entry) => entry.version === step.version)} draft={project.overview.state === "draft"} />
                </span>
              )}
            </span>
            <span className="flex flex-wrap justify-end gap-1.5">{action(step, index)}</span>
          </li>
        ))}
      </ol>
      {error !== null && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
    </section>
  );
}

/** A version that waits for the human: what Loom's review said, what changed, and the way to the Spec tab. */
function VersionCard({ view, project, onSpec }: { view: PlannerView; project: ProjectView; onSpec?(version: number): void }) {
  const draft = project.overview.state === "draft";
  const version = draft ? view.versions.at(-1)?.version : view.pendingVersion;
  if (version === undefined || version === null) return null;
  const entry = view.versions.find((row) => row.version === version);
  const review = view.review;
  const comments = view.steps.filter((step) => step.kind === "notes" && step.version === version - 1).reduce((sum, step) => sum + (step.kind === "notes" ? step.notes.length : 0), 0);
  const facts: Array<[string, ReactNode]> = [];
  if (review.kind === "approved") facts.push(["✓", `Passed Loom's spec review in round ${review.round}.`]);
  else if (review.kind === "limit") facts.push(["!", `Loom stopped reviewing after ${SPEC_REVIEW_ROUNDS} rounds, with ${plural(review.findings.length, "finding")} still open.`]);
  else if (review.kind === "failed")
    facts.push([
      "!",
      <>
        Loom's spec review did not finish: {review.reason}. Ask the planner to propose again, or approve it anyway with <code className="font-mono text-xs">bb loom approve {project.overview.slug}{draft ? "" : ` --version ${version}`} --skip-review</code>.
      </>,
    ]);
  else facts.push(["·", "No spec review ran for it."]);
  if (entry?.change != null) facts.push(["◆", `Since v${version - 1}: ${changeLine(entry.tickets, entry.change)}.`]);
  if (entry?.summary != null && (draft || entry.summaryChanged)) facts.push(["¶", <VersionSummary key="summary" entry={entry} draft={draft} />]);
  if (comments > 0) facts.push(["✎", `You sent ${plural(comments, "comment")} on v${version - 1}; the Spec tab shows what v${version} did with each.`]);
  const barApproves = project.next?.action?.control === "approve";
  return (
    <section data-version-card={version} aria-label={draft ? `Draft v${version} is ready` : `v${version} waits for you`} className={NEED}>
      <div className="flex flex-wrap items-center gap-2">
        <PlannerMark />
        <h3 className="text-sm font-semibold">{review.kind === "failed" ? `Loom's spec review of v${version} did not finish` : draft ? `Draft v${version} is ready for your review` : `Spec v${version} waits for your approval`}</h3>
        {entry !== undefined && <span className="text-xs text-muted-foreground">proposed {timeLabel(entry.createdAt, view.now)}</span>}
      </div>
      <ul className="space-y-0.5 text-sm">
        {facts.map(([icon, text], index) => (
          <li key={index} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-1.5">
            <span aria-hidden className={`text-center ${icon === "✓" ? "text-success" : icon === "!" ? "text-warning-text" : "text-muted-foreground"}`}>
              {icon}
            </span>
            <span className="[overflow-wrap:anywhere]">{text}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {onSpec !== undefined && (
          <button type="button" className="inline-flex h-7 cursor-pointer items-center rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90" onClick={() => onSpec(version)}>
            Review v{version} on the Spec tab
          </button>
        )}
        {barApproves && <span className="text-xs text-muted-foreground">When you are happy with it, approve it with the button in the bar above.</span>}
      </div>
    </section>
  );
}

function calmText(view: PlannerView, status: Status, steps: readonly JourneyStep[]): string {
  if (status === "working") {
    const on = workingOn(steps);
    return `The planner is working${on === null ? "" : ` on ${on}`}. This shows what it needs from you when it does.`;
  }
  if (view.review.kind === "reviewing") return `Loom is reviewing v${view.review.version}. The planner revises it for each finding and hands it over once a review passes.`;
  if (view.review.kind === "changes") return `Loom's spec review found ${plural(view.review.findings.length, "problem")} in v${view.review.version}; the planner is revising it.`;
  if (view.projectState === "done" || view.projectState === "archived") return "The project is finished.";
  if (view.approvedVersion !== null) return "The planner is on call: Loom sends it each blocked ticket in a triage round, and what it asks of you shows here.";
  return "The planner is idle. Message it below if you expected a question or a draft.";
}

/** The Planner page: what the planner needs from you, what it did step by step, and its chat one click away. */
/**
 * Whether the element given to the returned ref is at least `min` pixels wide, from a ResizeObserver; false where none
 * runs (jsdom), so the one-column layout shows. A callback ref, so it measures the page once it renders after loading.
 */
function useWide(min: number): [boolean, (element: HTMLElement | null) => void] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setWide(element.clientWidth >= min);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, min]);
  return [wide, setElement];
}

// 64rem, where Tailwind's @5xl starts: wide enough for the side column beside the story.
const WIDE = 1024;

/** The Planner page: what the planner needs from you, what it did step by step, and its chat one click away. */
export function PlannerPage({ threadId, project, busy = false, onControl, onSpec, onTicket }: PlannerPageProps) {
  const rpc = useRpc<typeof rpcContract>();
  const slug = project?.overview.slug ?? null;
  // Wrapped, so a thread that is not a planner (null) is told apart from one still loading.
  const remote = useRemote((client) => client.call("plannerView", { threadId }).then((loaded) => ({ loaded })), `planner:${threadId}`, slug, true);
  const status = useStatus(threadId);
  const view = remote.data?.loaded ?? null;
  const rounds = useQuestionRounds(threadId, `${status}:${view?.steps.length ?? 0}`);
  // bb's sidebar may leave the thread out, or lag behind the round its events show open: then the open questions are read anyway.
  const questions = usePendingQuestions(threadId, status === "missing" || rounds.some((round) => round.status === "open"));
  const [mode, setMode] = useState<"summary" | "chat">("summary");
  // Here, so a message being written survives the layout switching between one and two columns.
  const [draft, setDraft] = useState("");
  const [wide, root] = useWide(WIDE);
  const needs = useRef<HTMLElement>(null);
  const dismiss = useRun();

  if (remote.data === null) {
    return remote.error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading the planner…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load the planner: {remote.error}</p>;
  }
  if (view === null) return <p className="p-4 text-sm text-muted-foreground">This thread is not a Loom planner.</p>;
  const chapters: Chapter[] = journey(view, rounds);
  const steps = chapters.flatMap((chapter) => chapter.steps);
  // The server refuses a planner that has ended; bb's sidebar may leave out a thread that still takes messages.
  const live = view.projectState !== "archived";
  const ask = view.ask !== null && view.ask.open && project !== null ? view.ask : null;
  const askedApprove = ask?.steps.some((step) => step.action === "approve" && !step.done) === true;
  const waitingVersion = project === null ? null : project.overview.state === "draft" ? (view.versions.at(-1)?.version ?? null) : project.overview.state === "archived" ? null : view.pendingVersion;
  // Once the human commented on the version, it is the planner's turn: the next version comes back here.
  const commented = view.steps.some((step) => step.kind === "notes" && step.version === waitingVersion);
  const versionCard = waitingVersion !== null && !askedApprove && !commented && (!specReviewBlocks(view.review) || view.review.kind === "failed");
  const pendingQuestions = questions.rows.length;
  // One Ask User Question round can hold several questions; the strip counts the questions, Needs you the rounds.
  const askedCount = questions.rows.reduce((sum, row) => sum + (questionsOf(row.payload.data)?.length ?? 1), 0);
  const needCount = pendingQuestions + (ask === null ? 0 : ask.steps.filter((step) => !step.done).length) + (versionCard ? 1 : 0);
  const repos = (project?.overview.repos ?? []).flatMap((repo) => (repo.name === null ? [] : [repo.name]));
  const toNeeds = () => needs.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const needsYou = (
    <section ref={needs} data-needs-you aria-label="Needs you" className="space-y-2">
      <h2 className={`${HEADING} flex items-center gap-2`}>
        Needs you
        {needCount > 0 && <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-semibold text-black">{needCount}</span>}
      </h2>
      <PlannerQuestions threadId={threadId} rows={questions.rows} error={questions.error} respond={questions.respond} />
      {ask !== null && project !== null && (
        <AsksCard ask={ask} project={project} versions={view.versions} busy={busy} onControl={onControl} onSpec={onSpec} onTicket={onTicket} onDismiss={() => void dismiss.run(async () => remote.set({ loaded: await rpc.call("dismissAsk", { slug: project.overview.slug, ask: ask.id, confirm: true }) }))} />
      )}
      {versionCard && project !== null && <VersionCard view={view} project={project} onSpec={onSpec} />}
      {dismiss.error !== null && <p role="alert" className="text-xs text-destructive-text">{dismiss.error}</p>}
      {needCount === 0 && (
        <div data-nothing-needed className={CALM}>
          <p className="text-sm font-semibold">Nothing needs you right now</p>
          <p className="text-sm text-muted-foreground">{calmText(view, status, steps)}</p>
        </div>
      )}
    </section>
  );
  const message = <MessageBox threadId={threadId} live={live} text={draft} onText={setDraft} onSent={(next) => remote.set({ loaded: next })} />;
  const story = <PlannerStory chapters={chapters} now={view.now} repos={repos} working={status === "working" ? workingOn(steps) : false} on={{ onSpec, onTicket, ...(pendingQuestions > 0 ? { onNeeds: toNeeds } : {}) }} />;
  const facts = (
    <>
      <Decisions rounds={rounds} now={view.now} />
      <Versions versions={view.versions} onSpec={onSpec} />
      <About view={view} rounds={rounds} steps={steps} />
    </>
  );

  return (
    <div ref={root} data-planner-page className="@container space-y-3 p-4">
      <Strip view={view} status={status} questions={askedCount} steps={steps} />
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Planner view" className="flex gap-0.5 rounded-md border border-border-seam p-0.5">
          {(["summary", "chat"] as const).map((entry) => (
            <button key={entry} type="button" role="tab" aria-selected={mode === entry} onClick={() => setMode(entry)} className={`cursor-pointer rounded px-2.5 py-0.5 text-xs ${mode === entry ? "bg-surface-selected font-medium text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
              {entry === "summary" ? "Summary" : "Conversation"}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{mode === "summary" ? "What the planner needs from you, and what it did step by step." : "The planner's whole thread, as bb shows it."}</span>
      </div>
      {mode === "chat" ? (
        <div className="h-[70vh] min-h-96">
          <ThreadChat threadId={threadId} variant="compact" layout="contained" />
        </div>
      ) : wide ? (
        // Two columns: what needs you and the story, then beside them the message box and the facts, in that reading order.
        <div data-planner-layout="wide" className="grid grid-cols-[minmax(0,1fr)_20rem] items-start gap-4">
          <div className="min-w-0 space-y-4">
            {needsYou}
            {story}
          </div>
          <aside aria-label="About the planner's work" className="sticky top-3 space-y-3">
            {message}
            {facts}
          </aside>
        </div>
      ) : (
        // One column, in the order it reads: what needs you, the message box, the story, then the facts.
        <div data-planner-layout="narrow" className="space-y-4">
          {needsYou}
          {message}
          {story}
          <aside aria-label="About the planner's work" className="space-y-3">
            {facts}
          </aside>
        </div>
      )}
    </div>
  );
}

export type { QuestionRound };
