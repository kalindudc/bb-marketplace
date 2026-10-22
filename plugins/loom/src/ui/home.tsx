import { useState, type ReactNode } from "react";
import type { HomeProject, HomeView, NeedItem } from "../contract";
import { formatDuration, plural } from "../format";
import { ShareBar, Spark, type Swatch } from "./charts";
import { BUTTON, BUTTON_PRIMARY, CARD, FIELD, HEADING, StateBadge, countsLabel, mergeLabel, useRemote } from "./common";
import { Guide } from "./guide";

const DONE: Swatch = { fill: "var(--success, currentColor)" };
const IN_FLIGHT: Swatch = { fill: "var(--primary, currentColor)" };
const BLOCKED: Swatch = { fill: "var(--destructive, currentColor)" };
const WAITING: Swatch = { fill: "var(--muted-foreground, currentColor)", opacity: 0.35 };
const NEED_ICONS: Record<NeedItem["kind"], { glyph: string; tone: string }> = {
  blocked: { glyph: "!", tone: "text-destructive-text" },
  approve: { glyph: "✎", tone: "text-warning-text" },
  pending: { glyph: "✎", tone: "text-warning-text" },
  land: { glyph: "↑", tone: "text-success" },
  paused: { glyph: "⏸", tone: "text-warning-text" },
};
const count = (value: number) => value.toLocaleString("en-US");
const CELL = "px-3 py-2 align-middle";

