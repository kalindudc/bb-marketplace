// A project's page: the project line, the phase rail and the view row with the time ruler over five views (Work, Spec,
// Planner, Ship, History). Later phases rebuild what is inside each view; the shell, its keys and its rewind are here.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { ControlAction, ProjectView } from "../contract";
import { readyToLand } from "../format";
import { AgentsView } from "./agents";
import { DoNextCard } from "./do-next";
import { doNextOf } from "./ship-plan";
import { BadgeNotice } from "./badge-notice";
import { ChangesTab, landingFiles, useViewed } from "./changes";
import { BUTTON, useLoom } from "./common";
import { useControl } from "./controls";
import { InsightsTab } from "./insights";
import { Tip, sidewaysInto } from "./kit";
import { MergeOrderTab } from "./merge-order";
import { PhaseRail, railOf } from "./phase-rail";
import { PlannerPage } from "./planner-page";
import { ProjectLine } from "./project-line";
import { useWaiting } from "./questions";
import { useStored } from "./remember";
import { RolloutTab } from "./rollout";
import { SpecView } from "./spec-view";
import { tabBadges, type BadgeTab, type TabBadge } from "./tab-badges";
import { TicketView } from "./ticket";
import { TimelineStrip } from "./timeline-strip";
import { TimeRuler, useMoments } from "./time-ruler";
import { WorkView } from "./work";
import { VIEWS, historyPartOf, historyParts, projectViews, shipPartOf, shipParts, viewOf, type HistoryPart, type ShipPart, type View } from "./views";

/** A project shows its changes once it has started: before that no worker has changed anything. */
export { sidewaysInto };

const hasChanges = (state: ProjectView["overview"]["state"]) => state !== "draft" && state !== "ready";


const SHELL = "flex min-h-full flex-col gap-2 px-5 pb-6 pt-1 @max-xl/loom:px-3";
const PANEL = "min-h-0 flex-1 pt-2";
const COUNT = "loom-num inline-flex h-[18px] min-w-[18px] items-center justify-center px-1 text-[11px] font-bold leading-none";

// Every count on a tab is something waiting on the person, so one attention fill; a destructive count, such as a failed
// check, is a solid one and a warning an outlined one, so the two read apart without colour alone.
const TONE: Record<TabBadge["tone"], string> = { destructive: "bg-[var(--attention)] text-[var(--attention-foreground)]", warning: "border border-[var(--attention)] text-foreground" };

/** One Tab stop per row of tabs: arrows, Home and End move focus along it, and Enter or Space opens the focused tab. */
const roveTabs = (event: KeyboardEvent<HTMLDivElement>) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (step === undefined && event.key !== "Home" && event.key !== "End") return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (at + step! + tabs.length) % tabs.length;
  tabs[next]!.focus();
};

function Tab({ id, name, label, selected, count, hidden, keys, onPick }: { id: string; name: string; label: string; selected: boolean; count?: TabBadge; hidden?: string; keys?: string; onPick(): void }) {
  const button = (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      aria-disabled={hidden === undefined ? undefined : true}
      aria-keyshortcuts={keys}
      aria-description={count?.label}
      onClick={() => (hidden === undefined ? onPick() : void toast.info(hidden))}
      className={`inline-flex h-10 shrink-0 cursor-pointer items-center gap-1.5 px-2.5 text-[13px] whitespace-nowrap shadow-[inset_0_-2px_0_transparent] transition-[color,box-shadow] duration-150 @max-xl/loom:min-h-11 pointer-coarse:min-h-11 ${selected ? "font-semibold text-foreground shadow-[inset_0_-2px_0_var(--primary)]" : "text-[var(--loom-muted)] hover:text-foreground"} ${hidden !== undefined ? "cursor-not-allowed opacity-55" : ""}`}
    >
      {label}
      {count !== undefined && (
        <span data-tab-badge={name} data-tone={count.tone} aria-hidden className={`${COUNT} ${TONE[count.tone]}`}>
          {count.text}
        </span>
      )}
    </button>
  );
  return <Tip text={hidden ?? (count?.label === undefined ? label : `${label}: ${count.label}`)} keys={keys}>{button}</Tip>;
}

