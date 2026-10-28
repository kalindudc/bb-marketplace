import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_ATTRIBUTE, watchInstalledGrid } from "../src/anchor";
import { renderInstalledPage } from "./dom";

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeEach(() => {
  window.history.replaceState(null, "", "/plugins?view=installed");
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("watchInstalledGrid", () => {
  it("puts one scoped host right before the grid of plugin rows", () => {
    const { grid } = renderInstalledPage();
    const hosts: Array<HTMLElement | null> = [];
    const dispose = watchInstalledGrid(document, "update-shelf", (host) => hosts.push(host));
    const host = hosts.at(-1)!;
    expect(host.nextElementSibling).toBe(grid);
    expect(host.hasAttribute(HOST_ATTRIBUTE)).toBe(true);
    expect(host.getAttribute("data-bb-plugin")).toBe("update-shelf");
    expect(host.hasAttribute("data-bb-plugin-root")).toBe(true);
    expect(document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)).toHaveLength(1);
    dispose();
    expect(document.querySelector(`[${HOST_ATTRIBUTE}]`)).toBeNull();
  });

  it("waits for the page to render and lets go when it leaves", async () => {
    const hosts: Array<HTMLElement | null> = [];
    const dispose = watchInstalledGrid(document, "update-shelf", (host) => hosts.push(host));
    expect(hosts).toEqual([]);
    const page = renderInstalledPage();
    await settle();
    expect(hosts).toHaveLength(1);
    page.container.remove();
    await settle();
    expect(hosts.at(-1)).toBeNull();
    dispose();
  });

  it("moves its host back in front of a grid the page rendered again", async () => {
    const { container, grid } = renderInstalledPage();
    const hosts: Array<HTMLElement | null> = [];
    const dispose = watchInstalledGrid(document, "update-shelf", (host) => hosts.push(host));
    const replacement = grid.cloneNode(true) as HTMLElement;
    grid.remove();
    container.append(replacement);
    await settle();
    expect(hosts.at(-1)!.nextElementSibling).toBe(replacement);
    expect(document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)).toHaveLength(1);
    dispose();
  });

  it("stays away from pages outside Plugins", () => {
    window.history.replaceState(null, "", "/threads/thr_1");
    renderInstalledPage();
    const hosts: Array<HTMLElement | null> = [];
    const dispose = watchInstalledGrid(document, "update-shelf", (host) => hosts.push(host));
    expect(hosts).toEqual([]);
    expect(document.querySelector(`[${HOST_ATTRIBUTE}]`)).toBeNull();
    dispose();
  });
});
