import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, Markdown, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { ChecksItem, CheckStep, MergeItem, PostDto, PrFeedbackItem, PrTextItem, ReviewDto, rpcContract, ThreadDto } from "../contract";
import { formatDuration, plural } from "../format";
import type { AuthorKind } from "../states";
import { messageOf } from "./common";
import { jumpBehavior } from "./motion";

// A ghost button grows with its label and wraps inside its row, so enlarged text never runs it out of a card.
export const GHOST =
  "inline-flex min-h-6 max-w-full shrink-0 cursor-pointer py-0.5 text-left leading-tight [overflow-wrap:anywhere] items-center gap-1 rounded px-1.5 text-xs text-[var(--loom-muted)] hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 @max-xl/loom:min-h-11 @max-xl/loom:min-w-11 @max-xl/loom:justify-center max-[576px]:min-h-11 max-[576px]:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11";
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
    <span aria-hidden className={`inline-grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-foreground ${tint}`}>
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

const MARKS = { pass: { mark: "✓", tone: "text-[var(--loom-ok)]" }, fail: { mark: "✗", tone: "text-[var(--loom-bad)]" }, none: { mark: "·", tone: "text-[var(--loom-muted)]" } } as const;
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
  if (state.error !== null) return <p role="alert" className="mt-1 text-xs text-[var(--loom-bad)]">Could not load the output: {state.error}</p>;
  if (state.output === null) return <p role="status" className="mt-1 text-xs text-[var(--loom-muted)]">Loading…</p>;
  return <pre data-run-output className={PRE}>{state.output}</pre>;
}

