import { useState } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ControlAction, ProjectView, rpcContract } from "../contract";
import type { ProjectMetrics } from "../metrics";
import type { WindowDays } from "../states";
import { AgentsView } from "./agents";
import { Board } from "./board";
import { ConfirmButton, HEADING, MoreMenu, StateBadge, countsLabel, mergeLabel, useRemote, useRun } from "./common";
import { Feed } from "./feed";
import { Guide } from "./guide";
import { HealthStrip } from "./health";
import { Home } from "./home";
import { MetricsView } from "./metrics-view";
import { NewProject } from "./new-project";
import { NextStepBar } from "./next-step-bar";
import { PlannerChat, PlanningView } from "./planning";
import { SpecDashboard } from "./spec-dashboard";
import { TicketView } from "./ticket";

type Tab = "board" | "agents" | "feed" | "metrics" | "spec" | "planner";
const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: "board", label: "Board" },
  { tab: "agents", label: "Agents" },
  { tab: "feed", label: "Feed" },
  { tab: "metrics", label: "Metrics" },
  { tab: "spec", label: "Spec" },
  { tab: "planner", label: "Planner" },
];

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

/** The header's secondary controls: the next-step bar's action is left out here, and Archive sits in the ⋯ menu. */
function Controls({ view, busy, primary, onControl }: { view: ProjectView; busy: boolean; primary: ControlAction | null; onControl(action: ControlAction, version?: number): void }) {
  const { overview } = view;
  const live = overview.state === "running" || overview.state === "paused" || overview.state === "done";
  const landable = overview.strategy === "integration" && live && (overview.ticketCounts.done ?? 0) > 0;
  const act = (label: string, action: ControlAction, version?: number) =>
    action === primary ? null : <ConfirmButton key={label} label={label} disabled={busy} onConfirm={() => onControl(action, version)} />;
  return (
    <span data-controls className="ml-auto flex flex-wrap items-center gap-2">
      {overview.state === "draft" && act("Approve", "approve")}
      {overview.state !== "draft" && overview.state !== "archived" && overview.pendingVersion !== null && act(`Approve v${overview.pendingVersion}`, "approve", overview.pendingVersion)}
      {overview.state === "ready" && act("Start", "start")}
      {overview.state === "running" && act("Pause", "pause")}
      {overview.state === "running" && act("Pause now", "pauseNow")}
      {overview.state === "paused" && act("Resume", "resume")}
      {landable && act("Land", "land")}
      {landable && act(`Land to ${overview.base}`, "landDirect")}
      {overview.state !== "archived" && (
        <MoreMenu>
          <ConfirmButton label="Archive project" danger disabled={busy} onConfirm={() => onControl("archive")} />
        </MoreMenu>
      )}
    </span>
  );
}

/** The dashboard, under a note on any pending version. Its Approve shows only when the next-step bar does not carry one. */
function SpecTab({ view, busy, onApprove }: { view: ProjectView; busy: boolean; onApprove(version: number): void }) {
  const { spec, overview } = view;
  const barApproves = view.next?.action?.control === "approve";
  return (
    <div className="space-y-6 p-4">
      {spec.pendingVersion !== null && (
        <section data-spec-pending>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Pending v{spec.pendingVersion}</h2>
            <span className="text-xs text-muted-foreground">waiting for approval; its tickets are unchanged</span>
            {!barApproves && <ConfirmButton label={`Approve v${spec.pendingVersion}`} disabled={busy} onConfirm={() => onApprove(spec.pendingVersion!)} />}
          </div>
        </section>
      )}
      <SpecDashboard slug={overview.slug} />
    </div>
  );
}

/** The project view carries the 14-day metrics; another window reads the metrics RPC. */
function MetricsTab({ slug, metrics }: { slug: string; metrics: ProjectMetrics }) {
  const [days, setDays] = useState<WindowDays>(14);
  return days === 14 ? <MetricsView metrics={metrics} days={days} onDays={setDays} /> : <WindowedMetrics slug={slug} days={days} onDays={setDays} />;
}

function WindowedMetrics({ slug, days, onDays }: { slug: string; days: WindowDays; onDays(days: WindowDays): void }) {
  const { data, error } = useRemote((rpc) => rpc.call("metrics", { slug, days }), `metrics:${slug}:${days}`, slug);
  if (data === null) return error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load the metrics: {error}</p>;
  return <MetricsView metrics={data} days={days} onDays={onDays} />;
}

