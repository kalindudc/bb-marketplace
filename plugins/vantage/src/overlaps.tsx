import { useMemo, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { FileChange, Overview, PatchOutput, SharedFile, ThreadSummary, Worktree } from "./contract";
import type { CommentStore } from "./comments";
import { FileCard, patchKey, patchRequest, type FileLoaders } from "./file-card";
import { loadShared, useLoaded, type Loaded } from "./loaded";
import { plural, type Row } from "./model";
import { StatusGlyph } from "./review";

export type Verdict = "conflict" | "clean" | "unknown";
interface Range { start: number; end: number }

// Old-side line ranges of every hunk; an insertion with no old lines counts as touching the line it follows.
export function hunkRanges(patch: string): Range[] {
  const ranges: Range[] = [];
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = Number(match[1]);
    const length = match[2] === undefined ? 1 : Number(match[2]);
    ranges.push({ start, end: start + Math.max(length, 1) - 1 });
  }
  return ranges;
}

// A guess, not a merge: git stops on changes to the same or neighbouring lines, so ranges that touch count as a conflict.
export function overlapVerdict(patches: ReadonlyArray<readonly string[]>): Verdict {
  if (patches.length < 2 || patches.some((list) => list.length === 0)) return "unknown";
  const sides = patches.map((list) => list.flatMap(hunkRanges));
  if (sides.some((ranges) => ranges.length === 0)) return "unknown";
  for (let a = 0; a < sides.length; a++) {
    for (let b = a + 1; b < sides.length; b++) {
      for (const left of sides[a]!) for (const right of sides[b]!) if (left.start <= right.end + 1 && right.start <= left.end + 1) return "conflict";
    }
  }
  return "clean";
}

interface Side { worktree: Worktree; row: Row | undefined; parts: Array<{ file: FileChange; scope: "uncommitted" | "committed" }> }

function sidesOf(shared: SharedFile, overview: Overview, rows: ReadonlyMap<string, Row>): Side[] {
  return shared.worktreeKeys.flatMap((key) => {
    const worktree = overview.worktrees.find((entry) => entry.key === key);
    if (worktree === undefined) return [];
    const parts = [
      ...worktree.committed.filter((file) => file.path === shared.path).map((file) => ({ file, scope: "committed" as const })),
      ...worktree.uncommitted.filter((file) => file.path === shared.path).map((file) => ({ file, scope: "uncommitted" as const })),
    ];
    return [{ worktree, row: rows.get(key), parts }];
  });
}

// One load for the card's verdict; each patch goes through the shared cache, so the cards below reuse it.
function usePatches(sides: readonly Side[], loaders: FileLoaders): Loaded<string[][]> {
  const keys = sides.map((side) => side.parts.map((part) => `patch\0${patchKey(side.worktree, part.file, part.scope, null)}`));
  const [state] = useLoaded(`overlap\0${keys.flat().join("\u0001")}`, true, () => Promise.all(sides.map((side, index) => Promise.all(
    side.parts.map((part, partIndex) => loadShared<PatchOutput>(keys[index]![partIndex]!, () => loaders.patch(patchRequest(side.worktree, part.file, part.scope, null)))
      .then((output) => output.patch)),
  ))));
  return state;
}

