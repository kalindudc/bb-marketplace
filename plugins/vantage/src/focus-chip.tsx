import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

export function FocusChip({ label, onClear }: { label: string; onClear(): void }) {
  return (
    <span data-repo-focus className="inline-flex min-w-0 max-w-56 shrink items-center gap-1 rounded-full border border-border-seam py-px pl-2 pr-0.5 text-xs text-foreground">
      <span title={label} className="min-w-0 truncate">Only {label}</span>
      <button type="button" aria-label="Show all repositories" title="Show all repositories" onClick={onClear}
        className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Icon name="X" className="size-3" aria-hidden />
      </button>
    </span>
  );
}
