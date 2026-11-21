import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { CopyPath, FileCard } from "./file-card";
import { reviewDraftKey } from "./comments";
import { DraftInspection } from "./draft-inspection";
import { FileTree } from "./file-tree-view";
import { needsYou } from "./live";
import { usePanelNav } from "./navigator";
import { IncompleteChip, NotReadChip } from "./panel-head";
import { readingKey, type Subject } from "./reading-state";
import { returnToFiles, useReadingStream } from "./reading-stream";
import { useRemembered } from "./remember";
import {
  DiffLayout,
  FocusSummary,
  FoldAllButton,
  Review,
  ReviewBar,
  WrapButton,
  isTyping,
  type ReviewProps,
} from "./review";
import { useShared } from "./session";
import { SkeletonRows } from "./skeleton";
import { evidenceOf, sameSubject, sourceChoices, type TrailEntry } from "./trail";
import { diffView, diffWrap, fileFolds, foldAll, setFoldAll } from "./ui-prefs";

const emptyCounts = new Map<string, number>();
const emptyPaths = new Set<string>();
const sourceLabel = {
  checkout: "Checkout Git",
  branch: "Kept branch",
  recorded: "Recorded edits",
  unavailable: "Unavailable",
};

type Props = Omit<ReviewProps, "row"> & {
  readerKey: string;
  entry: TrailEntry | undefined;
  onSource(subject: Subject): void;
};

export function EvidenceReader(props: Props) {
  const { reader, entry, onSource, toolbar } = props;
  const { subject } = reader;
  const nav = usePanelNav();
  const groupRef = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef<Subject | null>(null);
  useLayoutEffect(() => {
    if (!sameSubject(pendingFocus.current, subject)) return;
    pendingFocus.current = null;
    const group = groupRef.current;
    if (group !== null && (document.activeElement === document.body || group.contains(document.activeElement)))
      (group.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? group).focus();
  }, [subject]);
  const sources = entry === undefined ? [] : evidenceOf(entry);
  const readable = sources.some((source) => sameSubject(source, subject));
  const choice = (source: Subject) => {
    const label = sourceLabel[source.source];
    const row = entry?.worktrees.find(({ worktree }) => worktree.key === source.worktreeKey);
    return sources.filter((other) => other.source === source.source).length > 1 && row !== undefined
      ? `${label} · ${row.worktree.label} (${row.worktree.root})`
      : label;
  };
  const controls = (
    <>
      {toolbar}
      <div
        ref={groupRef}
        tabIndex={-1}
        role="group"
        aria-label="Evidence source"
        className="flex min-w-0 flex-wrap items-center gap-1 text-xs focus-visible:ring-1 focus-visible:ring-ring"
      >
        {(!readable || sources.length > 1 ? sources.filter((source) => source.source !== "unavailable") : []).map(
          (source) => (
            <button
              type="button"
              key={`${source.source}:${source.worktreeKey ?? ""}`}
              aria-pressed={sameSubject(source, subject)}
              onClick={(event) => {
                if (sameSubject(source, subject)) return;
                pendingFocus.current = event.currentTarget === document.activeElement ? source : null;
                onSource(source);
              }}
              className="min-h-7 max-w-full truncate rounded border border-border-seam px-2 hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring"
            >
              {choice(source)}
            </button>
          ),
        )}
        {(!readable || sources.length <= 1) && (
          <span className="text-muted-foreground">
            {!readable && "Requested: "}
            {sourceLabel[subject.source]}
          </span>
        )}
      </div>
    </>
  );
  // The side panel's source switch for when its navigator is hidden: each source says whose work it is.
  const choices = nav === null || entry === undefined ? [] : sourceChoices(entry, props.currentThreadId);
  const panelSources = nav !== null && choices.length > 0 && (
    <div role="group" aria-label="Evidence source" className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
      {choices.length > 1 || !readable ? (
        choices.map((choice) => (
          <button
            type="button"
            key={choice.key}
            aria-pressed={sameSubject(choice.subject, subject)}
            onClick={() => {
              if (!sameSubject(choice.subject, subject)) onSource(choice.subject);
            }}
            title={`${choice.label} · ${choice.qualifier}`}
            className={`inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border-seam px-2 hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${sameSubject(choice.subject, subject) ? "bg-surface-selected font-medium" : ""}`}
          >
            <span className="truncate">
              {choice.label} · {choice.qualifier}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{choice.count ?? "…"}</span>
          </button>
        ))
      ) : (
        <span className="text-muted-foreground">
          {choices[0]!.label} · {choices[0]!.qualifier}
        </span>
      )}
    </div>
  );
  const onRecorded =
    entry !== undefined && entry.recorded.length > 0
      ? () => onSource({ threadId: entry.id, source: "recorded" })
      : undefined;
  const row = readable ? entry?.worktrees.find(({ worktree }) => worktree.key === subject.worktreeKey) : undefined;
  if (row !== undefined && entry !== undefined) {
    return (
      <Review
        {...props}
        key={props.readerKey}
        panelSources={panelSources}
        onRecorded={onRecorded}
        toolbar={controls}
        row={{
          ...row,
          live: entry.live,
          threadId: entry.id,
          title: entry.id === props.currentThreadId ? "This thread" : entry.live.title,
        }}
      />
    );
  }
  return (
    <RecordedReader
      {...props}
      key={props.readerKey}
      panelSources={panelSources}
      toolbar={controls}
      readable={readable && subject.source === "recorded"}
    />
  );
}