function Tile({ id, title, value, note, children }: { id: string; title: string; value: ReactNode; note?: string; children?: ReactNode }) {
  return (
    <div data-home-tile={id} className={CARD}>
      <h3 className={HEADING}>{title}</h3>
      <p data-tile-value className="mt-1 text-xl font-semibold">{value}</p>
      {note !== undefined && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
      {children}
    </div>
  );
}

function Tiles({ home }: { home: HomeView }) {
  const { totals } = home;
  const small = (text: string) => <span className="text-xs font-normal text-muted-foreground">{text}</span>;
  return (
    <div className="grid grid-cols-2 gap-3 px-4 pt-3 lg:grid-cols-5">
      <Tile id="running" title="Running" value={String(totals.running)} note={`of ${plural(totals.projects, "project")} · ${totals.paused} paused`} />
      <Tile id="agents" title="Agents now" value={<>{totals.workers + totals.reviewers} {small(`/ ${totals.slots} slots`)}</>} note={`${plural(totals.workers, "worker")} · ${plural(totals.reviewers, "reviewer")}`} />
      <Tile id="done" title="Done, 7 days" value={String(totals.doneLast7)}>
        <Spark values={totals.doneByDay} label="Tickets done per day across projects, last 14 days" />
      </Tile>
      <Tile id="needs" title="Needs you" value={String(home.needsYou.length)} />
      <Tile id="tokens" title="Tokens (sampled)" value={count(totals.tokens)} note={totals.perDoneTicket === null ? "no done ticket yet" : `${count(Math.round(totals.perDoneTicket))} per done ticket`} />
    </div>
  );
}

function NeedText({ item }: { item: NeedItem }) {
  const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;
  if (item.kind === "blocked") return <><b>{item.key}</b> is blocked {muted(`· ${item.project} · ${item.text}`)}</>;
  if (item.kind === "paused") return <><b>{item.project}</b> paused by Loom {muted(`· ${item.text}`)}</>;
  return <><b>{item.project}</b> {item.text}</>;
}

function NeedsYou({ home, go }: { home: HomeView; go(subPath: string): void }) {
  const action = (item: NeedItem): { label: string; to: string } => {
    if (item.kind === "blocked") return { label: "Open ticket", to: `${item.slug}/${item.key}` };
    if (item.kind === "approve") return { label: "Review and approve", to: item.slug };
    if (item.kind === "land") return { label: "Land", to: item.slug };
    const pending = item.kind === "pending" ? home.projects.find((project) => project.slug === item.slug)?.pendingVersion : null;
    return { label: pending == null ? "Open" : `Approve v${pending}`, to: item.slug };
  };
  return (
    <section aria-label="Needs you" className={`${CARD} mx-4 mt-3`}>
      <h2 className={HEADING}>Needs you</h2>
      {home.needsYou.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Nothing needs you right now.</p>
      ) : (
        <ul className="mt-1">
          {home.needsYou.map((item) => {
            const { label, to } = action(item);
            return (
              <li key={`${item.kind}:${item.slug}:${item.key ?? ""}`} data-need={item.kind} className="flex items-center gap-3 border-t border-border-seam py-2 first:border-t-0">
                <span aria-hidden className={`w-4 shrink-0 text-center ${NEED_ICONS[item.kind].tone}`}>{NEED_ICONS[item.kind].glyph}</span>
                <span className="min-w-0 flex-1 text-sm">
                  <NeedText item={item} />
                </span>
                <button type="button" className={BUTTON} onClick={() => go(to)}>
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ProjectRow({ project, now, go }: { project: HomeProject; now: number; go(subPath: string): void }) {
  const { progress } = project;
  const queued = Math.max(0, progress.total - progress.done - progress.inFlight - progress.blocked);
  const parts = [
    { label: `${progress.done} of ${progress.total} done`, value: progress.done, swatch: DONE },
    { label: `${progress.inFlight} in flight`, value: progress.inFlight, swatch: IN_FLIGHT },
    { label: `${progress.blocked} blocked`, value: progress.blocked, swatch: BLOCKED },
    { label: `${queued} queued`, value: queued, swatch: WAITING },
  ].filter((part, index) => index === 0 || part.value > 0);
  return (
    <tr data-project-row={project.slug} onClick={() => go(project.slug)} className="cursor-pointer border-t border-border-seam hover:bg-state-hover">
      <td className={CELL}>
        <button type="button" className="cursor-pointer text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <span className="text-sm font-medium">{project.name}</span> <span className="text-xs text-muted-foreground">{project.key}</span>
        </button>
        <span className="block text-xs text-muted-foreground">{mergeLabel(project)} · {countsLabel(project.ticketCounts)}</span>
        {project.reason !== null && <span className="block text-xs text-warning-text">{project.reason}</span>}
      </td>
      <td className={CELL}>
        <StateBadge state={project.state} />
      </td>
      <td className={`${CELL} min-w-40`}>{progress.total === 0 ? <span className="text-xs text-muted-foreground">—</span> : <ShareBar label="Progress" parts={parts} />}</td>
      <td data-project-agents className={`${CELL} tabular-nums`}>{project.agents}</td>
      <td className={CELL}>
        <Spark values={project.throughput} label={`${project.name}: tickets done per day, last 14 days`} />
      </td>
      <td data-project-tokens className={`${CELL} whitespace-nowrap tabular-nums`}>{project.maxTokens === null ? count(project.tokens) : `${count(project.tokens)} / ${count(project.maxTokens)}`}</td>
      <td className={`${CELL} whitespace-nowrap text-xs text-muted-foreground`}>{project.lastEventAt === null ? "—" : `${formatDuration(now - project.lastEventAt)} ago`}</td>
    </tr>
  );
}

const HIDE_KEY = "loom.home.hideFinished";

// Storage can be unavailable: then the switch starts off and is not remembered.
function savedHideFinished(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveHideFinished(hide: boolean): void {
  try {
    localStorage.setItem(HIDE_KEY, String(hide));
  } catch {}
}

/** The projects the table shows: done and archived ones left out when `hideFinished`, and those whose name, key or slug contains the query. */
function visibleProjects(projects: HomeProject[], hideFinished: boolean, query: string): HomeProject[] {
  const needle = query.trim().toLowerCase();
  return projects.filter(
    (project) =>
      !(hideFinished && (project.state === "done" || project.state === "archived")) &&
      (needle === "" || [project.name, project.key, project.slug].some((text) => text.toLowerCase().includes(needle))),
  );
}

/** The Loom page's start: the guide while there is nothing yet, else the overview, the planning conversations and the projects. */
export function Home({ go }: { go(subPath: string): void }) {
  const home = useRemote((rpc) => rpc.call("home"), "home", null);
  const planning = useRemote((rpc) => rpc.call("planning"), "planning", null);
  const [hideFinished, setHideFinished] = useState(savedHideFinished);
  const [query, setQuery] = useState("");
  const error = home.error ?? planning.error;
  if (home.data === null || planning.data === null) {
    return error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading projects…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load the projects: {error}</p>;
  }
  // A conversation whose thread proposed already shows as its draft project.
  const sessions = planning.data.filter((session) => session.slug === null);
  if (home.data.projects.length === 0 && sessions.length === 0) return <Guide onStart={() => go("_new")} />;
  const shown = visibleProjects(home.data.projects, hideFinished, query);

  return (
    <div className="pb-4">
      <div className="flex items-center justify-end gap-2 border-b border-border-seam px-4 py-2">
        <button type="button" className={BUTTON} onClick={() => go("_guide")}>
          How Loom works
        </button>
        <button type="button" className={BUTTON_PRIMARY} onClick={() => go("_new")}>
          New project
        </button>
      </div>
      <Tiles home={home.data} />
      <NeedsYou home={home.data} go={go} />
      {sessions.length > 0 && (
        <section aria-label="Planning" className={`${CARD} mx-4 mt-3`}>
          <h2 className={HEADING}>Planning</h2>
          {sessions.map((session) => (
            <div key={session.threadId} data-planning-row={session.threadId} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{session.title}</span>
                <span className="text-xs text-muted-foreground">planner is asking questions · started {formatDuration(Math.max(0, Date.now() - session.startedAt))} ago</span>
              </span>
              <button type="button" className={BUTTON} onClick={() => go(`_plan/${session.threadId}`)}>
                Continue
              </button>
            </div>
          ))}
        </section>
      )}
      <section aria-label="Projects" className={`${CARD} mx-4 mt-3 overflow-x-auto p-0`}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border-seam px-3 py-2">
          <input type="search" aria-label="Search projects" placeholder="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} className={`${FIELD} max-w-64`} />
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={hideFinished}
              onChange={(event) => {
                setHideFinished(event.target.checked);
                saveHideFinished(event.target.checked);
              }}
            />
            Hide done and archived
          </label>
        </div>
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              {["Project", "State", "Progress", "Agents", "Throughput 14d", "Tokens", "Last event"].map((heading) => (
                <th key={heading} className={`${CELL} font-normal`}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {home.data.projects.length > 0 && shown.length === 0 && (
              <tr>
                <td colSpan={7} data-projects-empty className={`${CELL} text-xs text-muted-foreground`}>
                  {query.trim() === "" ? "Every project is done or archived." : `No project matches "${query.trim()}".`}
                </td>
              </tr>
            )}
            {shown.map((project) => (
              <ProjectRow key={project.slug} project={project} now={home.data!.now} go={go} />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