/** A row of tabs inside Ship or History. */
function Parts<P extends string>({ label, parts, chosen, badges, onPick }: { label: string; parts: ReadonlyArray<{ part: P; label: string }>; chosen: P; badges: Partial<Record<string, TabBadge>>; onPick(part: P): void }) {
  return (
    <div role="tablist" aria-label={label} data-parts={label} onKeyDown={roveTabs} className="mb-3 flex flex-wrap gap-1 border-b border-[var(--loom-line)]">
      {parts.map((entry) => (
        <Tab key={entry.part} id={entry.part} name={entry.part} label={entry.label} selected={entry.part === chosen} count={badges[entry.part]} onPick={() => onPick(entry.part)} />
      ))}
    </div>
  );
}

export function ProjectShell({ slug, ticketKey, at, onSeek, go }: { slug: string; ticketKey: string | null; at: number | null; onSeek(at: number | null): void; go(subPath: string): void }) {
  const remote = useLoom("project", at === null ? { slug } : { slug, at }, { keep: true });
  useStored(projectViews);
  useStored(shipParts);
  useStored(historyParts);
  const { busy, run } = useControl(slug);
  const [chosenChange, setChosenChange] = useState<string | null>(null);
  // The spec version the Planner asked to open; choosing a view by hand opens the spec's own default again.
  const [specVersion, setSpecVersion] = useState<number | null>(null);
  const plannerWaiting = useWaiting(remote.data?.overview.plannerThreadId ?? "");
  const moments = useMoments(slug, at, onSeek);
  const loaded = remote.data;
  const chosenView: View = ticketKey !== null ? "work" : viewOf(slug);
  const wantChanges = loaded !== undefined && at === null && loaded.at === null && hasChanges(loaded.overview.state) && ((chosenView === "ship" && shipPartOf(slug) !== "merge" && shipPartOf(slug) !== "rollout") || readyToLand(loaded.overview));
  const changes = useLoom("changes", { slug }, { keep: true, enabled: wantChanges });
  const viewed = useViewed(slug);
  const views = useRef<HTMLDivElement>(null);

  const view = remote.data;
  const rewound = at !== null || (view?.at ?? null) !== null;
  const plannerHidden = view === undefined ? undefined : view.overview.plannerThreadId === null ? "This project has no planner thread" : rewound ? "Planner is hidden while rewound" : undefined;
  const shipHidden = rewound ? "Ship is hidden while rewound: it shows what is live now" : undefined;
  const hiddenOf = (entry: View) => (entry === "planner" ? plannerHidden : entry === "ship" ? shipHidden : undefined);
  const shown: View = hiddenOf(chosenView) !== undefined ? "work" : chosenView;

  const pick = (next: View) => {
    setSpecVersion(null);
    projectViews.put(slug, next);
    if (ticketKey !== null) go(slug);
  };

  useLayoutEffect(() => {
    const element = views.current;
    const chosen = element?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (element == null || chosen == null) return;
    const left = sidewaysInto(element.getBoundingClientRect(), chosen.getBoundingClientRect(), element.scrollLeft);
    if (left !== null) element.scrollLeft = left;
    // The tabs exist once the project has loaded, so that counts as a change too.
  }, [shown, view === undefined]);

  if (view === undefined) {
    // A ticket reads on its own, so it still shows when its project could not be read. While the project loads, the
    // ticket waits for Work's pane, so it is read once.
    if (ticketKey !== null && remote.error !== null)
      return (
        <div data-project-shell={slug} className={SHELL} onKeyDown={(event) => event.key === "Escape" && !event.defaultPrevented && go(slug)}>
          {null}
          {remote.error === null ? null : (
            <p role="alert" className="text-xs text-[var(--loom-muted)]">
              Could not load {slug}: {remote.error}
            </p>
          )}
          {null}
          {null}
          <div role="tabpanel" data-view="work" className={PANEL}>
            <TicketView ticketKey={ticketKey} at={at} onNow={() => onSeek(null)} />
          </div>
        </div>
      );
    return remote.error === null ? (
      <p role="status" className="p-4 text-sm text-[var(--loom-muted)]">
        Loading…
      </p>
    ) : (
      <p role="alert" className="p-4 text-sm text-foreground">
        Could not load {slug}: {remote.error}
      </p>
    );
  }
  const { overview } = view;
  const changesOn = !rewound && hasChanges(overview.state);
  const mergeOn = changesOn && view.mergeOrder !== null;
  const rolloutOn = !rewound && view.rollout !== null;
  const landing = landingFiles(changes.data ?? null);
  const badges: Partial<Record<BadgeTab, TabBadge>> = rewound ? {} : tabBadges(view, landing === null ? null : viewed.unviewed(landing), plannerWaiting);
  const shipList: Array<{ part: ShipPart; label: string }> = [...(changesOn && overview.strategy === "integration" ? [{ part: "changes" as const, label: "Changes" }] : []), ...(mergeOn ? [{ part: "merge" as const, label: "Merge order" }] : []), ...(rolloutOn ? [{ part: "rollout" as const, label: "Rollout" }] : []), ...(changesOn && overview.strategy === "pr" ? [{ part: "changes" as const, label: "Changes" }] : [])];
  const shipPart = shipList.find((entry) => entry.part === shipPartOf(slug))?.part ?? shipList[0]?.part ?? null;
  const shipCount = (["changes", "merge", "rollout"] as const).map((part) => badges[part]).filter((badge): badge is TabBadge => badge !== undefined);
  const counts: Partial<Record<View, TabBadge>> = {
    ...(badges.board === undefined ? {} : { work: badges.board }),
    ...(badges.spec === undefined ? {} : { spec: badges.spec }),
    ...(badges.planner === undefined ? {} : { planner: badges.planner }),
    ...(shipCount.length === 0 ? {} : { ship: { ...shipCount[0]!, text: shipCount.length === 1 ? shipCount[0]!.text : String(shipCount.reduce((sum, badge) => sum + (Number(badge.text) || 1), 0)), label: shipCount.map((badge) => badge.label).join("; ") } }),
  };
  const historyList: Array<{ part: HistoryPart; label: string }> = [
    { part: "rewind", label: "Rewind" },
    { part: "insights", label: "Insights" },
    { part: "agents", label: "Agents" },
  ];
  const historyPart = historyPartOf(slug) ?? "rewind";
  const control = (action: ControlAction, version?: number, repo?: string) => void run(action, version, repo);
  const onTicket = (key: string) => go(`${slug}/${key}`);
  const openChanges = (id: string | null) => {
    setChosenChange(id);
    shipParts.put(slug, "changes");
    pick("ship");
  };
  const notice = (tab: BadgeTab, listed = false) => {
    const badge = badges[tab];
    return badge === undefined ? null : (
      <div className="mb-3">
        <BadgeNotice key={tab} slug={slug} tab={tab} badge={badge} onTicket={onTicket} listed={listed} />
      </div>
    );
  };

  const cards = railOf(view, view.phaseFill === null ? null : { ref: view.phaseFill.ref, count: view.phaseFill.count });
  const currentCard = view.phases === null ? null : (cards.find((card) => card.state === "active")?.id ?? (shown === "spec" ? (cards.find((card) => card.state === "proposed")?.id ?? null) : null));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"], [data-confirm-armed]') !== null) return;
    const number = /^[1-5]$/.test(event.key) ? Number(event.key) : null;
    if (number !== null) {
      const entry = VIEWS[number - 1]!;
      const hidden = hiddenOf(entry.view);
      event.preventDefault();
      if (hidden !== undefined) return void toast.info(hidden);
      return pick(entry.view);
    }
    if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      return moments.step(event.key === "[" ? -1 : 1);
    }
    if (event.key === "Escape") {
      if (ticketKey !== null) {
        event.preventDefault();
        return go(slug);
      }
      if (rewound) {
        event.preventDefault();
        return onSeek(null);
      }
    }
  };

  let content: ReactNode;
  if (ticketKey !== null || shown === "work")
    content = (
      <>
        {ticketKey === null && notice("board", true)}
        <WorkView view={view} at={at} ticketKey={ticketKey} go={go} onSeek={onSeek} onChanges={changesOn ? openChanges : undefined} />
      </>
    );
  else if (shown === "spec")
    content = (
      <>
        {/* The gate's version line says what the notice would. */}
        {(view.gate == null || rewound || specVersion !== null) && notice("spec")}
        <SpecView view={view} busy={busy} rewound={rewound} requested={specVersion} onApprove={(version) => control("approve", version)} onTicket={onTicket} {...(plannerHidden === undefined ? { onPlanner: () => pick("planner") } : {})} />
      </>
    );
  else if (shown === "planner" && overview.plannerThreadId !== null)
    content = (
      <>
        <PlannerPage
          threadId={overview.plannerThreadId}
          project={view}
          busy={busy}
          onControl={(action, version) => control(action, version)}
          onSpec={(version) => {
            projectViews.put(slug, "spec");
            setSpecVersion(version);
          }}
          onTicket={onTicket}
        />
      </>
    );
  else if (shown === "ship")
    content =
      shipPart === null ? (
        <p role="status" data-empty className="loom-card px-4 py-6 text-sm text-[var(--loom-muted)]">
          Nothing to ship yet: changes, the merge order and the rollout show here once workers push work.
        </p>
      ) : (
        <>
          <DoNextCard view={view} onTicket={onTicket} />
          <Parts label="Ship" parts={shipList} chosen={shipPart} badges={badges} onPick={(part) => shipParts.put(slug, part)} />
          {notice(shipPart)}
          {shipPart === "changes" && <ChangesTab changes={changes.data ?? null} error={changes.error} view={view} busy={busy} chosen={chosenChange} onChoose={setChosenChange} onControl={(action, repo) => control(action, undefined, repo)} onReload={changes.reload} />}
          {shipPart === "merge" && <MergeOrderTab order={view.mergeOrder} rollout={view.rollout} onTicket={onTicket} />}
          {shipPart === "rollout" && <RolloutTab slug={slug} rollout={view.rollout} mergeOrder={view.mergeOrder} now={view.now} onTicket={onTicket} held={doNextOf(view)?.lead ?? null} />}
        </>
      );
  else
    content = (
      <>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Parts label="History" parts={historyList} chosen={historyPart} badges={{}} onPick={(part) => historyParts.put(slug, part)} />
          </div>
          {historyPart === "insights" && (
            <button type="button" data-insights-across className={`${BUTTON} mt-1.5`} onClick={() => go("_insights")}>
              Across projects
            </button>
          )}
        </div>
        {historyPart === "rewind" && <TimelineStrip slug={slug} at={at} onSeek={onSeek} onTicket={onTicket} full />}
        {historyPart === "insights" && <InsightsTab slug={slug} at={at} onTicket={onTicket} />}
        {historyPart === "agents" && <AgentsView agents={view.agents} byRole={view.metrics.tokens.byRole} unreported={view.metrics.tokens.unreported} now={view.now} />}
      </>
    );

  return (
    <div data-project-shell={slug} className={SHELL} onKeyDown={onKeyDown}>
      {/* bb's title bar names the project for sight; the page's own heading names it for a screen reader's outline. */}
      {ticketKey === null && <h1 className="sr-only">{overview.name}</h1>}
      <ProjectLine view={view} moments={moments} current={shown} openTicket={ticketKey} go={go} onView={pick} onReviewChanges={changesOn && !(shown === "ship" && shipPart === "changes") ? () => openChanges("branch") : undefined} />
      <PhaseRail cards={cards} currentId={currentCard} label={view.phases === null ? "Tickets by repo" : "Phases"} onPick={() => pick("work")} />
      {/* On a phone the views and the ruler stay at the top while the view scrolls under them. */}
      <div data-view-row className="flex flex-wrap items-center gap-x-4 gap-y-0 border-b border-[var(--loom-line)] @max-xl/loom:sticky @max-xl/loom:top-0 @max-xl/loom:z-10 @max-xl/loom:bg-background">
        <div ref={views} role="tablist" aria-label="Project views" onKeyDown={roveTabs} className="flex min-w-0 max-w-full shrink-0 flex-nowrap overflow-x-auto [scrollbar-width:none]">
          {VIEWS.map((entry, index) => (
            <Tab key={entry.view} id={`view-${entry.view}`} name={entry.view} label={entry.label} keys={String(index + 1)} selected={shown === entry.view} count={counts[entry.view]} hidden={hiddenOf(entry.view)} onPick={() => pick(entry.view)} />
          ))}
        </div>
        <div className="flex min-w-[260px] flex-1 basis-[420px] @max-5xl/loom:basis-full">
          <TimeRuler moments={moments} compact />
        </div>
      </div>
      <div role="tabpanel" aria-labelledby={`view-${shown}`} data-view={shown} className={PANEL}>
        {content}
      </div>
    </div>
  );
}