function RecordedReader({
  overview,
  entry,
  reader,
  currentThreadId,
  compact,
  toolbar,
  loaders,
  comments,
  onMessage,
  readable,
  panelSources,
}: Props & { readable: boolean }) {
  const navigate = useBbNavigate();
  const nav = usePanelNav();
  const root = useRef<HTMLElement | null>(null);
  const { subject, surface, onArrival } = reader;
  useEffect(() => {
    if (!overview.partial) onArrival?.();
  }, [overview.partial, onArrival]);
  const key = readingKey(reader.keyScope ?? surface, subject);
  const state = useReadingStream({ ...reader, key, fallback: { scope: "recorded" }, ready: !overview.partial });
  const { reading, treeOn, streamRef, toggleRef, select, focusMode, toggleFocus, updateAnchor } = state;
  const layout = useShared(diffView);
  const wrap = useShared(diffWrap);
  const foldDefault = useShared(foldAll);
  const folds = useRemembered(fileFolds);
  const files = readable ? (entry?.recorded ?? []) : [];
  const parts = files.map((file) => ({ part: "recorded" as const, file }));
  const threads = useMemo(() => new Map(overview.threads.map((thread) => [thread.id, thread])), [overview.threads]);
  const foldKey = (path: string) => `review\0recorded\0${subject.threadId}\0${path}`;
  const folded = (path: string) => folds.get(foldKey(path)) ?? foldDefault;
  const setFold = (path: string, value: boolean) =>
    fileFolds.set(foldKey(path), value === foldDefault ? undefined : value);
  const allFolded = files.length > 0 && files.every(({ path }) => folded(path));
  const selected =
    reading.part === "recorded" && files.some(({ path }) => path === reading.file) ? reading.file! : null;
  const hasTree = nav === null && treeOn && !focusMode && parts.length > 0;
  const title = entry?.live.title ?? subject.threadId;
  const archived = entry?.live.archived === true;
  const live = entry !== undefined && !archived && !entry.stub;
  const toggleAll = () => setFoldAll(!allFolded);
  const unavailableFile = !overview.partial && reading.file !== undefined && selected === null;
  const draftWorktrees = new Set(
    entry?.worktrees.filter(({ worktree }) => worktree.state === "unavailable").map(({ worktree }) => worktree.key),
  );
  if (subject.worktreeKey !== undefined) draftWorktrees.add(subject.worktreeKey);
  return (
    <section
      ref={root}
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-recorded-review={subject.threadId}
      onKeyDown={(event) => {
        if (event.defaultPrevented || isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "f" || (event.key === "Escape" && focusMode)) {
          if (event.nativeEvent.isComposing) return;
          if (!event.repeat) toggleFocus("stream");
          event.preventDefault();
        } else if (
          event.key === "Escape" &&
          returnToFiles(nav?.treeSlot ?? root.current, selected, toggleRef.current, event.target)
        )
          event.preventDefault();
        else if (event.key === "x" && parts.length > 0) {
          toggleAll();
          event.preventDefault();
        } else if (event.key === "w" && !event.nativeEvent.isComposing) {
          diffWrap.set(!wrap);
          event.preventDefault();
        }
        if (event.defaultPrevented) event.stopPropagation();
      }}
    >
      {nav !== null && !focusMode && (
        <div
          data-thread-chips
          className="relative flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 px-3 pb-2 pt-1.5"
        >
          {entry?.worktrees
            .filter(({ worktree }) => worktree.state === "unavailable")
            .map(({ worktree }) => (
              <NotReadChip key={worktree.key} message={worktree.message} />
            ))}
          {entry?.incomplete === true && <IncompleteChip onOpen={nav.showIncomplete} />}
          {archived && (
            <span className="text-xs text-muted-foreground">
              This thread is archived and cannot receive review messages.
            </span>
          )}
          {!nav.sourcesShown && panelSources}
        </div>
      )}
      {nav === null && (
        <div hidden={focusMode} className="shrink-0 space-y-2 border-b border-border-seam p-3">
          <h2 className="truncate font-semibold" title={title}>
            {title}
            {archived && " · Archived"}
          </h2>
          {entry?.message != null && (
            <p role="status" className="text-xs text-warning-text">
              {entry.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2 text-xs">
            {live && currentThreadId !== subject.threadId && (
              <button
                type="button"
                onClick={onMessage}
                className="min-h-7 rounded border border-border-seam px-2 hover:bg-state-hover"
              >
                {entry.live.indicator === "waiting-for-input" && needsYou(entry.live) ? "Answer" : "Message agent"}
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                navigate.toThread(subject.threadId, currentThreadId === null ? undefined : { split: true })
              }
              className="min-h-7 rounded border border-border-seam px-2 hover:bg-state-hover"
            >
              Open thread
            </button>
            {archived && (
              <span className="self-center text-muted-foreground">
                This thread is archived and cannot receive review messages.
              </span>
            )}
          </div>
        </div>
      )}
      {focusMode && currentThreadId !== null && <FocusSummary title={title} files={files.length} />}
      <ReviewBar stream={state} className="px-3" panel={nav?.layout}>
        {(nav === null || focusMode) && toolbar}
        <WrapButton />
        {parts.length > 0 && <FoldAllButton allFolded={allFolded} compact={compact === true} onToggle={toggleAll} />}
        {(currentThreadId === null || focusMode) && <DiffLayout view={layout} />}
      </ReviewBar>
      <div
        className={`grid min-h-0 min-w-0 flex-1 ${hasTree && compact ? "grid-rows-[auto_minmax(0,1fr)]" : hasTree ? "grid-cols-[clamp(10rem,24%,16rem)_minmax(0,1fr)]" : "grid-cols-1"}`}
      >
        {nav !== null &&
          nav.treeSlot !== null &&
          !focusMode &&
          parts.length > 0 &&
          createPortal(
            <FileTree
              parts={parts}
              worktreeKey={`recorded:${subject.threadId}`}
              cardKey={({ file }) => file.path}
              noteOf={() => null}
              focused={selected}
              marks={undefined}
              commentCounts={emptyCounts}
              overlapPaths={emptyPaths}
              onJump={(path) => {
                setFold(path, false);
                select(path, "recorded", true);
                nav.onFilePicked();
              }}
              navigator={{
                tabStop: nav.filesTabStop,
                onFocusItem: nav.onFilesFocus,
                onPresence: nav.onFilesPresent,
                files: nav.files,
              }}
            />,
            nav.treeSlot,
          )}
        {hasTree && (
          <FileTree
            parts={parts}
            stacked={compact === true}
            worktreeKey={`recorded:${subject.threadId}`}
            cardKey={({ file }) => file.path}
            noteOf={() => null}
            focused={selected}
            marks={undefined}
            commentCounts={emptyCounts}
            overlapPaths={emptyPaths}
            onJump={(path) => {
              setFold(path, false);
              select(path, "recorded", true);
            }}
          />
        )}
        <div
          ref={streamRef}
          data-diff-stream
          tabIndex={-1}
          onScroll={updateAnchor}
          className="min-h-0 min-w-0 overflow-y-auto p-3"
        >
          {unavailableFile && (
            <section
              data-file-card={reading.file}
              data-reading-part={reading.part}
              data-reading-selected
              data-reading-unavailable={reading.file}
              className="mb-3 rounded-lg border border-border-seam bg-card p-3 text-sm"
            >
              <div className="flex items-center gap-2">
                <h3 className="break-all font-mono">{reading.file}</h3>
                {reading.file !== undefined && <CopyPath path={reading.file} />}
              </div>
              <p className="text-muted-foreground">This file is not available from this source.</p>
            </section>
          )}
          {files.length === 0 &&
            !unavailableFile &&
            (overview.partial ? (
              <SkeletonRows count={3} label="Loading thread evidence" />
            ) : (
              <div className="space-y-2 text-sm text-muted-foreground">
                {nav !== null && entry?.incomplete === true ? (
                  <>
                    <p>
                      No recorded paths for {title}. bb's records for archived threads may be incomplete, so this is not
                      proof that nothing changed.
                    </p>
                    <button
                      type="button"
                      onClick={nav.refreshRecords}
                      className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      Refresh records
                    </button>
                  </>
                ) : (
                  <p>No readable evidence in this overview. That does not mean nothing changed.</p>
                )}
              </div>
            ))}
          {entry !== undefined &&
            !entry.stub &&
            [...draftWorktrees].map((worktreeKey) => {
              const worktreeRoot =
                entry.worktrees.find(({ worktree }) => worktree.key === worktreeKey)?.worktree.root || null;
              return (
                <div key={worktreeKey}>
                  {worktreeRoot !== null && <CopyPath path={worktreeRoot} />}
                  <DraftInspection store={comments} draftKey={worktreeKey} root={worktreeRoot} />
                  <DraftInspection
                    store={comments}
                    draftKey={reviewDraftKey(worktreeKey, entry.id)}
                    root={worktreeRoot}
                    recipient={entry.live.title}
                  />
                </div>
              );
            })}
          {files.map((file) => (
            <FileCard
              key={file.path}
              cardKey={file.path}
              readingPart="recorded"
              repo={null}
              file={file}
              scope="uncommitted"
              loaders={loaders}
              threads={threads}
              compact={compact === true}
              view={currentThreadId !== null && !focusMode ? "unified" : layout}
              wrap={wrap}
              focused={selected === file.path}
              folded={folded(file.path)}
              onFold={(path) => setFold(path, !folded(path))}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
