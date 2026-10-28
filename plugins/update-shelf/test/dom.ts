/** The Installed page's markup this plugin anchors to: a container, a banner, then the grid of rows. */
export function renderInstalledPage(ids: string[] = ["genui", "loom"]): { container: HTMLElement; grid: HTMLElement } {
  const container = document.createElement("div");
  container.className = "space-y-3";
  const banner = document.createElement("div");
  banner.textContent = "1 plugin isn't running";
  const grid = document.createElement("div");
  for (const id of ids) {
    const row = document.createElement("div");
    row.setAttribute("data-testid", `plugin-row-${id}`);
    grid.append(row);
  }
  container.append(banner, grid);
  document.body.append(container);
  return { container, grid };
}
