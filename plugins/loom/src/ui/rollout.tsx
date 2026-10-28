import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { RolloutCheckResult, RolloutLive, RolloutMilestone, RolloutRequirement, RolloutStage, RolloutStep, RolloutView, RolloutWindow } from "../contract";
import { ConfirmButton, HEADING, RepoChip, listText, momentLabel, plural, useAction, useLoomWrite } from "./common";
import { CHIP, CHIP_TONES, PR_LINK, TONES, type Tone } from "./merge-order";

// The deploy order of a pull request project: the next safe step, warnings, the stages with one row per step, the
// milestones and the windows. It is advice for the human; the Mark live buttons record what is live and move nothing.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const BY: Record<RolloutLive["by"], string> = { merge: "merged", verify: "verify passed", check: "check passed", human: "marked by you" };

function Chip({ tone, text, title, data }: { tone: Tone; text: string; title?: string; data?: Record<string, string> }) {
  return (
    <span title={title} className={`${CHIP} ${CHIP_TONES[tone]}`} {...data}>
      {text}
    </span>
  );
}

function mergeChip(step: RolloutStep): { tone: Tone; text: string } {
  switch (step.merge) {
    case "merged":
      return { tone: "good", text: "merged" };
    case "approved":
      return { tone: "good", text: "approved" };
    case "open":
      return { tone: "muted", text: "open" };
    case "no_pr":
      return { tone: "muted", text: "no pull request" };
  }
}

function liveChip(step: RolloutStep, now: number): { tone: Tone; text: string; title?: string } {
  if (step.live === null) return { tone: step.merge === "merged" ? "warn" : "muted", text: "not live" };
  const by = `${BY[step.live.by]}, ${momentLabel(step.live.at)}`;
  if (!step.soaked && step.soakedAt !== null && step.soakedAt > now) return { tone: "good", text: `live · soaking until ${momentLabel(step.soakedAt)}`, title: by };
  return { tone: "good", text: step.soaked && step.soakedAt !== step.live.at ? "live · soaked" : "live", title: by };
}

function needChip(need: RolloutRequirement): { tone: Tone; text: string; title: string } {
  const what = need.title === null ? need.target : `${need.target}: ${need.title}`;
  if (need.cancelled) return { tone: "muted", text: `${need.target} cancelled`, title: `${what}. Cancelled, so it holds nothing back.` };
  if (need.unknown) return { tone: "muted", text: `${need.target} ?`, title: `${need.target} is no longer in the spec.` };
  const word = need.kind === "milestone" ? (need.live ? "holds" : "does not hold") : need.live ? "live" : "not live";
  return { tone: need.live ? "good" : "warn", text: `${need.live ? "✓" : "◌"} ${need.target}`, title: `${what}: ${word}${need.viaStage ? ". It gates the stage." : "."}${need.how === null ? "" : ` Deploys: ${need.how}`}` };
}

function checkLabel(check: RolloutCheckResult): { tone: Tone; text: string } {
  if (check.exitCode === 0) return { tone: "good", text: `passed ${momentLabel(check.at)}` };
  if (check.exitCode === null) return { tone: "bad", text: `did not finish ${momentLabel(check.at)}` };
  return { tone: "warn", text: `exited ${check.exitCode} ${momentLabel(check.at)}` };
}

/** The command's last run, with its output behind a disclosure. */
function LastCheck({ command, check, label }: { command: string; check: RolloutCheckResult | null; label: string }) {
  const result = check === null ? null : checkLabel(check);
  return (
    <div data-rollout-check className="text-[11.5px] text-muted-foreground">
      {label} <code className="font-mono text-foreground [overflow-wrap:anywhere]">{command}</code>
      {result === null ? <span> · not run yet; Loom runs it every 15 minutes</span> : <span className={TONES[result.tone]}> · {result.text}</span>}
      {check !== null && check.output !== "" && (
        <details className="mt-0.5">
          <summary className="cursor-pointer text-subtle-foreground">Output</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface-recessed p-2 font-mono text-[11px] whitespace-pre-wrap">{check.output}</pre>
        </details>
      )}
    </div>
  );
}

interface Mark {
  busy: boolean;
  onMark(target: string, undo: boolean): void;
}

function MarkButton({ target, live, busy, onMark }: { target: string; live: boolean } & Mark) {
  return live ? (
    <ConfirmButton label="Undo live" confirmLabel={`Click again to undo ${target}'s live mark`} disabled={busy} onConfirm={() => onMark(target, true)} />
  ) : (
    <ConfirmButton label="Mark live" confirmLabel={`Click again to mark ${target} live`} disabled={busy} onConfirm={() => onMark(target, false)} />
  );
}