function ProjectPanel({ slug, tab, onTab }: { slug: string; tab: Tab; onTab(tab: Tab): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const remote = useRemote((client) => client.call("project", { slug }), `project:${slug}`, slug);
  const { busy, error, run } = useRun();
  const view = remote.data;
  if (view === null) {
    return remote.error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load {slug}: {remote.error}</p>;
  }
  const { overview } = view;
  const control = (action: ControlAction, version?: number) =>
    run(async () => remote.set(await rpc.call("control", { slug, action, ...(version === undefined ? {} : { version }), confirm: true })));

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-seam px-4 py-2.5">
        <h1 className="text-sm font-semibold">{overview.name}</h1>
        <span className="text-xs text-muted-foreground">{overview.key}</span>
        <StateBadge state={overview.state} />
        <span className="text-xs text-muted-foreground">{mergeLabel(overview)} · {countsLabel(overview.ticketCounts)}</span>
        <Controls view={view} busy={busy} primary={view.next?.action?.control ?? null} onControl={(action, version) => void control(action, version)} />
      </div>
      {view.next !== null && (
        <div className="px-4 pt-3">
          <NextStepBar next={view.next} busy={busy} onAct={(action, version) => void control(action, version)} />
        </div>
      )}
      {view.prUrl !== null && (
        <p className="border-b border-border-seam px-4 py-2 text-xs text-muted-foreground">
          Pull request <button type="button" className="underline" onClick={() => navigate.openUrl(view.prUrl!)}>{view.prUrl}</button>
        </p>
      )}
      {error !== null && <p role="alert" className="border-b border-border-seam px-4 py-2 text-xs text-destructive-text">{error}</p>}
      {view.health !== null && <HealthStrip health={view.health} />}
      <div role="tablist" aria-label="Project" className="flex shrink-0 gap-1 border-b border-border-seam px-3 pt-1.5">
        {TABS.filter((entry) => entry.tab !== "planner" || overview.plannerThreadId !== null).map((entry) => (
          <button key={entry.tab} type="button" role="tab" aria-selected={tab === entry.tab} onClick={() => onTab(entry.tab)} className={`cursor-pointer rounded-t-md px-3 py-1.5 text-xs ${tab === entry.tab ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {tab === "board" && <Board slug={slug} cards={view.board} strategy={overview.strategy} now={view.now} draftVersion={overview.state === "draft" ? view.spec.version : null} />}
        {tab === "agents" && <AgentsView agents={view.agents} byRole={view.metrics.tokens.byRole} unreported={view.metrics.tokens.unreported} now={view.now} />}
        {tab === "feed" && <Feed slug={slug} />}
        {tab === "metrics" && <MetricsTab slug={slug} metrics={view.metrics} />}
        {tab === "spec" && <SpecTab view={view} busy={busy} onApprove={(version) => void control("approve", version)} />}
        {tab === "planner" && overview.plannerThreadId !== null && <PlannerChat threadId={overview.plannerThreadId} />}
      </div>
    </div>
  );
}

export function LoomPage({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const navigate = useBbNavigate();
  const go = (next: string) => navigate.toPluginPanel("loom", { subPath: next });
  // The tab belongs to the project it was chosen in, so opening another project starts on the board.
  const [chosen, setChosen] = useState<{ slug: string | null; tab: Tab }>({ slug: null, tab: "board" });
  const slug = route.view === "project" || route.view === "ticket" ? route.slug : null;
  const tab = chosen.slug === slug ? chosen.tab : "board";
  const crumb = "cursor-pointer rounded px-1 hover:bg-state-hover hover:text-foreground";
  const trail: Array<{ label: string; to: string | null }> =
    route.view === "guide"
      ? [{ label: "How Loom works", to: null }]
      : route.view === "new"
        ? [{ label: "New project", to: null }]
        : route.view === "plan"
          ? [{ label: "Planning", to: null }]
          : route.view === "project"
            ? [{ label: route.slug, to: null }]
            : route.view === "ticket"
              ? [
                  { label: route.slug, to: route.slug },
                  { label: route.key, to: null },
                ]
              : [];

  return (
    <section data-loom-page className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground">
      <nav aria-label="Loom" className="flex shrink-0 items-center gap-1.5 border-b border-border-seam px-4 py-2 text-xs text-muted-foreground">
        <Icon name="Layers" className="size-3.5" aria-hidden />
        <button type="button" className={crumb} onClick={() => go("")}>Loom</button>
        {trail.map((step) => (
          <span key={step.label} className="flex items-center gap-1.5">
            <span aria-hidden>/</span>
            {step.to === null ? <span className={HEADING}>{step.label}</span> : <button type="button" className={crumb} onClick={() => go(step.to!)}>{step.label}</button>}
          </span>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {route.view === "home" && <Home go={go} />}
        {route.view === "guide" && <Guide onStart={() => go("_new")} />}
        {route.view === "new" && <NewProject go={go} />}
        {route.view === "plan" && <PlanningView threadId={route.threadId} go={go} />}
        {route.view === "project" && <ProjectPanel slug={route.slug} tab={tab} onTab={(next) => setChosen({ slug: route.slug, tab: next })} />}
        {route.view === "ticket" && <TicketView slug={route.slug} ticketKey={route.key} />}
      </div>
    </section>
  );
}
