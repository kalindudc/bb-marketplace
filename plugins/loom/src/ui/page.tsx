import { useCallback, useState } from "react";
import { experimental_usePluginId, useBbNavigate, type ExperimentalPageTitle, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ControlAction, ProjectView } from "../contract";
import { isMultiRepoProject } from "../format";
import { readyToLand, specReviewBlocks } from "../format";
import { STAGES } from "../next-step";
import { AboutStrip } from "./about";
import { AgentsView } from "./agents";
import { Board } from "./board";
import { ChangesTab, landingFiles, useViewed } from "./changes";
import { BUTTON_PRIMARY, ConfirmButton, MoreMenu, RepoChip, StateBadge, countsLabel, listText, mergeLabel, momentLabel, plural, useAction, useLoom, useLoomWrite } from "./common";
import { Guide } from "./guide";
import { HealthStrip } from "./health";
import { Home } from "./home";
import { InsightsTab } from "./insights";
import { MergeOrderTab } from "./merge-order";
import { NewProject } from "./new-project";
import { NextStepBar, repoLand } from "./next-step-bar";
import { PlannerPage } from "./planner-page";
import { PlanningView } from "./planning";
import { useWaiting } from "./questions";
import { SpecPage, bbProjectNamesOf } from "./spec-page";
import { TicketView } from "./ticket";
import { TimelineStrip } from "./timeline-strip";

type Tab = "board" | "agents" | "insights" | "spec" | "planner" | "changes" | "merge";
const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: "board", label: "Board" },
  { tab: "agents", label: "Agents" },
  { tab: "insights", label: "Insights" },
  { tab: "spec", label: "Spec" },
  { tab: "planner", label: "Planner" },
  { tab: "changes", label: "Changes" },
  { tab: "merge", label: "Merge order" },
];

/** A project shows its changes once it has started: before that no worker has changed anything. */
const hasChangesTab = (state: ProjectView["overview"]["state"]) => state !== "draft" && state !== "ready";

interface TabBadge {
  text: string;
  label: string;
  tone: "destructive" | "warning" | "info";
}
const BADGE_TONES = { destructive: "bg-destructive text-destructive-foreground", warning: "bg-warning text-black", info: "bg-primary text-primary-foreground" };

/**
 * What waits for the human on each tab. A badge is a state, not unread news, so it stays until the thing is resolved.
 * `unviewed` counts the files of a project ready to land that the human has not marked viewed; `plannerWaiting` is bb's
 * word that the planner's thread waits on a question.
 */
export function tabBadges(view: ProjectView, unviewed: number | null = null, plannerWaiting = false): Partial<Record<Tab, TabBadge>> {
  const { overview, spec } = view;
  const badges: Partial<Record<Tab, TabBadge>> = {};
  const blocked = view.board.filter((card) => card.state === "blocked").length;
  if (blocked > 0) badges.board = { text: String(blocked), label: `${plural(blocked, "ticket")} ${blocked === 1 ? "is" : "are"} blocked`, tone: "destructive" };
  if (overview.state === "draft") badges.spec = { text: "1", label: `Draft v${spec.version} waits for your review`, tone: "warning" };
  else if (overview.state !== "archived" && overview.pendingVersion !== null) badges.spec = { text: "1", label: `Spec v${overview.pendingVersion} waits for your approval`, tone: "warning" };
  if (plannerWaiting) badges.planner = { text: "?", label: "The planner asks you a question", tone: "warning" };
  else if (view.openAsks > 0) badges.planner = { text: String(view.openAsks), label: `The planner asks you to do ${plural(view.openAsks, "thing")}`, tone: "warning" };
  if (unviewed !== null && unviewed > 0 && readyToLand(overview)) badges.changes = { text: String(unviewed), label: `${plural(unviewed, "file")} to land you have not marked viewed`, tone: "warning" };
  const order = view.mergeOrder?.counts;
  if (order !== undefined && order.wrong > 0) badges.merge = { text: String(order.wrong), label: `${plural(order.wrong, "pull request")} merged into another ticket's branch`, tone: "destructive" };
  else if (order !== undefined && order.first > 0) badges.merge = { text: String(order.first), label: `${plural(order.first, "pull request")} with nothing before ${order.first === 1 ? "it" : "them"}`, tone: "info" };
  return badges;
}

