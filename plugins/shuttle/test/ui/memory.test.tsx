import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import type { PrView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { callsTo, find, mine, next, page, unmountAll } from "./helpers";

afterEach(unmountAll);

const open = mine({ number: 21, title: "Retry WAF rule deletes", next: next({ kind: "waiting_review" }) });
const other = mine({ number: 22, title: "Page Edge Infrastructure when token checks fail", next: next({ kind: "waiting_review" }) });

function shuttle(subPath: string, prs: PrView[] = [open, other]) {
  return page(subPath, {
    list: ({ area }) => ({ prs: area === "mine" ? prs : [] }),
    detail: ({ key }) => ({ pr: prs.find((item) => item.key === key)!, events: [], body: "", draft: null }),
  });
}

/** jsdom has no layout: every element scrolls, but its content lets it go at most `max.value` pixels down. */
const max = { value: 10_000 };
const tops = new WeakMap<Element, number>();
const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
beforeEach(() => {
  max.value = 10_000;
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) { return tops.get(this) ?? 0; },
    set(this: Element, value: number) { tops.set(this, Math.max(0, Math.min(value, max.value))); },
  });
});
afterEach(() => {
  Object.defineProperty(Element.prototype, "scrollTop", original);
});

const scroller = (root: HTMLElement) => root.querySelector<HTMLElement>("[data-scroller]")!;
function scrollTo(node: HTMLElement, top: number) {
  node.scrollTop = top;
  fireEvent.scroll(node);
}

describe("where the page was left", () => {
  it("opens the Inbox at its root the first time, without moving the URL", async () => {
    const { slot } = await shuttle("");
    await waitFor(() => expect(callsTo(slot, "inbox")).toEqual([{}]));
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("opens at its root on the list and the PR it was left on, and moves the URL there", async () => {
    const left = formatRoute({ view: "mine", key: open.key });
    const first = await shuttle(left);
    await find(first.slot.container, `[data-detail="${open.key}"]`);
    first.slot.lifecycle.unmount();

    const { slot } = await shuttle("");
    await find(slot.container, `[data-detail="${open.key}"]`);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "shuttle", options: { subPath: left, replace: true } }]);
    expect(callsTo(slot, "inbox")).toEqual([]);
    expect(callsTo(slot, "list")).toEqual([{ area: "mine" }]);
  });

  it("follows the place, so the Inbox picked last is where it opens next", async () => {
    const first = await shuttle("mine");
    await find(first.slot.container, `[data-pr="${open.key}"]`);
    first.route("inbox");
    await waitFor(() => expect(callsTo(first.slot, "inbox")).toEqual([{}]));
    first.slot.lifecycle.unmount();

    const { slot } = await shuttle("");
    await waitFor(() => expect(callsTo(slot, "inbox")).toEqual([{}]));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "shuttle", options: { subPath: "inbox", replace: true } }]);
  });

  it("scrolls each list back to where it was left", async () => {
    const { slot, route } = await shuttle("mine");
    await find(slot.container, `[data-pr="${open.key}"]`);
    const list = scroller(slot.container);
    scrollTo(list, 420);
    route("inbox");
    await waitFor(() => expect(callsTo(slot, "inbox")).toEqual([{}]));
    expect(list.scrollTop).toBe(0);
    route("mine");
    expect(list.scrollTop).toBe(420);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem("bb-plugin-shuttle:scroll") ?? "{}")).toEqual({ mine: 420 }));
  });

  it("keeps the position while a list is still too short to reach it", async () => {
    const { slot, route } = await shuttle("mine");
    await find(slot.container, `[data-pr="${open.key}"]`);
    const list = scroller(slot.container);
    scrollTo(list, 900);
    route("inbox");
    max.value = 0;
    route("mine");
    expect(list.scrollTop).toBe(0);
    // The browser clamps a list that has not loaded; that scroll is not the user's.
    fireEvent.scroll(list);
    max.value = 2000;
    await waitFor(() => expect(list.scrollTop).toBe(900));
    route("inbox");
    route("mine");
    expect(list.scrollTop).toBe(900);
  });

  it("lets the user's own scroll win over a position still being put back", async () => {
    const { slot, route } = await shuttle("mine");
    await find(slot.container, `[data-pr="${open.key}"]`);
    const list = scroller(slot.container);
    scrollTo(list, 900);
    route("inbox");
    max.value = 100;
    route("mine");
    fireEvent.wheel(list);
    scrollTo(list, 40);
    max.value = 2000;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(list.scrollTop).toBe(40);
  });

  it("keeps the list where it was when a PR opens beside it", async () => {
    const { slot, route } = await shuttle("mine");
    await find(slot.container, `[data-pr="${open.key}"]`);
    const list = scroller(slot.container);
    scrollTo(list, 300);
    route(formatRoute({ view: "mine", key: open.key }));
    await find(slot.container, `[data-detail="${open.key}"]`);
    // Opening a PR moves the list into a new element beside the panel.
    const beside = scroller(slot.container);
    expect(beside).not.toBe(list);
    expect(beside.scrollTop).toBe(300);
  });
});

describe("which PR each thread's tab shows in full", () => {
  it("keeps the 50 threads opened last and forgets a thread sent back to its list", async () => {
    const { panelPrs, rememberPanelPr } = await import("../../src/ui/prefs");
    for (let i = 0; i < 55; i++) rememberPanelPr(`thr_${i}`, `github:a/b#${i}`);
    const kept = Object.keys(panelPrs.get());
    expect(kept).toHaveLength(50);
    expect(kept[0]).toBe("thr_5");
    rememberPanelPr("thr_5", "github:a/b#99");
    expect(Object.keys(panelPrs.get()).at(-1)).toBe("thr_5");
    rememberPanelPr("thr_5", null);
    expect(panelPrs.get()).not.toHaveProperty("thr_5");
    expect(JSON.parse(window.localStorage.getItem("bb-plugin-shuttle:panel-pr")!)).toEqual(panelPrs.get());
  });
});
