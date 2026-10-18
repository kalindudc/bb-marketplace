import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { experimental_Icon as Icon, type PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { HUE_IDS, type HueId, type SortMode } from "./layout";
import type { Group } from "./tree";
import { Hint } from "./hint";
import { portalScopeProps } from "./portal-scope";

export interface SectionMenuProps {
  group: Group;
  unreadCount: number;
  hueOverride: HueId | null;
  onRename(): void;
  onSetHue(hue: HueId | null): void;
  onNewThread(): void;
  onMarkAllRead(): void;
  onDelete(): void;
  sortMode?: SortMode;
  staleCount?: number;
  staleChildCount?: number;
  staleDays?: number;
  onSort?(mode: SortMode): void;
  onArchiveStale?(): void;
  projects?: readonly PluginSidebarProject[];
  defaultProjectId?: string | null;
  onSetDefaultProject?(projectId: string | null): void;
}

// Contains a space, so it never collides with a stored project ID.
const AUTOMATIC_PROJECT = "automatic project";

export function RenameInput({ initial, onSubmit, onCancel }: {
  initial: string; onSubmit(name: string): void; onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const finished = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) input.current?.focus(); });
    return () => { mounted = false; };
  }, []);
  const submit = () => {
    if (finished.current) return;
    finished.current = true;
    const name = value.trim();
    if (name) onSubmit(name);
    else onCancel();
  };
  return <input ref={input} aria-label="Section name" value={value} maxLength={100}
    className="sb-rename min-w-0 flex-1 rounded border border-primary bg-background px-1 text-[11px] text-sidebar-foreground outline-none"
    onChange={(event) => setValue(event.target.value)} onBlur={submit}
    onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); submit(); }
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); finished.current = true; onCancel();
      }
    }} />;
}