export type Route = { view: "home" } | { view: "guide" } | { view: "new" } | { view: "plan"; threadId: string } | { view: "project"; slug: string } | { view: "ticket"; slug: string; key: string };

/** The route remainder: "" is home, "_guide" the guide, "_new" New project, "_plan/<threadId>" a conversation, "<slug>" a project, "<slug>/<KEY>" a ticket. A slug never starts with "_". */
export function parseRoute(subPath: string): Route {
  const [first, second] = subPath.split("/").filter((part) => part !== "");
  if (first === undefined) return { view: "home" };
  if (first === "_guide") return { view: "guide" };
  if (first === "_new") return { view: "new" };
  if (first === "_plan") return second === undefined ? { view: "home" } : { view: "plan", threadId: second };
  return second === undefined ? { view: "project", slug: first } : { view: "ticket", slug: first, key: second };
}

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

/** The header's secondary controls: the next-step bar's action is left out here, and Archive sits in the ⋯ menu. */
function Controls({ view, busy, primary, onControl }: { view: ProjectView; busy: boolean; primary: ControlAction | null; onControl(action: ControlAction, version?: number): void }) {
  const { overview } = view;
  const live = overview.state === "running" || overview.state === "paused" || overview.state === "done";
  const landable = overview.strategy === "integration" && live && (overview.ticketCounts.done ?? 0) > 0;
  const land = repoLand(overview.repos);
  // A multi-repo project lands each repo onto its own base.
  const bases = [...new Set(overview.repos.map((repo) => repo.base))];
  const base = !isMultiRepoProject(overview) ? overview.base : bases.length === 1 ? bases[0]! : null;
  const act = (label: string, action: ControlAction, version?: number, confirm?: string) =>
    action === primary ? null : <ConfirmButton key={label} label={label} confirmLabel={confirm} disabled={busy} onConfirm={() => onControl(action, version)} />;
  return (
    <span data-controls className="ml-auto flex flex-wrap items-center gap-2">
      {overview.state === "draft" && !specReviewBlocks(view.specReview) && act("Approve", "approve")}
      {overview.state !== "draft" && overview.state !== "archived" && overview.pendingVersion !== null && !specReviewBlocks(view.specReview) && act(`Approve v${overview.pendingVersion}`, "approve", overview.pendingVersion)}
      {overview.state === "ready" && act("Start", "start")}
      {overview.state === "running" && act("Pause", "pause")}
      {overview.state === "running" && act("Pause now", "pauseNow")}
      {overview.state === "paused" && act("Resume", "resume")}
      {landable && act(land?.label ?? "Land", "land", undefined, land?.confirm)}
      {landable && act(base === null ? "Land to each repo's base" : `Land to ${base}`, "landDirect", undefined, land === null ? undefined : `Click again to land ${listText(land.names)} to ${base ?? "their bases"}`)}
      {overview.state !== "archived" && (
        <MoreMenu>
          <ConfirmButton label="Archive project" danger disabled={busy} onConfirm={() => onControl("archive")} />
        </MoreMenu>
      )}
    </span>
  );
}

/**
 * The spec page for the version waiting for the human, or the newest one. Its review panel offers Approve only when the
 * next-step bar does not carry it. Rewound, it shows the version in force then and takes no comments.
 */
