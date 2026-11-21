import { useId, useMemo, type ReactNode } from "react";
import { experimental_Icon as Icon, experimental_ThreadStatusGlyph as ThreadStatusGlyph } from "@get-bb/plugin-sdk/app";
import type { FileChange, Overview } from "./contract";
import { countedFiles } from "./counted";
import { archiveReported, isWorking, needsYou, resolveLive, type LiveThread } from "./live";
import { plural, type Row } from "./model";
import { filesLabel, SOURCE_LABEL, sourceQualifier } from "./panel-head";
import {
  Chevron,
  INDENT_PX,
  IndentGuides,
  NAV_FOCUS,
  NAV_HOVER,
  NAV_MUTED,
  NAV_SELECTED,
  SelectionBar,
} from "./navigator";
import type { Subject } from "./reading-state";
import { useRemembered } from "./remember";
import { trailFolds } from "./ui-prefs";
import type { RowsData } from "./use-rows";

export interface TrailEntry {
  id: string;
  parentId: string | null;
  stub: boolean;
  live: LiveThread;
  worktrees: Row[];
  recorded: FileChange[];
  message: string | null;
  children: TrailEntry[];
  hidden: boolean;
  companionOf: string | null;
  incomplete: boolean;
}

export const sameSubject = (a: Subject | null, b: Subject): boolean =>
  a !== null && a.threadId === b.threadId && a.source === b.source && a.worktreeKey === b.worktreeKey;
export const worktreeSubject = (row: Row, threadId = row.threadId): Subject => ({
  threadId,
  source: row.worktree.kind === "branch" ? "branch" : "checkout",
  worktreeKey: row.worktree.key,
});
export function evidenceOf(entry: TrailEntry): Subject[] {
  const sources = entry.worktrees
    .filter(({ worktree }) => worktree.state !== "unavailable")
    .map((row) => worktreeSubject(row, entry.id));
  if (entry.recorded.length > 0) sources.push({ threadId: entry.id, source: "recorded" });
  if (sources.length === 0) sources.push({ threadId: entry.id, source: "unavailable" });
  return sources;
}

export function useTrail(overview: Overview | null, data: RowsData, rootId: string | null) {
  const { live, rows, rowFor } = data;
  return useMemo(() => {
    const byId = new Map<string, TrailEntry>();
    const roots: TrailEntry[] = [];
    if (overview === null) return { byId, roots, counts: new Set<string>() };
    const add = (id: string, parentId: string | null, stub: boolean) => {
      const entry: TrailEntry = {
        id,
        parentId,
        stub,
        live: resolveLive(live.get(id) ?? null, undefined, id),
        worktrees: [],
        recorded: [],
        message: null,
        children: [],
        hidden: false,
        companionOf: null,
        incomplete: false,
      };
      byId.set(id, entry);
      return entry;
    };
    for (const summary of overview.threads) {
      const entry = add(summary.id, summary.id === rootId ? null : summary.parentThreadId, false);
      const sidebar = live.get(summary.id) ?? null;
      entry.live = { ...resolveLive(sidebar, summary, summary.id), archived: archiveReported(sidebar, summary) };
      entry.hidden = summary.hidden === true;
      entry.companionOf = summary.companionOf ?? null;
      entry.incomplete = summary.recordsIncomplete === true;
    }
    for (const worktree of overview.worktrees) {
      const row = rowFor(worktree.key);
      for (const id of worktree.threadIds) {
        const entry = byId.get(id) ?? add(id, null, false);
        if (row !== null) entry.worktrees.push(row);
        entry.message ??= worktree.state === "unavailable" ? worktree.message : null;
      }
    }
    for (const repo of overview.repos) {
      if (repo.state !== "unavailable") continue;
      for (const id of repo.threadIds) {
        const entry = byId.get(id);
        if (entry !== undefined) entry.message ??= repo.message;
      }
    }
    const recorded = new Map<string, Map<string, FileChange>>();
    const collect = (file: FileChange, root: string | null) => {
      if (file.edits === null) return;
      const path = root === null || file.path.startsWith("/") ? file.path : `${root.replace(/\/$/, "")}/${file.path}`;
      for (const threadId of file.edits.threadIds) {
        if (!byId.has(threadId)) continue;
        const files = recorded.get(threadId) ?? new Map<string, FileChange>();
        const existing = files.get(path);
        const rawPaths = [...new Set([...(existing?.edits?.rawPaths ?? []), ...file.edits.rawPaths])];
        const count = Math.max(existing?.edits?.count ?? 0, file.edits.count);
        files.set(path, {
          ...file,
          path,
          previousPath: null,
          folder: undefined,
          additions: null,
          deletions: null,
          edits: { rawPaths, count, threadIds: [threadId] },
        });
        recorded.set(threadId, files);
      }
    };
    for (const repo of overview.repos) for (const file of [...repo.files, ...repo.otherFiles]) collect(file, repo.root);
    for (const worktree of overview.worktrees)
      for (const file of [...worktree.uncommitted, ...worktree.committed]) collect(file, worktree.root);
    for (const file of overview.otherFiles) collect(file, null);
    for (const entry of byId.values()) {
      entry.recorded = [...(recorded.get(entry.id)?.values() ?? [])];
      if (entry.parentId !== null && !byId.has(entry.parentId))
        add(entry.parentId, entry.parentId === rootId ? null : rootId, true);
    }
    for (const entry of byId.values()) {
      const parent = entry.parentId === null ? undefined : byId.get(entry.parentId);
      let cursor = parent;
      const seen = new Set([entry.id]);
      while (cursor !== undefined && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
      }
      if (parent !== undefined && cursor === undefined) parent.children.push(entry);
      else roots.push(entry);
    }
    const rank = (entry: TrailEntry) =>
      entry.live.archived ? 3 : needsYou(entry.live) ? 0 : isWorking(entry.live) ? 1 : 2;
    const order = (a: TrailEntry, b: TrailEntry) =>
      Number(b.id === rootId) - Number(a.id === rootId) || rank(a) - rank(b);
    roots.sort(order);
    for (const entry of byId.values()) entry.children.sort(order);
    return { byId, roots, counts: new Set(rows.map((row) => row.worktree.key)) };
  }, [overview, live, rows, rowFor, rootId]);
}

