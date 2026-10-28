import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { MergeEntry, MergeOrderView, RolloutCheckResult, RolloutMilestone, RolloutRequirement, RolloutStage, RolloutStep, RolloutView, RolloutWindow } from "../contract";
import { BUTTON, BUTTON_PRIMARY, ConfirmButton, HEADING, RepoChip, listText, plural, useAction, useLoomWrite } from "./common";
import { createStored, useStored } from "./remember";
import {
  byUrgency,
  chainOf,
  columnsOf,
  dependentsOf,
  earlierOpen,
  earliestOf,
  holdsOf,
  milestoneStatus,
  pullRequestNote,
  readyToMerge,
  repoDeploys,
  shortCommand,
  soakWords,
  stageLabel,
  stageOfStep,
  stepStatus,
  unmet,
  type Column,
  type Earliest,
  type Hold,
  type Status,
  type Tone,
} from "./rollout-plan";

// The deploy order of a pull request project, for the human: what to do next and what to hold off, the freeze windows
// on a dated strip, and one column per stage with one status per step, whose details open in place. It is advice: the
// Mark live buttons record what is live and move nothing.

const TONE_TEXT: Record<Tone, string> = { live: "text-success", go: "text-primary", hold: "text-destructive-text", warn: "text-warning-text", wait: "text-muted-foreground" };
const TONE_ICON: Record<Tone, string> = { live: "✓", go: "●", hold: "■", warn: "▲", wait: "○" };
const NOTE = "text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]";
const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const SWITCH = `inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded py-1 text-[11.5px] text-muted-foreground ${FOCUS}`;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LIVE_BY = { merge: "its pull request merged", verify: "its verify command passed", check: "its check passed", human: "marked by you" } as const;

/** The step the Do next card names to act on; none while the next thing is a soak, a milestone or another step to wait for. */
const nextStepKey = (view: RolloutView) => (view.next.kind === "merge" || view.next.kind === "deploy" || view.next.kind === "pr" || view.next.kind === "blocked" ? view.next.keys[0] : undefined);

/** Whether hovering a step highlights what it needs and what waits on it, and whether every link shows; remembered on this device. */
export const rolloutHover = createStored<boolean>("rollout.hover", true, (value) => (typeof value === "boolean" ? value : null));
export const rolloutLinks = createStored<boolean>("rollout.links", false, (value) => (typeof value === "boolean" ? value : null));

const dayLabel = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const utcDay = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const dateLabel = (at: number) => new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
// The axis runs on UTC days, as the windows do.
const utcDateLabel = (at: number) => new Date(at).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
const windowName = (window: RolloutWindow) => window.title.split(":")[0]!.trim();
/** "#84212", or words for a pull request whose URL ends in no number. */
const prName = (step: Pick<RolloutStep, "prNumber">) => (step.prNumber === null ? "its pull request" : `#${step.prNumber}`);

/** "11:02 AM" today, "Thu 11:02 AM" within six days, "Nov 9" further off. */
function whenLabel(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time;
  if (Math.abs(at - now) < 6 * DAY_MS) return `${new Date(at).toLocaleDateString([], { weekday: "short" })} ${time}`;
  return dateLabel(at);
}

