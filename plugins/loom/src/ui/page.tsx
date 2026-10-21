import { useState } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ControlAction, ProjectSummary, ProjectView, rpcContract } from "../contract";
import { TICKET_STATES } from "../states";
import { Board } from "./board";
import { ConfirmButton, HEADING, StateBadge, useRemote, useRun } from "./common";
import { Feed } from "./feed";
import { MetricsView } from "./metrics-view";
import { TicketView } from "./ticket";

type Tab = "board" | "feed" | "metrics" | "spec";
const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: "board", label: "Board" },
  { tab: "feed", label: "Feed" },
  { tab: "metrics", label: "Metrics" },
  { tab: "spec", label: "Spec" },
];

/** The route remainder: "" is the list, "<slug>" a project, "<slug>/<KEY>" a ticket. */
export function parseRoute(subPath: string): { slug: string | null; key: string | null } {
  const [slug, key] = subPath.split("/").filter((part) => part !== "");
  return { slug: slug ?? null, key: key ?? null };
}

const mergeLabel = (project: Pick<ProjectSummary, "strategy" | "branch">) => (project.strategy === "integration" ? `integration branch ${project.branch}` : "one pull request per ticket");
const countsLabel = (counts: ProjectSummary["ticketCounts"]) =>
  TICKET_STATES.filter((state) => (counts[state] ?? 0) > 0)
    .map((state) => `${counts[state]} ${state.replace("_", " ")}`)
    .join(" · ") || "no tickets";

function ProjectList({ go }: { go(subPath: string): void }) {
  const { data, error } = useRemote((rpc) => rpc.call("projects"), "projects", null);
  if (error !== null && data === null) return <p role="alert" className="p-4 text-sm text-destructive-text">Could not load the projects: {error}</p>;
  if (data === null) return <p role="status" className="p-4 text-sm text-muted-foreground">Loading projects…</p>;
  if (data.length === 0) return <p className="p-4 text-sm text-muted-foreground">No Loom projects yet. Ask a thread to plan one; its agent has the loom-plan skill.</p>;
  return (
    <div>
      {data.map((project) => (
        <button key={project.slug} type="button" data-project-row={project.slug} onClick={() => go(project.slug)} className="flex w-full cursor-pointer flex-col gap-1 border-b border-border-seam px-4 py-3 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{project.name}</span>
            <span className="text-xs text-muted-foreground">{project.key}</span>
            <StateBadge state={project.state} />
          </span>
          <span className="text-xs text-muted-foreground">{mergeLabel(project)} · {countsLabel(project.ticketCounts)}</span>
          {project.reason !== null && <span className="text-xs text-warning-text">{project.reason}</span>}
        </button>
      ))}
    </div>
  );
}

function Controls({ view, busy, onControl }: { view: ProjectView; busy: boolean; onControl(action: ControlAction, version?: number): void }) {
  const { overview } = view;
  const live = overview.state === "running" || overview.state === "paused" || overview.state === "done";
  const act = (label: string, action: ControlAction, version?: number, danger = false) => (
    <ConfirmButton key={label} label={label} disabled={busy} danger={danger} onConfirm={() => onControl(action, version)} />
  );
  return (
    <span data-controls className="ml-auto flex flex-wrap items-center gap-2">
      {overview.state === "draft" && act("Approve", "approve")}
      {overview.state !== "draft" && overview.state !== "archived" && overview.pendingVersion !== null && act(`Approve v${overview.pendingVersion}`, "approve", overview.pendingVersion)}
      {overview.state === "ready" && act("Start", "start")}
      {overview.state === "running" && act("Pause", "pause")}
      {overview.state === "running" && act("Pause now", "pauseNow")}
      {overview.state === "paused" && act("Resume", "resume")}
      {overview.strategy === "integration" && live && (overview.ticketCounts.done ?? 0) > 0 && act("Land", "land")}
      {overview.state !== "archived" && act("Archive", "archive", undefined, true)}
    </span>
  );
}

