import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { SwitchboardSettings, View } from "./settings";
import { Hint } from "./hint";
import { portalScopeProps } from "./portal-scope";

const item = "flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-xs outline-none focus:bg-sidebar-accent";
const choice = `${item} relative pl-7`;
const check = <DropdownMenu.ItemIndicator data-sb-check="" className="absolute left-2 inline-grid size-3.5 place-items-center">
  <Icon name="Check" className="size-3.5" aria-hidden /></DropdownMenu.ItemIndicator>;
const content = "sb-view-menu z-50 min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg";

export function ViewSwitch({ view, onChange }: { view: View; onChange(view: View): void }) {
  return <div className="sb-view-switch flex shrink-0 items-center gap-0.5" role="group" aria-label="Thread view">
    {([ ["sections", "ListView", "Sections view", "Sections: your sections, in the order you set"],
        ["status", "Rows2", "Status lanes view", "Status lanes: threads grouped by state, newest first"] ] as const)
      .map(([value, icon, label, hint]) => <Hint key={value} label={hint}><button type="button" aria-label={label}
        aria-pressed={view === value} className="sb-control sb-icon-button grid place-items-center text-muted-foreground aria-pressed:bg-surface-selected aria-pressed:text-sidebar-foreground"
        onClick={() => onChange(value)}><Icon name={icon} aria-hidden /></button></Hint>)}
  </div>;
}

export function ViewMenu({ settings, onChange }: {
  settings: SwitchboardSettings; onChange(values: Partial<SwitchboardSettings>): void;
}) {
  const radios = <>
    <DropdownMenu.Label className="px-2 pt-1 text-[11px] font-semibold uppercase text-subtle-foreground">View</DropdownMenu.Label>
    <DropdownMenu.RadioGroup value={settings.view} onValueChange={(value) => onChange({ view: value as View })}>
      {([ ["sections", "Sections"], ["status", "Status lanes"] ] as const).map(([value, label]) =>
        <DropdownMenu.RadioItem key={value} value={value} className={choice}>{check}{label}</DropdownMenu.RadioItem>)}
    </DropdownMenu.RadioGroup>
    <DropdownMenu.Separator className="my-1 h-px bg-sidebar-border" />
    <DropdownMenu.Label className="px-2 pt-1 text-[11px] font-semibold uppercase text-subtle-foreground">Density</DropdownMenu.Label>
    <DropdownMenu.RadioGroup value={settings.density} onValueChange={(value) => onChange({ density: value as SwitchboardSettings["density"] })}>
      {([ ["compact", "Compact"], ["default", "Comfortable"], ["two-line", "Two lines"] ] as const).map(([value, label]) =>
        <DropdownMenu.RadioItem key={value} value={value} className={choice}>{check}{label}</DropdownMenu.RadioItem>)}
    </DropdownMenu.RadioGroup>
    <DropdownMenu.Separator className="my-1 h-px bg-sidebar-border" />
    <DropdownMenu.Label className="px-2 pt-1 text-[11px] font-semibold uppercase text-subtle-foreground">Section colour</DropdownMenu.Label>
    <DropdownMenu.RadioGroup value={settings.sectionColour} onValueChange={(value) => onChange({ sectionColour: value as SwitchboardSettings["sectionColour"] })}>
      {([ ["rail", "Rail"], ["tint", "Tint"], ["swatch", "Swatch"] ] as const).map(([value, label]) =>
        <DropdownMenu.RadioItem key={value} value={value} className={choice}>{check}{label}</DropdownMenu.RadioItem>)}
    </DropdownMenu.RadioGroup>
  </>;
  const toggles: { key: keyof SwitchboardSettings; label: string }[] = [
    { key: "statusChips", label: "Status chips" }, { key: "needsYouShelf", label: "Needs-you shelf" },
    { key: "showArchived", label: "Archived threads" },
    { key: "treeGuides", label: "Tree lines" }, { key: "showBranch", label: "Branch names" },
    { key: "showPullRequests", label: "Pull request numbers" }, { key: "showAge", label: "Ages" },
  ];
  return <DropdownMenu.Root>
    <Hint label="View options: view, density, colours and row details">
      <DropdownMenu.Trigger asChild><button type="button" aria-label="View options"
        className="sb-control sb-icon-button shrink-0 text-muted-foreground">
        <Icon name="SlidersHorizontal" aria-hidden /></button></DropdownMenu.Trigger>
    </Hint>
    <DropdownMenu.Portal><DropdownMenu.Content {...portalScopeProps()} side="bottom" align="end" sideOffset={4} className={content}>
      {radios}
      <DropdownMenu.Separator className="my-1 h-px bg-sidebar-border" />
      {toggles.map(({ key, label }) => <DropdownMenu.CheckboxItem key={key} className={choice}
        checked={settings[key] === true} onCheckedChange={(checked) => onChange({ [key]: checked === true })}>
        {check}{label}
      </DropdownMenu.CheckboxItem>)}
      <DropdownMenu.Separator className="my-1 h-px bg-sidebar-border" />
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className={`${item} justify-between`}>Fade idle threads after <span aria-hidden>›</span></DropdownMenu.SubTrigger>
        <DropdownMenu.Portal><DropdownMenu.SubContent {...portalScopeProps()} sideOffset={4} className={content}>
          <DropdownMenu.RadioGroup value={String(settings.staleDays)} onValueChange={(value) => onChange({ staleDays: Number(value) })}>
            {([ [0, "Off"], [1, "1 day"], [3, "3 days"], [7, "7 days"], [14, "14 days"] ] as const)
              .map(([days, label]) => <DropdownMenu.RadioItem key={days} value={String(days)} className={choice}>{check}{label}</DropdownMenu.RadioItem>)}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.SubContent></DropdownMenu.Portal>
      </DropdownMenu.Sub>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