function StepRow({ step, now, onTicket, onOpen, ...mark }: { step: RolloutStep; now: number; onTicket(key: string): void; onOpen(url: string): void } & Mark) {
  const merge = mergeChip(step);
  const live = liveChip(step, now);
  return (
    <div data-rollout-row={step.key} className="flex flex-col gap-1 border-b border-border-seam px-1.5 py-2 text-xs hover:bg-state-hover">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <button type="button" onClick={() => onTicket(step.key)} className="cursor-pointer font-semibold hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {step.key}
        </button>
        {step.repo !== null && <RepoChip name={step.repo} />}
        {step.prUrl !== null && (
          <button type="button" aria-label={`Open ${step.key}'s pull request`} className={PR_LINK} onClick={() => onOpen(step.prUrl!)}>
            #{step.prNumber ?? "PR"}
          </button>
        )}
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{step.title}</span>
        <Chip tone={merge.tone} text={merge.text} data={{ "data-rollout-merge": step.merge }} />
        <Chip tone={live.tone} text={live.text} title={live.title} data={{ "data-rollout-live": step.live === null ? "no" : step.live.by }} />
        {step.dark && <Chip tone="muted" text="dark" title="Ships with its gate off" />}
        <MarkButton target={step.key} live={step.live !== null} {...mark} />
      </div>
      <p className="text-[11.5px] text-muted-foreground">
        {step.onMerge ? <b className="font-medium text-foreground">Deploys on merge</b> : <span>Deploys</span>}
        {step.how === null ? (step.onMerge ? "." : " the way its repo does.") : `: ${step.how}`}
        {step.release !== null && ` Release ${step.release}${step.releaseWith.length === 0 ? "" : ` with ${listText(step.releaseWith)}`}.`}
        {step.liveConsumers.length > 0 && <span className={TONES.warn}> Rolling it back now breaks {listText(step.liveConsumers)}, which {step.liveConsumers.length === 1 ? "is" : "are"} live.</span>}
      </p>
      {step.requires.length > 0 && (
        <p className="flex flex-wrap items-baseline gap-1 text-[11.5px] text-muted-foreground">
          Needs live first
          {step.requires.map((need) => {
            const chip = needChip(need);
            return <Chip key={need.target} tone={chip.tone} text={chip.text} title={chip.title} data={{ "data-rollout-need": need.target }} />;
          })}
        </p>
      )}
      {step.verify !== null && <LastCheck command={step.verify} check={step.lastCheck} label="Verify" />}
      {step.rollback !== null && <p className="text-[11.5px] text-muted-foreground">Rollback: {step.rollback}</p>}
    </div>
  );
}

function StageSection({ stage, now, ...rest }: { stage: RolloutStage; now: number; onTicket(key: string): void; onOpen(url: string): void } & Mark) {
  const live = stage.steps.filter((step) => step.live !== null).length;
  const soaking = stage.live && !stage.soaked && stage.soakedAt !== null;
  return (
    <section data-rollout-stage={stage.name ?? "none"} aria-label={stage.name ?? "No stage"} className="mt-4">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-border-seam pb-1">
        <h3 className={HEADING}>{stage.name ?? "No stage"}</h3>
        {stage.goal !== null && <span className="text-[11.5px] text-muted-foreground">{stage.goal}</span>}
        {stage.soak !== null && <Chip tone="muted" text={`soak ${stage.soak}`} />}
        {stage.milestones.map((milestone) => (
          <Chip key={milestone.ref} tone={milestone.live === null ? "warn" : "good"} text={`${milestone.live === null ? "◌" : "✓"} ${milestone.ref}`} title={`${milestone.title}: gates this stage`} />
        ))}
        <span className="ml-auto text-[11px] text-subtle-foreground">
          {stage.steps.length === 0 ? "no steps" : `${live} of ${plural(stage.steps.length, "step")} live`}
          {soaking && ` · soaks until ${momentLabel(stage.soakedAt!)}`}
        </span>
      </div>
      {stage.steps.map((step) => (
        <StepRow key={step.key} step={step} now={now} {...rest} />
      ))}
    </section>
  );
}

