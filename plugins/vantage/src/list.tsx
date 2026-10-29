import { memo, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { isWorking } from "./live";
import { plural, reviewStarted, type Chip, type Group, type Outside, type Row } from "./model";
import { useRemembered } from "./remember";
import { PullRequestChip, StatusGlyph } from "./review";
import { EditsSkeleton, Skeleton } from "./skeleton";
import { groupFolds } from "./ui-prefs";

export interface WorktreeListProps {
  groups: readonly Group[];
  outside: readonly Outside[];
  counts: Record<Chip, number>;
  chip: Chip | null;
  onChip(chip: Chip | null): void;
  selectedKey: string | null;
  selectedOutside?: string | null;
  titleOf(worktreeKey: string): string;
  onOpen(key: string): void;
  onOpenOutside(entry: Outside): void;
  hidden: number;
  archivedHidden: number;
  onIncludeArchived(): void;
  partial: boolean;
  // A child's row on the page says which tree it belongs to; the thread tab already is that tree.
  underOf?(row: Row): string | null;
}

const CHIPS: ReadonlyArray<{ id: Chip; label: string; tone: string }> = [
  { id: "needs", label: "Waiting on you", tone: "text-foreground" },
  { id: "review", label: "Ready to review", tone: "text-foreground" },
  { id: "working", label: "Still working", tone: "text-foreground" },
  { id: "overlaps", label: "Shared files", tone: "text-warning-text" },
];

export function FilterChips({ counts, chip, onChip }: Pick<WorktreeListProps, "counts" | "chip" | "onChip">) {
  const shown = CHIPS.filter((entry) => counts[entry.id] > 0 || chip === entry.id);
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label="Show only" className="flex flex-wrap gap-1.5">
      {shown.map((entry) => (
        <button key={entry.id} type="button" aria-pressed={chip === entry.id} onClick={() => onChip(chip === entry.id ? null : entry.id)}
          className={`inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-2 text-xs ${chip === entry.id ? "border-ring bg-surface-selected text-foreground" : "border-border-seam text-muted-foreground hover:text-foreground"}`}>
          <span className={`font-semibold ${entry.tone}`}>{counts[entry.id]}</span>{entry.label}
        </button>
      ))}
    </div>
  );
}

// One plain sentence per row: what this worktree needs, not how git describes it.
function why(row: Row, titleOf: (key: string) => string): { tone: string; text: string } {
  if (row.worktree.state === "unavailable") return { tone: "text-destructive-text", text: row.worktree.message ?? "This worktree can't be read" };
  if (row.bucket === "needs") {
    return row.live.indicator === "unread-error"
      ? { tone: "text-destructive-text", text: row.live.sidebar?.indicatorLabel ?? "The last turn failed" }
      : { tone: "text-foreground", text: "The agent asked you a question" };
  }
  if (row.bucket === "archived") return { tone: "text-muted-foreground", text: "Archived" };
  const overlap = row.overlaps[0];
  if (overlap !== undefined) {
    const more = row.overlaps.length > 1 ? ` and ${plural(row.overlaps.length - 1, "more file")}` : "";
    return { tone: "text-warning-text", text: `Shares ${overlap.path.slice(overlap.path.lastIndexOf("/") + 1)} with ${titleOf(overlap.otherKeys[0]!)}${more}` };
  }
  if (isWorking(row.live)) return { tone: "text-muted-foreground", text: "The agent is still working" };
  if (reviewStarted(row) && row.progress !== null) {
    return row.progress.reviewed === row.progress.total
      ? { tone: "text-success", text: "All files checked" }
      : { tone: "text-muted-foreground", text: `${row.progress.reviewed} of ${row.progress.total} files checked` };
  }
  if (row.bucket === "reviewed") return { tone: "text-success", text: "All files checked" };
  return { tone: "text-muted-foreground", text: `${plural(row.worktree.uncommitted.length + row.worktree.committed.length, "file")} to read` };
}

