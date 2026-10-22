import { useState } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ControlAction, ProjectView, rpcContract } from "../contract";
import type { ProjectMetrics } from "../metrics";
import { STAGES } from "../next-step";
import type { WindowDays } from "../states";
import { AgentsView } from "./agents";
import { Board } from "./board";
import { BUTTON_PRIMARY, ConfirmButton, HEADING, MoreMenu, StateBadge, countsLabel, mergeLabel, momentLabel, useRemote, useRun } from "./common";
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
import { TimelineStrip } from "./timeline-strip";

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

/** The dashboard, under a note on any pending version. Its Approve shows only when the next-step bar does not carry one. Rewound, it shows the version in force then and takes no notes. */
function SpecTab({ view, busy, rewound, onApprove }: { view: ProjectView; busy: boolean; rewound: boolean; onApprove(version: number): void }) {
  const { spec, overview } = view;
  const barApproves = view.next?.action?.control === "approve";
  if (rewound) {
    return (
      <div className="space-y-6 p-4">
        <p data-spec-rewound className="text-xs text-muted-foreground">
          At this moment, version {spec.version} was the spec in force.
        </p>
        <SpecDashboard slug={overview.slug} version={spec.version} readOnly />
      </div>
    );
  }
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

/** The project view carries the 14-day metrics; another window reads the metrics RPC, at the rewound moment when `at` is set. */
function MetricsTab({ slug, metrics, at }: { slug: string; metrics: ProjectMetrics; at: number | null }) {
  const [days, setDays] = useState<WindowDays>(14);
  return days === 14 ? <MetricsView metrics={metrics} days={days} onDays={setDays} /> : <WindowedMetrics slug={slug} days={days} at={at} onDays={setDays} />;
}

function WindowedMetrics({ slug, days, at, onDays }: { slug: string; days: WindowDays; at: number | null; onDays(days: WindowDays): void }) {
  const { data, error } = useRemote((rpc) => rpc.call("metrics", at === null ? { slug, days } : { slug, days, at }), `metrics:${slug}:${days}${at === null ? "" : `@${at}`}`, slug);
  if (data === null) return error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load the metrics: {error}</p>;
  return <MetricsView metrics={data} days={days} onDays={onDays} />;
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

function ProjectPanel({ slug, tab, onTab, at, onSeek }: { slug: string; tab: Tab; onTab(tab: Tab): void; at: number | null; onSeek(at: number | null): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const remote = useRemote((client) => client.call("project", at === null ? { slug } : { slug, at }), at === null ? `project:${slug}` : `project:${slug}@${at}`, slug, true);
  const { busy, error, run } = useRun();
  const view = remote.data;
  if (view === null) {
    return remote.error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load {slug}: {remote.error}</p>;
  }
  const { overview } = view;
  // Either side counts: the shown view can still be the past one while the live view loads.
  const rewound = at !== null || view.at !== null;
  const shownTab = rewound && tab === "planner" ? "board" : tab;
  const control = (action: ControlAction, version?: number) =>
    run(async () => remote.set(await rpc.call("control", { slug, action, ...(version === undefined ? {} : { version }), confirm: true })));

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
      {rewound ? (
        <div className="px-4 pt-3">
          <RewindBar now={view.now} stage={view.next?.stage ?? null} onNow={() => onSeek(null)} />
        </div>
      ) : (
        view.next !== null && (
          <div className="px-4 pt-3">
            <NextStepBar next={view.next} busy={busy} onAct={(action, version) => void control(action, version)} />
          </div>
        )
      )}
      {view.prUrl !== null && (
        <p className="border-b border-border-seam px-4 py-2 text-xs text-muted-foreground">
          Pull request <button type="button" className="underline" onClick={() => navigate.openUrl(view.prUrl!)}>{view.prUrl}</button>
        </p>
      )}
      {error !== null && <p role="alert" className="border-b border-border-seam px-4 py-2 text-xs text-destructive-text">{error}</p>}
      {view.health !== null && <HealthStrip health={view.health} />}
      <TimelineStrip slug={slug} at={at} onSeek={onSeek} />
      <div role="tablist" aria-label="Project" className="flex shrink-0 gap-1 border-b border-border-seam px-3 pt-1.5">
        {TABS.filter((entry) => entry.tab !== "planner" || (overview.plannerThreadId !== null && !rewound)).map((entry) => (
          <button key={entry.tab} type="button" role="tab" aria-selected={shownTab === entry.tab} onClick={() => onTab(entry.tab)} className={`cursor-pointer rounded-t-md px-3 py-1.5 text-xs ${shownTab === entry.tab ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {shownTab === "board" && <Board slug={slug} cards={view.board} strategy={overview.strategy} now={view.now} draftVersion={overview.state === "draft" ? view.spec.version : null} />}
        {shownTab === "agents" && <AgentsView agents={view.agents} byRole={view.metrics.tokens.byRole} unreported={view.metrics.tokens.unreported} now={view.now} />}
        {shownTab === "feed" && <Feed slug={slug} at={at} />}
        {shownTab === "metrics" && <MetricsTab slug={slug} metrics={view.metrics} at={at} />}
        {shownTab === "spec" && <SpecTab view={view} busy={busy} rewound={rewound} onApprove={(version) => void control("approve", version)} />}
        {shownTab === "planner" && overview.plannerThreadId !== null && <PlannerChat threadId={overview.plannerThreadId} />}
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
  // The ticket route reads the rewind too, so it lives here, with the project it belongs to.
  const [rewind, setRewind] = useState<{ slug: string; at: number } | null>(null);
  const at = rewind !== null && rewind.slug === slug ? rewind.at : null;
  const seek = (next: number | null) => setRewind(next === null || slug === null ? null : { slug, at: next });
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
      <div data-loom-scroll className="min-h-0 flex-1 overflow-y-auto">
        {route.view === "home" && <Home go={go} />}
        {route.view === "guide" && <Guide onStart={() => go("_new")} />}
        {route.view === "new" && <NewProject go={go} />}
        {route.view === "plan" && <PlanningView threadId={route.threadId} go={go} />}
        {route.view === "project" && <ProjectPanel key={route.slug} slug={route.slug} tab={tab} onTab={(next) => setChosen({ slug: route.slug, tab: next })} at={at} onSeek={seek} />}
        {route.view === "ticket" && <TicketView slug={route.slug} ticketKey={route.key} at={at} onNow={() => seek(null)} />}
      </div>
    </section>
  );
}