const item = "sb-menu-item rounded px-2 py-1.5 text-xs outline-none";
export function SectionMenu({ group, unreadCount, hueOverride, onRename, onSetHue,
  onNewThread, onMarkAllRead, onDelete, sortMode = "manual", staleCount = 0,
  staleChildCount = 0, staleDays = 3, onSort, onArchiveStale, projects = [], defaultProjectId = null,
  onSetDefaultProject }: SectionMenuProps) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const renamePending = useRef(false);
  const name = group.section?.name ?? "Section";
  const count = group.threadCount;
  return <>
    <DropdownMenu.Root>
      <Hint label="Section actions: rename, colour, sort and more"><DropdownMenu.Trigger asChild><button type="button" aria-label="Section actions"
        className="sb-control sb-section-menu-trigger sb-icon-button relative z-10 shrink-0 text-muted-foreground">⋯</button></DropdownMenu.Trigger></Hint>
      <DropdownMenu.Portal><DropdownMenu.Content {...portalScopeProps()} side="right" align="start" sideOffset={4}
        onCloseAutoFocus={(event) => {
          if (renamePending.current) { event.preventDefault(); renamePending.current = false; }
        }}
        className="sb-section-menu z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
        {group.kind === "section" && <>
          <DropdownMenu.Item className={item} onSelect={() => { renamePending.current = true; onRename(); }}>Rename</DropdownMenu.Item>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={`${item} flex items-center justify-between`}>Colour <span aria-hidden>›</span></DropdownMenu.SubTrigger>
            <DropdownMenu.Portal><DropdownMenu.SubContent {...portalScopeProps()} sideOffset={4}
              className="sb-colour-menu z-50 w-max rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg">
              <DropdownMenu.RadioGroup className="grid gap-1.5" value={hueOverride ?? "automatic"} onValueChange={(value) =>
                onSetHue(value === "automatic" ? null : value as HueId)}>
                <DropdownMenu.RadioItem value="automatic" aria-label="Automatic"
                  className={`${item} col-span-4 w-full text-left data-[state=checked]:bg-sidebar-accent`}>Automatic</DropdownMenu.RadioItem>
                <div className="grid grid-cols-4 gap-1.5">
                  {HUE_IDS.map((hue) => <DropdownMenu.RadioItem key={hue} value={hue} aria-label={hue[0]!.toUpperCase() + hue.slice(1)}
                    title={hue[0]!.toUpperCase() + hue.slice(1)}
                    className={`sb-hue-${hue} grid size-6 cursor-pointer place-items-center rounded-md border border-border outline-none focus:ring-1 focus:ring-primary data-[state=checked]:ring-2 data-[state=checked]:ring-primary`}>
                    <span aria-hidden className="size-4 rounded-sm" style={{ background: "var(--sb-hue)" }} />
                  </DropdownMenu.RadioItem>)}
                </div>
              </DropdownMenu.RadioGroup>
            </DropdownMenu.SubContent></DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Separator className="my-1 h-px bg-sidebar-border" />
        </>}
        {group.kind !== "pinned" && <>
          {onSort && <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={`${item} flex items-center justify-between`}>Sort <span aria-hidden>›</span></DropdownMenu.SubTrigger>
            <DropdownMenu.Portal><DropdownMenu.SubContent {...portalScopeProps()} sideOffset={4}
              className="sb-sort-menu z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
              <DropdownMenu.RadioGroup value={sortMode} onValueChange={(mode) => onSort(mode as SortMode)}>
                {([ ["manual", "By hand"], ["recent", "Recent activity"], ["status", "Status"] ] as const)
                  .map(([mode, label]) => <DropdownMenu.RadioItem key={mode} value={mode} className={`${item} relative pl-7`}>
                    <DropdownMenu.ItemIndicator data-sb-check="" className="absolute left-2 inline-grid size-3.5 place-items-center">
                      <Icon name="Check" className="size-3.5" aria-hidden /></DropdownMenu.ItemIndicator>{label}</DropdownMenu.RadioItem>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.SubContent></DropdownMenu.Portal>
          </DropdownMenu.Sub>}
          {onSetDefaultProject && projects.length > 0 && <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={`${item} flex items-center justify-between`}>Default project <span aria-hidden>›</span></DropdownMenu.SubTrigger>
            <DropdownMenu.Portal><DropdownMenu.SubContent {...portalScopeProps()} sideOffset={4}
              className="sb-project-menu z-50 max-h-80 min-w-40 max-w-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
              <DropdownMenu.RadioGroup value={defaultProjectId ?? AUTOMATIC_PROJECT}
                onValueChange={(value) => onSetDefaultProject(value === AUTOMATIC_PROJECT ? null : value)}>
                {[{ id: AUTOMATIC_PROJECT, name: "Automatic" }, ...projects].map(({ id, name: label }) =>
                  <DropdownMenu.RadioItem key={id} value={id} className={`${item} relative truncate pl-7`}>
                    <DropdownMenu.ItemIndicator data-sb-check="" className="absolute left-2 inline-grid size-3.5 place-items-center">
                      <Icon name="Check" className="size-3.5" aria-hidden /></DropdownMenu.ItemIndicator>{label}</DropdownMenu.RadioItem>)}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.SubContent></DropdownMenu.Portal>
          </DropdownMenu.Sub>}
          <DropdownMenu.Item className={item} onSelect={onNewThread}>New thread here</DropdownMenu.Item>
        </>}
        <DropdownMenu.Item className={item} disabled={unreadCount === 0} onSelect={onMarkAllRead}>Mark all read</DropdownMenu.Item>
        {group.kind !== "pinned" && onArchiveStale && <DropdownMenu.Item className={item}
          disabled={staleCount === 0} onSelect={() => setArchiveOpen(true)}>Archive stale threads…</DropdownMenu.Item>}
        {group.kind === "section" && <>
          <DropdownMenu.Separator className="my-1 h-px bg-sidebar-border" />
          <DropdownMenu.Item className={`${item} text-destructive`}
            onSelect={() => setDeleteOpen(true)}>Delete section…</DropdownMenu.Item>
        </>}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <AlertDialog.Root open={archiveOpen} onOpenChange={setArchiveOpen}>
      <AlertDialog.Portal><AlertDialog.Overlay {...portalScopeProps()} className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content {...portalScopeProps()} className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,400px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-xl">
          <AlertDialog.Title className="text-sm font-semibold">Archive {staleCount} {staleCount === 1 ? "thread" : "threads"} idle for more than {staleDays} {staleDays === 1 ? "day" : "days"}?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
            Their {staleChildCount} child {staleChildCount === 1 ? "thread is" : "threads are"} archived too.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel className="sb-control rounded border border-border px-3 py-1.5 text-xs">Cancel</AlertDialog.Cancel>
            <AlertDialog.Action className="sb-control rounded bg-destructive px-3 py-1.5 text-xs text-white" onClick={onArchiveStale}>
              Archive stale threads
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
    <AlertDialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
      <AlertDialog.Portal><AlertDialog.Overlay {...portalScopeProps()} className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content {...portalScopeProps()} className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,400px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-xl">
          <AlertDialog.Title className="text-sm font-semibold">Delete section “{name}”?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
            Its {count} {count === 1 ? "thread moves" : "threads move"} to Threads. Nothing is archived.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel className="sb-control rounded border border-border px-3 py-1.5 text-xs">Cancel</AlertDialog.Cancel>
            <AlertDialog.Action className="sb-control rounded bg-destructive px-3 py-1.5 text-xs text-white"
              onClick={onDelete}>Delete section</AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </>;
}
