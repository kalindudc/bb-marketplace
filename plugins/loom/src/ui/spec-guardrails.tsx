import { useState, type ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { Spec } from "../spec";
import { BUTTON, plural } from "./common";
import { CHANGED_TAG, Commentable, DiffList, WordDiff, changeAt, kept, useReview, type ListMark } from "./spec-review-kit";

const LONG_GOAL = 700;

function Card({ id, title, count, anchor, children }: { id: string; title: string; count?: number; anchor?: string; children: ReactNode }) {
  return (
    <section data-guardrail={id} data-anchor={anchor} aria-label={title} className="min-w-0 rounded-lg border border-border-seam bg-card p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        {title}
        {count !== undefined && <span className="text-xs font-normal text-muted-foreground">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** The lines of a list, each taking a comment; removed lines struck through, added ones marked new. */
function Lines({ path, label, items, marker }: { path: string; label: string; items: readonly string[]; marker: (index: number) => ReactNode }) {
  const line = (text: string, mark: ListMark, index: number) =>
    mark === "removed" ? (
      <li data-removed className="flex gap-2 rounded-md bg-destructive-text/10 px-1.5 py-1 text-sm text-destructive-text line-through">
        {text}
      </li>
    ) : (
      <li>
        <Commentable target={{ paths: [`${path}[${index}]`], label: `${label} ${index + 1}`, kind: "text" }} className={`flex gap-2 px-1.5 py-1 text-sm ${mark === "added" ? "bg-success/15 ring-1 ring-success" : ""}`}>
          <span aria-hidden className="shrink-0 text-xs text-subtle-foreground">
            {marker(index)}
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {text}
            {mark === "added" && <span className="ml-1.5 text-[10px] font-semibold text-success">new</span>}
          </span>
        </Commentable>
      </li>
    );
  return (
    <ul className="space-y-0.5">
      <DiffList path={path} items={items} render={line} rest={(count) => <li className="px-1.5 text-[11px] text-subtle-foreground">… {count} unchanged</li>} />
    </ul>
  );
}

/** What the project is for, what it leaves out, what every reviewer checks, the planner's open questions and the raw spec. */
export function GuardrailsSection({ spec, toml, onShowAll }: { spec: Spec; toml: string; onShowAll(): void }) {
  const review = useReview();
  const { project, review: rules } = spec;
  const [whole, setWhole] = useState(false);
  const [diff, setDiff] = useState<boolean | null>(null);
  const goalChange = changeAt(review, "project.goal");
  const showDiff = goalChange?.kind === "text" && (diff ?? review.only);
  const parts = [
    { id: "goal", paths: ["project.goal", "project.name", "project.key", "project.slug"] },
    { id: "non-goals", paths: ["project.non_goals"] },
    { id: "rubric", paths: ["review.rubric"] },
    { id: "questions", paths: ["project.open_questions"] },
  ].filter((part) => kept(review, part.paths));
  const shown = new Set(parts.map((part) => part.id));
  const hidden = 4 - parts.length;

  return (
    <div className="space-y-3">
      {shown.has("goal") && (
        <Card id="goal" title="Goal" anchor="project">
          <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Commentable as="span" target={{ paths: ["project.name"], label: "Project name", kind: "text", value: project.name }} className="px-1 text-foreground">
              {project.name}
            </Commentable>
            ·
            <Commentable as="span" target={{ paths: ["project.key"], label: "Project key", kind: "text", value: project.key }} className="px-1 font-mono">
              {project.key}
            </Commentable>
            ·
            <Commentable as="span" target={{ paths: ["project.slug"], label: "Project slug", kind: "text", value: project.slug }} className="px-1 font-mono">
              {project.slug}
            </Commentable>
          </p>
          {goalChange !== undefined && <span className={`${CHANGED_TAG} mb-1 inline-block`}>rewritten</span>}
          <Commentable target={{ paths: ["project.goal"], label: "Goal", kind: "text" }} className="p-1" showWas={false}>
            {showDiff ? (
              <WordDiff before={goalChange.before} after={goalChange.after} />
            ) : (
              <div className={project.goal.length > LONG_GOAL && !whole ? "max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]" : ""}>
                <Markdown content={project.goal} className="text-sm [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap" />
              </div>
            )}
          </Commentable>
          <div className="mt-1 flex flex-wrap gap-1">
            {!showDiff && project.goal.length > LONG_GOAL && (
              <button type="button" className={BUTTON} aria-expanded={whole} onClick={() => setWhole(!whole)}>
                {whole ? "Show less" : "Read the whole goal"}
              </button>
            )}
            {goalChange?.kind === "text" && (
              <button type="button" className={BUTTON} onClick={() => setDiff(!showDiff)}>
                {showDiff ? "Show the goal as it reads now" : "Show what changed"}
              </button>
            )}
          </div>
        </Card>
      )}
      {(shown.has("non-goals") || shown.has("rubric")) && (
        <div className="grid gap-3 @3xl:grid-cols-2">
          {shown.has("non-goals") && (
            <Card id="non-goals" title="Not in this project" anchor="project.non_goals" count={project.non_goals.length}>
              {project.non_goals.length === 0 && changeAt(review, "project.non_goals") === undefined ? <p className="px-1.5 text-sm text-muted-foreground">The planner listed no non-goals.</p> : <Lines path="project.non_goals" label="Non-goal" items={project.non_goals} marker={() => "⊘"} />}
              {review.onComment !== undefined && (
                <Commentable as="span" target={{ paths: ["project.non_goals"], label: "Non-goals", kind: "text" }} className="mt-2 inline-block rounded-full border border-border-seam px-2 text-xs text-muted-foreground" showWas={false}>
                  + Suggest another non-goal
                </Commentable>
              )}
            </Card>
          )}
          {shown.has("rubric") && (
            <Card id="rubric" title="What every reviewer checks" anchor="review.rubric" count={rules.rubric.length}>
              {rules.rubric.length === 0 && changeAt(review, "review.rubric") === undefined ? (
                <Commentable target={{ paths: ["review.rubric"], label: "Reviewer rubric", kind: "text" }} className="p-1.5 text-sm text-muted-foreground">
                  No rubric: reviewers judge each ticket by its criteria.
                </Commentable>
              ) : (
                <Lines path="review.rubric" label="Rubric line" items={rules.rubric} marker={(index) => `${index + 1}.`} />
              )}
            </Card>
          )}
        </div>
      )}
      {shown.has("questions") && (
        <Card id="questions" title="Open questions" anchor="project.open_questions" count={project.open_questions.length}>
          {project.open_questions.length === 0 && changeAt(review, "project.open_questions") === undefined ? <p className="px-1.5 text-sm text-muted-foreground">The planner left no open questions.</p> : <Lines path="project.open_questions" label="Open question" items={project.open_questions} marker={() => "?"} />}
        </Card>
      )}
      {hidden > 0 && (
        <p data-hidden-line className="flex items-center gap-2 rounded-md border border-dashed border-border-seam px-3 py-2 text-xs text-muted-foreground">
          {hidden === 4 ? "Nothing here changed." : `${plural(hidden, "part")} did not change.`}
          <button type="button" className={`${BUTTON} ml-auto`} onClick={onShowAll}>
            Show {hidden === 1 ? "it" : "them"}
          </button>
        </p>
      )}
      <details data-spec-raw-details className="rounded-lg border border-border-seam bg-card px-3 py-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">Read the raw spec (TOML). Everything above comes from it.</summary>
        <pre data-spec-raw className="mt-2 max-h-96 overflow-auto rounded-md bg-surface-recessed p-3 text-xs leading-relaxed">{toml}</pre>
      </details>
    </div>
  );
}
