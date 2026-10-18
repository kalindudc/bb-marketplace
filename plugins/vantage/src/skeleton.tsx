export const EDITS_HINT = "Looking for edits in other repositories…";

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block animate-pulse rounded bg-muted ${className}`} />;
}

export function SkeletonRows({ count, label }: { count: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2.5 px-3.5 py-3">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-2">
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className="h-3.5 min-w-0 flex-1" />
          <Skeleton className="h-3.5 w-14 shrink-0" />
        </div>
      ))}
    </div>
  );
}

// Stands where the edits made outside the worktrees will appear; those need the event scan, which is not done yet.
export function EditsSkeleton() {
  return (
    <div role="status" aria-label={EDITS_HINT} className="space-y-1.5 px-3.5 py-2">
      <div className="flex items-center gap-2">
        <Skeleton className="size-3.5 shrink-0" />
        <Skeleton className="h-3.5 w-40" />
      </div>
      <p className="text-xs text-muted-foreground">{EDITS_HINT}</p>
    </div>
  );
}