function SpecTab({ view, busy, rewound, requested, onApprove }: { view: ProjectView; busy: boolean; rewound: boolean; requested: number | null; onApprove(version: number): void }) {
  const { spec, overview } = view;
  const barApproves = view.next?.action?.control === "approve";
  const waiting = specReviewBlocks(view.specReview) ? null : overview.state === "draft" ? spec.version : overview.state === "archived" ? null : spec.pendingVersion;
  const approve = rewound || barApproves || waiting === null ? null : { version: waiting, label: `Approve v${waiting}`, busy, onApprove: () => onApprove(waiting) };
  return (
    <div className="space-y-3 p-4">
      {rewound && (
        <p data-spec-rewound className="text-xs text-muted-foreground">
          At this moment, version {spec.version} was the spec in force.
        </p>
      )}
      {!rewound && spec.pendingVersion !== null && (
        <p data-spec-pending className="text-xs text-muted-foreground">
          v{spec.pendingVersion} waits for your approval; until then the project runs on v{spec.version} and its tickets stay as they are.
        </p>
      )}
      <SpecPage slug={overview.slug} version={rewound ? spec.version : (requested ?? undefined)} readOnly={rewound} bbProjectNames={bbProjectNamesOf(view)} specReview={view.specReview} approve={approve} />
    </div>
  );
}