function RowView({ row, selected, under, titleOf, onOpen }: { row: Row; selected: boolean; under: string | null; titleOf(key: string): string; onOpen(key: string): void }) {
  const loading = row.worktree.state === "loading";
  const reason = why(row, titleOf);
  const context = [row.worktree.label, loading ? "" : reason.text, under === null ? "" : `under ${under}`].filter((part) => part !== "").join(" · ");
  return (
    <button type="button" data-worktree-row={row.worktree.key} aria-current={selected ? "true" : undefined} onClick={() => onOpen(row.worktree.key)}
      className={`grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${selected ? "bg-surface-selected" : ""}`}>
      <span className="row-span-2 flex size-4 items-center justify-center self-start pt-0.5"><StatusGlyph row={row} /></span>
      <span title={row.live.title} className="min-w-0 truncate text-[13px] font-medium text-foreground">{row.title}</span>
      <span className="whitespace-nowrap text-right font-mono text-[11px]">
        {loading ? <Skeleton className="h-3 w-12 align-middle" /> : <><span className="text-diff-added">+{row.additions}</span> <span className="text-diff-removed">−{row.deletions}</span></>}
      </span>
      <span className={`col-span-2 col-start-2 flex min-w-0 items-center gap-1.5 text-[11.5px] ${reason.tone}`}>
        <span className="min-w-0 truncate">{context}</span>
        {!loading && <PullRequestChip environmentId={row.worktree.ref.kind === "workspace" ? row.worktree.ref.environmentId : null} />}
      </span>
    </button>
  );
}

const WorktreeRow = memo(RowView);

function Heading({ children, count, action }: { children: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-subtle-foreground">
      {children}{count !== undefined && <span className="font-normal">{count}</span>}
      {action !== undefined && <span className="ml-auto normal-case tracking-normal">{action}</span>}
    </h3>
  );
}

export function WorktreeList(props: WorktreeListProps) {
  const { groups, outside, selectedKey, selectedOutside = null, titleOf, onOpen, onOpenOutside, hidden, archivedHidden, onIncludeArchived, partial, underOf } = props;
  const hasArchived = groups.some((group) => group.id === "archived");
  const folds = useRemembered(groupFolds);
  const foldedByDefault = (id: string) => id === "archived";
  const isFolded = (id: string) => folds.get(id) ?? foldedByDefault(id);
  const toggle = (id: string) => {
    const folded = !isFolded(id);
    groupFolds.set(id, folded === foldedByDefault(id) ? undefined : folded);
  };
  return (
    <div data-worktree-list className="pb-3">
      {groups.length === 0 && outside.length === 0 && !partial && (
        <p className="px-2 pt-3 text-sm text-muted-foreground">No worktree has changes{props.chip === null ? " yet" : " in this filter"}.</p>
      )}
      {groups.map((group) => {
        const open = !isFolded(group.id);
        // A folded group still shows the worktree that is open, so the selection is never hidden.
        const rows = open ? group.rows : group.rows.filter((row) => row.worktree.key === selectedKey);
        return (
          <section key={group.id} data-worktree-group={group.label}>
            <Heading count={group.rows.length}>
              <button type="button" aria-expanded={open} onClick={() => toggle(group.id)} className="inline-flex cursor-pointer items-center gap-1 uppercase hover:text-foreground">
                <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3" aria-hidden />{group.label}
              </button>
            </Heading>
            {rows.map((row) => (
              <WorktreeRow key={row.worktree.key} row={row} selected={row.worktree.key === selectedKey} under={underOf?.(row) ?? null} titleOf={titleOf} onOpen={onOpen} />
            ))}
          </section>
        );
      })}
      {!hasArchived && archivedHidden > 0 && (
        <Heading action={<button type="button" onClick={onIncludeArchived} className="cursor-pointer text-[11px] font-normal text-muted-foreground underline hover:text-foreground">Show</button>}>
          <Icon name="ChevronRight" className="size-3" aria-hidden />Archived<span className="font-normal">{archivedHidden} hidden</span>
        </Heading>
      )}
      {(outside.length > 0 || partial) && (
        <section data-worktree-group="Changed outside worktrees">
          <Heading>Changed outside worktrees</Heading>
          {partial && outside.length === 0 && <EditsSkeleton />}
          {outside.map((entry) => (
            <button key={entry.key} type="button" data-outside-row={entry.key} aria-current={selectedOutside === entry.key ? "true" : undefined} onClick={() => onOpenOutside(entry)}
              className={`grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-state-hover ${selectedOutside === entry.key ? "bg-surface-selected" : ""}`}>
              <Icon name={entry.kind === "repo" ? "Folder" : "EditFile"} className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate"><span className="text-[13px] text-foreground">{entry.title}</span> <span className="text-muted-foreground">· {entry.detail}</span></span>
              <span className="whitespace-nowrap font-mono text-[11px]"><span className="text-diff-added">+{entry.additions}</span> <span className="text-diff-removed">−{entry.deletions}</span></span>
            </button>
          ))}
        </section>
      )}
      {hidden > 0 && (
        <p className="px-2 pt-3 text-[11.5px] text-subtle-foreground">{plural(hidden, "worktree")} with no changes {hidden === 1 ? "is" : "are"} hidden.</p>
      )}
    </div>
  );
}
