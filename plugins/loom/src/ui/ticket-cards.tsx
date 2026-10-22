import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, Markdown, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { ChecksItem, CheckStep, MergeItem, PostDto, ReviewDto, rpcContract, ThreadDto } from "../contract";
import { formatDuration, plural } from "../format";
import type { AuthorKind } from "../states";
import { messageOf } from "./common";

export const GHOST =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
/** A card inside an attempt: a post, a check, a review. */
export const INNER = "rounded-lg border border-border-seam bg-surface-recessed";
export const MARKDOWN = "text-sm [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap";
const PRE = "mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-seam p-2 font-mono text-xs";

const AVATARS: Record<AuthorKind, { tint: string; initial: string }> = {
  planner: { tint: "bg-pr-merged/15", initial: "P" },
  worker: { tint: "bg-timeline-accent/15", initial: "W" },
  reviewer: { tint: "bg-attention/15", initial: "R" },
  human: { tint: "bg-success/15", initial: "Y" },
  loom: { tint: "bg-subtle-foreground/15", initial: "L" },
};

/** The role's initial on its tint; foreground initials keep the contrast that tone-coloured ones lose on light themes. */
export function Avatar({ kind }: { kind: AuthorKind }) {
  const { tint, initial } = AVATARS[kind];
  return (
    <span aria-hidden className={`inline-grid size-5 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold text-foreground ${tint}`}>
      {initial}
    </span>
  );
}

export const ago = (at: number, now: number) => `${formatDuration(Math.max(0, now - at))} ago`;
/** "About five lines" without measuring: the first guess, which useLong checks once the body is laid out. */
export const isLong = (body: string) => body.length > 400 || body.split("\n").length > 5;
/** Five lines at a line height of 1.5, fading out. */
export const CLAMP = "max-h-[7.5em] overflow-hidden [mask-image:linear-gradient(#000_60%,transparent)]";

/** Whether a body gets the clamp and Show all: isLong's guess, dropped when the clamped body (`ref`) turns out to fit. jsdom measures 0, so there the guess stands. */
export function useLong(text: string, expanded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(false);
  const guess = isLong(text);
  useLayoutEffect(() => {
    const body = ref.current;
    if (guess && !expanded && body !== null && body.scrollHeight > 0 && body.scrollHeight <= body.clientHeight + 1) setFits(true);
  }, [guess, expanded]);
  return { ref, long: guess && !fits };
}

const MARKS = { pass: { mark: "✓", tone: "text-success-foreground" }, fail: { mark: "✗", tone: "text-destructive-text" }, none: { mark: "·", tone: "text-muted-foreground" } } as const;
const okOf = (step: CheckStep) => (step.ok === null ? "none" : step.ok ? "pass" : "fail");
/** Seconds with a decimal under a minute, as the check post shows them. */
const stepDuration = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms));

function stepText(step: CheckStep, now: number): string {
  if (step.running) return step.startedAt === null ? "running" : `running, started ${ago(step.startedAt, now)}`;
  if (step.ok === null) return "did not finish";
  const took = step.durationMs === null ? "" : stepDuration(step.durationMs);
  if (step.timedOut) return `timed out after ${took}`;
  if (step.ok || step.exitCode === null) return took;
  return `exit ${step.exitCode}${took === "" ? "" : ` · ${took}`}`;
}

/** The step whose output explains a failed check, by the rule src/activity.ts gives the old output to; -1 for none. */
export function failedStep(item: ChecksItem): number {
  if (item.status !== "failed") return -1;
  const failed = item.steps.findIndex((step) => step.timedOut || (step.exitCode !== null && step.exitCode !== 0));
  if (failed !== -1 || !item.afterMerge || item.changed === null) return failed;
  return item.steps.map((step) => step.kind).lastIndexOf("command");
}