/** In place of the next-step bar while the page is rewound: when it shows, and the way back. */
function RewindBar({ now, stage, onNow }: { now: number; stage: number | null; onNow(): void }) {
  return (
    <section data-rewind-bar aria-label="Rewound" className="space-y-2 rounded-md border border-warning bg-warning/10 px-4 py-3">
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {STAGES.map((label, index) => (
          <li key={label} data-stage={label} aria-current={index === stage ? "step" : undefined} className={index === stage ? "font-semibold text-foreground" : stage !== null && index < stage ? "text-muted-foreground" : "text-subtle-foreground"}>
            {stage !== null && index < stage ? "✓" : index + 1} {label}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-warning-text">
          <b>Rewound to {momentLabel(now)}.</b> You are seeing the project as it was then; nothing here can change it, and its controls come back at now.
        </p>
        <button type="button" className={BUTTON_PRIMARY} onClick={onNow}>
          Back to now
        </button>
      </div>
    </section>
  );
}

function ProjectPanel({ slug, tab, onTab, at, onSeek, go }: { slug: string; tab: Tab; onTab(tab: Tab): void; at: number | null; onSeek(at: number | null): void; go(subPath: string): void }) {
  const navigate = useBbNavigate();
  const remote = useLoom("project", at === null ? { slug } : { slug, at }, { keep: true });
  const send = useLoomWrite("control");
  const { busy, act } = useAction();
  const [chosenChange, setChosenChange] = useState<string | null>(null);
  // The spec version the Planner page asked to open; a tab change by the human opens the spec's own default again.
  const [specVersion, setSpecVersion] = useState<number | null>(null);
  const plannerWaiting = useWaiting(remote.data?.overview.plannerThreadId ?? "");
  const loaded = remote.data;
  const wantChanges = loaded !== undefined && at === null && loaded.at === null && hasChangesTab(loaded.overview.state) && (tab === "changes" || readyToLand(loaded.overview));
  const changes = useLoom("changes", { slug }, { keep: true, enabled: wantChanges });
  const viewed = useViewed(slug);
  const view = remote.data;
  if (view === undefined) {
    return remote.error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load {slug}: {remote.error}</p>;
  }
  const { overview } = view;
  // Either side counts: the shown view can still be the past one while the live view loads.
  const rewound = at !== null || view.at !== null;
  const changesTab = !rewound && hasChangesTab(overview.state);
  // The merge order is of the project now, so a rewound page leaves it out, as it does the changes.
  const mergeTab = changesTab && view.mergeOrder !== null;
  const shownTab = (rewound && tab === "planner") || (!changesTab && tab === "changes") || (!mergeTab && tab === "merge") ? "board" : tab;
  const landing = landingFiles(changes.data ?? null);
  const badges = rewound ? {} : tabBadges(view, landing === null ? null : viewed.unviewed(landing), plannerWaiting);
  const openChanges = (id: string | null) => {
    setChosenChange(id);
    onTab("changes");
  };
  const control = (action: ControlAction, version?: number, repo?: string) =>
    act(() => send({ slug, action, ...(version === undefined ? {} : { version }), ...(repo === undefined ? {} : { repo }), confirm: true }), controlDone(action, version, repo));

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-seam px-4 py-2.5">
        <h1 className="text-sm font-semibold">{overview.name}</h1>
        <span className="text-xs text-muted-foreground">{overview.key}</span>
        <StateBadge state={overview.state} />
        <span className="text-xs text-muted-foreground">{mergeLabel(overview)} · {countsLabel(overview.ticketCounts)}</span>
        {rewound ? (
          <span className="ml-auto">
            <StateBadge state="rewound" />
          </span>
        ) : (
          <Controls view={view} busy={busy} primary={view.next?.action?.control ?? null} onControl={(action, version) => void control(action, version)} />
        )}
      </div>
      <AboutStrip overview={overview} onGoal={() => onTab("spec")} />
      {rewound ? (
        <div className="px-4 pt-3">
          <RewindBar now={view.now} stage={view.next?.stage ?? null} onNow={() => onSeek(null)} />
        </div>
      ) : (
        view.next !== null && (
          <div className="px-4 pt-3">
            {/* On a multi-repo project "branch" opens the first repo with work to land, as pickSource reads it. */}
            <NextStepBar next={view.next} busy={busy} repos={overview.repos} onAct={(action, version) => void control(action, version)} onReviewChanges={changesTab ? () => openChanges("branch") : undefined} />
          </div>
        )
      )}
      {view.prUrl !== null && (
        <p className="border-b border-border-seam px-4 py-2 text-xs text-muted-foreground">
          Pull request <button type="button" className="underline" onClick={() => navigate.openUrl(view.prUrl!)}>{view.prUrl}</button>
        </p>
      )}
      {isMultiRepoProject(overview) && overview.repos.some((repo) => repo.prUrl !== null) && (
        <p data-repo-prs className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-seam px-4 py-2 text-xs text-muted-foreground">
          Pull requests
          {overview.repos.flatMap((repo) =>
            repo.prUrl === null
              ? []
              : [
                  <span key={repo.name} className="inline-flex min-w-0 items-center gap-1">
                    <RepoChip name={repo.name!} />
                    <button type="button" aria-label={`Open the pull request in ${repo.name}`} className="underline [overflow-wrap:anywhere]" onClick={() => navigate.openUrl(repo.prUrl!)}>
                      {repo.prUrl}
                    </button>
                  </span>,
                ],
          )}
        </p>
      )}
      {view.health !== null && <HealthStrip health={view.health} />}
      <TimelineStrip slug={slug} at={at} onSeek={onSeek} onTicket={(key) => go(`${slug}/${key}`)} />
      <div role="tablist" aria-label="Project" className="flex shrink-0 gap-1 border-b border-border-seam px-3 pt-1.5">
        {TABS.filter((entry) => (entry.tab !== "planner" || (overview.plannerThreadId !== null && !rewound)) && (entry.tab !== "changes" || changesTab) && (entry.tab !== "merge" || mergeTab)).map((entry) => {
          const badge = badges[entry.tab];
          return (
            <button
              key={entry.tab}
              type="button"
              role="tab"
              aria-selected={shownTab === entry.tab}
              aria-description={badge?.label}
              title={badge?.label}
              onClick={() => {
                setSpecVersion(null);
                onTab(entry.tab);
              }}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs ${shownTab === entry.tab ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}
            >
              {entry.label}
              {badge !== undefined && (
                <span data-tab-badge={entry.tab} aria-hidden className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold ${BADGE_TONES[badge.tone]}`}>
                  {badge.text}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {shownTab === "board" && <Board slug={slug} cards={view.board} strategy={overview.strategy} now={view.now} draftVersion={overview.state === "draft" ? view.spec.version : null} onChanges={changesTab ? openChanges : undefined} />}
        {shownTab === "agents" && <AgentsView agents={view.agents} byRole={view.metrics.tokens.byRole} unreported={view.metrics.tokens.unreported} now={view.now} />}
        {shownTab === "insights" && <InsightsTab slug={slug} at={at} onTicket={(key) => go(`${slug}/${key}`)} />}
        {shownTab === "spec" && <SpecTab view={view} busy={busy} rewound={rewound} requested={specVersion} onApprove={(version) => void control("approve", version)} />}
        {shownTab === "planner" && overview.plannerThreadId !== null && (
          <PlannerPage
            threadId={overview.plannerThreadId}
            project={view}
            busy={busy}
            onControl={(action, version) => void control(action, version)}
            onSpec={(version) => {
              setSpecVersion(version);
              onTab("spec");
            }}
            onTicket={(key) => go(`${slug}/${key}`)}
          />
        )}
        {shownTab === "merge" && <MergeOrderTab order={view.mergeOrder} onTicket={(key) => go(`${slug}/${key}`)} />}
        {shownTab === "changes" && (
          <ChangesTab changes={changes.data ?? null} error={changes.error} view={view} busy={busy} chosen={chosenChange} onChoose={setChosenChange} onControl={(action, repo) => void control(action, undefined, repo)} onReload={changes.reload} />
        )}
      </div>
    </div>
  );
}

export function LoomPage({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const navigate = useBbNavigate();
  const go = useCallback((next: string) => navigate.toPluginPanel("loom", { subPath: next }), [navigate]);
  // The tab belongs to the project it was chosen in, so opening another project starts on the board.
  const [chosen, setChosen] = useState<{ slug: string | null; tab: Tab }>({ slug: null, tab: "board" });
  const slug = route.view === "project" || route.view === "ticket" ? route.slug : null;
  const tab = chosen.slug === slug ? chosen.tab : "board";
  // A planning conversation that proposed is its project's Planner tab from then on; the redirect replaces the
  // conversation's address, so Back does not land on it and bounce forward again.
  const openPlanner = useCallback(
    (next: string) => {
      setChosen({ slug: next, tab: "planner" });
      navigate.toPluginPanel("loom", { subPath: next, replace: true });
    },
    [navigate],
  );
  // The ticket route reads the rewind too, so it lives here, with the project it belongs to.
  const [rewind, setRewind] = useState<{ slug: string; at: number } | null>(null);
  const at = rewind !== null && rewind.slug === slug ? rewind.at : null;
  const seek = (next: number | null) => setRewind(next === null || slug === null ? null : { slug, at: next });

  return (
    <section data-loom-page className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground">
      <div data-loom-scroll className="min-h-0 flex-1 overflow-y-auto">
        {route.view === "home" && <Home go={go} />}
        {route.view === "guide" && <Guide onStart={() => go("_new")} />}
        {route.view === "new" && <NewProject go={go} />}
        {route.view === "plan" && <PlanningView threadId={route.threadId} openProject={openPlanner} />}
        {route.view === "project" && <ProjectPanel key={route.slug} slug={route.slug} tab={tab} onTab={(next) => setChosen({ slug: route.slug, tab: next })} at={at} onSeek={seek} go={go} />}
        {route.view === "ticket" && <TicketView ticketKey={route.key} at={at} onNow={() => seek(null)} />}
      </div>
    </section>
  );
}

/** bb's title bar on the Loom page: where the page is, with a ticket's project linking back to it. Home keeps bb's own "Loom". */
export function useLoomPageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const pluginId = experimental_usePluginId();
  const route = parseRoute(subPath);
  const slug = route.view === "project" || route.view === "ticket" ? route.slug : null;
  // The sidebar's reads of home and of the conversation, so the names cost no read of their own, even on a ticket, whose page reads no project.
  const name = useLoom("home", null, { enabled: slug !== null }).data?.projects.find((project) => project.slug === slug)?.name ?? slug ?? "";
  const conversation = useLoom("planningSession", { threadId: route.view === "plan" ? route.threadId : "" }, { enabled: route.view === "plan" }).data?.title;
  switch (route.view) {
    case "home":
      return null;
    case "guide":
      return { title: "How Loom works" };
    case "new":
      return { title: "New project" };
    case "plan":
      return conversation === undefined ? { title: "Planning" } : { breadcrumbs: [{ label: "Planning" }, { label: conversation }] };
    case "project":
      return { title: name };
    case "ticket":
      return { breadcrumbs: [{ label: name, to: `/plugins/${encodeURIComponent(pluginId)}/loom/${encodeURIComponent(route.slug)}` }, { label: route.key }] };
  }
}
