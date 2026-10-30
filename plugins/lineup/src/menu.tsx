import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import {
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders,
  useComposer,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  inLineup,
  matchesQuery,
  modelKey,
  resolveModel,
  rowTitleIndex,
  sameModel,
  searchCatalog,
  timeAgo,
  type ModelRef,
  type ResolvedModel,
  type View,
} from "./lineup";
import {
  activeNativeTab,
  ensureMounts,
  findComposerRoot,
  nativeRowSlots,
  openPopover,
  PIN_SLOT_ATTR,
  readPicker,
  removeMounts,
  VIEW_ATTR,
  type NativeRow,
  type PickerMounts,
  type PickerParts,
} from "./picker";
import { useLineupStore, type LineupStore } from "./store";

type Composer = ReturnType<typeof useComposer>;

const SEARCH_RESULTS = 30;
// Class lists copied from bb's own menu so Lineup's rows look like bb's.
const LIST_CLASS = "min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1 pt-0";
const HEADER_CLASS =
  "sticky top-0 z-10 bg-background px-2 text-xs font-medium text-muted-foreground pb-[0.3125rem] pt-2 max-md:pointer-coarse:pb-1.5";
const ROW_CLASS =
  "relative flex w-full cursor-default select-none items-center justify-between gap-3 rounded-sm px-2 text-xs outline-none hover:bg-state-hover hover:text-foreground transition-none py-[0.3125rem] max-md:pointer-coarse:py-2";
const OWN_NODE_SELECTOR = `[data-lineup-tabs], [data-lineup-list], [data-lineup-tabrow], [${PIN_SLOT_ATTR}]`;

const keepFocus = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};
const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * Lineup's portals sit inside bb's menu in the page, but their React parents
 * are the composer. Stop their events here so the composer does not react to
 * clicks it never saw, and keep focus in the menu's search box.
 */
function Contained({ children }: { children: ReactNode }) {
  return (
    <div
      style={{ display: "contents" }}
      onPointerDown={stop}
      onMouseDown={keepFocus}
      onClick={stop}
      onKeyDown={stop}
    >
      {children}
    </div>
  );
}

/**
 * Mounted in each composer as an action that draws nothing. It watches this
 * composer's model button and adds Recent and Lineup to the menu it opens.
 */
export function MenuAnchor() {
  const composer = useComposer();
  const store = useLineupStore();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [popover, setPopover] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    let root = findComposerRoot(anchor);
    let frame = 0;
    const check = () => {
      if (root === null || !root.isConnected) root = findComposerRoot(anchor);
      const next = root === null ? null : openPopover(root);
      setPopover((current) => (current === next ? current : next));
    };
    // bb can mount the menu a frame after it marks the button expanded.
    const onChange = () => {
      check();
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          check();
        });
      }
    };
    const observer = new MutationObserver(onChange);
    observer.observe(root ?? document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "aria-controls"],
    });
    check();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <span ref={anchorRef} hidden data-lineup-anchor="" />
      {popover === null ? null : <PickerSession key={popover.id} popover={popover} composer={composer} store={store} />}
    </>
  );
}

interface Row {
  key: string;
  model: ResolvedModel | null;
  ref: ModelRef;
  usedAt?: number;
}

interface Section {
  title: string;
  rows: Row[];
  empty?: string;
}

function sameRows(a: NativeRow[], b: NativeRow[]): boolean {
  return a.length === b.length && a.every((row, index) => row.slot === b[index]!.slot && row.title === b[index]!.title);
}

function isOwnRecord(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (target?.closest(OWN_NODE_SELECTOR)) return true;
  if (record.type !== "childList") return false;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return nodes.length > 0 && nodes.every((node) => node instanceof Element && node.matches(OWN_NODE_SELECTOR));
}

interface SessionProps {
  popover: HTMLElement;
  composer: Composer;
  store: LineupStore;
}

