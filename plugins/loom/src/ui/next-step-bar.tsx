import type { ControlAction, NextStep, RepoOverview } from "../contract";
import { isMultiRepoProject } from "../format";
import { STAGES } from "../next-step";
import { ConfirmButton, listText } from "./common";

const STAGE_TONES = { done: "text-muted-foreground", current: "font-semibold text-foreground", todo: "text-subtle-foreground" } as const;

/** The land button of a multi-repo project: it opens a pull request in each repo with merged work not landed yet, and its confirm names them. Null on a single-repo project, and when no repo has work to land. */
export function repoLand(repos: readonly RepoOverview[]): { names: string[]; label: string; confirm: string } | null {
  if (!isMultiRepoProject({ repos })) return null;
  const names = repos.flatMap((repo) => (repo.toLand ? [repo.name!] : []));
  return names.length === 0 ? null : { names, label: "Land · open the pull requests", confirm: `Click again to land ${listText(names)}` };
}

/** The stages with the current one marked, one sentence on what happens next, and at most one button. `repos` gives a multi-repo land its own label. */
export function NextStepBar({ next, busy, onAct, repos = [] }: { next: NextStep; busy: boolean; onAct(action: ControlAction, version?: number): void; repos?: readonly RepoOverview[] }) {
  const warning = next.tone === "warning";
  const land = next.action?.control === "land" ? repoLand(repos) : null;
  const action = next.action === null || land === null ? next.action : { ...next.action, label: land.label, confirm: land.confirm };
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
