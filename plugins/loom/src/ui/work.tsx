// Work: the tickets by whose move it is, beside the pane. With nothing open the pane shows the phase and its map (or,
// on an unphased project, what unblocks the most); with a ticket open the list turns compact and the ticket takes the
// pane. Map shows the same tickets as a picture, with the exact list one switch away. The view stays mounted while
// tickets open and close, so the list keeps its filter, folds and scroll, and the map keeps focus on the node chosen.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { BoardCard, ProjectView } from "../contract";
import { isMultiRepoProject } from "../format";
import { AboutStrip } from "./about";
import { BUTTON, RepoChip, TAP, useNow } from "./common";
import { depIndex, isOpen, type DepIndex } from "./deps";
import { confirmHold, shipConsequences } from "./ship-readiness";
import { ExactList, HopMap, PhaseMap, ProjectMap, doneText, type MapPicture } from "./dep-map";
import { STATE_WORDS } from "./groups";
import { HealthStrip } from "./health";
import { mapFileName, scopeText, whenText } from "./map-export";
import { MapExport, type ExportDescription } from "./map-export-ui";
import { Disclosure, Menu, MenuItem, MenuSeparator, Tip } from "./kit";
import { StateMark } from "./marks";
import { consequenceText } from "./readiness";
import { PHONE_TEXT } from "./narrow";
import { createStoredMap, useStored } from "./remember";
import { TicketView } from "./ticket";
import { projectViews } from "./views";
import { GroupedRows, onListKeys, rowsOf } from "./work-list";

type Mode = "list" | "map";
export const workModes = createStoredMap<Mode>("workMode", 50, (value): value is Mode => value === "list" || value === "map");
/** Map's Show done, per project, once the person has set it; until then it is on only while nothing is open. */
export const mapShowDone = createStoredMap<boolean>("mapShowDone", 50, (value): value is boolean => typeof value === "boolean");

const CARD = "loom-card loom-selvedge min-w-0 rounded-md pl-1.5";
const TOGGLE = `inline-flex h-7 cursor-pointer items-center gap-1 px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`;

/** The project's pull request on an integration project, or each repo's on a multi-repo one. */
function PullRequests({ view }: { view: ProjectView }) {
  const navigate = useBbNavigate();
  const { overview } = view;
  const repos = isMultiRepoProject(overview) ? overview.repos.filter((repo) => repo.prUrl !== null) : [];
  if (view.prUrl === null && repos.length === 0) return null;
  return (
    <div data-repo-prs={repos.length > 0 ? "" : undefined} className="grid grid-cols-1 gap-1 px-3 text-xs text-[var(--loom-muted)]">
      <span className="font-semibold">Pull requests</span>
      {view.prUrl !== null && (
        <button type="button" className="text-left text-foreground underline [overflow-wrap:anywhere]" onClick={() => navigate.openUrl(view.prUrl!)}>
          {view.prUrl}
        </button>
      )}
      {repos.map((repo) => (
        <span key={repo.name} className="inline-flex min-w-0 items-center gap-1.5">
          <RepoChip name={repo.name!} />
          <button type="button" aria-label={`Open the pull request in ${repo.name}`} className="min-w-0 text-left text-foreground underline [overflow-wrap:anywhere]" onClick={() => navigate.openUrl(repo.prUrl!)}>
            {repo.prUrl}
          </button>
        </span>
      ))}
    </div>
  );
}

function ModeToggle({ mode, onMode }: { mode: Mode; onMode(mode: Mode): void }) {
  return (
    <div role="group" aria-label="Work as" data-work-mode className="inline-flex overflow-hidden rounded-md border border-[var(--loom-line)]">
      {(["list", "map"] as const).map((one) => (
        <Tip key={one} text={one === "list" ? "List" : "Map"} keys="m">
          <button type="button" aria-pressed={mode === one} onClick={() => onMode(one)} className={`${TOGGLE} @max-xl/loom:min-w-11 pointer-coarse:min-w-11 @max-xl/loom:justify-center ${mode === one ? "bg-[var(--loom-sel)] font-semibold text-foreground" : "text-[var(--loom-muted)] hover:text-foreground"}`}>
            <Icon name={one === "list" ? "ListView" : "Workflow"} aria-hidden className="size-3.5" />
            <span className="@max-xl/loom:sr-only">{one === "list" ? "List" : "Map"}</span>
          </button>
        </Tip>
      ))}
    </div>
  );
}

