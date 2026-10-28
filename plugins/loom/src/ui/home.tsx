import { useState, type ReactNode } from "react";
import type { HomeProject, HomeView, NeedItem, PlanningSession } from "../contract";
import { formatDuration, plural } from "../format";
import { ShareBar, Spark, type Swatch } from "./charts";
import { BUTTON, BUTTON_PRIMARY, CARD, FIELD, HEADING, StateBadge, countsLabel, mergeLabel, useLoom } from "./common";
import { Guide } from "./guide";

const DONE: Swatch = { fill: "var(--success, currentColor)" };
const IN_FLIGHT: Swatch = { fill: "var(--primary, currentColor)" };
const BLOCKED: Swatch = { fill: "var(--destructive, currentColor)" };
const WAITING: Swatch = { fill: "var(--muted-foreground, currentColor)", opacity: 0.35 };
type Attention = NeedItem["kind"] | "planning";
const NEED_ICONS: Record<Attention, { glyph: string; tone: string }> = {
  blocked: { glyph: "!", tone: "text-destructive-text" },
  approve: { glyph: "✎", tone: "text-warning-text" },
  pending: { glyph: "✎", tone: "text-warning-text" },
  land: { glyph: "↑", tone: "text-success" },
  paused: { glyph: "⏸", tone: "text-warning-text" },
  planning: { glyph: "?", tone: "text-warning-text" },
};
/** Most urgent first; a row sorts by its most urgent need. */
const RANK: Record<Attention, number> = { blocked: 0, paused: 1, approve: 2, pending: 2, planning: 2, land: 3 };
const ACCENT: Record<Attention, string> = {
  blocked: "border-l-destructive",
  paused: "border-l-warning",
  approve: "border-l-warning",
  pending: "border-l-warning",
  planning: "border-l-warning",
  land: "border-l-success",
};
// The accent of a row's most urgent need, along the left of its card on a narrow page.
const CARD_ACCENT: Record<Attention, string> = {
  blocked: "@max-xl/loom:shadow-[inset_3px_0_0_var(--destructive)]",
  paused: "@max-xl/loom:shadow-[inset_3px_0_0_var(--warning)]",
  approve: "@max-xl/loom:shadow-[inset_3px_0_0_var(--warning)]",
  pending: "@max-xl/loom:shadow-[inset_3px_0_0_var(--warning)]",
  planning: "@max-xl/loom:shadow-[inset_3px_0_0_var(--warning)]",
  land: "@max-xl/loom:shadow-[inset_3px_0_0_var(--success)]",
};
const MAX_CHIPS = 3;
const CALM = 9;
const COLUMNS = ["Project", "State", "Needs you", "Progress", "Agents", "Throughput 14d", "Tokens", "Last event"];
const count = (value: number) => value.toLocaleString("en-US");
const CELL = "px-3 py-2 align-middle @max-xl/loom:block @max-xl/loom:p-0";
// On a narrow page: a card of name and summary beside the state, then what needs you and the progress; the rest hides.
const CARD_ROW = "@max-xl/loom:grid @max-xl/loom:grid-cols-[minmax(0,1fr)_auto] @max-xl/loom:gap-x-3 @max-xl/loom:gap-y-1.5 @max-xl/loom:px-3 @max-xl/loom:py-2.5";
const FULL = "@max-xl/loom:col-span-2";
const WIDE_ONLY = "@max-xl/loom:hidden";
const CHIP = "inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border border-current px-2 text-[11px] leading-[18px] whitespace-nowrap hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export type Row = { kind: "project"; project: HomeProject; needs: NeedItem[] } | { kind: "planning"; session: PlanningSession };

function Tile({ id, title, value, note, attention = false, children }: { id: string; title: string; value: ReactNode; note?: string; attention?: boolean; children?: ReactNode }) {
  return (
    <div data-home-tile={id} className={`rounded-md border p-3 ${attention ? "border-warning" : "border-border-seam"}`}>
      <h3 className={HEADING}>{title}</h3>
      <p data-tile-value className={`mt-1 text-xl font-semibold ${attention ? "text-warning-text" : ""}`}>{value}</p>
      {note !== undefined && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
      {children}
    </div>
  );
}

/** "across 3 projects · 2 blocked"; undefined when nothing needs you. */
function needsNote(needs: readonly NeedItem[]): string | undefined {
  if (needs.length === 0) return undefined;
  const blocked = needs.filter((need) => need.kind === "blocked").length;
  return `across ${plural(new Set(needs.map((need) => need.slug)).size, "project")}${blocked > 0 ? ` · ${blocked} blocked` : ""}`;
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
      <Tile id="needs" title="Needs you" value={String(home.needsYou.length)} note={needsNote(home.needsYou)} attention={home.needsYou.length > 0} />
      <Tile id="tokens" title="Tokens (sampled)" value={count(totals.tokens)} note={totals.perDoneTicket === null ? "no done ticket yet" : `${count(Math.round(totals.perDoneTicket))} per done ticket`} />
    </div>
  );
}