/** "45m", "4h 49m", "2d 3h": how long until `at`. */
function leftLabel(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return hours % 24 === 0 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

interface Actions {
  now: number;
  busy: boolean;
  onMark(target: string, undo: boolean): void;
  onTicket(key: string): void;
  onOpen(url: string): void;
}

function MarkButton({ target, live, busy, onMark, label }: { target: string; live: boolean; label?: string } & Pick<Actions, "busy" | "onMark">) {
  return live ? (
    <ConfirmButton label="Undo live" confirmLabel={`Click again to undo ${target}'s live mark`} disabled={busy} onConfirm={() => onMark(target, true)} />
  ) : (
    <ConfirmButton label={label ?? "Mark live"} confirmLabel={`Click again to mark ${target} live`} disabled={busy} onConfirm={() => onMark(target, false)} />
  );
}

/** Copies through the clipboard API, or a selected text area where the page has none, such as bb opened over plain HTTP. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused: try the older way below.
  }
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  // 16px keeps iOS from zooming the page when the text area takes focus.
  area.style.fontSize = "16px";
  document.body.append(area);
  area.focus();
  area.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    back?.focus();
  }
}

function CopyButton({ text }: { text: string }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  useLayoutEffect(() => {
    if (result === null) return;
    const timer = setTimeout(() => setResult(null), 2000);
    return () => clearTimeout(timer);
  }, [result]);
  return (
    <>
      <button type="button" aria-label={`Copy the command ${text}`} className={`${BUTTON} h-5.5 px-1.5 text-[11px] @max-xl/loom:h-7`} onClick={() => void copyText(text).then((ok) => setResult(ok ? "copied" : "failed"))}>
        {result === "copied" ? "Copied" : result === "failed" ? "Copy failed" : "Copy"}
      </button>
      <span role="status" className="sr-only">
        {result === "copied" ? "Copied the command" : result === "failed" ? "Could not copy the command" : ""}
      </span>
    </>
  );
}

function checkLabel(check: RolloutCheckResult, now: number): { tone: Tone; text: string } {
  if (check.exitCode === 0) return { tone: "live", text: `✓ passed ${whenLabel(check.at, now)}` };
  if (check.exitCode === null) return { tone: "hold", text: `did not finish ${whenLabel(check.at, now)}` };
  return { tone: "hold", text: `✗ exited ${check.exitCode} ${whenLabel(check.at, now)}` };
}

/** A verify or check command, short, with its last result, Copy and its output behind a disclosure. */
function Command({ command, check, idle, now }: { command: string; check: RolloutCheckResult | null; idle: string; now: number }) {
  const result = check === null ? null : checkLabel(check, now);
  const output = check !== null && check.output !== "";
  const full = shortCommand(command) !== command.trim();
  return (
    <div data-rollout-check className="min-w-0 [overflow-wrap:anywhere]">
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <code title={command} className="rounded bg-surface-recessed px-1 font-mono text-[11px] text-foreground [overflow-wrap:anywhere]">
          {shortCommand(command)}
        </code>
        {(result !== null || idle !== "") && <span className={result === null ? "text-muted-foreground" : TONE_TEXT[result.tone]}>{result === null ? idle : result.text}</span>}
        <CopyButton text={command} />
      </span>
      {(output || full) && (
        <details className="mt-0.5">
          <summary className={`cursor-pointer rounded text-[11px] text-subtle-foreground ${FOCUS}`}>{output && full ? "Full command and output" : output ? "Output" : "Full command"}</summary>
          {full && <pre className="mt-1 rounded bg-surface-recessed p-2 font-mono text-[10.5px] whitespace-pre-wrap [overflow-wrap:anywhere]">{command}</pre>}
          {output && <pre className="mt-1 max-h-40 overflow-auto rounded bg-surface-recessed p-2 font-mono text-[10.5px] whitespace-pre-wrap [overflow-wrap:anywhere]">{check!.output}</pre>}
        </details>
      )}
    </div>
  );
}

function StatusLine({ status, data }: { status: Status; data?: Record<string, string> }) {
  return (
    <span className={`flex flex-wrap items-baseline gap-x-1.5 text-[11.5px] font-semibold ${TONE_TEXT[status.tone]}`} {...data}>
      <span aria-hidden className={`size-[7px] shrink-0 -translate-y-px self-center rounded-full ${status.tone === "wait" ? "border-[1.5px] border-current" : "bg-current"}`} />
      <span>{status.label}</span>{" "}
      {status.why !== null && <span className="basis-full pl-3 text-[11px] font-normal text-muted-foreground">{status.why}</span>}
    </span>
  );
}

function NeedLine({ need, view }: { need: RolloutRequirement; view: RolloutView }) {
  const milestone = need.kind === "milestone" ? view.milestones.find((each) => each.ref === need.target) : undefined;
  const other = need.kind === "ticket" ? view.stages.flatMap((stage) => stage.steps).find((step) => step.key === need.target) : undefined;
  const word = need.cancelled ? "cancelled" : need.unknown ? "no longer in the spec" : need.kind === "milestone" ? (need.live ? "holds" : "does not hold") : need.live ? "live" : "not live";
  return (
    <div data-rollout-need={need.target} className="[overflow-wrap:anywhere]">
      <span aria-hidden className={need.live ? "text-success" : need.cancelled || need.unknown ? "text-muted-foreground" : "text-destructive-text"}>
        {need.live ? "✓" : need.cancelled || need.unknown ? "–" : "○"}
      </span>{" "}
      <b className={`font-semibold text-foreground ${need.kind === "milestone" ? "font-mono text-[11px]" : ""}`}>{need.target}</b> {word}
      {need.viaStage && " · gates the stage"}
      {milestone === undefined && other === undefined && need.title !== null && <span className="text-subtle-foreground"> · {need.title}</span>}
    </div>
  );
}

function Detail({ rows, children }: { rows: Array<[string, ReactNode]>; children: ReactNode }) {
  return (
    <div data-rollout-detail className="mt-1 cursor-default border-t border-border-seam px-2 pt-2 pb-2">
      <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-[11.5px] @max-xl/loom:grid-cols-1 @max-xl/loom:gap-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="pt-px text-[10.5px] text-subtle-foreground @max-xl/loom:mt-1.5">{label}</dt>
            <dd className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** What a step's verify command is waiting for before its first run. */
function verifyIdle(step: RolloutStep): string {
  // A merge marks a deploy-on-merge step live at once; its verify runs only once the human has undone that mark.
  if (step.onMerge) return "Loom marks it live when it merges, so this runs only after you undo that mark";
  return step.merge === "merged" ? "not run yet; Loom runs it every 15 minutes" : "runs every 15 minutes once it merges";
}

/** The accessible name of a button that opens the step's pull request, with the number it shows. */
const prLabel = (step: RolloutStep) => (step.prNumber === null ? `Open ${step.key}'s pull request` : `Open #${step.prNumber}, ${step.key}'s pull request`);

/** Hover highlights only for a mouse: a tap sends an emulated enter that no leave follows. */
const fromMouse = (event: { pointerType: string }) => event.pointerType === "mouse";

/** Focus highlights only when the browser shows a focus ring, so a tap or a click does not leave one. */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function StepDetail({ step, view, ...actions }: { step: RolloutStep; view: RolloutView } & Actions) {
  const downs = dependentsOf(view, step.key);
  const rows: Array<[string, ReactNode]> = [
    [
      "Needs",
      step.requires.length === 0 ? (
        "nothing first"
      ) : (
        <div data-rollout-needs className="flex flex-col gap-0.5">
          {step.requires.map((need) => (
            <NeedLine key={need.target} need={need} view={view} />
          ))}
        </div>
      ),
    ],
    [
      "Deploys",
      <>
        {step.onMerge ? <b className="font-semibold text-warning-text">⚡ On merge. </b> : <b className="font-semibold text-foreground">{step.how === null ? "After merge, the way its repo deploys." : "After merge. "}</b>}
        {step.how}
        {step.release !== null && ` Release ${step.release}${step.releaseWith.length === 0 ? "" : ` with ${listText(step.releaseWith)}`}.`}
        {step.dark && " Ships dark, with its gate off."}
      </>,
    ],
  ];
  if (step.verify !== null) rows.push(["Verify", <Command command={step.verify} check={step.lastCheck} idle={verifyIdle(step)} now={actions.now} />]);
  if (step.rollback !== null) {
    rows.push([
      "Rollback",
      <>
        {step.rollback}
        {step.liveConsumers.length > 0 && (
          <span className="mt-0.5 block text-destructive-text">
            ⚠ Rolling it back now breaks {listText(step.liveConsumers)}, which {step.liveConsumers.length === 1 ? "is" : "are"} live.
          </span>
        )}
      </>,
    ]);
  }
  if (downs.length > 0) rows.push(["Unblocks", listText(downs)]);
  if (step.live !== null) rows.push(["Live", `since ${whenLabel(step.live.at, actions.now)}, ${LIVE_BY[step.live.by]}${step.live.by === "human" && step.live.evidence !== null ? `: ${step.live.evidence}` : ""}`]);
  return (
    <Detail rows={rows}>
      <MarkButton target={step.key} live={step.live !== null} busy={actions.busy} onMark={actions.onMark} />
      <button type="button" className={BUTTON} onClick={() => actions.onTicket(step.key)}>
        Open ticket
      </button>
      {step.prUrl !== null && (
        <button type="button" aria-label={prLabel(step)} className={BUTTON} onClick={() => actions.onOpen(step.prUrl!)}>
          Open {step.prNumber === null ? "pull request" : `#${step.prNumber}`}
        </button>
      )}
    </Detail>
  );
}

function MilestoneDetail({ milestone, ...actions }: { milestone: RolloutMilestone } & Actions) {
  const rows: Array<[string, ReactNode]> = [["What", milestone.title]];
  rows.push(["Check", milestone.check === null ? "No command: mark it live once it holds." : <Command command={milestone.check} check={milestone.lastCheck} idle="not run yet; Loom runs it every 15 minutes" now={actions.now} />]);
  if (milestone.stage !== null) rows.push(["Gates", stageLabel(milestone.stage)]);
  if (milestone.neededBy.length > 0) rows.push(["Needed by", listText(milestone.neededBy)]);
  if (milestone.live !== null) rows.push(["Holds", `since ${whenLabel(milestone.live.at, actions.now)}, ${LIVE_BY[milestone.live.by]}${milestone.live.by === "human" && milestone.live.evidence !== null ? `: ${milestone.live.evidence}` : ""}`]);
  return (
    <Detail rows={rows}>
      <MarkButton target={milestone.ref} live={milestone.live !== null} busy={actions.busy} onMark={actions.onMark} />
    </Detail>
  );
}

interface Chain {
  key: string;
  up: Set<string>;
  down: Set<string>;
}

/** A link from what a step needs to the step lies on the chain when following needs up, or needed-by down, from its key reaches it. */
const onChain = (chain: Chain, from: string, to: string) => ((from === chain.key || chain.down.has(from)) && chain.down.has(to)) || ((to === chain.key || chain.up.has(to)) && chain.up.has(from));

interface Focus {
  open: string | null;
  /** The focused item and what it needs and what waits on it, or null for no focus. */
  chain: Chain | null;
  onToggle(key: string): void;
  onHover(key: string | null): void;
}

const RELATION = "pointer-events-none absolute -top-2 right-2 z-[2] rounded border border-current bg-card px-1 text-[10px] leading-[13px] font-bold tracking-wide uppercase";

function Relation({ itemKey, focus }: { itemKey: string; focus: Focus }) {
  if (focus.chain === null) return null;
  if (focus.chain.up.has(itemKey)) return <span className={`${RELATION} text-primary`}>needed first</span>;
  if (focus.chain.down.has(itemKey)) return <span className={`${RELATION} text-muted-foreground`}>waits on it</span>;
  return null;
}

function tileClass(key: string, focus: Focus, extra: string): string {
  const chain = focus.chain;
  const me = chain?.key === key;
  const dim = chain !== null && !me && !chain.up.has(key) && !chain.down.has(key);
  return `relative z-[1] my-1 rounded-md border text-xs transition-opacity ${me ? extra.replace(/\bring-1\b/u, "") : extra} ${me ? "ring-2 ring-primary" : ""} ${dim ? "opacity-30" : ""}`;
}

function StepTile({ step, view, next, merge, focus, ...actions }: { step: RolloutStep; view: RolloutView; next: boolean; merge: MergeEntry | undefined; focus: Focus } & Actions) {
  const status = stepStatus(view, step, actions.now);
  const open = focus.open === step.key;
  const detailId = `rollout-detail-${step.key}`;
  const note = pullRequestNote(merge);
  const live = step.live !== null;
  const edge = live ? "border-border-seam bg-transparent" : next ? "border-primary bg-card ring-1 ring-primary" : status.tone === "hold" ? "border-destructive/55 bg-card" : "border-border-seam bg-card";
  const summary = live ? (
    <span className="grid grid-cols-[0.75rem_auto_minmax(0,1fr)_auto] items-baseline gap-x-1.5">
      <span aria-hidden className="text-success">
        ✓
      </span>
      <b className="font-semibold whitespace-nowrap">
        <span className="sr-only">Live:</span>{" "}
        {step.key}
      </b>{" "}
      <span data-rollout-title title={step.title} className={`text-muted-foreground ${open ? "[overflow-wrap:anywhere]" : "truncate"}`}>
        {step.title}
      </span>{" "}
      <span className="flex items-baseline gap-1 text-[10.5px] whitespace-nowrap text-subtle-foreground" data-rollout-status={status.kind}>
        {step.dark && <span className="rounded-full border border-border-seam px-1.5 text-[10px]">dark</span>}{" "}
        {status.kind === "soaking" ? <span title={`Soaking until ${whenLabel(step.soakedAt!, actions.now)}`}>soaks {leftLabel(step.soakedAt!, actions.now)} more</span> : stageOfStep(view, step.key)?.soak == null ? "live" : "soaked"}
      </span>
    </span>
  ) : (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-1.5">
        <b className="font-semibold">{step.key}</b> {step.repo !== null && <RepoChip name={step.repo} />}{" "}
        {step.onMerge && (
          <span title="Merging deploys it" className="text-[11px] text-warning-text">
            <span aria-hidden>⚡</span>
            <span className="sr-only">deploys on merge</span>
          </span>
        )}
        {" "}
        {step.prNumber !== null && <span className="font-mono text-[11px] text-primary">#{step.prNumber}</span>}{" "}
        {next && <span className="ml-auto rounded-sm bg-primary px-1 text-[10px] leading-[15px] font-bold tracking-wide text-primary-foreground">NEXT</span>}
      </span>
      {" "}
      <span data-rollout-title className="[overflow-wrap:anywhere]">{step.title}</span>{" "}
      <StatusLine status={status} data={{ "data-rollout-status": status.kind }} />{" "}
      {note !== null && <span className={`text-[11px] ${note.tone === "hold" ? "text-destructive-text" : "text-muted-foreground"}`}>{note.text}</span>}
    </span>
  );
  return (
    <div data-rollout-row={step.key} className={tileClass(step.key, focus, edge)} onPointerEnter={(event) => fromMouse(event) && focus.onHover(step.key)} onPointerLeave={(event) => fromMouse(event) && focus.onHover(null)}>
      <Relation itemKey={step.key} focus={focus} />
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => focus.onToggle(step.key)}
        onFocus={(event) => focusVisible(event.currentTarget) && focus.onHover(step.key)}
        onBlur={() => focus.onHover(null)}
        className={`block w-full cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${live ? "px-2 py-1 @max-xl/loom:py-1.5" : "px-2 py-1.5 @max-xl/loom:py-2"}`}
      >
        {summary}
      </button>
      {open && (
        <div id={detailId}>
          <StepDetail step={step} view={view} {...actions} />
        </div>
      )}
    </div>
  );
}

function MilestoneTile({ milestone, focus, ...actions }: { milestone: RolloutMilestone; focus: Focus } & Actions) {
  const status = milestoneStatus(milestone);
  const open = focus.open === milestone.ref;
  const holds = milestone.live !== null;
  const detailId = `rollout-detail-${milestone.ref}`;
  return (
    <div
      data-rollout-milestone={milestone.ref}
      data-rollout-holds={holds ? "yes" : "no"}
      className={tileClass(milestone.ref, focus, `border-dashed ${holds ? "border-border-seam bg-transparent" : "border-border-seam bg-card"}`)}
      onPointerEnter={(event) => fromMouse(event) && focus.onHover(milestone.ref)}
      onPointerLeave={(event) => fromMouse(event) && focus.onHover(null)}
    >
      <Relation itemKey={milestone.ref} focus={focus} />
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => focus.onToggle(milestone.ref)}
        onFocus={(event) => focusVisible(event.currentTarget) && focus.onHover(milestone.ref)}
        onBlur={() => focus.onHover(null)}
        className="block w-full cursor-pointer rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring @max-xl/loom:py-2"
      >
        {holds ? (
          <span className="grid grid-cols-[0.75rem_auto_minmax(0,1fr)_auto] items-baseline gap-x-1.5">
            <span aria-hidden className="text-success">
              ◆
            </span>
            <b className="font-mono text-[11px] font-semibold [overflow-wrap:anywhere]">
              <span className="sr-only">Milestone</span>{" "}
              {milestone.ref}
            </b>{" "}
            <span title={milestone.title} className={`text-muted-foreground ${open ? "[overflow-wrap:anywhere]" : "truncate"}`}>
              {milestone.title}
            </span>{" "}
            <span className="text-[10.5px] text-subtle-foreground">holds</span>
          </span>
        ) : (
          <span className="flex flex-col gap-1">
            <span className="flex items-baseline gap-1.5">
              <span aria-hidden className={TONE_TEXT[status.tone]}>
                ◆
              </span>
              <b className="font-mono text-[11px] font-semibold [overflow-wrap:anywhere]">
                <span className="sr-only">Milestone</span>{" "}
                {milestone.ref}
              </b>
            </span>{" "}
            <span className={`text-muted-foreground [overflow-wrap:anywhere] ${open ? "" : "line-clamp-3"}`}>{milestone.title}</span>{" "}
            <StatusLine status={status} />
          </span>
        )}
      </button>
      {open && (
        <div id={detailId}>
          <MilestoneDetail milestone={milestone} {...actions} />
        </div>
      )}
    </div>
  );
}

function Then() {
  return (
    <div role="separator" aria-label="Then, after the steps above" className="mx-1 my-1.5 flex items-center gap-1.5 text-[10px] tracking-wider text-subtle-foreground uppercase before:flex-1 before:border-t before:border-dashed before:border-border-seam after:flex-1 after:border-t after:border-dashed after:border-border-seam">
      <span aria-hidden>then</span>
    </div>
  );
}

function stageStatusText(view: RolloutView, columns: Column[], index: number, earliest: Earliest | undefined, now: number): ReactNode {
  const stage = columns[index]!.stage;
  const pending = stage.steps.filter((step) => step.live === null);
  const soak = stage.soak === null ? "" : `, then it soaks ${soakWords(stage.soak)}`;
  const thenSoaks = stage.soak === null ? "" : `; this stage then soaks ${soakWords(stage.soak)}`;
  let lead: ReactNode;
  if (stage.name === null) lead = "Steps in no stage: they go in any order.";
  else if (pending.length === 0) lead = stage.soaked || stage.soakedAt === null ? <b className="font-semibold text-success">✓ Done</b> : <><b className="font-semibold text-success">All live</b>, soaking until {whenLabel(stage.soakedAt, now)}</>;
  else {
    const before = index > 0 && columns[index - 1]!.stage.name !== null && !columns[index - 1]!.stage.soaked ? columns[index - 1]!.stage : earlierOpen(view, stage);
    lead =
      before === null ? (
        <>
          <b className="font-semibold text-foreground">{plural(pending.length, "step")} left</b>
          {soak}
        </>
      ) : (
        <>
          Starts once <b className="font-semibold text-foreground">{stageLabel(before.name)}</b> {before.soak === null ? "is all live" : "has soaked"}
          {thenSoaks}
        </>
      );
  }
  const done = stage.name !== null && pending.length === 0;
  return (
    <>
      {lead}
      {!done && earliest !== undefined && (
        <span className="block text-muted-foreground">
          {earliest.at !== null ? `Earliest done: ${dateLabel(earliest.at)}` : `Earliest done: once ${listText(earliest.waitsFor)} ${earliest.waitsFor.length === 1 ? "holds" : "hold"}`}
        </span>
      )}
    </>
  );
}

function StageColumn({ column, index, columns, view, current, earliest, merges, focus, ...actions }: { column: Column; index: number; columns: Column[]; view: RolloutView; current: boolean; earliest: Earliest | undefined; merges: ReadonlyMap<string, MergeEntry>; focus: Focus } & Actions) {
  const { stage } = column;
  const live = stage.steps.filter((step) => step.live !== null).length;
  const order = column.layers.flat().flatMap((item) => ("step" in item ? [item.step] : []));
  const nextKey = nextStepKey(view);
  const [goalOpen, setGoalOpen] = useState(false);
  return (
    <section data-rollout-stage={stage.name ?? "none"} aria-label={stageLabel(stage.name)} className={`relative min-w-0 rounded-lg border bg-surface-raised px-2 pt-2.5 pb-2 ${current ? "border-primary/55" : "border-border-seam"}`}>
      {index > 0 && stage.name !== null && (
        <>
          <span aria-hidden className="absolute top-2 -left-[17px] hidden text-lg leading-none text-subtle-foreground @3xl/rollout:block">
            ›
          </span>
          <span aria-hidden className="absolute -top-[21px] left-1/2 text-sm text-subtle-foreground @3xl/rollout:hidden">
            ⌄
          </span>
        </>
      )}
      <header className="px-1 pb-2">
        <div className="flex items-baseline gap-1.5">
          {stage.name !== null && <span className="font-semibold text-subtle-foreground">{index + 1}</span>}
          <h4 className="text-[12.5px] font-semibold [overflow-wrap:anywhere]">{stageLabel(stage.name)}</h4>
          <span className="ml-auto text-[11px] whitespace-nowrap text-muted-foreground">
            {live} of {stage.steps.length} live
          </span>
        </div>
        {stage.goal !== null && (
          <button type="button" data-rollout-goal aria-expanded={goalOpen} onClick={() => setGoalOpen(!goalOpen)} className={`mt-0.5 block w-full cursor-pointer rounded text-left text-[11px] text-muted-foreground [overflow-wrap:anywhere] ${FOCUS}`}>
            {/* The clamp sets its own display, so it sits on a span: on the button, `block` would win over it. */}
            <span className={goalOpen ? "" : "line-clamp-2"}>
              <span className="sr-only">Goal:</span> {stage.goal}
            </span>
          </button>
        )}
        <div aria-hidden className="mt-1.5 flex gap-0.5">
          {order.map((step) => {
            const status = stepStatus(view, step, actions.now);
            const fill = step.live !== null ? "bg-success" : step.key === nextKey ? "bg-primary" : status.tone === "hold" ? "bg-destructive/70" : "bg-foreground/15";
            return <i key={step.key} title={`${step.key}: ${status.label}`} className={`h-1 flex-1 rounded-sm ${fill}`} />;
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">{stageStatusText(view, columns, index, earliest, actions.now)}</p>
      </header>
      {column.gates.map((milestone) => (
        <MilestoneTile key={milestone.ref} milestone={milestone} focus={focus} {...actions} />
      ))}
      {column.gates.length > 0 && column.layers.length > 0 && <Then />}
      {column.layers.map((layer, layerIndex) => (
        <div key={layerIndex}>
          {layerIndex > 0 && <Then />}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(17rem,100%),1fr))] items-start gap-x-2 @3xl/rollout:block">
            {layer.map((item) =>
              "step" in item ? (
                <StepTile key={item.step.key} step={item.step} view={view} next={item.step.key === nextKey} merge={merges.get(item.step.key)} focus={focus} {...actions} />
              ) : (
                <MilestoneTile key={item.milestone.ref} milestone={item.milestone} focus={focus} {...actions} />
              ),
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

interface Edge {
  from: string;
  to: string;
  live: boolean;
  d: string;
}

/** The columns, and the links from what a step needs to the step, measured from where the tiles sit. */
function DeployOrder({ view, columns, earliest, merges, focus, showAll, ...actions }: { view: RolloutView; columns: Column[]; earliest: Earliest[]; merges: ReadonlyMap<string, MergeEntry>; focus: Focus; showAll: boolean } & Actions) {
  const grid = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edge[]>([]);
  const marker = useId().replace(/:/gu, "");
  const current = columns.findIndex((column) => column.stage.name !== null && column.stage.steps.some((step) => step.live === null));
  const chain = focus.chain;
  // Opening or closing a step moves the tiles under it, so the links are measured again.
  const opened = focus.open;
  const measure = useCallback(() => {
    const root = grid.current;
    if (root === null) return;
    if (chain === null && !showAll) return setEdges([]);
    const box = root.getBoundingClientRect();
    const tiles = new Map([...root.querySelectorAll<HTMLElement>("[data-rollout-row],[data-rollout-milestone]")].map((tile) => [tile.dataset.rolloutRow ?? tile.dataset.rolloutMilestone!, tile.getBoundingClientRect()]));
    const next: Edge[] = [];
    for (const step of view.stages.flatMap((stage) => stage.steps)) {
      for (const need of step.requires) {
        const a = tiles.get(need.target);
        const b = tiles.get(step.key);
        if (a === undefined || b === undefined) continue;
        if (!showAll && (chain === null || !onChain(chain, need.target, step.key))) continue;
        const y1 = a.top + Math.min(14, a.height / 2) - box.top;
        const y2 = b.top + Math.min(14, b.height / 2) - box.top;
        let d: string;
        if (b.left > a.right - 4) {
          const x1 = a.right - box.left;
          const x2 = b.left - box.left - 3;
          const mid = (x1 + x2) / 2;
          d = `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
        } else {
          const x1 = a.left - box.left;
          const x2 = b.left - box.left - 3;
          d = `M${x1} ${y1} C${x1 - 12} ${y1}, ${x2 - 12} ${y2}, ${x2} ${y2}`;
        }
        next.push({ from: need.target, to: step.key, live: need.live, d });
      }
    }
    setEdges(next);
  }, [view, chain, showAll, opened]);

  useLayoutEffect(() => {
    measure();
    const root = grid.current;
    if (root === null || typeof ResizeObserver === "undefined") return;
    // A tile that grows inside a column shorter than the tallest moves what is under it without resizing the grid.
    const observer = new ResizeObserver(measure);
    for (const element of [root, ...root.querySelectorAll("section, [data-rollout-row], [data-rollout-milestone]")]) observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  const named = (edge: Edge) => chain !== null && onChain(chain, edge.from, edge.to);
  return (
    <div className="overflow-x-auto px-1 pb-1 @3xl/rollout:-mx-1">
      <div ref={grid} data-rollout-columns className="relative mt-2 grid gap-6 @3xl/rollout:grid-cols-[repeat(var(--rollout-stages),minmax(12.5rem,1fr))] @3xl/rollout:gap-[22px]" style={{ "--rollout-stages": columns.length } as CSSProperties}>
        {columns.map((column, index) => (
          <StageColumn
            key={column.stage.name ?? "none"}
            column={column}
            index={index}
            columns={columns}
            view={view}
            current={index === current}
            earliest={earliest.find((each) => each.stage === column.stage)}
            merges={merges}
            focus={focus}
            {...actions}
          />
        ))}
        <svg aria-hidden className="pointer-events-none absolute inset-0 z-[2] h-full w-full overflow-visible">
          <defs>
            {(["live", "wait"] as const).map((kind) => (
              <marker key={kind} id={`${marker}-${kind}`} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0 0 L6 3 L0 6 z" className={kind === "live" ? "fill-success" : "fill-subtle-foreground"} />
              </marker>
            ))}
          </defs>
          {edges.map((edge) => (
            <path
              key={`${edge.from}>${edge.to}`}
              data-rollout-link={`${edge.from}>${edge.to}`}
              d={edge.d}
              fill="none"
              strokeWidth={chain !== null && named(edge) ? 1.75 : 1.25}
              markerEnd={`url(#${marker}-${edge.live ? "live" : "wait"})`}
              className={`${edge.live ? "stroke-success" : "stroke-subtle-foreground [stroke-dasharray:4_3]"} ${showAll && !(chain !== null && named(edge)) ? "opacity-35" : ""}`}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

function Switch({ on, label, onChange, className = "" }: { on: boolean; label: string; onChange(next: boolean): void; className?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={`${SWITCH} ${className}`}>
      <span aria-hidden className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors ${on ? "bg-primary" : "bg-foreground/25"}`}>
        <span className={`absolute top-0.5 size-2.5 rounded-full bg-background transition-[left] ${on ? "left-3" : "left-0.5"}`} />
      </span>
      {label}
    </button>
  );
}

function PlanRow({ index, done, current, label, children }: { index: number; done: boolean; current: boolean; label: string; children: ReactNode }) {
  return (
    <li data-rollout-plan={label.toLowerCase()} className="grid grid-cols-[1.125rem_3.5rem_minmax(0,1fr)] items-baseline gap-x-1.5 py-0.5 @max-xl/loom:grid-cols-[1.125rem_minmax(0,1fr)]">
      <span aria-hidden className={`inline-flex size-4 items-center justify-center rounded-full border-[1.5px] text-[9.5px] ${done ? "border-success text-success" : current ? "border-primary font-semibold text-primary" : "border-border-seam text-muted-foreground"}`}>
        {done ? "✓" : index}
      </span>
      <span className="font-semibold">{label}</span>
      <div className="min-w-0 text-muted-foreground [overflow-wrap:anywhere] @max-xl/loom:col-start-2">{children}</div>
    </li>
  );
}

const CARD = "min-w-0 rounded-lg border px-3.5 py-3 @max-xl/loom:px-3";

/** The checklist for the step that goes next: review, merge, deploy and verify, and what its going live opens. */
function StepPlan({ view, step, merge, earliest, ...actions }: { view: RolloutView; step: RolloutStep; merge: MergeEntry | undefined; earliest: Earliest[] } & Actions) {
  const stage = stageOfStep(view, step.key)!;
  const rows: Array<{ label: string; done: boolean; body: ReactNode }> = [];
  const note = pullRequestNote(merge);
  const merged = step.merge === "merged";
  if (!merged && merge !== undefined && merge.prOpen) {
    const stacked = merge.waitsOn.find((wait) => wait.why === "stacked");
    const ready = readyToMerge(merge);
    const name = prName(step);
    rows.push({
      label: "Review",
      done: ready,
      body: (
        <>
          {note === null ? `Loom has not read ${name === "its pull request" ? "its pull request's" : `${name}'s`} review yet.` : `${name === "its pull request" ? "Its pull request:" : name} ${note.text}`}
          {ready && <span className="block">The Merge order calls it ready to merge.</span>}
          {merge.elsewhere !== null && <span className="block">It targets {merge.elsewhere}, not {merge.base}.</span>}
          {stacked !== undefined && <span className="block">It builds on {stacked.key}'s branch; merge {stacked.prNumber === null ? stacked.key : `#${stacked.prNumber}`} first.</span>}
        </>
      ),
    });
  }
  if (step.merge === "no_pr") rows.push({ label: "Review", done: false, body: "Its pull request is not open yet; Loom opens it once the work passes review." });
  rows.push({ label: "Merge", done: merged, body: merged ? "merged" : step.onMerge ? <b className="font-semibold text-warning-text">⚡ merging deploys it</b> : "merging deploys nothing" });
  if (!step.onMerge) rows.push({ label: "Deploy", done: false, body: step.how ?? "the way its repo deploys" });
  rows.push({
    label: "Verify",
    done: false,
    body:
      step.verify === null ? (
        step.onMerge ? `Loom marks ${step.key} live when it merges.` : `Mark ${step.key} live once it is out.`
      ) : (
        <>
          <Command command={step.verify} check={step.lastCheck} idle="" now={actions.now} />
          <span className="block">
            {step.onMerge
              ? `Loom marks ${step.key} live when it merges, without waiting for this command; run it yourself to check.`
              : merged
                ? `Loom runs it every 15 minutes and marks ${step.key} live when it passes.`
                : `Loom runs it every 15 minutes once ${step.key} merges, and marks it live when it passes.`}
          </span>
        </>
      ),
  });
  const firstOpen = rows.findIndex((row) => !row.done);
  const others = stage.steps.filter((each) => each.live === null && each.key !== step.key);
  const after = view.stages.slice(view.stages.indexOf(stage) + 1).find((each) => each.name !== null && each.steps.length > 0);
  const opens = after === undefined ? [] : after.steps.filter((each) => each.live === null && unmet(each).every((need) => need.kind === "ticket" && need.target === step.key)).map((each) => each.key);
  const waits = dependentsOf(view, step.key).filter((key) => view.stages.some((each) => each.steps.some((other) => other.key === key && other.live === null)));
  const soaked = earliest.find((each) => each.stage === stage)?.at ?? null;
  return (
    <>
      <ol className="mt-2.5">
        {rows.map((row, index) => (
          <PlanRow key={row.label} index={index + 1} done={row.done} current={index === firstOpen} label={row.label}>
            {row.body}
          </PlanRow>
        ))}
      </ol>
      <p data-rollout-then className="mt-2.5 border-t border-dashed border-border-seam pt-2 text-muted-foreground [overflow-wrap:anywhere]">
        When it is live:{" "}
        {others.length > 0 ? (
          `${plural(others.length, "more step")} in ${stageLabel(stage.name)} after this: ${listText(others.map((each) => each.key))}.`
        ) : stage.name === null ? (
          "every step with a stage is live."
        ) : (
          <>
            <b className="font-semibold text-foreground">{stageLabel(stage.name)}</b> is all live{stage.soak === null ? "" : ` and soaks ${soakWords(stage.soak)}`}
            {soaked !== null && stage.soak !== null && `, until about ${whenLabel(soaked, actions.now)}`}.
            {after !== undefined && opens.length > 0 && (
              <>
                {" "}
                Then <b className="font-semibold text-foreground">{listText(opens)}</b> can go in {stageLabel(after.name)}.
              </>
            )}
          </>
        )}
        {waits.length > 0 && ` ${listText(waits)} ${waits.length === 1 ? "waits" : "wait"} on it.`}
        {view.next.keys.length > 1 && ` ${listText(view.next.keys.slice(1))} can go now too.`}
      </p>
    </>
  );
}

function NextCard({ view, merges, earliest, ...actions }: { view: RolloutView; merges: ReadonlyMap<string, MergeEntry>; earliest: Earliest[] } & Actions) {
  const next = view.next;
  const steps = view.stages.flatMap((stage) => stage.steps);
  const step = steps.find((each) => each.key === next.keys[0]);
  const stage = next.stage === null ? null : (view.stages.find((each) => each.name === next.stage) ?? null);
  let title: string;
  let body: ReactNode = null;
  let buttons: ReactNode = null;
  if ((next.kind === "merge" || next.kind === "deploy" || next.kind === "pr") && step !== undefined) {
    title = next.kind === "deploy" ? `Deploy ${step.key}` : next.kind === "pr" ? `${step.key} is next` : step.onMerge ? `Merge ${step.key}: merging deploys it` : `Merge ${step.key}, then deploy it`;
    body = <StepPlan view={view} step={step} merge={merges.get(step.key)} earliest={earliest} {...actions} />;
    buttons = (
      <>
        {step.prUrl !== null ? (
          <button type="button" aria-label={prLabel(step)} className={BUTTON_PRIMARY} onClick={() => actions.onOpen(step.prUrl!)}>
            Open {step.prNumber === null ? "pull request" : `#${step.prNumber}`}
          </button>
        ) : null}
        <MarkButton target={step.key} live={false} label={`Mark ${step.key} live`} busy={actions.busy} onMark={actions.onMark} />
        <button type="button" className={step.prUrl === null ? BUTTON_PRIMARY : BUTTON} onClick={() => actions.onTicket(step.key)}>
          Open ticket
        </button>
      </>
    );
  } else if (next.kind === "blocked" && step !== undefined) {
    title = `${step.key} is next, and it is blocked`;
    body = <p className="mt-1.5 text-muted-foreground">Its ticket is blocked. Answer it or requeue it from the ticket page; the deploy order waits on it.</p>;
    buttons = (
      <button type="button" className={BUTTON_PRIMARY} onClick={() => actions.onTicket(step.key)}>
        Open ticket
      </button>
    );
  } else if (next.kind === "soak" && stage !== null && next.until !== null) {
    // The server names every step still to go; only those that need nothing else can go once the soak ends.
    const soakReady = next.keys.filter((key) => {
      const waiting = steps.find((each) => each.key === key);
      return waiting !== undefined && waiting.state !== "blocked" && unmet(waiting).length === 0;
    });
    title = `Wait for ${stageLabel(stage.name)} to soak`;
    body = (
      <p className="mt-1.5 text-muted-foreground">
        It soaks until {whenLabel(next.until, actions.now)}, {leftLabel(next.until, actions.now)} from now.{" "}
        {soakReady.length > 0 ? `Then ${listText(soakReady)} can go.` : "Then the next stage starts, once what its steps need is live."}
      </p>
    );
  } else if (next.kind === "milestone") {
    const milestone = view.milestones.find((each) => each.ref === next.keys[0]);
    title = `Wait for ${next.keys[0]} to hold`;
    body =
      milestone === undefined ? null : (
        <div className="mt-1.5 text-muted-foreground">
          <p className="[overflow-wrap:anywhere]">{milestone.title}</p>
          <div className="mt-1.5">
            {milestone.check === null ? "It has no check command: mark it live once it holds." : <Command command={milestone.check} check={milestone.lastCheck} idle="not run yet; Loom runs it every 15 minutes" now={actions.now} />}
          </div>
          {milestone.neededBy.length > 0 && <p className="mt-1.5">{listText(milestone.neededBy)} {milestone.neededBy.length === 1 ? "needs" : "need"} it.</p>}
        </div>
      );
    buttons = milestone === undefined ? null : <MarkButton target={milestone.ref} live={false} busy={actions.busy} onMark={actions.onMark} />;
  } else if (next.kind === "wait" && next.keys[0] !== undefined) {
    const target = steps.find((each) => each.key === next.keys[0]);
    title = `Wait for ${next.keys[0]} to go live`;
    body = target === undefined ? null : (
      <div className="mt-1.5">
        <p className="text-muted-foreground [overflow-wrap:anywhere]">{target.title}</p>
        <div className="mt-1">
          <StatusLine status={stepStatus(view, target, actions.now)} />
        </div>
      </div>
    );
    buttons =
      target === undefined ? null : (
        <button type="button" className={BUTTON} onClick={() => actions.onTicket(target.key)}>
          Open ticket
        </button>
      );
  } else {
    title = next.kind === "done" ? "Everything is live" : next.text;
    if (next.kind === "done" && next.until !== null) body = <p className="mt-1.5 text-muted-foreground">The last stage soaks until {whenLabel(next.until, actions.now)}.</p>;
  }
  const where = stage === null ? "" : ` · ${stageLabel(stage.name)}`;
  return (
    <div data-rollout-next={next.kind} className={`${CARD} border-primary/55 shadow-[inset_3px_0_0_var(--primary)]`}>
      <p className={HEADING}>
        {next.kind === "done" ? "Rollout" : "Do next"}
        {where}
      </p>
      <h3 className="mt-1 text-sm font-semibold [overflow-wrap:anywhere]">{title}</h3>
      {step !== undefined && (next.kind === "merge" || next.kind === "deploy" || next.kind === "pr" || next.kind === "blocked") && (
        <>
          <p className="text-muted-foreground [overflow-wrap:anywhere]">{step.title}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-1.5">
            {step.repo !== null && <RepoChip name={step.repo} />}
            {step.prNumber !== null && <span className="font-mono text-[11px] text-primary">#{step.prNumber}</span>}
          </p>
        </>
      )}
      {body}
      {buttons !== null && <div className="mt-2.5 flex flex-wrap gap-1.5 @max-xl/loom:[&>button]:h-8 @max-xl/loom:[&>button]:flex-auto">{buttons}</div>}
    </div>
  );
}

function holdTitle(hold: Hold): string {
  const key = hold.step.key;
  switch (hold.kind) {
    case "dont_merge":
      return `Don't merge ${key} yet`;
    case "dont_deploy":
      return `Don't deploy ${key} yet`;
    case "waits": {
      const milestones = hold.needs.filter((need) => need.kind === "milestone").map((need) => need.target);
      return `${key} waits for ${listText(milestones)}`;
    }
    case "ahead":
      return `${key} is ahead of its stage`;
    case "calendar": {
      const window = hold.windows[0];
      if (window === undefined) return `Mind the calendar for ${key}`;
      return window.active ? `${key} deploys on merge during the ${windowName(window)}` : `Merge ${key} before the ${windowName(window)}`;
    }
  }
}

function HoldCard({ view, holds, now, onOpen }: { view: RolloutView; holds: Hold[]; now: number; onOpen(url: string): void }) {
  return (
    <div data-rollout-hold-off className={`${CARD} border-border-seam shadow-[inset_3px_0_0_var(--warning)]`}>
      <h3 className={HEADING}>Hold off</h3>
      {holds.map((hold, index) => {
        const stage = stageOfStep(view, hold.step.key);
        return (
          <div key={hold.step.key} data-rollout-hold={hold.step.key} data-rollout-hold-kind={hold.kind} className={`pt-2 pb-0.5 ${index > 0 ? "mt-1.5 border-t border-border-seam" : ""}`}>
            <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-semibold">
              <span aria-hidden className={TONE_TEXT[hold.tone]}>
                {TONE_ICON[hold.tone]}
              </span>
              <span className={`[overflow-wrap:anywhere] ${TONE_TEXT[hold.tone]}`}>{holdTitle(hold)}</span>
              {hold.step.prUrl !== null && (
                <button type="button" aria-label={prLabel(hold.step)} className={`cursor-pointer rounded font-mono text-[11px] text-primary hover:underline ${FOCUS}`} onClick={() => onOpen(hold.step.prUrl!)}>
                  {hold.step.prNumber === null ? "pull request" : `#${hold.step.prNumber}`}
                </button>
              )}
              {hold.step.repo !== null && <RepoChip name={hold.step.repo} />}
            </p>
            <p className="mt-0.5 text-muted-foreground [overflow-wrap:anywhere]">
              {hold.step.title}
              {hold.kind === "dont_merge" && (
                <span className="text-warning-text">
                  {" "}
                  · <span aria-hidden>⚡</span> merging deploys it
                </span>
              )}
            </p>
            <ul className="mt-0.5 list-disc pl-4 text-muted-foreground">
              {hold.needs.map((need) => {
                const milestone = need.kind === "milestone" ? view.milestones.find((each) => each.ref === need.target) : undefined;
                const why = milestone === undefined ? null : milestoneStatus(milestone).why;
                return (
                  <li key={need.target} className="[overflow-wrap:anywhere]">
                    <b className={`font-medium text-foreground ${need.kind === "milestone" ? "font-mono text-[11px]" : ""}`}>{need.target}</b>
                    {need.kind === "milestone" ? ` does not hold${why === null ? "" : `: ${why}`}` : " is not live yet"}
                    {hold.kind === "waits" && milestone !== undefined && <span className="block text-[11px]">{milestone.title}</span>}
                  </li>
                );
              })}
              {hold.stage !== null && (
                <li>
                  <b className="font-medium text-foreground">{stageLabel(hold.stage.name)}</b> {hold.stage.live && hold.stage.soakedAt !== null ? `soaks until ${whenLabel(hold.stage.soakedAt, now)}` : "is not all live yet"}, and {hold.step.key} is in {stageLabel(stage?.name ?? null)}
                </li>
              )}
              {hold.windows.map((window) => (
                <li key={`${window.title}-${window.from}`}>
                  <b className="font-medium text-foreground">{windowName(window)}</b> {window.active ? `is on until ${dayLabel(window.to)}` : `starts in ${plural(window.startsIn!, "day")} (${dayLabel(window.from)})`}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

const BANDS = ["bg-warning/15 text-warning-text", "bg-destructive/15 text-destructive-text", "border border-dashed border-warning/45 bg-warning/5 text-warning-text"];

function Calendar({ view, earliest, now }: { view: RolloutView; earliest: Earliest[]; now: number }) {
  const today = new Date(now);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - DAY_MS;
  const ahead = view.windows.filter((window) => !window.past);
  const forecast = earliest.filter((each): each is Earliest & { at: number } => each.at !== null && each.at > now);
  const end = Math.max(start + 14 * DAY_MS, ...ahead.map((window) => utcDay(window.to) + DAY_MS), ...forecast.map((each) => each.at + DAY_MS)) + 3 * DAY_MS;
  const x = (at: number) => `${(((Math.min(Math.max(at, start), end) - start) / (end - start)) * 100).toFixed(2)}%`;
  const span = (from: number, to: number) => `${(((Math.min(to, end) - Math.max(from, start)) / (end - start)) * 100).toFixed(2)}%`;
  const step = end - start > 84 * DAY_MS ? 28 : end - start > 42 * DAY_MS ? 14 : 7;
  const ticks: number[] = [];
  const first = new Date(start);
  // A tick in the last stretch of the axis would have its label cut off at the edge.
  for (let at = start + ((8 - first.getUTCDay()) % 7 || 7) * DAY_MS; at < end - (end - start) * 0.08; at += step * DAY_MS) ticks.push(at);
  const soon = byUrgency(ahead)[0];
  const gated = earliest.find((each) => each.at === null);
  return (
    <section data-rollout-calendar aria-label="Calendar" className="mt-4">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h3 className={HEADING}>Calendar</h3>
        {soon !== undefined && (
          <span className="text-muted-foreground [overflow-wrap:anywhere]">
            {soon.active ? (
              <b className="font-semibold text-destructive-text">The {windowName(soon)} is on now, until {dayLabel(soon.to)}</b>
            ) : (
              <>
                <b className="font-semibold text-foreground">{plural(soon.startsIn!, "day")}</b> until the {windowName(soon)} on {dayLabel(soon.from)}
              </>
            )}
            {soon.title.includes(":") && `: ${soon.title.slice(soon.title.indexOf(":") + 1).trim()}`}
          </span>
        )}
      </div>
      <div aria-hidden className="relative mt-1.5 h-[46px]">
        <div className="absolute inset-x-0 top-[30px] border-t border-border-seam" />
        {ticks.map((at) => (
          <span key={at} className="absolute top-[30px] h-4 border-l border-border-seam pt-0.5 pl-0.5 text-[10px] whitespace-nowrap text-subtle-foreground" style={{ left: x(at) }}>
            {utcDateLabel(at)}
          </span>
        ))}
        {ahead.map((window, index) => (
          <span
            key={`${window.title}-${window.from}`}
            data-rollout-window={window.title}
            title={`${window.title}: ${dayLabel(window.from)} to ${dayLabel(window.to)}${window.note === null ? "" : `. ${window.note}`}`}
            className={`absolute top-1.5 h-[22px] truncate rounded px-1.5 text-[10.5px] leading-[22px] ${BANDS[index % BANDS.length]}`}
            style={{ left: x(utcDay(window.from)), width: span(utcDay(window.from), utcDay(window.to) + DAY_MS) }}
          >
            {windowName(window)}
          </span>
        ))}
        {forecast.map((each) => (
          <span key={each.stage.name} title={`${stageLabel(each.stage.name)} done, at the earliest: ${whenLabel(each.at, now)}`} className="absolute top-[25px] -ml-[5px] size-[11px] rounded-full border-2 border-primary bg-background" style={{ left: x(each.at) }} />
        ))}
        <span className="absolute top-0 h-[46px] border-l-2 border-primary" style={{ left: x(now) }}>
          <span className="absolute -top-px left-1 text-[10.5px] font-semibold whitespace-nowrap text-primary">Today</span>
        </span>
      </div>
      <p className="mt-1 flex flex-wrap gap-x-3.5 gap-y-0.5 text-[11px] text-muted-foreground">
        {forecast.map((each) => (
          <span key={each.stage.name}>
            <span aria-hidden className="mr-1 inline-block size-[9px] rounded-full border-2 border-primary align-[-1px]" />
            {stageLabel(each.stage.name)} done, earliest {dateLabel(each.at)}
          </span>
        ))}
        {gated !== undefined && (
          <span className="[overflow-wrap:anywhere]">
            <span aria-hidden className="mr-1 text-destructive-text">
              ◆
            </span>
            {stageLabel(gated.stage.name)} waits for <span className="font-mono [overflow-wrap:anywhere]">{listText(gated.waitsFor)}</span>
          </span>
        )}
      </p>
      <ul aria-label="Windows" className="mt-1 text-[11px] text-muted-foreground @3xl/rollout:pointer-fine:sr-only">
        {view.windows.map((window) => (
          <li key={`${window.title}-${window.from}`} data-rollout-window-row={window.title} className={`[overflow-wrap:anywhere] ${window.past ? "opacity-60" : ""}`}>
            <b className="font-medium text-foreground">{window.title}</b> · {dayLabel(window.from)} to {dayLabel(window.to)} · {window.active ? "on now" : window.past ? "over" : `in ${plural(window.startsIn!, "day")}`}
            {window.note !== null && `. ${window.note}`}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RepoLegend({ view }: { view: RolloutView }) {
  const repos = repoDeploys(view);
  if (repos.length === 0) return null;
  return (
    <section data-rollout-repos aria-label="How each repo deploys" className="mt-4">
      <h3 className={HEADING}>How each repo deploys</h3>
      <dl className="mt-1.5 grid grid-cols-[minmax(0,max-content)_max-content_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-1 text-[11.5px] @max-xl/loom:grid-cols-[minmax(0,max-content)_minmax(0,1fr)]">
        {repos.map((entry) => (
          <div key={entry.repo ?? "project"} className="contents">
            <dt className="justify-self-start">{entry.repo === null ? <span className="text-muted-foreground">project</span> : <RepoChip name={entry.repo} />}</dt>
            <dd className="font-semibold">
              {entry.onMerge ? (
                <span className="text-warning-text">
                  <span aria-hidden>⚡ </span>on merge
                </span>
              ) : (
                "after merge"
              )}
            </dd>
            <dd className="text-muted-foreground [overflow-wrap:anywhere] @max-xl/loom:col-span-2 @max-xl/loom:mb-1">{entry.how}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function RolloutTab({ slug, rollout, mergeOrder = null, now, onTicket }: { slug: string; rollout: RolloutView | null; mergeOrder?: MergeOrderView | null; now: number; onTicket(key: string): void }) {
  if (rollout === null) return <p className="p-4 text-sm text-muted-foreground">The rollout shows the project as it is now. Go back to now to read it.</p>;
  return <RolloutBody slug={slug} view={rollout} mergeOrder={mergeOrder} now={now} onTicket={onTicket} />;
}

function RolloutBody({ slug, view, mergeOrder, now, onTicket }: { slug: string; view: RolloutView; mergeOrder: MergeOrderView | null; now: number; onTicket(key: string): void }) {
  const navigate = useBbNavigate();
  const send = useLoomWrite("markLive");
  const { busy, act } = useAction();
  const hoverOn = useStored(rolloutHover);
  const showAll = useStored(rolloutLinks);
  const [opened, setOpen] = useState<string | null>(null);
  const [hovered, setHover] = useState<string | null>(null);
  // A step or milestone the view no longer has, cancelled for one, keeps no focus.
  const known = new Set([...view.stages.flatMap((stage) => stage.steps.map((step) => step.key)), ...view.milestones.map((milestone) => milestone.ref)]);
  const open = opened !== null && known.has(opened) ? opened : null;
  const hover = hovered !== null && known.has(hovered) ? hovered : null;
  const focusKey = open ?? (hoverOn ? hover : null);
  // One chain object per focus, so the links are measured again only when the focus or the view changes.
  const chain = useMemo<Chain | null>(() => (focusKey === null ? null : { key: focusKey, ...chainOf(view, focusKey) }), [view, focusKey]);
  const merges = new Map((mergeOrder?.entries ?? []).map((entry) => [entry.key, entry]));
  const actions: Actions = {
    now,
    busy,
    onOpen: (url) => navigate.openUrl(url),
    onTicket,
    onMark: (target, undo) => void act(() => send({ slug, target, ...(undo ? { undo: true } : {}), confirm: true }), undo ? `${target} is no longer marked live` : `Marked ${target} live`),
  };
  const { columns, others } = columnsOf(view);
  const earliest = earliestOf(view, now);
  const holds = holdsOf(view);
  const focus: Focus = {
    open,
    chain,
    onToggle: (key) => setOpen(open === key ? null : key),
    onHover: (key) => setHover(key),
  };
  const steps = view.stages.flatMap((stage) => stage.steps);
  const named = columns.filter((column) => column.stage.name !== null);
  const current = named.findIndex((column) => column.stage.steps.some((step) => step.live === null));
  return (
    <div data-rollout className="@container/rollout px-4 pt-3.5 pb-5 text-xs @max-xl/loom:px-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 className="text-sm font-semibold">Rollout</h2>
        <span data-rollout-summary className="text-muted-foreground">
          {view.counts.live === view.counts.steps ? `All ${plural(view.counts.steps, "step")} live` : `${view.counts.live} of ${plural(view.counts.steps, "step")} live`}
          {current >= 0 && ` · stage ${current + 1} of ${named.length}, ${stageLabel(named[current]!.stage.name)}`}
        </span>
        <span data-rollout-advice className="ml-auto text-[11px] text-subtle-foreground @max-xl/loom:ml-0 @max-xl/loom:basis-full">
          Advice only: Loom blocks no merge or deploy
        </span>
      </div>
      <div className={`mt-3 grid gap-3 ${holds.length > 0 ? "@3xl/rollout:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]" : ""}`}>
        <NextCard view={view} merges={merges} earliest={earliest} {...actions} />
        {holds.length > 0 && <HoldCard view={view} holds={holds} now={now} onOpen={actions.onOpen} />}
      </div>
      {view.windows.length > 0 && <Calendar view={view} earliest={earliest} now={now} />}
      {columns.length > 0 && (
        <section aria-label="Deploy order" className="mt-4">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h3 className={HEADING}>Deploy order</h3>
            <span className="text-[11px] text-subtle-foreground [overflow-wrap:anywhere]">
              Stages go in order, and steps above a "then" line go first. {hoverOn && <span className="pointer-coarse:hidden">Hover a step to see what it needs and what waits on it. </span>}Open one for how to deploy, verify and roll back.
            </span>
            <span className="ml-auto flex flex-wrap gap-x-3 gap-y-1 @max-xl/loom:ml-0">
              <Switch
                on={hoverOn}
                className="pointer-coarse:hidden"
                label="Highlight on hover"
                onChange={(next) => {
                  setHover(null);
                  rolloutHover.set(next);
                }}
              />
              <Switch on={showAll} label="Show every link" onChange={(next) => rolloutLinks.set(next)} />
            </span>
          </div>
          <DeployOrder view={view} columns={columns} earliest={earliest} merges={merges} focus={focus} showAll={showAll} {...actions} />
        </section>
      )}
      {others.length > 0 && (
        <section data-rollout-others aria-label="Other milestones" className="mt-4">
          <h3 className={HEADING}>Other milestones</h3>
          <div className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(min(17rem,100%),1fr))] items-start gap-x-2">
            {others.map((milestone) => (
              <MilestoneTile key={milestone.ref} milestone={milestone} focus={focus} {...actions} />
            ))}
          </div>
        </section>
      )}
      {steps.length > 0 && <RepoLegend view={view} />}
    </div>
  );
}
