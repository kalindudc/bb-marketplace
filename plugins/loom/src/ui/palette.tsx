// The page's Jump to palette (`/`): the next thing that needs you, every need, the open project's tickets and views, every
// project, and the page's own places. Arrows move, Enter runs, Escape closes; every row is navigation, so a rewound page
// can use it too, and anything a row would change goes through the same guarded controls as the page.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useLoom } from "./common";
import { keysSheet, palette, useStore } from "./dispatch";
import { KBD, Sheet } from "./kit";
import type { Route } from "./page";
import { QUEUE_ICON, QUEUE_WORD, needRoute, useQueue } from "./needs";
import { VIEWS, projectViews } from "./views";

interface Row {
  group: string;
  icon: string;
  label: string;
  run(): void;
  attention?: boolean;
}

export function Palette({ route, go }: { route: Route; go(subPath: string): void }) {
  const open = useStore(palette);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Set by an arrow key, so the option it chose is brought into view; a pointer over a row leaves the list where it is.
  const moved = useRef(false);
  const home = useLoom("home", null, { enabled: open }).data;
  const queue = useQueue(home);
  const navigate = useBbNavigate();
  const slug = route.view === "project" || route.view === "ticket" ? route.slug : null;
  const project = useLoom("project", { slug: slug ?? "" }, { enabled: open && slug !== null }).data;
  const close = () => {
    palette.set(false);
    setQuery("");
    setChosen(0);
  };
  const rows = useMemo<Row[]>(() => {
    const needs = (queue ?? []).map<Row>((need) => ({ group: "Needs you", icon: QUEUE_ICON[need.kind], attention: true, label: `${need.key ?? need.projectKey} · ${QUEUE_WORD[need.kind].toLowerCase()}`, run: () => {
      const route = needRoute(need);
      if (route === null) navigate.toThread(need.threadId!);
      else go(route);
    } }));
    const next = needs[0] === undefined ? [] : [{ ...needs[0], group: "Next", label: `Next that needs you · ${needs[0].label}` }];
    const tickets = project === undefined ? [] : project.board.map<Row>((card) => ({ group: `${project.overview.key} tickets`, icon: card.state === "blocked" ? "AlertCircle" : card.state === "done" ? "CircleCheck" : "Circle", label: `${card.key} ${card.title}`, run: () => go(`${project.overview.slug}/${card.key}`) }));
    const views = project === undefined ? [] : VIEWS.map<Row>((entry) => ({ group: "Views", icon: "GridView", label: `${project.overview.key} · ${entry.label}`, run: () => {
      projectViews.put(project.overview.slug, entry.view);
      go(project.overview.slug);
    } }));
    const projects = (home?.projects ?? []).filter((entry) => entry.state !== "archived").map<Row>((entry) => ({ group: "Projects", icon: "Layers", label: `${entry.key} ${entry.name}`, run: () => go(entry.slug) }));
    const places: Row[] = [
      { group: "Go to", icon: "Home", label: "Home", run: () => go("_home") },
      { group: "Go to", icon: "ChartColumn", label: "Insights", run: () => go("_insights") },
      { group: "Go to", icon: "Plus", label: "New project", run: () => go("_new") },
      { group: "Go to", icon: "Info", label: "How Loom works", run: () => go("_guide") },
      { group: "Go to", icon: "Keyboard", label: "Keys", run: () => keysSheet.set(true) },
    ];
    return [...next, ...needs, ...tickets, ...views, ...projects, ...places];
  }, [home, queue, project, go]);
  const needle = query.trim().toLowerCase();
  const shown = (needle === "" ? rows : rows.filter((row) => row.label.toLowerCase().includes(needle))).slice(0, 40);
  const index = Math.min(chosen, Math.max(0, shown.length - 1));
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    list.current?.querySelector<HTMLElement>(`#loom-palette-${index}`)?.scrollIntoView?.({ block: "nearest" });
  }, [index]);
  useEffect(() => {
    if (list.current !== null) list.current.scrollTop = 0;
  }, [needle]);
  const runRow = (row: Row | undefined) => {
    close();
    row?.run();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      moved.current = true;
      setChosen((index + step + shown.length) % Math.max(1, shown.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runRow(shown[index]);
    }
  };
  let group = "";
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? palette.set(true) : close())} label="Jump to" initialFocus={() => input.current}>
      <div className="flex items-center gap-2 border-b border-[var(--loom-field-line)] px-3">
        <Icon name="Search" aria-hidden className="size-4 text-[var(--loom-muted)]" />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls="loom-palette-list"
          aria-activedescendant={shown[index] === undefined ? undefined : `loom-palette-${index}`}
          aria-label="Jump to"
          placeholder="Ticket, project, view or place"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setChosen(0);
          }}
          onKeyDown={onKeyDown}
          className="h-11 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-[var(--loom-muted)]"
        />
        {/* A phone has no Esc key. */}
        <button type="button" aria-label="Close" className="-mr-2 hidden size-11 shrink-0 cursor-pointer items-center justify-center text-[var(--loom-muted)] hover:text-foreground max-[576px]:inline-flex" onClick={close}>
          <Icon name="X" aria-hidden className="size-4" />
        </button>
      </div>
      <div ref={list} id="loom-palette-list" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1">
        {shown.length === 0 && (
          <p role="status" className="px-3 py-3 text-sm text-[var(--loom-muted)]">
            Nothing matches “{query.trim()}”.
          </p>
        )}
        {shown.map((row, rowIndex) => {
          const heading = row.group !== group ? row.group : null;
          group = row.group;
          return (
            <div key={`${row.group}-${row.label}`} role="presentation">
              {heading !== null && (
                <div role="presentation" className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold text-[var(--loom-muted)]">
                  {heading}
                </div>
              )}
              <div
                id={`loom-palette-${rowIndex}`}
                role="option"
                aria-selected={rowIndex === index}
                onPointerMove={() => setChosen(rowIndex)}
                onClick={() => runRow(row)}
                className={`flex min-h-9 cursor-pointer scroll-my-1 items-center gap-2.5 px-2.5 text-sm max-[576px]:min-h-11 pointer-coarse:min-h-11 ${rowIndex === index ? "bg-surface-selected text-foreground" : "text-foreground"}`}
              >
                <Icon name={row.icon} aria-hidden className={`size-4 shrink-0 ${row.attention === true ? "text-[var(--attention)]" : "text-[var(--loom-muted)]"}`} />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {rowIndex === index && <kbd className={KBD}>Enter</kbd>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-[var(--loom-muted)]">
        <kbd className={KBD}>↑</kbd>
        <kbd className={KBD}>↓</kbd>
        <span className="mr-2">move</span>
        <kbd className={KBD}>Enter</kbd>
        <span className="mr-2">open</span>
        <kbd className={KBD}>Esc</kbd>
        <span>close</span>
      </div>
    </Sheet>
  );
}