export type TrailData = ReturnType<typeof useTrail>;

// A Flare companion with nothing of its own to review: the navigator's footer counts it instead of listing it.
export const isHelper = (entry: TrailEntry): boolean =>
  entry.companionOf !== null &&
  entry.companionOf === entry.parentId &&
  entry.recorded.length === 0 &&
  entry.children.length === 0;
const hasLiveWork = (entry: TrailEntry): boolean =>
  entry.children.some((child) => !isHelper(child) && (!child.live.archived || hasLiveWork(child)));
const listed = (trail: TrailData) => [...trail.byId.values()].filter((entry) => !entry.stub && !isHelper(entry));
export const trailCount = (trail: TrailData): number => listed(trail).length;
export const helpersOf = (trail: TrailData): TrailEntry[] =>
  [...trail.byId.values()].filter((entry) => !entry.stub && isHelper(entry));
export const incompleteOf = (trail: TrailData): TrailEntry[] => listed(trail).filter((entry) => entry.incomplete);
export const ownerName = (entry: TrailEntry, currentThreadId: string | null): string =>
  entry.id === currentThreadId ? "this thread" : entry.live.title;

// The key the navigator's Files section folds under, per bb thread and source.
export const sourceKey = (subject: Subject): string =>
  `s:${subject.threadId}:${subject.source}:${subject.worktreeKey ?? ""}`;
export const filesFoldKey = (rootId: string, subject: Subject): string => `${rootId}\0files:${sourceKey(subject)}`;

export interface SourceChoice {
  subject: Subject;
  key: string;
  label: string;
  qualifier: string;
  count: number | null;
  row: Row | undefined;
}

// The selected thread's evidence as the navigator lists it: its own recorded edits first, then the checkouts it ran in.
export function sourceChoices(entry: TrailEntry, currentThreadId: string | null): SourceChoice[] {
  const sources = evidenceOf(entry).filter((source) => source.source !== "unavailable");
  const owner = ownerName(entry, currentThreadId);
  const choices = sources.map((subject): SourceChoice => {
    const row = entry.worktrees.find(({ worktree }) => worktree.key === subject.worktreeKey);
    const twin = sources.filter((other) => other.source === subject.source).length > 1 && row !== undefined;
    return {
      subject,
      key: sourceKey(subject),
      label: twin
        ? `${SOURCE_LABEL[subject.source]} · ${row.worktree.label} (${row.worktree.root})`
        : SOURCE_LABEL[subject.source],
      qualifier: sourceQualifier(subject.source, owner, row?.worktree),
      count:
        subject.source === "recorded"
          ? entry.recorded.length
          : row === undefined || row.worktree.state === "loading"
            ? null
            : countedFiles([...row.worktree.uncommitted, ...row.worktree.committed]).length,
      row,
    };
  });
  return [
    ...choices.filter((choice) => choice.subject.source === "recorded"),
    ...choices.filter((choice) => choice.subject.source !== "recorded"),
  ];
}

