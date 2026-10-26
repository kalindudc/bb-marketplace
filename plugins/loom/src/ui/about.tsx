import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ProjectSummary } from "../contract";
import { isMultiRepoProject } from "../format";
import { HEADING, RepoChip, plural } from "./common";

const LINK = "cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** "infra-central#28600" for an issue or pull request URL, as people write them. */
export function linkLabel(url: string): string {
  const match = /\/([^/\s]+)\/(?:-\/)?(?:issues|pull|pulls|merge_requests)\/(\d+)/u.exec(url);
  return match === null ? url : `${match[1]}#${match[2]}`;
}

/** The project's summary, what done means, and the way to its full goal and its planner, under the page's header. */
export function AboutStrip({ overview, onGoal }: { overview: ProjectSummary; onGoal(): void }) {
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  const { about } = overview;
  // A version waiting for approval that writes or rewrites the summary shows it here, so it can be read before approving.
  const proposed = overview.aboutPending !== null && overview.aboutPending.summary !== null && overview.aboutPending.summary !== about.summary ? overview.aboutPending : null;
  const summary = about.summary ?? proposed?.summary ?? null;
  const doneWhen = about.doneWhen.length > 0 || proposed === null ? about.doneWhen : proposed.doneWhen;
  const repos = isMultiRepoProject(overview) ? overview.repos.flatMap((repo) => (repo.name === null ? [] : [repo.name])) : [];
  return (
    <section data-about aria-label="About this project" className="mx-4 mt-3 rounded-lg border border-border-seam bg-card px-3 py-2">
      <div className="flex items-baseline gap-3">
        <h2 className={HEADING}>About</h2>
        <p data-about-summary className={`min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere] ${summary === null ? "line-clamp-2" : ""}`}>
          {summary ?? about.lead}
        </p>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        {about.links.map((url) => (
          <button key={url} type="button" data-about-link className={`${LINK} font-mono text-[11px]`} onClick={() => navigate.openUrl(url)}>
            {linkLabel(url)} <span aria-hidden>↗</span>
          </button>
        ))}
        {repos.map((name) => (
          <RepoChip key={name} name={name} />
        ))}
        {doneWhen.length > 0 && (
          <button type="button" aria-expanded={open} className={LINK} onClick={() => setOpen((before) => !before)}>
            Done when ({doneWhen.length}) <span aria-hidden>{open ? "▾" : "▸"}</span>
          </button>
        )}
        <button type="button" className={LINK} onClick={onGoal}>
          Full goal
        </button>
        {about.nonGoals > 0 && <span className="text-subtle-foreground">{plural(about.nonGoals, "non-goal")}</span>}
        {overview.plannerThreadId !== null && (
          <button type="button" className={LINK} onClick={() => navigate.toThread(overview.plannerThreadId!)}>
            Planner thread
          </button>
        )}
      </div>
      {open && (
        <ul data-about-done className="mt-2 mb-0.5 list-disc pl-5 text-[12.5px]">
          {doneWhen.map((line) => (
            <li key={line} className="my-0.5">
              {line}
            </li>
          ))}
        </ul>
      )}
      {proposed !== null && (
        <p data-about-pending={proposed.version} className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[11.5px] text-primary">
          <span>
            {about.summary === null
              ? `From v${proposed.version}, which waits for your approval; the version in force has no summary.`
              : `v${proposed.version}, which waits for your approval, changes the summary to: ${proposed.summary}`}
          </span>
          <button type="button" className={LINK} onClick={onGoal}>
            Review v{proposed.version}
          </button>
        </p>
      )}
      {summary === null && <p className="mt-1.5 text-[11.5px] text-warning-text">This spec has no summary, so this is the goal's first paragraph. The planner's next revision of the spec has to add one.</p>}
    </section>
  );
}
