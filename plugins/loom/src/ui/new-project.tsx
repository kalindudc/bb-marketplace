import { memo, useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { experimental_NewThreadComposer as NewThreadComposer, useComposers, useRpc, type NewThreadRequest, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import { MAX_PLANNING_REPOS } from "../prompts";
import { MERGE_CHOICES, type MergeChoice } from "../states";
import { BUTTON, CARD, CHIP, FIELD, HEADING, messageOf, useRemote } from "./common";
import { GuideSteps } from "./guide";

const MERGE_LABELS: Record<MergeChoice, string> = { ask: "Ask me", integration: "Integration branch", pr: "PR per ticket" };
const PROJECT_KEY = "loom.newProject.projectId";

// Storage can be unavailable: then the composer starts on no project and nothing is remembered.
function savedProjectId(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function saveProjectId(projectId: string): void {
  try {
    localStorage.setItem(PROJECT_KEY, projectId);
  } catch {}
}

/** The project of the newest new-thread composer on screen, which on this page is its own; bb updates it as the human picks another. Null when bb lists none or has not resolved its project. */
function composerProjectOf(composers: readonly PluginComposerApi[]): string | null {
  for (const composer of [...composers].reverse()) {
    if (composer.scope.kind === "new-thread") return composer.scope.projectId;
  }
  return null;
}

/** bb's standard projects except `exclude`, filterable by name. A picked repo stays listed under any filter, so it can be unpicked. */
function RepoPicker({ exclude, picked, onChange }: { exclude: string | null; picked: readonly string[]; onChange(next: string[]): void }) {
  const choices = useRemote((rpc) => rpc.call("bbProjects"), "bbProjects", null);
  const [query, setQuery] = useState("");
  const offered = (choices.data ?? []).filter((choice) => choice.id !== exclude);
  const needle = query.trim().toLowerCase();
  const shown = offered.filter((choice) => picked.includes(choice.id) || choice.name.toLowerCase().includes(needle));
  const full = picked.length >= MAX_PLANNING_REPOS;
  const note = (text: string, tone = "text-muted-foreground") => <p className={`text-xs ${tone}`}>{text}</p>;

  let list: ReactNode;
  if (choices.data === null) list = choices.error === null ? note("Loading bb's projects…") : note(`Could not list bb's projects: ${choices.error}`, "text-destructive-text");
  else if (offered.length === 0) list = note("bb has no other projects.");
  else if (shown.length === 0) list = note(`No repo matches "${query.trim()}".`);
  else
    list = (
      <ul className="grid max-h-48 gap-x-4 gap-y-1 overflow-y-auto sm:grid-cols-2">
        {shown.map((choice) => {
          const checked = picked.includes(choice.id);
          return (
            <li key={choice.id} data-repo-choice={choice.id}>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={checked} disabled={!checked && full} onChange={(event) => onChange(event.target.checked ? [...picked, choice.id] : picked.filter((id) => id !== choice.id))} />
                <span className="truncate">{choice.name}</span>{" "}
                {choice.hostIds.length === 0 && (
                  <span data-no-checkout title="No machine has a checkout of this repo. The planner offers to clone it." className={`${CHIP} shrink-0 text-warning-text`}>
                    no checkout
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    );

  return (
    <div role="group" aria-label="Repos" className="grid basis-full gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span>Repos</span>
        <span className="text-xs text-muted-foreground">
          {picked.length} of up to {MAX_PLANNING_REPOS} picked, besides the composer's project
        </span>
        <input type="search" aria-label="Filter repos" placeholder="Filter by name" value={query} onChange={(event) => setQuery(event.target.value)} className={`${FIELD} ml-auto max-w-56`} />
      </div>
      {list}
    </div>
  );
}

type Submit = (request: NewThreadRequest) => Promise<void>;

// bb's composer registers a fresh API for useComposers each time it renders, and that registration re-renders NewProject: re-rendering the composer from there loops until React gives up (minified error #185).
const PlannerComposer = memo(function PlannerComposer({ projectId, onSubmit }: { projectId: string | null; onSubmit: Submit }) {
  return <NewThreadComposer placeholder="Describe the outcome…" layout="document" defaultPermissionMode="full" onSubmit={onSubmit} {...(projectId === null ? {} : { defaultProjectId: projectId })} />;
});

/** bb's own new-thread composer, whose submit starts a Loom planner with the answers given up front. */
export function NewProject({ go }: { go(subPath: string): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const reviewerId = useId();
  const [merge, setMerge] = useState<MergeChoice>("ask");
  const [reviewer, setReviewer] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [projectId] = useState(savedProjectId);
  // Until bb reports the composer's project, it is the one the composer was seeded with.
  const composerProject = composerProjectOf(useComposers()) ?? projectId;
  const picked = repos.filter((id) => id !== composerProject);

  // Not async: the composer keeps the draft only when the promise it gets rejects, and an async wrapper would leave a second rejection that nothing handles.
  const submit: Submit = (request) => {
    setError(null);
    const extra = picked.filter((id) => id !== request.projectId);
    const attempt = rpc.call("startPlanning", { request, merge, reviewer, repos: extra, confirm: true }).then(
      ({ threadId }) => {
        saveProjectId(request.projectId);
        go(`_plan/${threadId}`);
      },
      (failure: unknown) => {
        setError(messageOf(failure));
        throw failure;
      },
    );
    attempt.catch(() => {});
    return attempt;
  };
  const latestSubmit = useRef(submit);
  useLayoutEffect(() => {
    latestSubmit.current = submit;
  });
  const onSubmit = useCallback<Submit>((request) => latestSubmit.current(request), []);

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1.3fr_1fr]">
      <div className="grid content-start gap-3">
        <h2 className="text-sm font-semibold">What should exist when the project is done?</h2>
        <PlannerComposer projectId={projectId} onSubmit={onSubmit} />
        {error !== null && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
        <section className={CARD}>
          <h2 className={HEADING}>Optional: answer up front</h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <div role="group" aria-label="Merge plan" className="flex items-center gap-2">
              <span>Merge plan</span>
              <span className="flex gap-1">
                {MERGE_CHOICES.map((choice) => (
                  <button key={choice} type="button" aria-pressed={merge === choice} onClick={() => setMerge(choice)} className={`${BUTTON} ${merge === choice ? "bg-surface-selected" : ""}`}>
                    {MERGE_LABELS[choice]}
                  </button>
                ))}
              </span>
            </div>
            <div className="flex min-w-56 flex-1 items-center gap-2">
              <label htmlFor={reviewerId} className="shrink-0">Reviewer model</label>
              <input id={reviewerId} type="text" value={reviewer} maxLength={200} placeholder="for example: codex, gpt-5" onChange={(event) => setReviewer(event.target.value)} className={FIELD} />
            </div>
            <RepoPicker exclude={composerProject} picked={picked} onChange={setRepos} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">These go to the planner with your goal, so it asks fewer questions. It still asks about checks, scope and anything it cannot find in the code. The repos are a starting point: the planner can add others the work changes.</p>
        </section>
      </div>
      <section className={`${CARD} content-start`}>
        <h2 className={`${HEADING} mb-3`}>What happens next</h2>
        <GuideSteps />
      </section>
    </div>
  );
}