const rankOf = (row: Row) => (row.kind === "planning" ? RANK.planning : row.needs[0] === undefined ? CALM : RANK[row.needs[0].kind]);
const attentionOf = (row: Row): Attention | null => (row.kind === "planning" ? "planning" : (row.needs[0]?.kind ?? null));

/** Rows that need you first, by their most urgent need, then the rest in the server's order; finished projects that need nothing apart. */
export function homeRows(home: HomeView, sessions: PlanningSession[]): { active: Row[]; finished: HomeProject[] } {
  const active: Row[] = [];
  const finished: HomeProject[] = [];
  for (const project of home.projects) {
    // Most urgent first, so the chip cap never hides a blocked ticket; the server's newest-first order holds within a rank.
    const needs = home.needsYou.filter((need) => need.slug === project.slug).sort((x, y) => RANK[x.kind] - RANK[y.kind]);
    if (needs.length === 0 && (project.state === "done" || project.state === "archived")) finished.push(project);
    else active.push({ kind: "project", project, needs });
  }
  for (const session of sessions) active.push({ kind: "planning", session });
  return { active: active.sort((x, y) => rankOf(x) - rankOf(y)), finished };
}

const matches = (texts: readonly string[], needle: string) => needle === "" || texts.some((text) => text.toLowerCase().includes(needle));

function chipOf(project: HomeProject, need: NeedItem): { label: string; title: string; to: string } {
  if (need.kind === "blocked") return { label: `${need.key} blocked`, title: `${need.key} is blocked: ${need.text}`, to: `${need.slug}/${need.key}` };
  if (need.kind === "approve") return { label: "Review draft", title: `${project.name} ${need.text}`, to: need.slug };
  if (need.kind === "pending") return { label: project.pendingVersion === null ? "Approve" : `Approve v${project.pendingVersion}`, title: need.text, to: need.slug };
  if (need.kind === "land") return { label: "Ready to land", title: `${project.name} ${need.text}`, to: need.slug };
  return { label: "Paused by Loom", title: need.text, to: need.slug };
}

