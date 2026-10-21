import { useId, useState } from "react";
import { experimental_NewThreadComposer as NewThreadComposer, useRpc, type NewThreadRequest } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import { MERGE_CHOICES, type MergeChoice } from "../states";
import { BUTTON, CARD, FIELD, HEADING, messageOf } from "./common";
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

/** bb's own new-thread composer, whose submit starts a Loom planner with the answers given up front. */
export function NewProject({ go }: { go(subPath: string): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const reviewerId = useId();
  const [merge, setMerge] = useState<MergeChoice>("ask");
  const [reviewer, setReviewer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [projectId] = useState(savedProjectId);

  // Not async: the composer keeps the draft only when the promise it gets rejects, and an async wrapper would leave a second rejection that nothing handles.
  const submit = (request: NewThreadRequest) => {
    setError(null);
    const attempt = rpc.call("startPlanning", { request, merge, reviewer, confirm: true }).then(
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

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[1.3fr_1fr]">
      <div className="grid content-start gap-3">
        <h2 className="text-sm font-semibold">What should exist when the project is done?</h2>
        <NewThreadComposer placeholder="Describe the outcome…" layout="document" defaultPermissionMode="full" onSubmit={submit} {...(projectId === null ? {} : { defaultProjectId: projectId })} />
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
          </div>
          <p className="mt-2 text-xs text-muted-foreground">These go to the planner with your goal, so it asks fewer questions. It still asks about checks, scope and anything it cannot find in the code.</p>
        </section>
      </div>
      <section className={`${CARD} content-start`}>
        <h2 className={`${HEADING} mb-3`}>What happens next</h2>
        <GuideSteps />
      </section>
    </div>
  );
}