interface Filter {
  text: string;
  states: ReadonlySet<string>;
  repo: string | null;
}

const matches = (card: BoardCard, filter: Filter, word: (card: BoardCard) => string) => {
  const text = filter.text.trim().toLowerCase();
  if (text !== "" && !card.key.toLowerCase().includes(text) && !card.title.toLowerCase().includes(text)) return false;
  if (filter.states.size > 0 && !filter.states.has(word(card))) return false;
  return filter.repo === null || card.repo === filter.repo;
};

function FilterTools({ cards, filter, onFilter, word, repos }: { cards: readonly BoardCard[]; filter: Filter; onFilter(next: Filter): void; word(card: BoardCard): string; repos: string[] }) {
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(word(card), (counts.get(word(card)) ?? 0) + 1);
  const on = filter.states.size + (filter.repo === null ? 0 : 1);
  const [opened, setOpened] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // A filter in force keeps its row open, so what hides tickets stays in view.
  const active = on > 0 || filter.text !== "";
  const open = opened || active;
  const toggle = () => {
    if (open && !active) return setOpened(false);
    setOpened(true);
    requestAnimationFrame(() => input.current?.focus());
  };
  return (
    <>
      <span className="hidden @max-xl/loom:contents">
        <button type="button" aria-expanded={open} aria-label={active ? `Filter, ${on + (filter.text === "" ? 0 : 1)} on` : "Filter"} onClick={toggle} className={`${TOGGLE} min-w-11 justify-center rounded-md border border-[var(--loom-line)] text-[var(--loom-muted)] hover:text-foreground ${open ? "bg-[var(--loom-sel)] text-foreground" : ""}`}>
          <Icon name="Search" aria-hidden className="size-3.5" />
        </button>
      </span>
      <span data-work-filters className={`contents ${open ? "@max-xl/loom:order-last @max-xl/loom:flex @max-xl/loom:basis-full @max-xl/loom:gap-2" : "@max-xl/loom:hidden"}`}>
      <label className="inline-flex h-7 min-w-0 flex-1 basis-32 items-center gap-1.5 @3xl/loom:max-w-48 rounded-md border border-[var(--loom-field-line)] px-2 focus-within:ring-2 focus-within:ring-ring @max-xl/loom:min-h-11 pointer-coarse:min-h-11">
        <Icon name="Search" aria-hidden className="size-3.5 shrink-0 text-[var(--loom-muted)]" />
        <span className="sr-only">Filter tickets</span>
        <input ref={input} data-work-filter value={filter.text} placeholder="Filter" onChange={(event) => onFilter({ ...filter, text: event.target.value })} className={`min-w-0 flex-1 self-stretch bg-transparent text-xs text-foreground outline-none placeholder:text-[var(--loom-muted)] ${PHONE_TEXT}`} />
      </label>
      <Menu
        label="Filter by state"
        align="start"
        trigger={
          <button type="button" aria-label={on > 0 ? `Filter, ${on} on` : "Filter by state"} className={`${TOGGLE} justify-center rounded-md @max-xl/loom:min-w-11 pointer-coarse:min-w-11 border border-[var(--loom-line)] text-[var(--loom-muted)] hover:text-foreground`}>
            <Icon name="Filter" aria-hidden className="size-3.5" />
            {on > 0 && <span className="loom-num text-foreground">{on}</span>}
          </button>
        }
      >
        {[...counts].map(([state, count]) => (
          <MenuItem key={state} icon={filter.states.has(state) ? "Check" : "Circle"} onSelect={() => onFilter({ ...filter, states: new Set(filter.states.has(state) ? [...filter.states].filter((one) => one !== state) : [...filter.states, state]) })}>
            {state} <span className="loom-num text-[var(--loom-muted)]">{count}</span>
          </MenuItem>
        ))}
        {repos.length > 1 && <MenuSeparator />}
        {repos.length > 1 &&
          repos.map((repo) => (
            <MenuItem key={repo} icon={filter.repo === repo ? "Check" : "FolderGit"} onSelect={() => onFilter({ ...filter, repo: filter.repo === repo ? null : repo })}>
              {repo}
            </MenuItem>
          ))}
        {on > 0 && <MenuSeparator />}
        {on > 0 && (
          <MenuItem icon="X" onSelect={() => onFilter({ ...filter, states: new Set(), repo: null })}>
            Clear filters
          </MenuItem>
        )}
      </Menu>
      </span>
    </>
  );
}