function MilestoneRow({ milestone, ...mark }: { milestone: RolloutMilestone } & Mark) {
  return (
    <div data-rollout-milestone={milestone.ref} className="flex flex-col gap-1 border-b border-border-seam px-1.5 py-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <b className="font-mono font-semibold">{milestone.ref}</b>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{milestone.title}</span>
        {milestone.stage !== null && <Chip tone="muted" text={`gates ${milestone.stage}`} />}
        <Chip tone={milestone.live === null ? "warn" : "good"} text={milestone.live === null ? "does not hold" : `holds · ${BY[milestone.live.by]}`} data={{ "data-rollout-holds": milestone.live === null ? "no" : "yes" }} />
        <MarkButton target={milestone.ref} live={milestone.live !== null} {...mark} />
      </div>
      {milestone.neededBy.length > 0 && <p className="text-[11.5px] text-muted-foreground">{listText(milestone.neededBy)} {milestone.neededBy.length === 1 ? "needs" : "need"} it.</p>}
      {milestone.check === null ? <p className="text-[11.5px] text-muted-foreground">No check command: mark it live when it holds.</p> : <LastCheck command={milestone.check} check={milestone.lastCheck} label="Check" />}
    </div>
  );
}

function WindowStrip({ windows }: { windows: readonly RolloutWindow[] }) {
  return (
    <div data-rollout-windows className="mt-2 flex flex-wrap gap-2">
      {windows.map((window) => {
        const tone: Tone = window.active ? "bad" : window.startsIn !== null && window.startsIn <= 14 ? "warn" : "muted";
        const state = window.active ? "on now" : window.past ? "over" : `in ${plural(window.startsIn!, "day")}`;
        return (
          <div key={`${window.title}-${window.from}`} data-rollout-window={window.title} title={window.note ?? undefined} className={`rounded-md border px-2.5 py-1.5 text-xs ${CHIP_TONES[tone]} ${window.past ? "opacity-60" : ""}`}>
            <b className="font-semibold">{window.title}</b>
            <span className="block font-mono text-[11px]">
              {dayLabel(window.from)} – {dayLabel(window.to)} · {state}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function RolloutTab({ slug, rollout, now, onTicket }: { slug: string; rollout: RolloutView | null; now: number; onTicket(key: string): void }) {
  const navigate = useBbNavigate();
  const send = useLoomWrite("markLive");
  const { busy, act } = useAction();
  if (rollout === null) return <p className="p-4 text-sm text-muted-foreground">The rollout shows the project as it is now. Go back to now to read it.</p>;
  const onOpen = (url: string) => navigate.openUrl(url);
  const onMark = (target: string, undo: boolean) => void act(() => send({ slug, target, ...(undo ? { undo: true } : {}), confirm: true }), undo ? `${target} is no longer marked live` : `Marked ${target} live`);
  const mark = { busy, onMark };
  return (
    <div data-rollout className="px-4 pt-3.5 pb-5">
      <h2 className="text-sm font-semibold">Rollout</h2>
      <p data-rollout-next={rollout.next.kind} className="mt-0.5 max-w-[70rem] text-xs text-foreground">
        {rollout.next.text}
      </p>
      <p className="mt-0.5 text-[11px] text-subtle-foreground">Advice for you: Loom starts, reviews and opens every pull request whatever this says, and holds no merge for it.</p>
      {rollout.warnings.length > 0 && (
        <ul data-rollout-warnings className="mt-2.5 space-y-1">
          {rollout.warnings.map((warning, index) => (
            <li
              key={`${warning.kind}-${index}`}
              role="note"
              data-rollout-warning={warning.kind}
              className={`flex items-start gap-2 rounded-lg px-3 py-1.5 text-xs ${warning.tone === "warning" ? "bg-warning/10 text-warning-text shadow-[inset_3px_0_0_var(--warning)]" : "bg-primary/10 text-foreground shadow-[inset_3px_0_0_var(--primary)]"}`}
            >
              <span aria-hidden>{warning.tone === "warning" ? "⚠" : "i"}</span>
              <span>{warning.text}</span>
            </li>
          ))}
        </ul>
      )}
      {rollout.windows.length > 0 && <WindowStrip windows={rollout.windows} />}
      {rollout.stages
        .filter((stage) => stage.steps.length > 0)
        .map((stage) => (
          <StageSection key={stage.name ?? "none"} stage={stage} now={now} onTicket={onTicket} onOpen={onOpen} {...mark} />
        ))}
      {rollout.milestones.length > 0 && (
        <section data-rollout-milestones aria-label="Milestones" className="mt-4">
          <div className="border-b border-border-seam pb-1">
            <h3 className={HEADING}>Milestones</h3>
          </div>
          {rollout.milestones.map((milestone) => (
            <MilestoneRow key={milestone.ref} milestone={milestone} {...mark} />
          ))}
        </section>
      )}
    </div>
  );
}