function StepRow({ step, now, startOpen }: { step: CheckStep; now: number; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const ok = okOf(step);
  const loadable = step.runId !== null && !step.running && step.outputChars > 0;
  const label = step.kind === "git" ? "text-[var(--loom-muted)]" : ok === "fail" ? "text-[var(--loom-bad)]" : "";
  return (
    <li data-check-step data-ok={ok} className="border-t border-border-seam py-1 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span aria-hidden className={`w-3 shrink-0 text-center ${MARKS[ok].tone}`}>
          {MARKS[ok].mark}
        </span>
        <span className={`min-w-[min(100%,8rem)] flex-1 font-mono [overflow-wrap:anywhere] ${label}`}>{step.label}</span>
        <span className="min-w-0 text-[var(--loom-muted)]">{stepText(step, now)}</span>
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
          <p className="mt-1 text-[11px] text-[var(--loom-muted)]">Output (last part)</p>
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
  passed: { title: "Checks passed", mark: "✓", tone: "text-[var(--loom-ok)]" },
  failed: { title: "Checks failed", mark: "✗", tone: "text-[var(--loom-bad)]" },
  running: { title: "Checks running", mark: "●", tone: "text-[var(--loom-run)] animate-pulse" },
  unfinished: { title: "Checks did not finish", mark: "·", tone: "text-[var(--loom-muted)]" },
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
          <span className={item.status === "failed" ? "text-[var(--loom-bad)]" : item.status === "passed" ? "text-[var(--loom-ok)]" : ""}>{item.afterMerge ? "Checks after the merge failed" : title}</span>
        </span>
        {summary !== null && <span className="text-[var(--loom-muted)] [overflow-wrap:anywhere]">{summary}</span>}
        {item.changed !== null && (
          <span data-changed className="text-[var(--loom-bad)] [overflow-wrap:anywhere]">
            The command passed but changed the branch: {item.changed}.
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-[var(--loom-muted)]">{ago(item.at, now)}</span>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={GHOST}>
          {open ? "Hide commands" : "Show commands"}
        </button>
      </div>
      {item.outside.length > 0 && <p className="px-3 pb-2 text-xs text-[var(--loom-warn)] [overflow-wrap:anywhere]">Outside the ticket's scope: {item.outside.join(", ")}</p>}
      {open && <StepRows steps={item.steps} now={now} openStep={openFailed ? failedIndex : -1} />}
    </div>
  );
}

const SEVERITY_TONES: Record<string, string> = { blocking: "text-[var(--loom-bad)] bg-destructive-text/10", "should-fix": "text-[var(--loom-warn)] bg-warning/10" };

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
        <span className={`rounded-full px-2 text-[11.5px] font-semibold ${approved ? "bg-success/15 text-[var(--loom-ok)]" : "bg-warning/15 text-[var(--loom-warn)]"}`}>{approved ? "Approved" : "Changes requested"}</span>
        <span className="text-xs text-[var(--loom-muted)]">
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
                <span className={`rounded px-1 text-[11px] font-bold uppercase tracking-wider ${SEVERITY_TONES[finding.severity] ?? "text-[var(--loom-muted)]"}`}>{finding.severity}</span>
                <span className="font-semibold [overflow-wrap:anywhere]">{finding.title}</span>
                {finding.file !== undefined && (
                  <span className="rounded border border-border-seam px-1 font-mono text-[11px] text-[var(--loom-muted)] [overflow-wrap:anywhere]">
                    {finding.file}
                    {finding.line === undefined ? "" : `:${finding.line}`}
                  </span>
                )}
              </div>
              <Markdown content={finding.detail} className="mt-0.5 text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap" />
            </li>
          ))}
        </ul>
      )}
      {notes !== null && (
        <details className="mx-3 mb-2 text-xs">
          <summary className="cursor-pointer py-1 [overflow-wrap:anywhere] @max-xl/loom:py-3.5 max-[576px]:py-3.5 pointer-coarse:py-3.5 text-[var(--loom-muted)]">The reviewer's notes</summary>
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
        <Icon name="GitBranch" aria-hidden className="size-3.5 text-[var(--loom-muted)]" />
        <span className={`font-semibold [overflow-wrap:anywhere] ${item.outcome === "conflict" || item.outcome === "diverged" ? "text-[var(--loom-bad)]" : ""} ${item.running ? "animate-pulse" : ""}`}>{text}</span>
        <span className="text-xs text-[var(--loom-muted)]">{ago(item.at, now)}</span>
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

/** The pull request's checks in words: "18 passed, 2 running and 1 failed". */
export function checksText(checks: { passed: number; failed: number; pending: number }): string {
  const parts = [checks.passed > 0 ? `${checks.passed} passed` : null, checks.pending > 0 ? `${checks.pending} running` : null, checks.failed > 0 ? `${checks.failed} failed` : null].filter((part): part is string => part !== null);
  if (parts.length === 0) return "no checks yet";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const DETAILS = "mt-1 text-xs [&_summary]:cursor-pointer [&_summary]:text-[var(--loom-muted)]";

/** The pull request's text as the worker wrote it, or Loom's template with the reason it stood in. */
export function PrTextCard({ item, now, onThread }: { item: PrTextItem; now: number; onThread: (() => void) | null }) {
  const worker = item.by === "worker";
  const heading = item.fix ? `${worker ? "The worker" : "Loom"} wrote the commit message for fix round ${item.round}` : worker ? "The worker wrote the pull request" : "Loom wrote the pull request from its template";
  return (
    <div data-pr-text className={`${INNER} px-3 py-2`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
        <Avatar kind={worker ? "worker" : "loom"} />
        <span className="font-semibold">{heading}</span>
        <span className="text-xs text-[var(--loom-muted)]">{ago(item.at, now)}</span>
        <span className="flex-1" />
        {onThread !== null && (
          <button type="button" aria-label="Open the worker's thread" onClick={onThread} className={GHOST}>
            ↗ Thread
          </button>
        )}
      </div>
      {item.reason !== null && <p className="mt-0.5 text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">Because {item.reason}.</p>}
      {item.title !== null && <p data-pr-title className="mt-1 text-sm font-semibold [overflow-wrap:anywhere]">{item.title}</p>}
      {item.body !== null && (
        <details className={DETAILS}>
          <summary className="cursor-pointer py-1 [overflow-wrap:anywhere] @max-xl/loom:py-3.5 max-[576px]:py-3.5 pointer-coarse:py-3.5">Description ({plural(item.body.length, "character")})</summary>
          <div className="mt-1 rounded-md border border-border-seam p-2">
            <Markdown content={item.body} className={MARKDOWN} />
          </div>
        </details>
      )}
      {item.commit !== "" &&
        (item.fix ? (
          <pre data-pr-commit className={PRE}>
            {item.commit}
          </pre>
        ) : (
          <details className={DETAILS}>
            <summary className="cursor-pointer py-1 [overflow-wrap:anywhere] @max-xl/loom:py-3.5 max-[576px]:py-3.5 pointer-coarse:py-3.5">Commit message</summary>
            <pre data-pr-commit className={PRE}>
              {item.commit}
            </pre>
          </details>
        ))}
    </div>
  );
}

const ENTRY_TAGS: Record<PrFeedbackItem["items"][number]["kind"], { text: string; tone: string }> = {
  review: { text: "review", tone: "bg-warning/15 text-[var(--loom-warn)]" },
  thread: { text: "thread", tone: "bg-timeline-accent/15 text-[var(--loom-run)]" },
  comment: { text: "comment", tone: "bg-foreground/5 text-[var(--loom-muted)]" },
  reply: { text: "your reply", tone: "bg-success/15 text-[var(--loom-ok)]" },
};

/**
 * A comment's Markdown, bounded like a post body: a box of fixed height that clips whole blocks, never a line clamp,
 * which on paragraphs, quotes and lists collapses their boxes and lets their lines paint over one another. Show all
 * appears when the box clips; a keyboard stop the box hides opens it.
 */
function FeedbackBody({ body }: { body: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [whole, setWhole] = useState(false);
  const [clipped, setClipped] = useState(isLong(body));
  // The stop whose focus opened the body. Opening moves it down, after the browser and the panel scrolled to it.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const stop = opener.current;
    opener.current = null;
    if (!whole || stop === null) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === stop) stop.scrollIntoView?.({ block: "nearest", behavior: jumpBehavior() });
    });
    return () => cancelAnimationFrame(frame);
  }, [whole]);
  useLayoutEffect(() => {
    const box = ref.current;
    if (box === null || whole) return;
    // jsdom measures 0, so there isLong's guess stands.
    const measure = () => box.scrollHeight > 0 && setClipped(box.scrollHeight > box.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined" || box.firstElementChild === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(box.firstElementChild);
    return () => observer.disconnect();
  }, [body, whole]);
  return (
    <>
      <div
        ref={ref}
        data-feedback-body
        className={`mt-0.5 text-xs [&_*]:scroll-my-4 ${whole ? "" : clipped ? CLAMP : "max-h-[7.5em] overflow-hidden"}`}
        onFocus={(event) => {
          const box = ref.current!;
          if (whole || !clipped) return;
          if (event.target.getBoundingClientRect().bottom > box.getBoundingClientRect().bottom - 1 || box.scrollTop > 0) {
            box.scrollTop = 0;
            opener.current = event.target;
            setWhole(true);
          }
        }}
      >
        <Markdown content={body} className="text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap" />
      </div>
      {clipped && (
        <button type="button" aria-expanded={whole} onClick={() => setWhole(!whole)} className={`${GHOST} -ml-1.5`}>
          {whole ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}

/** What one fix round sent the worker: the failed checks with their links, and each review, thread and comment. */
export function FeedbackCard({ item, max, now, openUrl }: { item: PrFeedbackItem; max: number; now: number; openUrl(url: string): void }) {
  const count = item.checks.length + item.items.length;
  const ignored = [item.ignored.bots > 0 ? plural(item.ignored.bots, "bot comment") : null, item.ignored.own > 0 ? `${plural(item.ignored.own, "item")} from your own account, which the worker's replies come from` : null].filter((part) => part !== null);
  return (
    <div data-pr-feedback={item.round} className={`${INNER} px-3 py-2 ${item.overLimit ? "shadow-[inset_3px_0_0_var(--destructive-text)]" : "shadow-[inset_3px_0_0_var(--warning)]"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
        <Avatar kind="loom" />
        <span className="font-semibold">{item.human ? "Your reply starts a fix round" : "Pull request feedback"}</span>
        <span className={`rounded-full px-2 text-[11.5px] font-semibold ${item.overLimit ? "bg-destructive-text/15 text-[var(--loom-bad)]" : "bg-warning/15 text-[var(--loom-warn)]"}`}>
          {item.overLimit ? `over the limit of ${plural(max, "fix round")}` : item.human || item.counted === null ? `fix round ${item.round}` : `fix round ${item.round} · ${item.counted} of ${max}`}
        </span>
        {!item.human && <span className="text-xs text-[var(--loom-muted)]">{plural(count, "item")}</span>}
        <span className="text-xs text-[var(--loom-muted)]">{ago(item.at, now)}</span>
        <span className="flex-1" />
        {item.url !== null && (
          <button type="button" aria-label="Open the pull request" onClick={() => openUrl(item.url!)} className={GHOST}>
            Open the pull request ↗
          </button>
        )}
      </div>
      {!item.human && (
        <ul className="mt-1.5 space-y-1.5">
          {item.checks.map((check, index) => (
            <li key={`check-${index}`} data-feedback-check className="rounded-md border border-border-seam bg-card px-2 py-1">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
                <span className="rounded bg-destructive-text/10 px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--loom-bad)]">check failed</span>
                <span className="font-mono text-xs [overflow-wrap:anywhere]">{check.name}</span>
                {check.url !== null && (
                  <button type="button" aria-label={`Open the details of ${check.name}`} onClick={() => openUrl(check.url!)} className={GHOST}>
                    Details ↗
                  </button>
                )}
              </div>
            </li>
          ))}
          {item.items.map((entry, index) => (
            <li key={`item-${index}`} data-feedback-item={entry.kind} className="rounded-md border border-border-seam bg-card px-2 py-1">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
                <span className={`rounded px-1 text-[11px] font-bold uppercase tracking-wider ${ENTRY_TAGS[entry.kind].tone}`}>{entry.kind === "review" && entry.state !== null ? entry.state.replace(/_/g, " ") : ENTRY_TAGS[entry.kind].text}</span>
                <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{entry.author}</span>
                {entry.path !== null && (
                  <span className="rounded border border-border-seam px-1 font-mono text-[11px] text-[var(--loom-muted)] [overflow-wrap:anywhere]">
                    {entry.path}
                    {entry.line === null ? "" : `:${entry.line}`}
                  </span>
                )}
                {entry.url !== null && (
                  <button type="button" aria-label={`Open the ${entry.kind} by ${entry.author}`} onClick={() => openUrl(entry.url!)} className={GHOST}>
                    ↗
                  </button>
                )}
              </div>
              <FeedbackBody body={entry.body} />
            </li>
          ))}
        </ul>
      )}
      {ignored.length > 0 && <p className="mt-1.5 text-[11px] text-[var(--loom-muted)]">Not counted: {ignored.join(" and ")}.</p>}
    </div>
  );
}