function RunOutput({ id }: { id: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const client = useRef(rpc);
  client.current = rpc;
  const [state, setState] = useState<{ output: string | null; error: string | null }>({ output: null, error: null });
  useEffect(() => {
    let live = true;
    client.current.call("runOutput", { id }).then(
      (result) => live && setState(result === null ? { output: null, error: "Loom has no output for this step." } : { output: result.output, error: null }),
      (failure: unknown) => live && setState({ output: null, error: messageOf(failure) }),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (state.error !== null) return <p role="alert" className="mt-1 text-xs text-destructive-text">Could not load the output: {state.error}</p>;
  if (state.output === null) return <p role="status" className="mt-1 text-xs text-muted-foreground">Loading…</p>;
  return <pre data-run-output className={PRE}>{state.output}</pre>;
}

function StepRow({ step, now, startOpen }: { step: CheckStep; now: number; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const ok = okOf(step);
  const loadable = step.runId !== null && !step.running && step.outputChars > 0;
  const label = step.kind === "git" ? "text-subtle-foreground" : ok === "fail" ? "text-destructive-text" : "";
  return (
    <li data-check-step data-ok={ok} className="border-t border-border-seam py-1 first:border-t-0">
      <div className="flex items-baseline gap-2 text-xs">
        <span aria-hidden className={`w-3 shrink-0 text-center ${MARKS[ok].tone}`}>
          {MARKS[ok].mark}
        </span>
        <span className={`min-w-0 flex-1 font-mono [overflow-wrap:anywhere] ${label}`}>{step.label}</span>
        <span className="shrink-0 text-muted-foreground">{stepText(step, now)}</span>
        {(loadable || step.output !== null) && (
          <button type="button" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the output of ${step.label}`} onClick={() => setOpen(!open)} className={GHOST}>
            {open ? "Hide output" : "Show output"}
          </button>
        )}
      </div>
      {open && loadable && (
        <div className="ml-5">
          <RunOutput id={step.runId!} />
        </div>
      )}
      {open && !loadable && step.output !== null && (
        <div className="ml-5">
          <p className="mt-1 text-[11px] text-muted-foreground">Output (last part)</p>
          <pre data-step-output className={PRE}>
            {step.output}
          </pre>
        </div>
      )}
    </li>
  );
}

/** A check's or a merge's steps. `openStep` starts open; -1 for none. A step's recorded output loads only when it opens. */
export function StepRows({ steps, now, openStep }: { steps: CheckStep[]; now: number; openStep: number }) {
  return (
    <ul className="px-3 pb-2">
      {steps.map((step, index) => (
        <StepRow key={step.runId ?? `step-${index}`} step={step} now={now} startOpen={index === openStep} />
      ))}
    </ul>
  );
}

const CHECK_TITLES: Record<ChecksItem["status"], { title: string; mark: string; tone: string }> = {
  passed: { title: "Checks passed", mark: "✓", tone: "text-success-foreground" },
  failed: { title: "Checks failed", mark: "✗", tone: "text-destructive-text" },
  running: { title: "Checks running", mark: "●", tone: "text-timeline-accent animate-pulse" },
  unfinished: { title: "Checks did not finish", mark: "·", tone: "text-muted-foreground" },
};

/** One run of the checks. `openFailed` opens the failed step's output: the page gives it to the newest failed check only. */
export function ChecksCard({ item, now, openFailed }: { item: ChecksItem; now: number; openFailed: boolean }) {
  const [open, setOpen] = useState(item.status !== "passed");
  const commands = item.steps.filter((step) => step.kind === "command");
  const failedIndex = failedStep(item);
  const failed = failedIndex === -1 ? null : item.steps[failedIndex]!;
  const { title, mark, tone } = CHECK_TITLES[item.status];
  const took = commands.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  const summary =
    item.changed !== null
      ? null
      : item.status === "passed"
        ? `${plural(commands.length, "command")} · ${stepDuration(took)}`
        : failed !== null
          ? `${commands.filter((step) => step.ok === true).length} of ${commands.length} passed · ${failed.label} failed`
          : null;
  return (
    <div data-checks-card data-status={item.status} className={INNER}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[12.5px]">
        <span className="font-semibold">
          <span aria-hidden className={tone}>
            {mark}
          </span>{" "}
          <span className={item.status === "failed" ? "text-destructive-text" : item.status === "passed" ? "text-success-foreground" : ""}>{item.afterMerge ? "Checks after the merge failed" : title}</span>
        </span>
        {summary !== null && <span className="text-muted-foreground [overflow-wrap:anywhere]">{summary}</span>}
        {item.changed !== null && (
          <span data-changed className="text-destructive-text [overflow-wrap:anywhere]">
            The command passed but changed the branch: {item.changed}.
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-subtle-foreground">{ago(item.at, now)}</span>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={GHOST}>
          {open ? "Hide commands" : "Show commands"}
        </button>
      </div>
      {item.outside.length > 0 && <p className="px-3 pb-2 text-xs text-warning-text [overflow-wrap:anywhere]">Outside the ticket's scope: {item.outside.join(", ")}</p>}
      {open && <StepRows steps={item.steps} now={now} openStep={openFailed ? failedIndex : -1} />}
    </div>
  );
}

const SEVERITY_TONES: Record<string, string> = { blocking: "text-destructive-text bg-destructive-text/10", "should-fix": "text-warning-text bg-warning/10" };

/** A reviewer's verdict with its findings. `notes` are the reviewer's notes as post cards; `footer` is Reply and its composer. */
export function ReviewCard({ review, post, thread, now, notes, footer }: { review: ReviewDto; post: PostDto; thread: ThreadDto | null; now: number; notes: ReactNode; footer: ReactNode }) {
  const navigate = useBbNavigate();
  const [expanded, setExpanded] = useState(false);
  const approved = review.verdict === "approved";
  const summary = review.summary ?? post.body;
  const { ref, long } = useLong(summary, expanded);
  return (
    <div data-review-card={review.id} className={`${INNER} ${approved ? "shadow-[inset_3px_0_0_var(--success)]" : "shadow-[inset_3px_0_0_var(--warning)]"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[12.5px]">
        <Avatar kind="reviewer" />
        <span className="font-semibold">Reviewer · round {review.round}</span>
        <span className={`rounded-full px-2 text-[11.5px] font-semibold ${approved ? "bg-success/15 text-success-foreground" : "bg-warning/15 text-warning-text"}`}>{approved ? "Approved" : "Changes requested"}</span>
        <span className="text-xs text-muted-foreground">
          {thread?.endedAt != null && `took ${formatDuration(thread.endedAt - thread.startedAt)} · `}
          {ago(post.at, now)}
        </span>
        <span className="flex-1" />
        {review.threadId !== null && (
          <button type="button" aria-label={`Open the thread of reviewer round ${review.round}`} onClick={() => navigate.toThread(review.threadId!)} className={GHOST}>
            ↗ Thread
          </button>
        )}
      </div>
      <div ref={ref} className={`px-3 ${long && !expanded ? CLAMP : ""}`}>
        <Markdown content={summary} className={MARKDOWN} />
      </div>
      {long && (
        <div className="px-2">
          <button type="button" onClick={() => setExpanded(!expanded)} className={GHOST}>
            {expanded ? "Show less" : "Show all"}
          </button>
        </div>
      )}
      {review.findings.length > 0 && (
        <ul className="mx-3 my-2 space-y-1.5">
          {review.findings.map((finding, index) => (
            <li key={index} data-finding className="rounded-md border border-border-seam bg-card px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
                <span className={`rounded px-1 text-[10.5px] font-bold uppercase tracking-wider ${SEVERITY_TONES[finding.severity] ?? "text-muted-foreground"}`}>{finding.severity}</span>
                <span className="font-semibold [overflow-wrap:anywhere]">{finding.title}</span>
                {finding.file !== undefined && (
                  <span className="rounded border border-border-seam px-1 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                    {finding.file}
                    {finding.line === undefined ? "" : `:${finding.line}`}
                  </span>
                )}
              </div>
              <Markdown content={finding.detail} className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap" />
            </li>
          ))}
        </ul>
      )}
      {notes !== null && (
        <details className="mx-3 mb-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">The reviewer's notes</summary>
          <div className="mt-1 space-y-1.5">{notes}</div>
        </details>
      )}
      {footer}
    </div>
  );
}

/** A merge result, or the merge steps no result follows yet. */
export function MergeRow({ item, post, now }: { item: MergeItem; post: PostDto | null; now: number }) {
  const [open, setOpen] = useState(false);
  const text = post?.body ?? (item.running ? "Loom is merging" : "The merge did not finish");
  return (
    <div data-merge>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-[13px]">
        <Icon name="GitBranch" aria-hidden className="size-3.5 text-muted-foreground" />
        <span className={`font-semibold [overflow-wrap:anywhere] ${item.outcome === "conflict" ? "text-destructive-text" : ""} ${item.running ? "animate-pulse" : ""}`}>{text}</span>
        <span className="text-xs text-subtle-foreground">{ago(item.at, now)}</span>
        {item.steps.length > 0 && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={GHOST}>
            {open ? "Hide steps" : `Show steps (${item.steps.length})`}
          </button>
        )}
      </div>
      {open && (
        <div className={INNER}>
          <StepRows steps={item.steps} now={now} openStep={-1} />
        </div>
      )}
    </div>
  );
}