function PickerSession({ popover, composer, store }: SessionProps) {
  const [parts, setParts] = useState<PickerParts | null>(null);
  const [mounts, setMounts] = useState<PickerMounts | null>(null);
  const [nativeRows, setNativeRows] = useState<NativeRow[]>([]);
  const [activeTabTitle, setActiveTabTitle] = useState<string | null>(null);
  const [view, setView] = useState<View>(store.state?.lastView ?? "native");
  const chosen = useRef(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const { refreshCatalog, refreshRecent } = store;

  // Re-find bb's parts and re-add Lineup's after each change bb makes to the menu.
  useLayoutEffect(() => {
    let frame = 0;
    const sync = () => {
      const next = readPicker(popover);
      if (next === null) {
        removeMounts(popover);
        setParts(null);
        setMounts(null);
        return;
      }
      const nextMounts = ensureMounts(next);
      setParts((current) =>
        current?.popover === next.popover &&
        current.search === next.search &&
        current.listbox === next.listbox &&
        current.nativeTabRow === next.nativeTabRow
          ? current
          : next,
      );
      setMounts((current) =>
        current?.tabs === nextMounts.tabs && current.list === nextMounts.list ? current : nextMounts,
      );
      const rows = nativeRowSlots(next.listbox);
      setNativeRows((current) => (sameRows(current, rows) ? current : rows));
      setActiveTabTitle(activeNativeTab(next)?.title ?? null);
      setQuery(next.search.value);
    };
    sync();
    const observer = new MutationObserver((records) => {
      if (records.every(isOwnRecord) || frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    });
    observer.observe(popover, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      removeMounts(popover);
    };
  }, [popover]);

  useEffect(() => {
    void refreshCatalog();
    void refreshRecent();
  }, [refreshCatalog, refreshRecent]);

  // The saved tab can arrive after the menu opened; use it unless the user already chose one.
  useEffect(() => {
    if (!chosen.current && store.state !== null) setView(store.state.lastView);
  }, [store.state?.lastView]);

  useLayoutEffect(() => {
    parts?.popover.setAttribute(VIEW_ATTR, view);
  }, [parts, view]);

  const choose = useCallback(
    (next: View) => {
      chosen.current = true;
      setView(next);
      setHighlight(null);
      store.setLastView(next);
    },
    [store.setLastView],
  );

  useEffect(() => {
    if (parts === null) return;
    const onInput = () => {
      setQuery(parts.search.value);
      setHighlight(null);
    };
    parts.search.addEventListener("input", onInput);
    return () => parts.search.removeEventListener("input", onInput);
  }, [parts]);

  // A click on one of bb's provider tabs goes back to bb's list.
  useEffect(() => {
    const row = parts?.nativeTabRow;
    if (!row) return;
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('button[title][class*="border-b-2"]')) choose("native");
    };
    row.addEventListener("click", onClick, true);
    return () => row.removeEventListener("click", onClick, true);
  }, [parts, choose]);

  const catalog = store.catalog ?? [];
  const lineup = store.state?.lineup ?? [];
  const selected: ModelRef | null =
    composer.selection?.providerId !== undefined && composer.selection.model !== undefined
      ? { providerId: composer.selection.providerId, model: composer.selection.model }
      : null;

  const sections = useMemo((): Section[] => {
    if (view === "native") return [];
    const shown: Row[] = [];
    let first: Section;
    if (view === "recent") {
      for (const recent of store.recent ?? []) {
        const model = resolveModel(catalog, recent);
        if (model !== null && matchesQuery(model, query)) {
          shown.push({ key: modelKey(recent), model, ref: recent, usedAt: recent.usedAt });
        }
      }
      first = {
        title: "Recently used by threads",
        rows: shown,
        empty:
          store.recent === null || store.catalog === null
            ? "Reading recent threads…"
            : query
              ? "No recent model matches."
              : "No thread has run a model offered here yet.",
      };
    } else {
      for (const ref of lineup) {
        const model = resolveModel(catalog, ref);
        if (model === null ? store.catalog !== null && query === "" : matchesQuery(model, query)) {
          shown.push({ key: modelKey(ref), model, ref });
        }
      }
      first = {
        title: "Lineup",
        rows: shown,
        empty: query ? "No model in your lineup matches." : "Your lineup is empty. Hover any model and click its pin to add it.",
      };
    }
    const more = searchCatalog(catalog, query, shown.map((row) => row.ref), SEARCH_RESULTS).map((model) => ({
      key: `all:${modelKey(model)}`,
      model,
      ref: model as ModelRef,
    }));
    return more.length > 0 ? [first, { title: "All models", rows: more }] : [first];
  }, [view, store.recent, store.catalog, catalog, lineup, query]);

  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const highlighted =
    rows.find((row) => row.key === highlight) ??
    rows.find((row) => selected !== null && row.model !== null && sameModel(row.ref, selected)) ??
    rows[0];

  const pick = useCallback(
    async (row: Row) => {
      if (row.model === null) return;
      const model = row.model;
      try {
        const result = await composer.setSelection({ providerId: model.providerId, model: model.model });
        if (result.providerId !== model.providerId || result.model !== model.model) {
          toast.error(`${model.name} is not offered here, so the model did not change.`);
        }
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [composer],
  );

  const togglePin = useCallback((ref: ModelRef) => store.setPinned(ref, !inLineup(lineup, ref)), [store.setPinned, lineup]);

  // Keys typed in the search box: Tab moves between tabs everywhere; the arrows and
  // Enter drive Lineup's list while it shows. Window capture runs before bb's handlers.
  const latest = useRef({ view, rows, highlighted, parts, choose, pick });
  latest.current = { view, rows, highlighted, parts, choose, pick };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current;
      if (current.parts === null || event.target !== current.parts.search || event.isComposing) return;
      if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        cycle(current.view, current.choose, event.shiftKey ? -1 : 1);
        return;
      }
      if (current.view === "native") return;
      const list = current.rows;
      const index = Math.max(0, list.findIndex((row) => row.key === current.highlighted?.key));
      let next: Row | undefined;
      if (event.key === "ArrowDown") next = list[(index + 1) % list.length];
      else if (event.key === "ArrowUp") next = list[(index - 1 + list.length) % list.length];
      else if (event.key === "Home") next = list[0];
      else if (event.key === "End") next = list.at(-1);
      else if (event.key === "Enter") {
        if (current.highlighted !== undefined) void current.pick(current.highlighted);
      } else return;
      event.preventDefault();
      event.stopPropagation();
      if (next !== undefined) setHighlight(next.key);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  if (parts === null || mounts === null) return null;
  const single = parts.nativeTabRow === null;
  const nativeProvider = single
    ? catalog.length === 1
      ? catalog[0]
      : undefined
    : catalog.filter((provider) => provider.displayName === activeTabTitle).length === 1
      ? catalog.find((provider) => provider.displayName === activeTabTitle)
      : undefined;
  const titleIndex = nativeProvider === undefined ? null : rowTitleIndex(nativeProvider);

  return (
    <>
      {createPortal(
        <Contained>
          <TabButton icon="Clock" label="Recent" active={view === "recent"} onSelect={() => choose("recent")} />
          <TabButton icon="Pin" label="Lineup" active={view === "lineup"} onSelect={() => choose("lineup")} />
          <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 self-center bg-border" />
          {single ? <TabButton label="All models" active={view === "native"} onSelect={() => choose("native")} /> : null}
        </Contained>,
        mounts.tabs,
      )}
      {view === "native"
        ? null
        : createPortal(
            <Contained>
              <OwnList
                sections={sections}
                highlighted={highlighted?.key ?? null}
                selected={selected}
                lineup={lineup}
                mixed={catalog.length > 1}
                drawer={parts.drawer}
                onHighlight={setHighlight}
                onPick={(row) => void pick(row)}
                onTogglePin={togglePin}
              />
            </Contained>,
            mounts.list,
          )}
      {view !== "native" || titleIndex === null || nativeProvider === undefined
        ? null
        : nativeRows.map((row) => {
            const model = titleIndex.get(row.title);
            if (model === undefined) return null;
            const ref = { providerId: nativeProvider.id, model };
            return createPortal(
              <Contained>
                <PinToggle label={row.title} pinned={inLineup(lineup, ref)} onToggle={() => togglePin(ref)} />
              </Contained>,
              row.slot,
              modelKey(ref),
            );
          })}
    </>
  );
}

/**
 * Move to the next or previous of Recent, Lineup and bb's own list. bb's
 * provider tabs are left out: clicking one also switches the composer's
 * provider, which a key that only browses should not do.
 */
function cycle(view: View, choose: (view: View) => void, delta: number) {
  const order: View[] = ["recent", "lineup", "native"];
  choose(order[(order.indexOf(view) + delta + order.length) % order.length]!);
}

function TabButton({ icon, label, active, onSelect }: { icon?: string; label: string; active: boolean; onSelect(): void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        "flex h-7 shrink-0 items-center justify-center gap-1 border-b-2 px-1.5 text-xs transition-none focus-visible:outline-none max-md:pointer-coarse:h-9",
        active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      onClick={onSelect}
    >
      {icon === undefined ? null : <Icon name={icon} className="size-3.5 shrink-0" />}
      {label}
    </button>
  );
}

function PinToggle({ label, pinned, onToggle }: { label: string; pinned: boolean; onToggle(): void }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-pressed={pinned}
      aria-label={pinned ? `Remove ${label} from lineup` : `Add ${label} to lineup`}
      data-lineup-pin={pinned ? "on" : "off"}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-state-hover max-md:pointer-coarse:size-7"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={(event) => {
        keepFocus(event);
        onToggle();
      }}
    >
      <Icon name={pinned && hover ? "PinOff" : "Pin"} className="size-3.5 max-md:pointer-coarse:size-5" />
    </span>
  );
}