const FOLD = `inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm ${NAV_MUTED} hover:text-foreground ${NAV_FOCUS}`;
const ROW_BUTTON = `flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 self-stretch rounded-sm pl-0.5 pr-1 text-left ${NAV_FOCUS}`;
// Each row draws its own indent, its guides and, when selected, the selection bar and fill across the column.
const rowShell = (depth: number, extra: string) => ({
  "data-depth": depth,
  className: `relative flex min-w-0 items-center pr-1 ${extra}`,
  style: { paddingLeft: depth * INDENT_PX },
});
const Mark = ({ label, icon, children }: { label: string; icon: string; children?: ReactNode }) => (
  <span
    role="img"
    aria-label={label}
    title={label}
    className={`inline-flex shrink-0 items-center gap-0.5 ${NAV_MUTED}`}
  >
    <Icon name={icon} fallback="Circle" className="size-3.5" aria-hidden />
    {children}
  </span>
);

interface ThreadNode {
  kind: "thread";
  key: string;
  entry: TrailEntry;
  depth: number;
  expandable: boolean;
  open: boolean;
  selected: boolean;
  sources: SourceChoice[];
  unread: Row[];
  children: TrailNode[];
}
interface GroupNode {
  kind: "group";
  key: string;
  foldKey: string;
  depth: number;
  entries: TrailEntry[];
  open: boolean;
  children: TrailNode[];
}
type TrailNode = ThreadNode | GroupNode;

export interface TrailProps {
  rootId: string;
  trail: TrailData;
  selected: Subject | null;
  // Archived threads read in this tab stay in their place in the tree.
  recent: ReadonlySet<string>;
  onSelect(subject: Subject): void;
  onSource(subject: Subject): void;
  active: string | null;
  onActive(key: string): void;
  // The navigator's Files section, which lists the active source's files.
  filesId: string;
}

