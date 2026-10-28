import type { ControlAction, NextStep, RepoOverview } from "../contract";
import { isMultiRepoProject } from "../format";
import { STAGES } from "../next-step";
import { BUTTON, ConfirmButton, listText, plural } from "./common";
import { labelOf } from "./spec-review-kit";

const STAGE_TONES = { done: "text-muted-foreground", current: "font-semibold text-foreground", todo: "text-subtle-foreground" } as const;

/**
 * The land buttons of a multi-repo project. land and landDirect name no repo, so the engine lands every repo with a done ticket, landed before or not,
 * and `names` lists each of them for the confirm. `label` is null when no repo has new work, so the caller keeps its own. Null on a single-repo project.
 */
export function repoLand(repos: readonly RepoOverview[]): { names: string[]; label: string | null; confirm: string } | null {
  if (!isMultiRepoProject({ repos })) return null;
  // A repo has a done ticket exactly when it has work to land or was landed: done is final, and only a repo with a done ticket lands.
  const names = repos.flatMap((repo) => (repo.toLand || repo.landedAt !== null ? [repo.name!] : []));
  if (names.length === 0) return null;
  return { names, label: repos.some((repo) => repo.toLand) ? "Land · open the pull requests" : null, confirm: `Click again to land ${listText(names)}` };
}

/** The settings a skipped spec review changed, behind a disclosure, each as the Spec tab names it, such as "web › forge › kind". */
export function SettingPaths({ paths, repos }: { paths: readonly string[]; repos: readonly string[] }) {
  return (
    <details data-setting-paths className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer">The {plural(paths.length, "setting")} it changes</summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-[11px] [overflow-wrap:anywhere]">
        {paths.map((path) => (
          <li key={path} data-setting-path={path} title={path}>
            {labelOf(path, repos)}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The stages with the current one marked, one sentence on what happens next, and at most one button, which goes under the
 * text when the bar is too narrow for both. `repos` gives a multi-repo land its own label and names the settings of a skipped review.
 */
export function NextStepBar({ next, busy, onAct, onReviewChanges, repos = [] }: { next: NextStep; busy: boolean; onAct(action: ControlAction, version?: number): void; onReviewChanges?: () => void; repos?: readonly RepoOverview[] }) {
  const warning = next.tone === "warning";
  const land = next.action?.control === "land" ? repoLand(repos) : null;
  const action = next.action === null || land === null ? next.action : { ...next.action, label: land.label ?? next.action.label, confirm: land.confirm };
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
        <div data-next-text className={`min-w-[min(100%,18rem)] flex-1 text-sm [overflow-wrap:anywhere] ${warning ? "text-warning-text" : ""}`}>
          <p>
            <b>{next.title}</b> {next.text}
          </p>
          {next.paths !== undefined && next.paths.length > 0 && <SettingPaths paths={next.paths} repos={repos.flatMap((repo) => (repo.name === null ? [] : [repo.name]))} />}
        </div>
        {action?.control === "land" && onReviewChanges !== undefined && (
          <button type="button" className={BUTTON} onClick={onReviewChanges}>
            Review changes
          </button>
        )}
        {action !== null && <ConfirmButton key={action.label} primary label={action.label} confirmLabel={action.confirm} disabled={busy} onConfirm={() => onAct(action.control, action.version)} />}
      </div>
    </section>
  );
}