function SpecTab({ view, busy, onApprove }: { view: ProjectView; busy: boolean; onApprove(version: number): void }) {
  const { spec, overview } = view;
  const pre = "mt-2 overflow-x-auto rounded-md border border-border-seam p-3 text-xs leading-relaxed";
  return (
    <div className="space-y-6 p-4">
      <section data-spec-current>
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Spec v{spec.version}</h2>
          <span className="text-xs text-muted-foreground">{overview.approvedVersion === null ? "draft" : "approved"}</span>
        </div>
        <pre className={pre}>{spec.toml}</pre>
      </section>
      {spec.pendingVersion !== null && spec.pendingToml !== null && (
        <section data-spec-pending>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Pending v{spec.pendingVersion}</h2>
            <span className="text-xs text-muted-foreground">waiting for approval; its tickets are unchanged</span>
            <ConfirmButton label={`Approve v${spec.pendingVersion}`} disabled={busy} onConfirm={() => onApprove(spec.pendingVersion!)} />
          </div>
          <pre className={pre}>{spec.pendingToml}</pre>
        </section>
      )}
    </div>
  );
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
        <Controls view={view} busy={busy} onControl={(action, version) => void control(action, version)} />
      </div>
      {overview.reason !== null && <p className="border-b border-border-seam px-4 py-2 text-xs text-warning-text">{overview.state === "paused" ? "Paused: " : ""}{overview.reason}</p>}
      {view.prUrl !== null && (
        <p className="border-b border-border-seam px-4 py-2 text-xs text-muted-foreground">
          Pull request <button type="button" className="underline" onClick={() => navigate.openUrl(view.prUrl!)}>{view.prUrl}</button>
        </p>
      )}
      {error !== null && <p role="alert" className="border-b border-border-seam px-4 py-2 text-xs text-destructive-text">{error}</p>}
      <div role="tablist" aria-label="Project" className="flex shrink-0 gap-1 border-b border-border-seam px-3 pt-1.5">
        {TABS.map((entry) => (
          <button key={entry.tab} type="button" role="tab" aria-selected={tab === entry.tab} onClick={() => onTab(entry.tab)} className={`cursor-pointer rounded-t-md px-3 py-1.5 text-xs ${tab === entry.tab ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {tab === "board" && <Board slug={slug} cards={view.board} strategy={overview.strategy} now={view.now} />}
        {tab === "feed" && <Feed slug={slug} />}
        {tab === "metrics" && <MetricsView metrics={view.metrics} />}
        {tab === "spec" && <SpecTab view={view} busy={busy} onApprove={(version) => void control("approve", version)} />}
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
  const tab = chosen.slug === route.slug ? chosen.tab : "board";
  const crumb = "cursor-pointer rounded px-1 hover:bg-state-hover hover:text-foreground";

  return (
    <section data-loom-page className="flex h-full min-h-0 min-w-0 flex-col bg-surface-recessed text-foreground">
      <nav aria-label="Loom" className="flex shrink-0 items-center gap-1.5 border-b border-border-seam px-4 py-2 text-xs text-muted-foreground">
        <Icon name="Layers" className="size-3.5" aria-hidden />
        <button type="button" className={crumb} onClick={() => go("")}>Loom</button>
        {route.slug !== null && (
          <>
            <span aria-hidden>/</span>
            {route.key === null ? <span className={HEADING}>{route.slug}</span> : <button type="button" className={crumb} onClick={() => go(route.slug!)}>{route.slug}</button>}
          </>
        )}
        {route.key !== null && (
          <>
            <span aria-hidden>/</span>
            <span className={HEADING}>{route.key}</span>
          </>
        )}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {route.slug === null ? <ProjectList go={go} /> : route.key === null ? <ProjectPanel slug={route.slug} tab={tab} onTab={(next) => setChosen({ slug: route.slug, tab: next })} /> : <TicketView slug={route.slug} ticketKey={route.key} />}
      </div>
    </section>
  );
}

