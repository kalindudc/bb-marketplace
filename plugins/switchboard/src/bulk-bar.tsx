import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { GroupKey } from "./layout";
import type { Group } from "./tree";
import { portalScopeProps } from "./portal-scope";

export interface BulkBarProps {
  count: number;
  childCount: number;
  groups: readonly Group[];
  onMove(key: GroupKey): void;
  onArchive(): void;
  onClear(): void;
  onSnooze?(): void;
  canSnooze?: boolean;
}

export function BulkBar({ count, childCount, groups, onMove, onArchive, onClear, onSnooze, canSnooze }: BulkBarProps) {
  const targets: { key: GroupKey; name: string; hue: Group["hue"] }[] = [
    { key: "pinned", name: "Pinned", hue: null },
    ...groups.filter((group) => group.kind === "section").map((group) =>
      ({ key: group.key, name: group.section!.name, hue: group.hue })),
    { key: "loose", name: "Threads", hue: null },
  ];
  return <div className="sb-bulk-bar mt-2 flex min-w-0 items-center gap-1 border border-sidebar-border bg-sidebar-accent px-2 text-xs text-sidebar-foreground"
    aria-label="Selected threads">
    <span className="mr-auto whitespace-nowrap font-medium">{count} selected</span>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="sb-control rounded px-1.5 py-1">Move to</DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content {...portalScopeProps()} align="end"
        className="z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
        {targets.map(({ key, name, hue }) => <DropdownMenu.Item key={key} onSelect={() => onMove(key)}
          className="sb-menu-item flex items-center gap-2 rounded px-2 py-1.5 text-xs outline-none">
          {hue ? <span aria-hidden className={`sb-hue-${hue} size-2.5 rounded-sm`} style={{ background: "var(--sb-hue)" }} /> :
            <span aria-hidden className="size-2.5" />}{name}
        </DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {onSnooze && <button type="button" disabled={!canSnooze} className="sb-control rounded px-1.5 py-1"
      onClick={onSnooze}>Snooze</button>}
    <AlertDialog.Root>
      <AlertDialog.Trigger className="sb-control rounded px-1.5 py-1 text-destructive">Archive</AlertDialog.Trigger>
      <AlertDialog.Portal><AlertDialog.Overlay {...portalScopeProps()} className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content {...portalScopeProps()} className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,400px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-xl">
          <AlertDialog.Title className="text-sm font-semibold">Archive {count} {count === 1 ? "thread" : "threads"}?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
            {childCount ? `Their ${childCount} child ${childCount === 1 ? "thread is" : "threads are"} archived too.` :
              "You can undo this action."}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel className="sb-control rounded border border-border px-3 py-1.5 text-xs">Cancel</AlertDialog.Cancel>
            <AlertDialog.Action className="sb-control rounded bg-destructive px-3 py-1.5 text-xs text-white" onClick={onArchive}>
              Archive threads
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
    <button type="button" aria-label="Clear selection" title="Clear selection"
      className="sb-control rounded px-1.5 py-1 text-muted-foreground" onClick={onClear}>×</button>
  </div>;
}
