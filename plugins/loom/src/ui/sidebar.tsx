import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { BoardCard, HomeProject, PlanningSession } from "../contract";
import type { TicketState } from "../states";
import { HEADING, plural, stateTone, useLoom } from "./common";
import { homeRows } from "./home";
import { parseRoute } from "./page";
import { useWaiting } from "./questions";

// A ticket in one of these is not moving and needs nothing, so the sidebar leaves it to the board.
const RESTING: readonly TicketState[] = ["queued", "done", "cancelled"];

function Item({ label, on, onClick, leading, trailing, sub = false, title }: { label: string; on: boolean; onClick(): void; leading?: ReactNode; trailing?: ReactNode; sub?: boolean; title?: string }) {
  return (
    <button
      type="button"
      aria-current={on ? "page" : undefined}
      title={title}
      onClick={onClick}
      className={`flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${sub ? "py-1 pl-7 pr-2 text-xs" : "px-2 py-1.5 text-sm"} ${on ? "bg-surface-selected font-semibold text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground"}`}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

const Dot = ({ state }: { state: string }) => <span aria-hidden className={`inline-block size-[7px] shrink-0 rounded-full bg-current ${stateTone(state)}`} />;
const Hot = ({ count, label }: { count: number; label: string }) => (
  <span aria-label={label} title={label} className="shrink-0 rounded-full bg-warning px-1.5 text-[10.5px] font-semibold leading-4 text-black">
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
      leading={<Dot state="draft" />}
      trailing={asking ? <Hot count={1} label="The planner asks you a question" /> : undefined}
    />
  );
}

/** The open project's tickets that are moving or stuck, blocked first, for a jump to one without the board. */
const movingOf = (cards: readonly BoardCard[]) => cards.filter((card) => !RESTING.includes(card.state)).sort((a, b) => Number(b.state === "blocked") - Number(a.state === "blocked"));

function Tickets({ slug, shown, ticket, go }: { slug: string; shown: readonly BoardCard[]; ticket: string | null; go(subPath: string): void }) {
  return shown.map((card) => (
    <Item
      key={card.key}
      sub
      label={card.key}
      title={card.title}
      on={ticket === card.key}
      onClick={() => go(`${slug}/${card.key}`)}
      trailing={<span className={`shrink-0 text-[11px] ${card.state === "blocked" ? "text-destructive-text" : "text-muted-foreground"}`}>{card.state.replace("_", " ")}</span>}
    />
  ));
}

function ProjectItem({ project, needs, open, ticket, go }: { project: HomeProject; needs: number; open: boolean; ticket: string | null; go(subPath: string): void }) {
  const shown = movingOf(useLoom("project", { slug: project.slug }, { enabled: open }).data?.board ?? []);
  // On a ticket the list leaves out, such as a done one, the project stays marked.
  const listed = ticket !== null && shown.some((card) => card.key === ticket);
  return (
    <>
      <Item
        label={project.name}
        title={`${project.name} · ${project.state}`}
        on={open && !listed}
        onClick={() => go(project.slug)}
        leading={<Dot state={project.state} />}
        trailing={needs > 0 ? <Hot count={needs} label={`${plural(needs, "thing")} in ${project.name} need${needs === 1 ? "s" : ""} you`} /> : <span className="shrink-0 text-[11px] text-subtle-foreground">{project.key}</span>}
      />
      {open && <Tickets slug={project.slug} shown={shown} ticket={ticket} go={go} />}
    </>
  );
}

/** Loom in place of bb's thread list while the Loom page is open: home, planning conversations, projects with what needs you, and the open project's tickets in flight. */
export function LoomSidebar({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const go = (next: string) => navigate.toPluginPanel("loom", { subPath: next });
  const route = parseRoute(subPath);
  const home = useLoom("home", null).data;
  const planning = useLoom("planning", null).data;
  const [showFinished, setShowFinished] = useState(false);
  const slug = route.view === "project" || route.view === "ticket" ? route.slug : null;
  const ticket = route.view === "ticket" ? route.key : null;
  const sessions = (planning ?? []).filter((session) => session.slug === null);
  const rows = home === undefined ? null : homeRows(home, []);
  const active = rows?.active.flatMap((row) => (row.kind === "project" ? [row] : [])) ?? [];
  const finished = rows?.finished ?? [];
  // The open project shows with its tickets even while the finished ones are folded away.
  const finishedShown = showFinished ? finished : finished.filter((project) => project.slug === slug);

  return (
    <nav aria-label="Loom" data-loom-sidebar className="flex h-full min-h-0 flex-col gap-px overflow-y-auto p-2">
      <div className={`${HEADING} px-2 pb-1 pt-1.5`}>Loom</div>
      <Item
        label="Home"
        on={route.view === "home"}
        onClick={() => go("")}
        leading={<Icon name="Home" className="size-4 shrink-0" aria-hidden />}
        trailing={home !== undefined && home.needsYou.length > 0 ? <Hot count={home.needsYou.length} label={`${plural(home.needsYou.length, "thing")} need${home.needsYou.length === 1 ? "s" : ""} you`} /> : undefined}
      />
      {sessions.length > 0 && (
        <>
          <div className={`${HEADING} px-2 pb-1 pt-3`}>Planning</div>
          {sessions.map((session) => (
            <PlanningItem key={session.threadId} session={session} on={route.view === "plan" && route.threadId === session.threadId} go={go} />
          ))}
        </>
      )}
      {(active.length > 0 || finished.length > 0) && <div className={`${HEADING} px-2 pb-1 pt-3`}>Projects</div>}
      {active.map((row) => (
        <ProjectItem key={row.project.slug} project={row.project} needs={row.needs.length} open={row.project.slug === slug} ticket={ticket} go={go} />
      ))}
      {finished.length > 0 && (
        <button type="button" aria-expanded={showFinished} onClick={() => setShowFinished(!showFinished)} className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
          <Icon name="ChevronRight" aria-hidden className={`size-3 shrink-0 ${showFinished ? "rotate-90" : ""}`} />
          Done and archived ({finished.length})
        </button>
      )}
      {finishedShown.map((project) => (
        <ProjectItem key={project.slug} project={project} needs={0} open={project.slug === slug} ticket={ticket} go={go} />
      ))}
      <div className="my-2 border-t border-border-seam" />
      <Item label="How Loom works" on={route.view === "guide"} onClick={() => go("_guide")} leading={<Icon name="Info" className="size-4 shrink-0" aria-hidden />} />
      <Item label="New project" on={route.view === "new"} onClick={() => go("_new")} leading={<Icon name="Plus" className="size-4 shrink-0" aria-hidden />} />
    </nav>
  );
}
