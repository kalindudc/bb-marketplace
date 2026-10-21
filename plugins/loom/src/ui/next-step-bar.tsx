import type { ControlAction, NextStep } from "../contract";
import { STAGES } from "../next-step";
import { ConfirmButton } from "./common";

const STAGE_TONES = { done: "text-muted-foreground", current: "font-semibold text-foreground", todo: "text-subtle-foreground" } as const;

/** The stages with the current one marked, one sentence on what happens next, and at most one button. */
export function NextStepBar({ next, busy, onAct }: { next: NextStep; busy: boolean; onAct(action: ControlAction, version?: number): void }) {
  const warning = next.tone === "warning";
  const { action } = next;
  return (
    <section data-next-step data-tone={next.tone} aria-label="Next step" className={`space-y-2 rounded-md border px-4 py-3 ${warning ? "border-warning bg-warning/10" : "border-primary/50 bg-primary/5"}`}>
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {STAGES.map((label, index) => {
          const state = index < next.stage ? "done" : index === next.stage ? "current" : "todo";
          return (
            <li key={label} data-stage={label} data-stage-state={state} aria-current={state === "current" ? "step" : undefined} className={STAGE_TONES[state]}>
              {state === "done" ? "✓" : index + 1} {label}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <p className={`min-w-0 flex-1 text-sm ${warning ? "text-warning-text" : ""}`}>
          <b>{next.title}</b> {next.text}
        </p>
        {action !== null && <ConfirmButton key={action.label} primary label={action.label} confirmLabel={action.confirm} disabled={busy} onConfirm={() => onAct(action.control, action.version)} />}
      </div>
    </section>
  );
}
