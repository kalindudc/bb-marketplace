import type { PluginSidebarSplitLayout } from "@get-bb/plugin-sdk/app";

export function splitLocations(layout: PluginSidebarSplitLayout | null): ReadonlyMap<string, string> | null {
  if (!layout || layout.panes.length < 2) return null;
  const locations = new Map<string, string>();
  for (const { threadId, rect } of layout.panes) {
    if (!threadId) continue;
    const horizontal = rect.width >= .999 ? "" : rect.x <= .001 ? "left" :
      rect.x + rect.width >= .999 ? "right" : "center";
    const vertical = rect.height >= .999 ? "" : rect.y <= .001 ? "top" :
      rect.y + rect.height >= .999 ? "bottom" : "middle";
    const position = [vertical, horizontal].filter(Boolean).join(" ");
    const label = position ? position[0]!.toUpperCase() + position.slice(1) + " pane" : "Split pane";
    const previous = locations.get(threadId);
    locations.set(threadId, previous ? `${previous} and ${label.toLowerCase()}` : label);
  }
  return locations;
}
