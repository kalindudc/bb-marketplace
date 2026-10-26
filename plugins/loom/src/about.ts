// What a project is about, in the few lines the page's About strip and the home list show: the spec's summary, what
// done means, and the issues and pull requests its goal links to. A spec written before summaries were required has
// none, so its goal's first paragraph stands in.
import type { Spec } from "./spec";

export interface ProjectAbout {
  /** The spec's summary; null on a spec written before every proposal needed one. */
  summary: string | null;
  /** The goal's first paragraph, which stands in for a missing summary. */
  lead: string;
  doneWhen: string[];
  /** The issue and pull request links in the goal, in the order it names them. */
  links: string[];
  nonGoals: number;
}

const MAX_LINKS = 6;
const LINK = /https?:\/\/[^\s)<>\]"'`]+\/(?:issues|pull|pulls|merge_requests)\/\d+/gu;

/** What a version that waits for the human's approval says the project is about, when it says something else than the version in force. */
export interface PendingAbout {
  version: number;
  summary: string | null;
  doneWhen: string[];
}

export function pendingAboutOf(current: ProjectAbout, version: number, spec: Spec): PendingAbout | null {
  const next = aboutOf(spec);
  const same = next.summary === current.summary && next.doneWhen.length === current.doneWhen.length && next.doneWhen.every((line, index) => line === current.doneWhen[index]);
  return same ? null : { version, summary: next.summary, doneWhen: next.doneWhen };
}

export function aboutOf(spec: Spec): ProjectAbout {
  const { goal } = spec.project;
  return {
    summary: spec.project.summary ?? null,
    lead: goal.trim().split(/\n\s*\n/u)[0]!.trim(),
    doneWhen: spec.project.done_when ?? [],
    links: [...new Set(goal.match(LINK) ?? [])].slice(0, MAX_LINKS),
    nonGoals: spec.project.non_goals.length,
  };
}