function Chip({ kind, label, title, onClick }: { kind: Attention; label: string; title: string; onClick(): void }) {
  return (
    <button
      type="button"
      data-need={kind}
      title={title}
      className={`${CHIP} ${NEED_ICONS[kind].tone}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <span aria-hidden>{NEED_ICONS[kind].glyph}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function NeedChips({ project, needs, go }: { project: HomeProject; needs: NeedItem[]; go(subPath: string): void }) {
  if (needs.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const more = needs.length - MAX_CHIPS;
  return (
    <span className="flex flex-wrap gap-1">
      {needs.slice(0, MAX_CHIPS).map((need) => {
        const chip = chipOf(project, need);
        return <Chip key={`${need.kind}:${need.key ?? ""}`} kind={need.kind} label={chip.label} title={chip.title} onClick={() => go(chip.to)} />;
      })}
      {more > 0 && (
        <button
          type="button"
          className={`${CHIP} text-muted-foreground`}
          onClick={(event) => {
            event.stopPropagation();
            go(project.slug);
          }}
        >
          +{more} more
        </button>
      )}
    </span>
  );
}

const accentOf = (attention: Attention | null) => `border-l-[3px] @max-xl/loom:border-l-0 ${attention === null ? "border-l-transparent" : ACCENT[attention]}`;
const cardAccentOf = (attention: Attention | null) => (attention === null ? "" : CARD_ACCENT[attention]);

function ProjectRow({ project, needs, now, go }: { project: HomeProject; needs: NeedItem[]; now: number; go(subPath: string): void }) {
  const { progress } = project;
  const attention = attentionOf({ kind: "project", project, needs });
  const queued = Math.max(0, progress.total - progress.done - progress.inFlight - progress.blocked);
  const parts = [
    { label: `${progress.done} of ${progress.total} done`, value: progress.done, swatch: DONE },
    { label: `${progress.inFlight} in flight`, value: progress.inFlight, swatch: IN_FLIGHT },
    { label: `${progress.blocked} blocked`, value: progress.blocked, swatch: BLOCKED },
    { label: `${queued} queued`, value: queued, swatch: WAITING },
  ].filter((part, index) => index === 0 || part.value > 0);
  return (
    <tr data-project-row={project.slug} data-attention={attention ?? undefined} onClick={() => go(project.slug)} className={`cursor-pointer border-t border-border-seam hover:bg-state-hover ${CARD_ROW} ${cardAccentOf(attention)}`}>
      <td className={`${CELL} ${accentOf(attention)}`}>
        <button type="button" data-project-name className="max-w-full min-w-0 cursor-pointer text-left [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <span className="text-sm font-medium">{project.name}</span> <span className="text-xs text-muted-foreground">{project.key}</span>
        </button>
        {/* A zero-minimum track, so the summary truncates at the cell's width instead of widening the table. */}
        <span className="grid grid-cols-[minmax(0,1fr)]">
          <span data-project-summary title={project.about.summary ?? project.aboutPending?.summary ?? project.about.lead} className="truncate text-xs text-muted-foreground @max-xl/loom:line-clamp-2 @max-xl/loom:whitespace-normal">
            {project.about.summary ?? project.aboutPending?.summary ?? project.about.lead}
          </span>
        </span>
        <span className="block text-xs text-muted-foreground">{mergeLabel(project)} · {countsLabel(project.ticketCounts)}</span>
        {project.reason !== null && <span className="block text-xs text-warning-text [overflow-wrap:anywhere]">{project.reason}</span>}
      </td>
      <td className={`${CELL} @max-xl/loom:self-start`}>
        <StateBadge state={project.state} />
      </td>
      <td data-project-needs className={`${CELL} max-w-72 @max-xl/loom:max-w-none ${FULL} ${needs.length === 0 ? WIDE_ONLY : ""}`}>
        <NeedChips project={project} needs={needs} go={go} />
      </td>
      <td data-project-progress className={`${CELL} min-w-40 @max-xl/loom:min-w-0 ${FULL} ${progress.total === 0 ? WIDE_ONLY : ""}`}>{progress.total === 0 ? <span className="text-xs text-muted-foreground">—</span> : <ShareBar label="Progress" parts={parts} />}</td>
      <td data-project-agents className={`${CELL} tabular-nums ${WIDE_ONLY}`}>{project.agents}</td>
      <td className={`${CELL} ${WIDE_ONLY}`}>
        <Spark values={project.throughput} label={`${project.name}: tickets done per day, last 14 days`} />
      </td>
      <td data-project-tokens className={`${CELL} whitespace-nowrap tabular-nums ${WIDE_ONLY}`}>{project.maxTokens === null ? count(project.tokens) : `${count(project.tokens)} / ${count(project.maxTokens)}`}</td>
      <td className={`${CELL} whitespace-nowrap text-xs text-muted-foreground ${WIDE_ONLY}`}>{project.lastEventAt === null ? "—" : `${formatDuration(now - project.lastEventAt)} ago`}</td>
    </tr>
  );
}

/** A conversation whose planner has not proposed yet, as a row of the table. */
function PlanningRow({ session, go }: { session: PlanningSession; go(subPath: string): void }) {
  const open = () => go(`_plan/${session.threadId}`);
  const none = <span className="text-xs text-muted-foreground">—</span>;
  return (
    <tr data-planning-row={session.threadId} data-attention="planning" onClick={open} className={`cursor-pointer border-t border-border-seam hover:bg-state-hover ${CARD_ROW} ${cardAccentOf("planning")}`}>
      <td className={`${CELL} ${accentOf("planning")}`}>
        <span className="block text-sm font-medium [overflow-wrap:anywhere]">{session.title}</span>
        <span className="block text-xs text-muted-foreground">planner is asking questions · started {formatDuration(Math.max(0, Date.now() - session.startedAt))} ago</span>
      </td>
      <td className={`${CELL} @max-xl/loom:self-start`}>
        <StateBadge state="planning" />
      </td>
      <td data-project-needs className={`${CELL} ${FULL}`}>
        <Chip kind="planning" label="Continue planning" title="The planner is asking questions before it proposes a spec" onClick={open} />
      </td>
      {[0, 1, 2, 3, 4].map((index) => (
        <td key={index} className={`${CELL} ${WIDE_ONLY}`}>
          {none}
        </td>
      ))}
    </tr>
  );
}

const SHOW_FINISHED_KEY = "loom.home.showFinished";

// Storage can be unavailable: then the group starts folded and is not remembered.
function savedShowFinished(): boolean {
  try {
    return localStorage.getItem(SHOW_FINISHED_KEY) === "true";
  } catch {
    return false;
  }
}

function saveShowFinished(show: boolean): void {
  try {
    localStorage.setItem(SHOW_FINISHED_KEY, String(show));
  } catch {}
}

/** The Loom page's start: the guide while there is nothing yet, else the tiles and one table of every project and planning conversation. */
export function Home({ go }: { go(subPath: string): void }) {
  const home = useLoom("home", null);
  const planning = useLoom("planning", null);
  const [showFinished, setShowFinished] = useState(savedShowFinished);
  const [query, setQuery] = useState("");
  const error = home.error ?? planning.error;
  if (home.data === undefined || planning.data === undefined) {
    return error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading projects…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load the projects: {error}</p>;
  }
  // A conversation whose thread proposed already shows as its draft project.
  const sessions = planning.data.filter((session) => session.slug === null);
  if (home.data.projects.length === 0 && sessions.length === 0) return <Guide onStart={() => go("_new")} />;
  const needle = query.trim().toLowerCase();
  const rows = homeRows(home.data, sessions);
  const active = rows.active.filter((row) => matches(row.kind === "planning" ? [row.session.title] : [row.project.name, row.project.key, row.project.slug], needle));
  const finished = rows.finished.filter((project) => matches([project.name, project.key, project.slug], needle));
  // Searching, or with nothing active, the finished projects are what there is to see.
  const forced = needle !== "" || rows.active.length === 0;
  const finishedOpen = forced || showFinished;
  const empty = active.length === 0 ? (needle !== "" && finished.length === 0 ? `No project matches "${query.trim()}".` : needle === "" ? "Every project is done or archived." : null) : null;
  const toggle = () => {
    setShowFinished(!showFinished);
    saveShowFinished(!showFinished);
  };

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
      <section aria-label="Projects" className={`${CARD} mx-4 mt-3 overflow-x-auto p-0`}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border-seam px-3 py-2">
          <input type="search" aria-label="Search projects" placeholder="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} className={`${FIELD} max-w-64`} />
        </div>
        <table data-projects-table className="w-full min-w-[860px] text-left text-sm @max-xl/loom:block @max-xl/loom:min-w-0">
          <thead className={`text-xs text-muted-foreground ${WIDE_ONLY}`}>
            <tr>
              {COLUMNS.map((heading) => (
                <th key={heading} className={`${CELL} font-normal`}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody className="@max-xl/loom:block">
            {empty !== null && (
              <tr className={CARD_ROW}>
                <td colSpan={COLUMNS.length} data-projects-empty className={`${CELL} ${FULL} text-xs text-muted-foreground`}>
                  {empty}
                </td>
              </tr>
            )}
            {active.map((row) =>
              row.kind === "planning" ? <PlanningRow key={row.session.threadId} session={row.session} go={go} /> : <ProjectRow key={row.project.slug} project={row.project} needs={row.needs} now={home.data!.now} go={go} />,
            )}
          </tbody>
          {finished.length > 0 && (
            <tbody data-finished className="@max-xl/loom:block">
              <tr className={`border-t border-border-seam ${CARD_ROW}`}>
                <td colSpan={COLUMNS.length} className={`${CELL} ${FULL}`}>
                  {forced ? (
                    <span className={HEADING}>Finished · {finished.length}</span>
                  ) : (
                    <button type="button" aria-expanded={finishedOpen} onClick={toggle} className={`${HEADING} cursor-pointer rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}>
                      {finishedOpen ? "▾" : "▸"} Finished · {finished.length}
                    </button>
                  )}
                </td>
              </tr>
              {finishedOpen && finished.map((project) => <ProjectRow key={project.slug} project={project} needs={[]} now={home.data!.now} go={go} />)}
            </tbody>
          )}
        </table>
      </section>
    </div>
  );
}
