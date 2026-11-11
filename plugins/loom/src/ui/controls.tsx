// A project's controls, worked out once for the title bar, the project line, the palette and the keys: which the state
// allows (README rule 4), which one leads, and how each is confirmed (decision 2: risky ones arm in place, reversible
// ones take one click). Every one runs through `useControl`, whose write goes through the rewind guard.
import type { ControlAction, ProjectView } from "../contract";
import { isMultiRepoProject, specReviewBlocks } from "../format";
import { listText, useAction, useLoomWrite } from "./common";
import { repoLand } from "./next-step-bar";

/** What a control's toast says once it went through. */
export function controlDone(action: ControlAction, version?: number, repo?: string): string {
  const where = repo === undefined ? "" : `${repo}: `;
  switch (action) {
    case "approve":
      return version === undefined ? "Spec approved" : `Approved v${version}`;
    case "start":
      return "Project started";
    case "pause":
      return "Paused: work in flight carries on, and nothing new starts";
    case "pauseNow":
      return "Paused, and its workers stopped";
    case "resume":
      return "Project resumed";
    case "land":
      return `${where}Landed: the branch is pushed and its pull request is open`;
    case "landDirect":
      return `${where}Landed on the base branch`;
    case "archive":
      return "Project archived";
  }
}

export interface ControlOffer {
  action: ControlAction;
  version?: number;
  label: string;
  /** The armed button's text; null for a reversible control, which takes one click. */
  yes: string | null;
  icon: string;
  /** What it does, for its tooltip. */
  hint: string;
  danger?: boolean;
}

/** Whether the project offers Sync pull requests: a running or paused project with a pull request per ticket and one open. */
export const canSyncPullRequests = (overview: ProjectView["overview"]) => overview.strategy === "pr" && (overview.state === "running" || overview.state === "paused") && (overview.ticketCounts.pr_open ?? 0) > 0;

/** Every control the project's state allows, in the order the title bar's menu lists them. */
export function controlsOf(view: ProjectView): ControlOffer[] {
  const { overview } = view;
  const offers: ControlOffer[] = [];
  const blocks = specReviewBlocks(view.specReview);
  if (overview.state === "draft" && !blocks) offers.push({ action: "approve", label: "Approve", yes: `Yes, approve v${view.spec.version}: nothing runs until you start`, icon: "Check", hint: "Creates the draft's tickets; nothing runs until you start" });
  if (overview.state !== "draft" && overview.state !== "archived" && overview.pendingVersion !== null && !blocks) {
    const version = overview.pendingVersion;
    offers.push({ action: "approve", version, label: `Approve v${version}`, yes: `Yes, approve v${version}`, icon: "Check", hint: `Puts spec v${version} in force and tells the planner` });
  }
  if (overview.state === "ready") {
    const workers = view.health?.capacity.maxWorkers ?? null;
    offers.push({ action: "start", label: "Start", yes: workers === null ? "Yes, start the project" : `Yes, start: up to ${workers} worker${workers === 1 ? "" : "s"}`, icon: "Play", hint: "Starts paid agent work at once" });
  }
  if (overview.state === "running") {
    offers.push({ action: "pause", label: "Pause", yes: null, icon: "Pause", hint: "Workers finish their turn; nothing new starts" });
    offers.push({ action: "pauseNow", label: "Pause now", yes: null, icon: "Square", hint: "Stops running agents at once, mid-turn" });
  }
  if (overview.state === "paused") offers.push({ action: "resume", label: "Resume", yes: null, icon: "Play", hint: "Starts work again" });
  const live = overview.state === "running" || overview.state === "paused" || overview.state === "done";
  if (overview.strategy === "integration" && live && (overview.ticketCounts.done ?? 0) > 0) {
    const land = repoLand(overview.repos);
    const bases = [...new Set(overview.repos.map((repo) => repo.base))];
    const base = !isMultiRepoProject(overview) ? overview.base : bases.length === 1 ? bases[0]! : null;
    offers.push({ action: "land", label: land?.label ?? "Land", yes: land?.confirm ?? "Yes, land: push and open the pull request", icon: "GitPullRequestArrow", hint: "Pushes the integration branch and opens its pull request" });
    offers.push({ action: "landDirect", label: base === null ? "Land to each repo's base" : `Land to ${base}`, yes: land === null ? `Yes, land to ${base ?? "the base"}` : `Yes, land ${listText(land.names)} to ${base ?? "their bases"}`, icon: "GitMerge", hint: "Pushes straight onto the base branch, with no pull request" });
  }
  if (overview.state !== "archived") offers.push({ action: "archive", label: "Archive project", yes: `Yes, archive ${overview.key}`, icon: "Archive", hint: "Stops the project and moves it to Finished", danger: true });
  return offers;
}

/** The control the project line leads with: the next step's, when it has one. */
/** Which control an offer is, and on what: an armed confirmation of it disarms when this changes. */
export const offerTarget = (offer: Pick<ControlOffer, "action" | "version" | "label" | "yes">): string => JSON.stringify([offer.action, offer.version ?? null, offer.label, offer.yes]);

export function leadOf(view: ProjectView): ControlOffer | null {
  const action = view.next?.action ?? null;
  if (action === null) return null;
  const offer = controlsOf(view).find((entry) => entry.action === action.control && entry.version === action.version);
  const land = action.control === "land" ? repoLand(view.overview.repos) : null;
  return {
    action: action.control,
    ...(action.version === undefined ? {} : { version: action.version }),
    label: land?.label ?? action.label,
    yes: action.confirm === "" ? null : (land?.confirm ?? action.confirm),
    icon: offer?.icon ?? "ArrowRight",
    hint: offer?.hint ?? view.next?.title ?? "",
  };
}

/** Runs a project control: one at a time, with bb's toast saying what it did. The write goes through the rewind guard. */
export function useControl(slug: string) {
  const send = useLoomWrite("control");
  const { busy, act } = useAction();
  const run = (action: ControlAction, version?: number, repo?: string) =>
    act(() => send({ slug, action, ...(version === undefined ? {} : { version }), ...(repo === undefined ? {} : { repo }), confirm: true }), controlDone(action, version, repo));
  return { busy, run };
}