interface OwnListProps {
  sections: Section[];
  highlighted: string | null;
  selected: ModelRef | null;
  lineup: ModelRef[];
  mixed: boolean;
  /** In bb's narrow-screen drawer, where bb's list fills the drawer instead of stopping at 16rem. */
  drawer: boolean;
  onHighlight(key: string): void;
  onPick(row: Row): void;
  onTogglePin(ref: ModelRef): void;
}

function OwnList({ sections, highlighted, selected, lineup, mixed, drawer, onHighlight, onPick, onTogglePin }: OwnListProps) {
  const { providers } = experimental_useProviders();
  const rowRefs = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (highlighted !== null) rowRefs.current.get(highlighted)?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  return (
    <div role="listbox" aria-label={sections[0]?.title ?? "Models"} className={cn(LIST_CLASS, !drawer && "max-h-64")}>
      {sections.map((section) => (
        <div key={section.title} role="group" aria-label={section.title}>
          <div className={HEADER_CLASS}>{section.title}</div>
          {section.rows.length === 0 && section.empty ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{section.empty}</div>
          ) : null}
          {section.rows.map((row) => {
            const isSelected = selected !== null && row.model !== null && sameModel(row.ref, selected);
            const name = row.model?.name ?? row.ref.model;
            const provider = providers.find((candidate) => candidate.id === row.ref.providerId);
            return (
              <button
                key={row.key}
                ref={(element) => {
                  if (element === null) rowRefs.current.delete(row.key);
                  else rowRefs.current.set(row.key, element);
                }}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-disabled={row.model === null}
                data-lineup-active={row.key === highlighted ? "" : undefined}
                className={cn(ROW_CLASS, row.key === highlighted && "bg-state-hover text-foreground", row.model === null && "opacity-60")}
                onMouseMove={() => {
                  if (row.key !== highlighted) onHighlight(row.key);
                }}
                onClick={() => onPick(row)}
              >
                <span
                  className="flex min-w-0 items-center gap-1.5"
                  title={[row.model?.providerName, name, row.model?.route].filter(Boolean).join(" · ")}
                >
                  {mixed ? (
                    <ProviderIcon
                      providerKind="agent"
                      provider={provider ?? { id: row.ref.providerId }}
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                  <span className="truncate">
                    {name}
                    {row.model === null ? (
                      <span className="ml-1.5 text-subtle-foreground">not offered here</span>
                    ) : row.model.route ? (
                      <span className="ml-1.5 text-subtle-foreground">{row.model.route}</span>
                    ) : null}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {row.usedAt === undefined ? null : (
                    <span className="tabular-nums text-subtle-foreground">{timeAgo(row.usedAt)}</span>
                  )}
                  <PinToggle label={name} pinned={inLineup(lineup, row.ref)} onToggle={() => onTogglePin(row.ref)} />
                  <Icon
                    name="Check"
                    className={cn("size-4 shrink-0 text-subtle-foreground max-md:pointer-coarse:size-5", isSelected ? "opacity-100" : "opacity-0")}
                  />
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
