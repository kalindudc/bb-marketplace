import type { ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { HomeProject, PlanningSession } from "../contract";
import { plural } from "../format";
import { useLoom } from "./common";
import { homeRows } from "./home";
import { QUEUE_ICON, QUEUE_WORD, useQueue, type QueueItem } from "./needs";
import { Disclosure, Tip, TipProvider } from "./kit";
import { formatRoute, lastRoute, parseRoute, routeOf } from "./page";
import { cardWords, PhaseMark, railOf } from "./phase-rail";
import { useWaiting } from "./questions";
import { sidebarFinished, useStored } from "./remember";
import { stateWord } from "./project-line";
import { useLoomTheme } from "./theme";
import { projectViews, viewOf } from "./views";
import { threadsOfCounts, TicketBar, TicketKey, ticketsLabel } from "./ticket-bar";

const HEADING = "px-2 pb-1 pt-3 text-[11px] font-semibold text-[var(--loom-muted)]";
const COUNT = "loom-num inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center px-1 text-[11px] font-bold leading-none";

function Item({ label, on, onClick, leading, trailing, second, sub = false, title, tip, info }: { label: ReactNode; on: boolean; onClick(): void; leading?: ReactNode; trailing?: ReactNode; second?: ReactNode; sub?: boolean; title?: string; tip?: ReactNode; info?: string }) {
  const button = (
    <button
      type="button"
      aria-current={on ? "page" : undefined}
      title={title}
      onClick={onClick}
      className={`relative grid w-full min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 text-left transition-colors duration-100 ${sub ? "min-h-7 py-1 pl-7 pr-2 text-xs" : "min-h-8 px-2 py-1.5 text-[13px]"} max-[576px]:min-h-11 pointer-coarse:min-h-11 ${on ? "bg-surface-selected font-semibold text-foreground shadow-[inset_2px_0_0_var(--primary)]" : "text-foreground hover:bg-state-hover"}`}
    >
      <span className="flex w-4 justify-center text-[var(--loom-muted)]">{leading}</span>
      <span className="min-w-0 truncate">{label}</span>
      <span className="flex items-center gap-1.5 text-[11px] text-[var(--loom-muted)]">{trailing}</span>
      {second !== undefined && <span className="col-start-2 col-end-4 flex min-w-0 items-center gap-2 pt-1 text-[11px] font-normal text-[var(--loom-muted)]">{second}</span>}
    </button>
  );
  if (tip === undefined) return button;
  const tipped = (
    <Tip text={tip} side="right">
      {button}
    </Tip>
  );
  if (info === undefined) return tipped;
  // A tap opens the row, and a touch screen shows no tips, so there the tip has a button of its own beside the row.
  return (
    <div className="flex min-w-0 items-stretch">
      <div className="min-w-0 flex-1">{tipped}</div>
      <Disclosure
        label={info}
        side="right"
        className="w-72"
        trigger={
          <button type="button" aria-label={info} data-row-info className="hidden w-11 shrink-0 cursor-pointer items-center justify-center text-[var(--loom-muted)] hover:bg-state-hover hover:text-foreground max-[576px]:inline-flex [@media(pointer:coarse)]:inline-flex">
            <Icon name="Info" aria-hidden className="size-4" />
          </button>
        }
      >
        <div className="text-xs leading-snug">{tip}</div>
      </Disclosure>
    </div>
  );
}

const Needs = ({ count, label }: { count: number; label: string }) => (
  <span aria-label={label} title={label} className={`${COUNT} bg-[var(--attention)] text-[var(--attention-foreground)]`}>
    {count}
  </span>
);

function PlanningItem({ session, on, go }: { session: PlanningSession; on: boolean; go(subPath: string): void }) {
  const asking = useWaiting(session.threadId);
  return (
    <Item
      label={session.title}
      on={on}
      onClick={() => go(`_plan/${session.threadId}`)}
      leading={<Icon name="MessageSquare" aria-hidden className={`size-3.5 ${asking ? "text-[var(--attention)]" : ""}`} />}
      trailing={asking ? <Needs count={1} label="The planner asks you a question" /> : undefined}
    />
  );
}


/** Under the open project: its phases, each with its count, and each ticket that needs the person. */
function ProjectParts({ project, needs, ticket, go }: { project: HomeProject; needs: readonly QueueItem[]; ticket: string | null; go(subPath: string): void }) {
  const view = useLoom("project", { slug: project.slug }).data;
  const cards = view === undefined || view.phases === null ? [] : railOf(view, view.phaseFill === null ? null : { ref: view.phaseFill.ref, count: view.phaseFill.count });
  const openView = (next: "work" | "spec") => {
    projectViews.put(project.slug, next);
    go(project.slug);
  };
  return (
    <>
      {cards.map((card) => (
        <Item
          key={card.id}
          sub
          title={`Phase ${card.number}, ${card.title} · ${cardWords(card)}`}
          label={card.title}
          on={false}
          onClick={() => openView(card.state === "proposed" ? "spec" : "work")}
          leading={<span className="loom-num text-[11px] font-bold text-foreground">{card.number}</span>}
          trailing={
            card.state === "closed" ? (
              <span className="inline-flex items-center gap-1 loom-num" aria-label={cardWords(card)}>
                <PhaseMark state="closed" />
                {card.done}/{card.total}
                {card.cancelled > 0 && <span>· {card.cancelled} cut</span>}
              </span>
            ) : card.state === "active" ? (
              <span className="loom-num font-semibold text-foreground">
                {card.done}/{card.total}
              </span>
            ) : card.state === "proposed" ? (
              <span className="text-[var(--attention)]">proposed</span>
            ) : (
              <span>planned</span>
            )
          }
        />
      ))}
      {needs.flatMap((need) =>
        need.key === null
          ? []
          : [
              <Item
                key={need.id}
                sub
                title={need.text}
                label={
                  <>
                    <b>{need.key}</b> <span className="font-normal text-[var(--loom-muted)]">{QUEUE_WORD[need.kind].toLowerCase()}</span>
                  </>
                }
                on={ticket === need.key}
                onClick={() => go(`${need.slug}/${need.key}`)}
                leading={<Icon name={QUEUE_ICON[need.kind]} aria-hidden className="size-3 text-[var(--attention)]" />}
              />,
            ],
      )}
    </>
  );
}

function ProjectItem({ project, needs, open, onWork, ticket, go }: { project: HomeProject; needs: readonly QueueItem[]; open: boolean; onWork: boolean; ticket: string | null; go(subPath: string): void }) {
  const threads = threadsOfCounts(project.ticketCounts);
  const word = stateWord(project).toLowerCase();
  const done = threads.filter((thread) => thread === "done").length;
  return (
    <>
      <Item
        info={`Key to the ${project.key} bar`}
        tip={
          <span className="grid gap-1">
            <span>
              <b>{project.name}</b> · {word} · {done} of {threads.length} done
            </span>
            <TicketKey threads={threads} />
          </span>
        }
        label={
          <>
            <b className="font-bold">{project.key}</b> <span>{project.name}</span>
          </>
        }
        on={open && onWork}
        onClick={() => {
          projectViews.put(project.slug, "work");
          go(project.slug);
        }}
        trailing={needs.length > 0 ? <Needs count={needs.length} label={`${plural(needs.length, "thing")} in ${project.name} need${needs.length === 1 ? "s" : ""} you`} /> : undefined}
        second={
          <>
            <TicketBar threads={threads} height={6} label={ticketsLabel(threads)} className="flex-1" />
            <span className="loom-num shrink-0 font-semibold text-foreground">
              {done}/{threads.length}
            </span>
            <span className="shrink-0">{word}</span>
          </>
        }
      />
      {open && <ProjectParts project={project} needs={needs} ticket={ticket} go={go} />}
    </>
  );
}

/** Loom in place of bb's thread list while the Loom page is open: home, the projects woven with what needs you, the open project's phases and asks, and planning conversations. */
export function LoomSidebar({ subPath }: PluginNavPanelProps) {
  useLoomTheme();
  const navigate = useBbNavigate();
  useStored(lastRoute);
  useStored(projectViews);
  const route = routeOf(subPath);
  // The page already shown stays one history entry, so Back after a second click on it still goes back.
  const go = (next: string) => {
    if (formatRoute(parseRoute(next)) !== formatRoute(route)) navigate.toPluginPanel("loom", { subPath: next });
  };
  const home = useLoom("home", null).data;
  const planning = useLoom("planning", null).data;
  const showFinished = useStored(sidebarFinished);
  const slug = route.view === "project" || route.view === "ticket" ? route.slug : null;
  const ticket = route.view === "ticket" ? route.key : null;
  const onWork = route.view === "project" && slug !== null && viewOf(slug) === "work";
  const sessions = (planning ?? []).filter((session) => session.slug === null);
  const queue = useQueue(home);
  const rows = home === undefined || queue === undefined ? null : homeRows(home.projects, queue, []);
  const active = rows?.active.flatMap((row) => (row.kind === "project" ? [row] : [])) ?? [];
  const finished = rows?.finished ?? [];
  // The open project shows with its parts even while the finished ones are folded away.
  const finishedShown = showFinished ? finished : finished.filter((project) => project.slug === slug);
  const needs = queue?.length ?? 0;

  return (
    <TipProvider>
      <nav aria-label="Loom" data-loom-sidebar data-loom-root className="flex h-full min-h-0 flex-col gap-px overflow-y-auto p-2 text-foreground">
        <Item label="Home" on={route.view === "home"} onClick={() => go("_home")} leading={<Icon name="Home" className="size-4" aria-hidden />} trailing={needs > 0 ? <Needs count={needs} label={`${plural(needs, "thing")} need${needs === 1 ? "s" : ""} you`} /> : undefined} />
        <Item label="Insights" on={route.view === "insights"} onClick={() => go("_insights")} leading={<Icon name="ChartColumn" className="size-4" aria-hidden />} />
        {(active.length > 0 || finished.length > 0) && <div className={HEADING}>Projects</div>}
        {active.map((row) => (
          <ProjectItem key={row.project.slug} project={row.project} needs={row.needs} open={row.project.slug === slug} onWork={onWork} ticket={ticket} go={go} />
        ))}
        {sessions.length > 0 && (
          <>
            <div className={HEADING}>Planning</div>
            {sessions.map((session) => (
              <PlanningItem key={session.threadId} session={session} on={route.view === "plan" && route.threadId === session.threadId} go={go} />
            ))}
          </>
        )}
        {finished.length > 0 && (
          <Item
            label="Finished"
            on={false}
            onClick={() => sidebarFinished.set(!showFinished)}
            leading={<Icon name={showFinished ? "ChevronDown" : "ChevronRight"} aria-hidden className="size-3.5" />}
            trailing={<span className={`${COUNT} border border-[var(--loom-line)] text-[var(--loom-muted)]`} aria-label={`${plural(finished.length, "finished project")}`}>{finished.length}</span>}
          />
        )}
        {finishedShown.map((project) => (
          <ProjectItem key={project.slug} project={project} needs={[]} open={project.slug === slug} onWork={onWork} ticket={ticket} go={go} />
        ))}
        <div className="my-2 border-t border-[var(--loom-line)]" />
        <Item label="How Loom works" on={route.view === "guide"} onClick={() => go("_guide")} leading={<Icon name="Info" className="size-4" aria-hidden />} />
        <Item label="New project" on={route.view === "new"} onClick={() => go("_new")} leading={<Icon name="Plus" className="size-4" aria-hidden />} />
      </nav>
    </TipProvider>
  );
}
