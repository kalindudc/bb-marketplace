import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { FileChange, ReviewMarks } from "./contract";
import { Counts, ICON_BUTTON, StatusLetter } from "./file-card";
import { buildFileTree, dirNodes, filesBelow, type DirNode, type TreeNode } from "./file-tree";
import { plural } from "./model";
import {
  Chevron,
  INDENT_PX as NAV_INDENT_PX,
  IndentGuides,
  NAV_FOCUS,
  NAV_HOVER,
  NAV_MUTED,
  NAV_SELECTED,
  SelectionBar,
  type PanelNav,
} from "./navigator";
import { useRemembered } from "./remember";
import { isReviewed, markId, type FilePart } from "./reviewed";
import { treeFolds } from "./ui-prefs";

type TreePart = FilePart | { part: "recorded"; file: FileChange };

export interface FileTreeProps<T extends TreePart> {
  parts: readonly T[];
  stacked?: boolean;
  // Folders stay collapsed per worktree.
  worktreeKey: string;
  cardKey(part: T): string;
  noteOf(part: T): string | null;
  focused: string | null;
  marks: ReviewMarks | undefined;
  commentCounts: ReadonlyMap<string, number>;
  overlapPaths: ReadonlySet<string>;
  onJump(key: string): void;
  onReview?(part: T): void;
  // Inside the side panel's navigator, which owns the keys and the one Tab stop of the whole tree.
  navigator?: {
    tabStop: boolean;
    onFocusItem(): void;
    onPresence(present: boolean): void;
    files: PanelNav["files"];
  };
}

const INDENT_PX = 12;
const indent = (depth: number): number => 6 + depth * INDENT_PX;
// In the navigator a level is 16 px, with a guide under each ancestor folder's chevron.
const navIndent = (depth: number): number => 4 + depth * NAV_INDENT_PX;

