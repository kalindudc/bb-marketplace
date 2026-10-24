import { useMemo, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ReviewMarks } from "./contract";
import { Counts, ICON_BUTTON, StatusLetter } from "./file-card";
import { buildFileTree, dirNodes, filesBelow, type DirNode, type TreeNode } from "./file-tree";
import { plural } from "./model";
import { useRemembered } from "./remember";
import { isReviewed, markId, type FilePart } from "./reviewed";
import { treeFolds } from "./ui-prefs";

export interface FileTreeProps {
  parts: readonly FilePart[];
  // Folders stay collapsed per worktree.
  worktreeKey: string;
  cardKey(part: FilePart): string;
  noteOf(part: FilePart): string | null;
  focused: string | null;
  marks: ReviewMarks | undefined;
  commentCounts: ReadonlyMap<string, number>;
  overlapPaths: ReadonlySet<string>;
  onJump(key: string): void;
  onReview(part: FilePart): void;
}

const INDENT_PX = 12;
const indent = (depth: number): number => 6 + depth * INDENT_PX;

export function FileTree(props: FileTreeProps) {
  const { parts, worktreeKey, cardKey, noteOf, focused, marks, commentCounts, overlapPaths, onJump, onReview } = props;
  const nodes = useMemo(() => buildFileTree(parts, (part) => part.file.path), [parts]);
  const folders = useMemo(() => dirNodes(nodes), [nodes]);
  const folds = useRemembered(treeFolds);
  const foldKey = (path: string) => `${worktreeKey}\0${path}`;
  // A joined row's path changes with the files listed ("src" and "src/lib" become "src/lib" when src holds nothing else),
  // so it counts as collapsed when any folder it stands for is, and opening it opens all of them.
  const collapsed = (node: DirNode<FilePart>) => node.chain.some((path) => folds.get(foldKey(path)) === true);
  const anyOpen = folders.some((node) => !collapsed(node));
  const changes = (node: DirNode<FilePart>, fold: boolean): Array<[string, true | undefined]> =>
    fold ? [[foldKey(node.path), true]] : node.chain.map((path) => [foldKey(path), undefined]);
  const setFolder = (node: DirNode<FilePart>, fold: boolean) => treeFolds.setMany(changes(node, fold));
  const setEvery = (fold: boolean) => treeFolds.setMany(folders.flatMap((node) => changes(node, fold)));
  const focusedPath = parts.find((part) => cardKey(part) === focused)?.file.path ?? null;
  const commentsOf = (part: FilePart) => commentCounts.get(markId(part.part, part.file.path)) ?? 0;

  const file = (part: FilePart, depth: number): ReactNode => {
    const key = cardKey(part);
    const reviewed = isReviewed(marks, part);
    const comments = commentsOf(part);
    const note = noteOf(part);
    return (
      <div key={key} data-tree-file={part.file.path} className={`flex items-center rounded-md ${focused === key ? "bg-surface-selected" : "hover:bg-state-hover"}`}>
        <button type="button" onClick={() => onJump(key)} title={part.file.path} style={{ paddingLeft: indent(depth) + 16 }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 pr-1 text-left">
          <StatusLetter file={part.file} />
          <span className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${reviewed ? "text-subtle-foreground" : "text-foreground"}`}>
            {part.file.path.slice(part.file.path.lastIndexOf("/") + 1)}
            {note !== null && <span className="font-sans text-[10.5px] text-subtle-foreground"> · {note}</span>}
          </span>
          {overlapPaths.has(part.file.path) && <Icon name="AlertTriangle" className="size-3 shrink-0 text-warning-text" aria-label="Also changed in another worktree" />}
          {comments > 0 && <span className="shrink-0 text-[10.5px] text-muted-foreground" title={plural(comments, "comment")}>{comments}</span>}
          <Counts file={part.file} />
        </button>
        <button type="button" aria-label={reviewed ? `Mark ${part.file.path} as not reviewed` : `Mark ${part.file.path} as reviewed`} aria-pressed={reviewed}
          onClick={() => onReview(part)} className={`${ICON_BUTTON} ml-0.5 ${reviewed ? "text-success" : ""}`}>
          <Icon name={reviewed ? "Check" : "Square"} className="size-3.5" aria-hidden />
        </button>
      </div>
    );
  };

  const folder = (node: DirNode<FilePart>, depth: number): ReactNode => {
    const closed = collapsed(node);
    const below = closed ? filesBelow(node) : [];
    // A collapsed folder still says what is inside that needs a look.
    const holdsFocus = closed && focusedPath !== null && focusedPath.startsWith(`${node.path}/`);
    const overlap = below.some((part) => overlapPaths.has(part.file.path));
    const comments = below.reduce((total, part) => total + commentsOf(part), 0);
    const reviewed = below.length > 0 && below.every((part) => isReviewed(marks, part));
    return (
      <div key={`dir\0${node.path}`} data-tree-dir={node.path}>
        <button type="button" aria-expanded={!closed} aria-label={`${node.path} folder`} onClick={() => setFolder(node, !closed)} title={node.path}
          style={{ paddingLeft: indent(depth) }}
          className={`flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pr-1.5 text-left text-muted-foreground hover:bg-state-hover hover:text-foreground ${holdsFocus ? "bg-surface-selected" : ""}`}>
          <Icon name={closed ? "ChevronRight" : "ChevronDown"} className="size-3 shrink-0" aria-hidden />
          <Icon name={closed ? "Folder" : "FolderOpen"} fallback="Folder" className="size-3 shrink-0" aria-hidden />
          <span className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${reviewed ? "text-subtle-foreground" : ""}`}>{node.name}</span>
          {overlap && <Icon name="AlertTriangle" className="size-3 shrink-0 text-warning-text" aria-label="A file in here is also changed in another worktree" />}
          {comments > 0 && <span className="shrink-0 text-[10.5px]" title={plural(comments, "comment")}>{comments}</span>}
          {reviewed && <Icon name="Check" className="size-3 shrink-0 text-success" aria-label="Every file reviewed" />}
          {closed && <span className="shrink-0 text-[10.5px] text-subtle-foreground" title={plural(node.files, "file")}>{node.files}</span>}
        </button>
        {!closed && render(node.children, depth + 1)}
      </div>
    );
  };

  const render = (list: readonly TreeNode<FilePart>[], depth: number): ReactNode[] =>
    list.map((node) => (node.kind === "dir" ? folder(node, depth) : file(node.item, depth)));

  return (
    <nav aria-label="Files" data-file-tree className="min-h-0 overflow-y-auto border-r border-border-seam px-1.5 pb-2 text-xs">
      <div className="sticky top-0 z-[1] flex h-8 items-center gap-1 bg-surface-recessed pl-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">
        Files<span className="font-normal">{parts.length}</span>
        <span className="flex-1" />
        {folders.length > 0 && (
          <button type="button" onClick={() => setEvery(anyOpen)} aria-label={anyOpen ? "Collapse every folder" : "Expand every folder"}
            title={anyOpen ? "Collapse every folder" : "Expand every folder"} className={ICON_BUTTON}>
            <Icon name={anyOpen ? "ChevronsUp" : "ChevronsDown"} fallback={anyOpen ? "ChevronUp" : "ChevronDown"} className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {render(nodes, 0)}
    </nav>
  );
}