function OverlapCard({ shared, overview, rows, titleOf, threads, loaders, onReview, onAskRebase }: {
  shared: SharedFile; overview: Overview; rows: ReadonlyMap<string, Row>; titleOf(key: string): string; threads: ReadonlyMap<string, ThreadSummary>;
  loaders: FileLoaders; onReview(key: string): void; onAskRebase(from: Worktree, onto: Worktree, path: string): void;
}) {
  const sides = sidesOf(shared, overview, rows);
  const loaded = usePatches(sides, loaders);
  const ready = loaded.status === "ready" || loaded.status === "error";
  const verdict: Verdict = loaded.status === "ready" ? overlapVerdict(loaded.value) : "unknown";
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const project = sides[0]?.worktree.label ?? "";
  return (
    <section data-overlap={shared.path} className="mb-4 overflow-hidden rounded-xl border border-border-seam bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-border-seam px-4 py-3">
        <Icon name="File" fallback="FileText" className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-mono text-sm font-semibold text-foreground">{shared.path}</span>
        <span className="text-xs text-muted-foreground">· {project}</span>
        <span className="flex-1" />
        {verdict === "conflict" && <span data-verdict="conflict" className="inline-flex items-center gap-1 rounded-full bg-surface-destructive px-2 py-px text-xs text-destructive-text"><Icon name="AlertTriangle" className="size-3" aria-hidden />Likely to conflict</span>}
        {verdict === "clean" && <span data-verdict="clean" className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-px text-xs text-success"><Icon name="Check" className="size-3" aria-hidden />Should merge cleanly</span>}
        {verdict === "unknown" && <span data-verdict="unknown" className="text-xs text-muted-foreground">{ready ? "Could not compare the changes" : "Comparing the changes…"}</span>}
      </header>
      <p className="px-4 pt-2.5 text-xs text-muted-foreground">
        {verdict === "conflict"
          ? "Both change the same or neighbouring lines, so whichever branch merges second will likely stop on a merge conflict."
          : verdict === "clean"
            ? "They change different parts of the file, so git should merge them without help. Check the result once both land."
            : "Vantage compares the lines each worktree changed. This is a guess, not a real merge."}
      </p>
      <div className={`grid gap-3 p-4 ${sides.length > 1 ? "lg:grid-cols-2" : ""}`}>
        {sides.map((side) => (
          <div key={side.worktree.key} className="min-w-0">
            <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-xs">
              {side.row !== undefined && <span className="flex size-4 items-center justify-center"><StatusGlyph row={side.row} /></span>}
              <span className="min-w-0 truncate font-medium text-foreground">{titleOf(side.worktree.key)}</span>
              {side.worktree.branch !== null && <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{side.worktree.branch}</span>}
            </div>
            {side.parts.map((part) => {
              const key = `${side.worktree.key}\0${part.scope}\0${part.file.path}`;
              return (
                <FileCard key={key} cardKey={key} repo={side.worktree} file={part.file} scope={part.scope} folded={folds.get(key) ?? false}
                  onFold={(id) => setFolds((current) => new Map(current).set(id, !(current.get(id) ?? false)))}
                  note={part.scope === "uncommitted" ? "not committed" : "committed"} view="unified" compact threads={threads} loaders={loaders} />
              );
            })}
          </div>
        ))}
      </div>
      <footer className="flex flex-wrap gap-2 px-4 pb-4">
        {sides.length === 2 && sides.map((side, index) => {
          const other = sides[1 - index]!;
          if (side.worktree.kind === "branch" || side.row?.live.archived === true) return null;
          return (
            <button key={side.worktree.key} type="button" onClick={() => onAskRebase(side.worktree, other.worktree, shared.path)}
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border-seam px-2.5 text-xs text-foreground hover:bg-state-hover">
              <Icon name="SideChat" className="size-3.5" aria-hidden />Ask {titleOf(side.worktree.key)} to rebase onto {titleOf(other.worktree.key)}
            </button>
          );
        })}
        {sides.map((side) => (
          <button key={`review\0${side.worktree.key}`} type="button" onClick={() => onReview(side.worktree.key)}
            className="h-7 cursor-pointer rounded-md px-2.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
            Review {titleOf(side.worktree.key)}
          </button>
        ))}
      </footer>
    </section>
  );
}

export function Overlaps({ overview, rows, titleOf, loaders, comments, onReview, text }: {
  overview: Overview; rows: readonly Row[]; titleOf(key: string): string; loaders: FileLoaders; comments: CommentStore; onReview(key: string): void; text: string;
}) {
  const byKey = useMemo(() => new Map(rows.map((row) => [row.worktree.key, row])), [rows]);
  const threads = useMemo(() => new Map(overview.threads.map((thread) => [thread.id, thread])), [overview.threads]);
  const query = text.trim().toLowerCase();
  const shared = overview.partial ? [] : overview.sharedFiles.filter((file) =>
    file.worktreeKeys.some((key) => byKey.get(key)?.bucket !== "archived")
    && (query === "" || file.path.toLowerCase().includes(query) || file.worktreeKeys.some((key) => titleOf(key).toLowerCase().includes(query))));
  const askRebase = (from: Worktree, onto: Worktree, path: string) => {
    const part = from.uncommitted.some((file) => file.path === path) ? "uncommitted" as const : "committed" as const;
    comments.add(from.key, {
      path, part, quote: "",
      text: `This file is also changed in "${titleOf(onto.key)}"${onto.branch === null ? "" : ` on ${onto.branch}`}. Commit your work, rebase onto ${onto.branch ?? "that branch"} and resolve the conflict in ${path}, keeping both changes.`,
    });
    onReview(from.key);
  };
  return (
    <div data-overlaps className="mx-auto w-full max-w-6xl px-6 pb-8 pt-5">
      <h1 className="text-lg font-semibold text-foreground">Overlapping files</h1>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">
        Files that more than one worktree of the same project changed. Vantage compares the changed lines to guess whether merging both branches will need a hand.
      </p>
      {overview.partial && <p className="text-sm text-muted-foreground">Reading every worktree's files…</p>}
      {!overview.partial && shared.length === 0 && <p className="text-sm text-muted-foreground">No file is changed in more than one worktree.</p>}
      {shared.map((file) => (
        <OverlapCard key={`${file.projectId}\0${file.path}`} shared={file} overview={overview} rows={byKey} titleOf={titleOf} threads={threads}
          loaders={loaders} onReview={onReview} onAskRebase={askRebase} />
      ))}
      {shared.length > 0 && <p className="text-xs text-subtle-foreground">{plural(shared.length, "file")} overlap.</p>}
    </div>
  );
}