/** The tickets worth starting from on an unphased project: what unblocks the most, the longest chain, the most prerequisites. */
function FocusChooser({ index, scope, onOpen }: { index: DepIndex; scope: readonly BoardCard[]; onOpen(key: string): void }) {
  const open = scope.filter(isOpen).map((card) => ({ card, all: index.inAll(card.key).length, pre: index.prereqs(card.key).length }));
  const top = [...open].filter((one) => one.all > 0).sort((a, b) => b.all - a.all || b.pre - a.pre).slice(0, 5);
  const most = [...open].sort((a, b) => b.pre - a.pre)[0];
  const row = (card: BoardCard, value: ReactNode, tip: string) => (
    <li key={card.key}>
      <button type="button" onClick={() => onOpen(card.key)} className={`flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`}>
        <StateMark state={card.state} />
        <span className="shrink-0 font-mono text-xs font-semibold">{card.key}</span>
        <span className="min-w-0 flex-1 truncate">{card.title}</span>
        <span className="loom-num shrink-0 text-xs text-[var(--loom-muted)]" title={tip}>
          {value}
        </span>
      </button>
    </li>
  );
  const HEAD = "m-0 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--loom-muted)]";
  return (
    <section data-focus-chooser aria-label="Dependencies" className="grid grid-cols-1 gap-3 px-2 py-3">
      <h2 className="m-0 flex items-center gap-2 px-2 text-sm font-semibold">
        Dependencies <span className="text-xs font-normal text-[var(--loom-muted)]">{open.length} open</span>
      </h2>
      {top.length === 0 ? (
        <p className="m-0 px-2 text-xs text-[var(--loom-muted)]">No open ticket waits on another.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-1">
            <h3 className={HEAD}>Unblocks the most</h3>
            <ul className="m-0 grid list-none grid-cols-1 gap-px p-0">{top.map(({ card, all }) => row(card, `${all} in all`, `Unblocks ${all} open tickets in all`))}</ul>
          </div>
          {index.longest.length > 0 && (
            <div className="grid grid-cols-1 gap-1">
              <h3 className={HEAD}>Longest chain · {index.longest.length}</h3>
              <p className="m-0 flex flex-wrap items-center gap-1 px-2">
                {index.longest.map((key, at) => (
                  <span key={key} className="inline-flex items-center gap-1">
                    {at > 0 && <Icon name="ArrowRight" aria-hidden className="size-3 text-[var(--loom-muted)]" />}
                    <button type="button" onClick={() => onOpen(key)} className={`cursor-pointer rounded border border-[var(--loom-line)] px-1.5 font-mono text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`}>
                      {key}
                    </button>
                  </span>
                ))}
              </p>
            </div>
          )}
          {most !== undefined && most.pre > 1 && (
            <div className="grid grid-cols-1 gap-1">
              <h3 className={HEAD}>Most prerequisites</h3>
              <ul className="m-0 grid list-none grid-cols-1 p-0">{row(most.card, `${most.pre} waits`, `Waits on ${most.pre} tickets`)}</ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const chainOf = (index: DepIndex, onOpen: (key: string) => void) =>
  index.longest.length === 0 ? null : (
    <p data-longest-chain className="m-0 flex flex-wrap items-center gap-1 text-xs">
      <span className="text-[var(--loom-muted)]">Longest chain</span>
      {index.longest.map((key, at) => (
        <span key={key} className="inline-flex items-center gap-1">
          {at > 0 && <Icon name="ArrowRight" aria-hidden className="size-3 text-[var(--loom-muted)]" />}
          <button type="button" onClick={() => onOpen(key)} className="cursor-pointer rounded font-mono underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {key}
          </button>
        </span>
      ))}
    </p>
  );

export function WorkView({ view, at, ticketKey, go, onSeek, onChanges }: { view: ProjectView; at: number | null; ticketKey: string | null; go(subPath: string): void; onSeek(at: number | null): void; onChanges?: (id: string) => void }) {
  const { overview } = view;
  const slug = overview.slug;
  const modes = useStored(workModes);
  const mode: Mode = modes[slug] ?? "list";
  const setMode = (next: Mode) => workModes.put(slug, next);
  const [filter, setFilter] = useState<Filter>({ text: "", states: new Set(), repo: null });
  const [pane, setPane] = useState(false);
  const [exact, setExact] = useState(false);
  const [hops, setHops] = useState<1 | 2>(2);
  // Show done defaults from the project as it is now: rewound to a day it had open tickets, a finished project's map
  // keeps the whole picture and replays it, rather than switching to that day's default.
  const showDone = useStored(mapShowDone);
  const noneOpenNow = useRef<boolean | null>(null);
  if (at === null) noneOpenNow.current = view.board.length > 0 && !view.board.some(isOpen);
  const whole = showDone[slug] ?? noneOpenNow.current ?? (view.board.length > 0 && !view.board.some(isOpen));
  const root = useRef<HTMLDivElement>(null);
  const phases = view.phases;
  const active = phases?.find((phase) => phase.state === "active") ?? [...(phases ?? [])].reverse().find((phase) => phase.tickets.total > 0) ?? null;
  const phaseNumber = active === null ? 0 : phases!.indexOf(active) + 1;
  const index = useMemo(() => depIndex(view.board), [view.board]);
  // A draft's tickets are proposals: the maps and the exact list draw them, and open none.
  const draft = overview.state === "draft";
  // Ages tick between refreshes from the server's clock, as the ticket's do; rewound, they hold at that moment.
  const live = useNow(30_000);
  const fetched = useMemo(() => Date.now(), [view.now]);
  const now = at !== null ? view.now : view.now + Math.max(0, live - fetched);
  const scope = useMemo(() => (active === null ? view.board : view.board.filter((card) => card.phase === active.ref)), [view.board, active]);
  const entries = view.mergeOrder?.entries ?? [];
  const rows = useMemo(() => rowsOf(scope, overview.state, entries), [scope, overview.state, entries]);
  const groupWord = (card: BoardCard) => {
    const group = rows.find((row) => row.card.key === card.key)?.group;
    return group === "failed" ? "Failed" : STATE_WORDS[card.state];
  };
  const repos = isMultiRepoProject(overview) ? overview.repos.flatMap((repo) => (repo.name === null ? [] : [repo.name])) : [];
  const shown = rows.filter((row) => matches(row.card, filter, groupWord));
  const groups = new Set(shown.map((row) => row.group)).size;
  const compact = ticketKey !== null;
  const phased = active !== null;
  const scopeLabel = phased ? `Phase ${phaseNumber} ${active.title}` : "Every ticket";
  const open = (key: string) => go(`${slug}/${key}`);
  const close = () => go(slug);
  // A focus for the map when nothing is open: what needs the person, then what unblocks the most.
  const defaultFocus = rows.find((row) => row.group === "need")?.card.key ?? rows.find((row) => row.group === "ready")?.card.key ?? [...scope].filter(isOpen).sort((a, b) => index.inAll(b.key).length - index.inAll(a.key).length)[0]?.key ?? null;

  // Back from a ticket: the row it came from takes focus again, in view.
  const lastOpen = useRef<string | null>(ticketKey);
  useEffect(() => {
    const before = lastOpen.current;
    lastOpen.current = ticketKey;
    if (before === null || ticketKey !== null) return;
    const row = root.current?.querySelector<HTMLElement>(`[data-open-row="${before}"], [data-map-node="${before}"]`);
    if (row == null || (document.activeElement !== null && document.activeElement !== document.body && root.current?.contains(document.activeElement) !== true)) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest" });
  }, [ticketKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"], [role="radiogroup"], [data-confirm-armed]') !== null) return;
    if (event.key === "m") {
      event.preventDefault();
      setMode(mode === "list" ? "map" : "list");
    } else if (event.key === "d" && ticketKey === null) {
      event.preventDefault();
      setPane(!pane);
    }
  };

  const mergeThen = ticketKey === null ? null : consequenceText(ticketKey, shipConsequences(ticketKey, view.mergeOrder, view.board, view.rollout));
  const phaseOf = (key: string) => {
    const card = index.by.get(key);
    const number = card?.phase == null ? 0 : (phases?.findIndex((phase) => phase.ref === card.phase) ?? -1) + 1;
    return number > 0 ? `phase ${number}` : undefined;
  };
  const sideMap = (focus: string | null, compactMap: boolean) =>
    phased ? (
      <PhaseMap small fold center={focus ?? defaultFocus} still={draft} index={index} scope={scope} phases={phases} focus={focus} onPick={open} compact={compactMap} label={`${scopeLabel} dependencies${focus === null ? "" : `, ${focus} lit`}; the exact list in Map has every one`} />
    ) : focus === null ? null : (
      <HopMap still={draft} index={index} focus={focus} hops={1} onPick={open} wide={false} label={`${focus} and the tickets one step either way`} />
    );

  const ticketPane =
    ticketKey === null ? null : (
      <TicketView
        ticketKey={ticketKey}
        at={at}
        onNow={() => onSeek(null)}
        context={{
          index,
          phaseLabel: phaseOf(ticketKey),
          map: mode === "map" || !index.by.has(ticketKey) ? null : sideMap(ticketKey, true),
          mergeThen,
          mergeHold: ticketKey === null ? null : confirmHold(ticketKey, view.rollout),
          onOpen: open,
          onClose: close,
          onChanges: onChanges !== undefined && index.by.get(ticketKey)?.hasChanges === true ? () => onChanges(ticketKey) : undefined,
        }}
      />
    );

  const summary = (
    <>
      {phased ? (
        <section data-phase-summary aria-label={scopeLabel} className="grid grid-cols-1 gap-2 px-2.5 py-3">
          <h2 className="m-0 flex flex-wrap items-center gap-2 text-sm font-semibold">
            <span>Phase {phaseNumber}</span>
            <span className="font-normal">{active.title}</span>
            <span className="rounded-sm border border-[var(--loom-line)] px-1 text-[11px] font-normal text-[var(--loom-muted)]">{active.state}</span>
            <span className="flex-1" />
            {active.doneWhen.length > 0 && (
              <Disclosure
                label="Done when"
                align="end"
                trigger={
                  <button type="button" className={`${BUTTON} h-7`}>
                    Done when <span className="loom-num text-[var(--loom-muted)]">{active.doneWhen.length}</span>
                  </button>
                }
              >
                <ol className="m-0 grid list-decimal gap-1 pl-5 text-xs [overflow-wrap:anywhere]">
                  {active.doneWhen.map((line, at) => (
                    <li key={at}>{line}</li>
                  ))}
                </ol>
              </Disclosure>
            )}
          </h2>
          {active.goal !== "" && <p className="m-0 line-clamp-2 text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]" title={active.goal}>{active.goal}</p>}
          {chainOf(index, open)}
          {sideMap(null, false)}
        </section>
      ) : (
        <FocusChooser index={index} scope={scope} onOpen={open} />
      )}
      <div data-work-about className="grid gap-2 border-t border-[var(--loom-line)] pb-3 pt-1 [&_[data-about]]:mx-2.5 [&_[data-about]]:border-0 [&_[data-about]]:bg-transparent [&_[data-about]]:px-0">
        <AboutStrip overview={overview} onGoal={() => projectViews.put(slug, "spec")} />
        <PullRequests view={view} />
        {view.health !== null && <HealthStrip health={view.health} />}
      </div>
    </>
  );

  const empty = rows.length === 0;
  const listCard = (
    <section data-ticket-list aria-label={phased ? `${scopeLabel} tickets` : "Tickets"} className={`${CARD} self-start`} onKeyDown={onListKeys}>
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--loom-line)] px-2.5 py-2 @max-xl/loom:gap-1.5">
        {/* On a phone the title gives way, so the tools keep one row. */}
        <h2 className="m-0 flex min-w-0 items-baseline gap-1.5 text-sm font-semibold @max-xl/loom:flex-1 @max-xl/loom:overflow-hidden @max-xl/loom:whitespace-nowrap">
          {phased ? (
            <>
              <span className="shrink-0">Phase {phaseNumber}</span>
              <span className={`min-w-0 truncate font-normal text-[var(--loom-muted)] ${compact ? "max-w-40" : ""}`}>{active.title}</span>
            </>
          ) : (
            <>
              All tickets <span className="loom-num text-xs font-normal text-[var(--loom-muted)]">{scope.length}</span>
            </>
          )}
        </h2>
        <ModeToggle mode={mode} onMode={setMode} />
        {!compact && !empty && <FilterTools cards={scope} filter={filter} onFilter={setFilter} word={groupWord} repos={active === null ? repos : []} />}
        <span className="flex-1 @max-xl/loom:hidden" />
        {!compact && (
          <button type="button" aria-expanded={pane} aria-keyshortcuts="d" onClick={() => setPane(true)} aria-label="Dependencies" className={`${BUTTON} @4xl/loom:hidden`}>
            <Icon name="Workflow" aria-hidden className="size-3.5" />
            {/* The Map toggle beside it on a phone has the same picture, so a word tells them apart. */}
            <span className="@max-xl/loom:hidden">Dependencies</span>
            <span aria-hidden className="hidden @max-xl/loom:inline">Deps</span>
          </button>
        )}
      </header>
      {overview.state === "draft" && !empty && (
        <p data-draft-note className="m-0 border-b border-[var(--loom-line)] px-2.5 py-2 text-xs text-[var(--loom-muted)]">
          {`Draft v${view.spec.version}: approving creates ${view.board.length === 1 ? "this ticket" : `these ${view.board.length} tickets`}. Until then they are proposals, not tickets to open.`}
        </p>
      )}
      <div className="px-1 pb-2">
        {empty ? (
          <p role="status" data-empty className="m-0 px-2 py-6 text-sm text-[var(--loom-muted)]">
            {overview.state === "draft" ? "No tickets proposed yet: the planner is still writing the spec." : "No tickets yet."}
          </p>
        ) : shown.length === 0 ? (
          <div role="status" data-empty className="grid justify-items-start gap-2 px-2 py-6 text-sm text-[var(--loom-muted)]">
            No ticket matches
            <button type="button" className={BUTTON} onClick={() => setFilter({ text: "", states: new Set(), repo: null })}>
              Clear filters
            </button>
          </div>
        ) : (
          <GroupedRows rows={shown} index={index} projectState={overview.state} openKey={ticketKey} compact={compact} multiRepo={repos.length > 1 && active === null} now={now} onOpen={open} onDeps={open} />
        )}
      </div>
    </section>
  );

  const mapFocus = ticketKey ?? (phased ? null : defaultFocus);
  // The map the stage draws leaves its picture here, for Export to turn into an image.
  const picture = useRef<MapPicture | null>(null);
  const hasMap = !exact && (whole ? view.board.length > 0 : phased ? scope.length > 0 : mapFocus !== null);
  const describe = (tickets: readonly BoardCard[]): ExportDescription => {
    const shown = at !== null ? view.now : Date.now();
    const kind = whole ? ({ kind: "whole" } as const) : phased ? ({ kind: "phase", number: phaseNumber, of: phases!.length, title: active.title } as const) : ({ kind: "hops", focus: mapFocus!, hops, total: view.board.length } as const);
    return {
      header: { key: overview.key, name: overview.name, scope: scopeText(kind, tickets, draft ? { version: view.spec.version } : null), when: whenText(shown, at !== null) },
      fileName: (ext) => mapFileName(overview.key, kind, shown, ext, draft),
    };
  };
  const mapCard = (
    <section data-map-stage data-map-whole={whole ? "" : undefined} aria-label={whole ? "Whole project map" : phased ? `${scopeLabel} map` : "Focus and hops"} className={`${CARD} self-start`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--loom-line)] px-2.5 py-2">
        <h2 className="m-0 flex min-w-0 items-baseline gap-1.5 text-sm font-semibold">
          {whole ? "Whole project" : phased ? `Phase ${phaseNumber}` : "Focus and hops"}
          <span className="min-w-0 truncate font-normal text-[var(--loom-muted)]">{whole ? doneText(view.board) : phased ? active.title : (mapFocus ?? "")}</span>
        </h2>
        <ModeToggle mode={mode} onMode={setMode} />
        {!whole && !phased && !exact && (
          <div role="group" aria-label="Hops" className="inline-flex overflow-hidden rounded-md border border-[var(--loom-line)]">
            {([1, 2] as const).map((n) => (
              <button key={n} type="button" aria-pressed={hops === n} onClick={() => setHops(n)} className={`${TOGGLE} ${hops === n ? "bg-[var(--loom-sel)] font-semibold text-foreground" : "text-[var(--loom-muted)]"}`}>
                {n === 1 ? "1 hop" : "2 hops"}
              </button>
            ))}
          </div>
        )}
        <label className={`inline-flex min-h-6 cursor-pointer items-center gap-1.5 text-xs ${TAP}`}>
          <input type="checkbox" role="switch" checked={exact} onChange={(event) => setExact(event.target.checked)} className="size-4 accent-[var(--primary)]" />
          Exact list
        </label>
        <label className={`inline-flex min-h-6 cursor-pointer items-center gap-1.5 text-xs ${TAP}`}>
          <input type="checkbox" role="switch" checked={whole} onChange={(event) => mapShowDone.put(slug, event.target.checked)} className="size-4 accent-[var(--primary)]" />
          Show done
        </label>
        {hasMap && (
          <span className="ml-auto inline-flex">
            <MapExport pictureRef={picture} describe={describe} />
          </span>
        )}
      </header>
      <div className="p-2.5">
        {exact ? (
          whole ? (
            <ExactList closed still={draft} index={index} scope={view.board} scopeLabel="Every ticket" focus={ticketKey} onPick={open} phaseOf={phased ? (key) => phaseOf(key)?.replace(/^phase /, "") : undefined} />
          ) : (
            <ExactList still={draft} index={index} scope={scope} scopeLabel={scopeLabel} focus={ticketKey} onPick={open} />
          )
        ) : whole ? (
          <ProjectMap pictureRef={picture} still={draft} index={index} board={view.board} phases={phases} focus={ticketKey} onPick={open} label={`Every ticket${phased ? " by phase" : ""}, done included; arrows move along the edges, Enter opens a ticket`} />
        ) : phased ? (
          <PhaseMap pictureRef={picture} still={draft} index={index} scope={scope} phases={phases} focus={ticketKey} onPick={open} label={`${scopeLabel} dependencies; arrows move along the edges, Enter opens a ticket`} />
        ) : mapFocus === null ? (
          <p role="status" className="m-0 py-6 text-sm text-[var(--loom-muted)]">
            No open tickets.
          </p>
        ) : (
          <HopMap pictureRef={picture} still={draft} index={index} focus={mapFocus} hops={hops} onPick={open} label={`${mapFocus} and its hops; arrows move along the edges, Enter opens a ticket`} />
        )}
      </div>
    </section>
  );

  const main = mode === "map" ? mapCard : listCard;
  const side = ticketPane ?? (mode === "map" ? null : summary);
  const sideOpen = ticketPane !== null || pane;
  const columns = ticketPane !== null ? (mode === "map" ? "@4xl/loom:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]" : "@4xl/loom:grid-cols-[300px_minmax(0,1fr)] @6xl/loom:grid-cols-[340px_minmax(0,1fr)]") : side === null ? "" : "@4xl/loom:grid-cols-[minmax(0,1fr)_minmax(340px,1fr)]";
  return (
    <div ref={root} data-work data-work-as={mode} className={`grid items-start gap-4 ${columns}`} onKeyDown={onKeyDown}>
      <div className={`min-w-0 ${sideOpen ? "@max-4xl/loom:hidden" : ""}`}>{main}</div>
      {side !== null && (
        <aside data-work-pane aria-label={ticketKey ?? (phased ? "Phase and dependencies" : "Dependencies")} className={`${CARD} min-w-0 p-2.5 pl-4 ${sideOpen ? "" : "@max-4xl/loom:hidden"}`}>
          {(ticketKey !== null || pane) && (
            <button type="button" onClick={() => (ticketKey !== null ? close() : setPane(false))} className={`${BUTTON} mb-2 @4xl/loom:hidden`}>
              <Icon name="ChevronLeft" aria-hidden className="size-3.5" />
              Back to {mode === "map" ? "the map" : "the list"}
            </button>
          )}
          {side}
        </aside>
      )}
    </div>
  );
}