export function FileTree<T extends TreePart>(props: FileTreeProps<T>) {
  const {
    parts,
    worktreeKey,
    cardKey,
    noteOf,
    focused,
    marks,
    commentCounts,
    overlapPaths,
    onJump,
    onReview,
    stacked,
    navigator,
  } = props;
  const [active, setActive] = useState<string | null>(null);
  const onPresence = navigator?.onPresence;
  useEffect(() => {
    if (onPresence === undefined) return;
    onPresence(true);
    return () => onPresence(false);
  }, [onPresence]);
  const nodes = useMemo(() => buildFileTree(parts, (part) => part.file.path), [parts]);
  const folders = useMemo(() => dirNodes(nodes), [nodes]);
  const folds = useRemembered(treeFolds);
  const foldKey = (path: string) => `${worktreeKey}\0${path}`;
  // A joined row's path changes with the files listed ("src" and "src/lib" become "src/lib" when src holds nothing else),
  // so it counts as collapsed when any folder it stands for is, and opening it opens all of them.
  const collapsed = (node: DirNode<T>) => node.chain.some((path) => folds.get(foldKey(path)) === true);
  const anyOpen = folders.some((node) => !collapsed(node));
  const changes = (node: DirNode<T>, fold: boolean): Array<[string, true | undefined]> =>
    fold ? [[foldKey(node.path), true]] : node.chain.map((path) => [foldKey(path), undefined]);
  const setFolder = (node: DirNode<T>, fold: boolean) => treeFolds.setMany(changes(node, fold));
  const setEvery = (fold: boolean) => treeFolds.setMany(folders.flatMap((node) => changes(node, fold)));
  const commentsOf = (part: T) =>
    part.part === "recorded" ? 0 : (commentCounts.get(markId(part.part, part.file.path)) ?? 0);
  const reviewedOf = (part: T) => part.part !== "recorded" && isReviewed(marks, part);
  const keys: string[] = [];
  const visibleKeys = (list: readonly TreeNode<T>[]) => {
    for (const node of list) {
      if (node.kind === "file") keys.push(cardKey(node.item));
      else {
        keys.push(`dir:${node.path}`);
        if (!collapsed(node)) visibleKeys(node.children);
      }
    }
  };
  visibleKeys(nodes);
  const held = folders.find(
    (node) =>
      collapsed(node) &&
      keys.includes(`dir:${node.path}`) &&
      filesBelow(node).some((part) => cardKey(part) === focused),
  );
  const tabbable =
    active !== null && keys.includes(active)
      ? active
      : focused !== null && keys.includes(focused)
        ? focused
        : held
          ? `dir:${held.path}`
          : keys[0];
  const tabStop = navigator === undefined || navigator.tabStop;
  const navigationProps = (key: string) => ({
    "data-file-nav": key,
    tabIndex: key === tabbable && tabStop ? 0 : -1,
    onFocus: () => {
      setActive(key);
      navigator?.onFocusItem();
    },
  });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target =
      event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("[data-file-nav]") : null;
    if (target === null || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-file-nav]")];
    const index = buttons.indexOf(target);
    const dir = target.parentElement?.hasAttribute("data-tree-dir") ? target.parentElement : null;
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = buttons[index + 1];
    else if (event.key === "ArrowUp") next = buttons[index - 1];
    else if (event.key === "Home") next = buttons[0];
    else if (event.key === "End") next = buttons.at(-1);
    else if (event.key === "ArrowRight" && dir !== null) {
      if (target.getAttribute("aria-expanded") === "false") target.click();
      else next = buttons[index + 1];
    } else if (event.key === "ArrowLeft") {
      if (dir !== null && target.getAttribute("aria-expanded") === "true") target.click();
      else
        next =
          target.parentElement?.parentElement
            ?.closest("[data-tree-dir]")
            ?.querySelector<HTMLButtonElement>("[data-file-nav]") ?? undefined;
    } else return;
    event.preventDefault();
    next?.focus();
  };

  const file = (part: T, depth: number): ReactNode => {
    const key = cardKey(part);
    const reviewed = reviewedOf(part);
    const comments = commentsOf(part);
    const note = noteOf(part);
    const current = focused === key;
    return (
      <div
        key={key}
        data-tree-file={part.file.path}
        data-selected={(navigator !== undefined && current) || undefined}
        className={
          navigator === undefined
            ? `flex items-center rounded-md ${current ? "bg-surface-selected" : "hover:bg-state-hover"}`
            : `relative flex min-h-7 items-center ${current ? NAV_SELECTED : NAV_HOVER}`
        }
      >
        {navigator !== undefined && <IndentGuides depth={depth} offset={navIndent(0) + 7} />}
        {navigator !== undefined && current && <SelectionBar />}
        <button
          type="button"
          {...navigationProps(key)}
          aria-current={current ? "true" : undefined}
          onClick={() => onJump(key)}
          title={part.file.path}
          style={{ paddingLeft: navigator === undefined ? indent(depth) + 16 : navIndent(depth) + 20 }}
          className={
            navigator === undefined
              ? "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 pr-1 text-left"
              : `flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm pr-1 text-left ${NAV_FOCUS}`
          }
        >
          {part.part !== "recorded" && <StatusLetter file={part.file} navigator={navigator !== undefined} />}
          <span
            className={
              navigator === undefined
                ? `min-w-0 flex-1 truncate font-mono text-[11.5px] ${reviewed ? "text-subtle-foreground" : "text-foreground"}`
                : `min-w-0 flex-1 truncate font-mono text-xs ${reviewed ? NAV_MUTED : "text-foreground"} ${current ? "font-semibold" : ""}`
            }
          >
            {part.file.path.slice(part.file.path.lastIndexOf("/") + 1)}
            {note !== null && (
              <span
                className={`font-sans text-[10.5px] ${navigator === undefined ? "text-subtle-foreground" : NAV_MUTED}`}
              >
                {" "}
                · {note}
              </span>
            )}
          </span>
          {overlapPaths.has(part.file.path) && (
            <Icon
              name="AlertTriangle"
              className="size-3 shrink-0 text-warning-text"
              aria-label="Also changed in another worktree"
            />
          )}
          {comments > 0 && (
            <span
              className={`shrink-0 text-[10.5px] ${navigator === undefined ? "text-muted-foreground" : NAV_MUTED}`}
              title={plural(comments, "comment")}
            >
              {comments}
            </span>
          )}
          {part.part !== "recorded" && <Counts file={part.file} navigator={navigator !== undefined} />}
        </button>
        {onReview !== undefined && (
          <button
            type="button"
            tabIndex={key === tabbable && navigator === undefined ? 0 : -1}
            aria-label={reviewed ? `Mark ${part.file.path} as not reviewed` : `Mark ${part.file.path} as reviewed`}
            aria-pressed={reviewed}
            onClick={() => onReview(part)}
            className={`${ICON_BUTTON} ml-0.5 ${reviewed ? "text-success" : ""}`}
          >
            <Icon name={reviewed ? "Check" : "Square"} className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
    );
  };

  const folder = (node: DirNode<T>, depth: number): ReactNode => {
    const closed = collapsed(node);
    const below = closed ? filesBelow(node) : [];
    // A collapsed folder still says what is inside that needs a look.
    const holdsFocus = below.some((part) => cardKey(part) === focused);
    const overlap = below.some((part) => overlapPaths.has(part.file.path));
    const comments = below.reduce((total, part) => total + commentsOf(part), 0);
    const reviewed = below.length > 0 && below.every(reviewedOf);
    const inNav = navigator !== undefined;
    return (
      <div key={`dir\0${node.path}`} data-tree-dir={node.path}>
        <button
          type="button"
          {...navigationProps(`dir:${node.path}`)}
          data-holds-selection={holdsFocus || undefined}
          aria-expanded={!closed}
          aria-label={`${node.path} folder`}
          onClick={() => setFolder(node, !closed)}
          title={node.path}
          style={{ paddingLeft: inNav ? navIndent(depth) : indent(depth) }}
          className={
            inNav
              ? `relative flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm pr-1.5 text-left text-foreground ${NAV_HOVER} ${NAV_FOCUS}`
              : `flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pr-1.5 text-left text-muted-foreground hover:bg-state-hover hover:text-foreground ${holdsFocus ? "bg-surface-selected" : ""}`
          }
        >
          {inNav && <IndentGuides depth={depth} offset={navIndent(0) + 7} />}
          {inNav ? (
            <Chevron open={!closed} />
          ) : (
            <Icon name={closed ? "ChevronRight" : "ChevronDown"} className="size-3 shrink-0" aria-hidden />
          )}
          <Icon
            name={closed ? "Folder" : "FolderOpen"}
            fallback="Folder"
            className={inNav ? `size-3.5 shrink-0 ${holdsFocus ? "text-primary" : NAV_MUTED}` : "size-3 shrink-0"}
            aria-hidden
          />
          <span
            className={
              inNav
                ? `min-w-0 flex-1 truncate font-mono text-xs ${reviewed ? NAV_MUTED : ""}`
                : `min-w-0 flex-1 truncate font-mono text-[11.5px] ${reviewed ? "text-subtle-foreground" : ""}`
            }
          >
            {node.name}
          </span>
          {overlap && (
            <Icon
              name="AlertTriangle"
              className="size-3 shrink-0 text-warning-text"
              aria-label="A file in here is also changed in another worktree"
            />
          )}
          {comments > 0 && (
            <span className={`shrink-0 text-[10.5px] ${inNav ? NAV_MUTED : ""}`} title={plural(comments, "comment")}>
              {comments}
            </span>
          )}
          {reviewed && <Icon name="Check" className="size-3 shrink-0 text-success" aria-label="Every file reviewed" />}
          {closed && (
            <span
              className={`shrink-0 tabular-nums ${inNav ? `text-[11px] ${NAV_MUTED}` : "text-[10.5px] text-subtle-foreground"}`}
              title={plural(node.files, "file")}
            >
              {node.files}
            </span>
          )}
        </button>
        {!closed && render(node.children, depth + 1)}
      </div>
    );
  };

  const render = (list: readonly TreeNode<T>[], depth: number): ReactNode[] =>
    list.map((node) => (node.kind === "dir" ? folder(node, depth) : file(node.item, depth)));

  const collapseEvery = folders.length > 0 && (
    <button
      type="button"
      onClick={() => setEvery(anyOpen)}
      aria-label={anyOpen ? "Collapse every folder" : "Expand every folder"}
      title={anyOpen ? "Collapse every folder" : "Expand every folder"}
      className={ICON_BUTTON}
    >
      <Icon
        name={anyOpen ? "ChevronsUp" : "ChevronsDown"}
        fallback={anyOpen ? "ChevronUp" : "ChevronDown"}
        className="size-3.5"
        aria-hidden
      />
    </button>
  );
  if (navigator !== undefined) {
    const { files } = navigator;
    return (
      <nav aria-label="Files" data-file-tree className="flex min-h-0 min-w-0 flex-1 flex-col text-xs">
        <div data-files-header className="flex h-9 shrink-0 items-center gap-1 pl-1.5 pr-1.5">
          <button
            type="button"
            data-files-toggle
            aria-expanded={!files.hidden}
            aria-controls={files.hidden ? undefined : `${files.id}-list`}
            onClick={files.toggle}
            title={`Files · ${files.label} · ${plural(parts.length, "file")}`}
            className={`flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1 text-left ${NAV_HOVER} ${NAV_FOCUS}`}
          >
            <Chevron open={!files.hidden} />
            <span className="shrink-0 font-semibold text-foreground">Files</span>
            <span className={`min-w-0 truncate ${NAV_MUTED}`}>· {files.label}</span>
            <span className="flex-1" />
            <span className={`shrink-0 tabular-nums ${NAV_MUTED}`}>{parts.length}</span>
          </button>
          {!files.hidden && collapseEvery}
        </div>
        {!files.hidden && (
          <div id={`${files.id}-list`} data-files-scroll className="min-h-0 flex-1 overflow-y-auto pb-2">
            {render(nodes, 0)}
          </div>
        )}
      </nav>
    );
  }
  return (
    <nav
      aria-label="Files"
      data-file-tree
      onKeyDown={onKeyDown}
      className={`min-h-0 min-w-0 overflow-y-auto border-border-seam px-1.5 pb-2 text-xs ${stacked ? "max-h-[min(28vh,16rem)] border-b" : "border-r"}`}
    >
      <div className="sticky top-0 z-[1] flex h-8 items-center gap-1 bg-surface-recessed pl-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">
        Files<span className="font-normal">{parts.length}</span>
        <span className="flex-1" />
        {collapseEvery}
      </div>
      {render(nodes, 0)}
    </nav>
  );
}