// The Trail: threads, and under the selected thread its evidence sources. The active source's files are listed in the
// navigator's Files section below, so a long file list never pushes the other threads out of reach.
export function Trail({ rootId, trail, selected, recent, onSelect, onSource, active, onActive, filesId }: TrailProps) {
  const folds = useRemembered(trailFolds);
  const baseId = useId();
  const selectedId = selected?.threadId ?? null;
  const kept = (entry: TrailEntry) =>
    entry.live.archived &&
    (entry.id === rootId || entry.id === selectedId || recent.has(entry.id) || hasLiveWork(entry));
  const titles = new Map<string, number>();
  for (const entry of listed(trail)) titles.set(entry.live.title, (titles.get(entry.live.title) ?? 0) + 1);
  const display = (entry: TrailEntry) =>
    entry.id === rootId
      ? "This thread"
      : (titles.get(entry.live.title) ?? 0) > 1
        ? `${entry.live.title} · ${entry.id.slice(-4)}`
        : entry.live.title;

  const keys: string[] = [];
  const build = (entries: readonly TrailEntry[], depth: number, parentKey: string): TrailNode[] => {
    const candidates = entries.filter((entry) => !isHelper(entry));
    const folding = candidates.filter((entry) => entry.live.archived && !entry.stub && !kept(entry));
    // A group of one would only hide a name behind a row of the same height.
    const folded = folding.length >= 2 ? folding : [];
    const nodes: TrailNode[] = candidates
      .filter((entry) => !folded.includes(entry))
      .map((entry) => thread(entry, depth));
    if (folded.length > 0) {
      const foldKey = `${rootId}\0archived:${parentKey}`;
      const key = `a:${parentKey}`;
      const open = folds.get(foldKey) === true;
      keys.push(key);
      const group: GroupNode = { kind: "group", key, foldKey, depth, entries: folded, open, children: [] };
      nodes.push(group);
      if (open) group.children = folded.map((entry) => thread(entry, depth + 1));
    }
    return nodes;
  };
  const thread = (entry: TrailEntry, depth: number): ThreadNode => {
    const key = `t:${entry.id}`;
    const isSelected = entry.id === selectedId;
    const children = entry.children.filter((child) => !isHelper(child));
    const sources = isSelected && !entry.stub ? sourceChoices(entry, rootId) : [];
    const unread = isSelected ? entry.worktrees.filter(({ worktree }) => worktree.state === "unavailable") : [];
    const expandable = children.length > 0 || sources.length > 0 || unread.length > 0;
    const open = expandable && folds.get(`${rootId}\0${entry.id}`) !== true;
    if (!entry.stub) keys.push(key);
    const node: ThreadNode = {
      kind: "thread",
      key,
      entry,
      depth,
      expandable,
      open,
      selected: isSelected,
      sources,
      unread,
      children: [],
    };
    if (open) {
      for (const source of sources) keys.push(source.key);
      node.children = build(entry.children, depth + 1, entry.id);
    }
    return node;
  };
  const nodes = build(trail.roots, 0, "");
  // The Tab stop is the row last focused, else the selected thread.
  const tabStop =
    active !== null && (keys.includes(active) || active === "files")
      ? active
      : selectedId !== null && keys.includes(`t:${selectedId}`)
        ? `t:${selectedId}`
        : keys[0];
  const roving = (key: string) => ({
    "data-nav-item": "",
    tabIndex: tabStop === key ? 0 : -1,
    onFocus: () => onActive(key),
  });

  const renderSource = (node: ThreadNode, choice: SourceChoice) => {
    const isActive = selected !== null && sameSubject(selected, choice.subject);
    const filesOpen = folds.get(filesFoldKey(rootId, choice.subject)) !== true;
    const descId = `${baseId}-${choice.key}`;
    const icon =
      choice.subject.source === "recorded"
        ? "Pencil"
        : choice.subject.source === "branch"
          ? "Archive"
          : (choice.row?.worktree.threadIds.length ?? 1) > 1
            ? "Users"
            : "GitBranch";
    const incomplete = choice.subject.source === "recorded" && node.entry.incomplete;
    const depth = node.depth + 1;
    return (
      <li key={choice.key} data-nav-group>
        <div data-row="source" {...rowShell(depth, `min-h-7 ${NAV_HOVER}`)}>
          <IndentGuides depth={depth} />
          <span className="size-6 shrink-0" />
          <button
            type="button"
            {...roving(choice.key)}
            data-trail-source={choice.subject.source}
            data-trail-checkout={choice.subject.worktreeKey}
            aria-label={choice.label}
            aria-describedby={descId}
            aria-current={isActive ? "true" : undefined}
            aria-expanded={isActive ? filesOpen : undefined}
            aria-controls={isActive ? filesId : undefined}
            title={`${choice.label} · ${choice.qualifier}`}
            onClick={() => onSource(choice.subject)}
            className={`${ROW_BUTTON} min-h-7 text-xs`}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Icon
                name={icon}
                fallback="GitBranch"
                className={`size-3.5 ${isActive ? "text-primary" : NAV_MUTED}`}
                aria-hidden
              />
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1">
              <span data-row-title className={`shrink-0 text-foreground ${isActive ? "font-semibold" : ""}`}>
                {choice.label}
              </span>
              <span data-row-qualifier className={`min-w-0 truncate ${NAV_MUTED}`}>
                · {choice.qualifier}
              </span>
            </span>
            {incomplete && <Mark label="Recorded edits may be incomplete" icon="CircleDashed" />}
            <span data-row-count className={`min-w-[2ch] shrink-0 text-right tabular-nums ${NAV_MUTED}`}>
              {choice.count ?? "…"}
            </span>
            <span id={descId} className="sr-only">
              {choice.qualifier} · {filesLabel(choice.count)}
              {incomplete ? " · records may be incomplete" : ""}
            </span>
          </button>
        </div>
      </li>
    );
  };

  const renderNotRead = (node: ThreadNode, row: Row) => (
    <li key={`n:${row.worktree.key}`}>
      <div
        data-row="source"
        data-trail-source="not-read"
        title={row.worktree.message ?? undefined}
        {...rowShell(node.depth + 1, `min-h-7 text-xs ${NAV_MUTED}`)}
      >
        <IndentGuides depth={node.depth + 1} />
        <span className="size-6 shrink-0" />
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Icon name="Globe" fallback="CircleOff" className="size-3.5" aria-hidden />
        </span>
        <span className="ml-1.5 flex min-w-0 flex-1 items-baseline gap-1">
          <span data-row-title className="shrink-0">
            Checkout Git
          </span>
          <span data-row-qualifier className="min-w-0 truncate">
            · not read
          </span>
        </span>
      </div>
    </li>
  );

  const renderNode = (node: TrailNode): ReactNode => {
    if (node.kind === "group") {
      const incomplete = node.entries.filter((entry) => entry.incomplete).length;
      const count = node.entries.length;
      return (
        <li key={node.key} data-nav-group data-trail-archived-group={node.key}>
          <div data-row="group" data-quiet {...rowShell(node.depth, `min-h-7 ${NAV_HOVER}`)}>
            <IndentGuides depth={node.depth} />
            <button
              type="button"
              {...roving(node.key)}
              data-nav-fold
              aria-expanded={node.open}
              aria-label={`${plural(count, "more archived thread")}${incomplete > 0 ? `, records may be incomplete for ${incomplete}` : ""}`}
              onClick={() => trailFolds.set(node.foldKey, node.open ? undefined : true)}
              className={`${ROW_BUTTON} min-h-7 pl-1.5 text-xs ${NAV_MUTED} hover:text-foreground`}
            >
              <Chevron open={node.open} />
              <span className="flex size-4 shrink-0 items-center justify-center">
                <Icon name="Archive" className="size-3.5" aria-hidden />
              </span>
              <span data-row-title className="min-w-0 flex-1 truncate">
                {count} more archived
              </span>
              {incomplete > 0 && (
                <Mark label={`Records may be incomplete for ${incomplete}`} icon="CircleDashed">
                  <span className="tabular-nums">{incomplete}</span>
                </Mark>
              )}
            </button>
          </div>
          {node.open && <ul>{node.children.map(renderNode)}</ul>}
        </li>
      );
    }
    const { entry, depth } = node;
    const own = entry.id === rootId;
    const title = own ? `This thread · ${entry.live.title}` : display(entry);
    const state = entry.stub
      ? "Ancestor not in this overview"
      : needsYou(entry.live)
        ? "Needs you"
        : isWorking(entry.live)
          ? "Working"
          : null;
    const descId = `${baseId}-${node.key}`;
    const facts = [
      entry.live.archived ? "archived" : state?.toLowerCase(),
      entry.hidden ? "hidden thread with recorded edits" : null,
      plural(entry.recorded.length, "recorded path"),
      entry.incomplete ? "records may be incomplete" : null,
    ].filter((fact) => fact != null);
    return (
      <li key={node.key} data-trail-thread={entry.id} data-nav-group>
        <div
          data-row="thread"
          data-selected={node.selected || undefined}
          {...rowShell(depth, `min-h-8 ${node.selected ? NAV_SELECTED : NAV_HOVER}`)}
        >
          <IndentGuides depth={depth} />
          {node.selected && <SelectionBar />}
          {node.expandable ? (
            <button
              type="button"
              data-nav-fold
              tabIndex={-1}
              aria-label={`${node.open ? "Hide" : "Show"} ${entry.children.length > 0 ? "descendants" : "the evidence"} of ${title}`}
              aria-expanded={node.open}
              onClick={() => trailFolds.set(`${rootId}\0${entry.id}`, node.open ? true : undefined)}
              className={FOLD}
            >
              <Icon name={node.open ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
            </button>
          ) : (
            <span className="size-6 shrink-0" />
          )}
          {entry.stub ? (
            <span className={`min-w-0 truncate px-1 text-xs ${NAV_MUTED}`} title={title}>
              {title} · {state}
            </span>
          ) : (
            <button
              type="button"
              {...roving(node.key)}
              data-trail-select
              aria-pressed={node.selected}
              aria-expanded={node.expandable ? node.open : undefined}
              aria-label={title}
              aria-describedby={descId}
              title={own ? title : entry.live.title}
              onClick={() => onSelect(evidenceOf(entry)[0]!)}
              className={`${ROW_BUTTON} min-h-8`}
            >
              <span data-status-slot className="flex size-4 shrink-0 items-center justify-center">
                <ThreadStatusGlyph indicator={entry.live.indicator} archived={entry.live.archived} size="compact" />
              </span>
              <span
                data-row-title
                className={`min-w-0 flex-1 truncate text-[13px] text-foreground ${node.selected ? "font-semibold" : ""}`}
              >
                {display(entry)}
              </span>
              {entry.hidden && <Mark label="Hidden thread with recorded edits" icon="EyeOff" />}
              {state !== null && <span className={`shrink-0 text-[11px] ${NAV_MUTED}`}>{state}</span>}
              {entry.incomplete && <Mark label="Recorded edits may be incomplete" icon="CircleDashed" />}
              <span
                data-row-count
                className={`min-w-[2ch] shrink-0 text-right text-xs tabular-nums ${entry.recorded.length > 0 ? "text-foreground" : NAV_MUTED}`}
                title={plural(entry.recorded.length, "recorded path")}
              >
                {entry.recorded.length}
              </span>
              <span id={descId} className="sr-only">
                {facts.join(" · ")}
              </span>
            </button>
          )}
        </div>
        {node.open && (
          <ul>
            {node.sources.map((choice) => renderSource(node, choice))}
            {node.unread.map((row) => renderNotRead(node, row))}
            {node.children.map(renderNode)}
          </ul>
        )}
      </li>
    );
  };
  return <ul>{nodes.map(renderNode)}</ul>;
}
