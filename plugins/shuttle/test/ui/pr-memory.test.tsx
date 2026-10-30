import { createElement, Fragment } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { formatRoute } from "../../src/ui/route";
import { prStates } from "../../src/ui/pr-state";
import { app, CAN_ALL, callsTo, draft, find, handlers, item, link, mine, mount, page, pr, setViewport, unmountAll } from "./helpers";

const own = mine({ number: 21, can: CAN_ALL, links: [link({ threadId: "thr_memory" })] });
const other = pr({ number: 22, can: CAN_ALL });
const body = "A long PR description. ".repeat(100);
const rpc = () => handlers({
  list: () => ({ prs: [own, other] }),
  threadPrs: () => ({ prs: [own], sent: [] }),
  detail: ({ key }) => ({ pr: key === own.key ? own : other, events: [], body, draft: null }),
  conversation: () => ({ items: [item({ author: "alice" })], details: null, error: null, fetchedAt: Date.now() }),
});

afterEach(unmountAll);

const openTab = (detail: HTMLElement, id: string) => fireEvent.click(detail.querySelector<HTMLElement>(`[data-tab="${id}"]`)!);
const selectedTab = (detail: HTMLElement) => detail.querySelector('[aria-selected="true"][data-tab]')!.getAttribute("data-tab");

async function fill(detail: HTMLElement) {
  fireEvent.click(within(detail).getByRole("button", { name: "Show the whole description" }));
  openTab(detail, "conversation");
  fireEvent.click(await within(detail).findByRole("button", { name: "Reply" }));
  fireEvent.change(within(detail).getByRole("textbox", { name: "Reply to alice" }), { target: { value: "Unfinished reply" } });
  const comment = within(detail).queryByRole("textbox", { name: "Comment on bb#21" });
  if (comment !== null) fireEvent.change(comment, { target: { value: "Unfinished comment" } });
}

/** The tab, the open reply and the unsent text come back; so does the description opened on Overview. */
function expectRestored(detail: HTMLElement, phone = false) {
  expect(selectedTab(detail)).toBe("conversation");
  expect((within(detail).getByRole("textbox", { name: "Reply to alice" }) as HTMLTextAreaElement).value).toBe("Unfinished reply");
  if (!phone) expect((within(detail).getByRole("textbox", { name: "Comment on bb#21" }) as HTMLTextAreaElement).value).toBe("Unfinished comment");
}

function expectDescriptionOpen(detail: HTMLElement) {
  openTab(detail, "overview");
  expect(within(detail).getByRole("button", { name: "Show less" })).toBeTruthy();
  openTab(detail, "conversation");
}

const scrollParent = (detail: HTMLElement): HTMLElement => {
  let node = detail.parentElement!;
  while (!node.classList.contains("overflow-y-auto")) node = node.parentElement!;
  return node;
};

const scroll = (node: HTMLElement, top: number) => {
  fireEvent.wheel(node);
  node.scrollTop = top;
  fireEvent.scroll(node);
};

describe("PR view session memory", () => {
  it.each([
    { name: "split panel", width: 1440, standalone: false },
    { name: "narrow overlay", width: 1000, standalone: false },
    { name: "phone", width: 390, standalone: false },
    { name: "standalone lookup", width: 1440, standalone: true },
  ])("restores the $name after the page is recreated", async ({ width, standalone }) => {
    act(() => setViewport(width));
    const subPath = formatRoute(standalone ? { view: "pr", key: own.key } : { view: "mine", key: own.key });
    const first = await page(subPath, rpc());
    const detail = await find(first.slot.container, "[data-detail]");
    await fill(detail);
    scroll(scrollParent(detail), 620);
    first.slot.lifecycle.unmount();
    // Reload from sessionStorage as a fresh plugin bundle would, not just the in-memory cache.
    prStates.reload();

    const again = await page(subPath, rpc());
    const restored = await find(again.slot.container, "[data-detail]");
    await waitFor(() => expectRestored(restored, width === 390));
    await waitFor(() => expect(scrollParent(restored).scrollTop).toBe(620));
    expectDescriptionOpen(restored);
  });

  it("holds the restored position while late rendering shifts the scroll, until the user takes over", async () => {
    const subPath = formatRoute({ view: "mine", key: own.key });
    const first = await page(subPath, rpc());
    scroll(scrollParent(await find(first.slot.container, "[data-detail]")), 620);
    first.slot.lifecycle.unmount();
    const again = await page(subPath, rpc());
    const pane = scrollParent(await find(again.slot.container, "[data-detail]"));
    await waitFor(() => expect(pane.scrollTop).toBe(620));
    pane.scrollTop = 663;
    fireEvent.scroll(pane);
    await waitFor(() => expect(pane.scrollTop).toBe(620));
    scroll(pane, 900);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(pane.scrollTop).toBe(900);
    expect(pane.style.overflowAnchor).toBe("");
  });

  it("restores the thread tab after its view is remounted", async () => {
    const loaded = await app();
    const component = loaded.tabs[0]!.component as never;
    const props = { threadId: "thr_memory", params: { threadId: "thr_memory" } };
    const slot = mount(component, props, rpc(), { sdk: { threads: { get: async () => ({ environmentId: null }) as never } } });
    fireEvent.click(await slot.findByRole("button", { name: "View PR" }));
    const detail = await find(slot.container, "[data-detail]");
    await fill(detail);
    scroll(scrollParent(detail), 620);
    slot.lifecycle.rerender(createElement(Fragment));
    slot.lifecycle.rerender(createElement(component, props));
    const restored = await find(slot.container, "[data-detail]");
    await waitFor(() => expectRestored(restored));
    await waitFor(() => expect(scrollParent(restored).scrollTop).toBe(620));
  });

  it("keeps each PR's state separate when switching in the same panel", async () => {
    const path = (key: string) => formatRoute({ view: "mine", key });
    const { slot, route } = await page(path(own.key), rpc());
    await fill(await find(slot.container, "[data-detail]"));
    route(path(other.key));
    const second = await find(slot.container, `[data-detail="${other.key}"]`);
    expect(selectedTab(second)).toBe("overview");
    expect(within(second).getByRole("button", { name: "Show the whole description" })).toBeTruthy();
    expect(within(second).queryByRole("textbox", { name: "Reply to alice" })).toBeNull();
    route(path(own.key));
    await waitFor(() => expectRestored(slot.container.querySelector<HTMLElement>(`[data-detail="${own.key}"]`)!));
  });

  it("restores edits to an AI review only for the same draft", async () => {
    let current = draft();
    const custom = { ...rpc(), detail: () => ({ pr: other, events: [], body, draft: current }) };
    const subPath = formatRoute({ view: "reviews", source: "all", key: other.key });
    const first = await page(subPath, custom);
    openTab(await find(first.slot.container, "[data-detail]"), "review");
    const summary = await first.slot.findByRole("textbox", { name: "Summary" });
    fireEvent.change(summary, { target: { value: "My edited summary" } });
    const finding = first.slot.getByRole("textbox", { name: "Text of the finding at header/actions.tsx:88" });
    fireEvent.change(finding, { target: { value: "My edited finding" } });
    first.slot.lifecycle.unmount();
    const again = await page(subPath, custom);
    expect((await again.slot.findByRole("textbox", { name: "Summary" }) as HTMLTextAreaElement).value).toBe("My edited summary");
    expect((again.slot.getByRole("textbox", { name: "Text of the finding at header/actions.tsx:88" }) as HTMLTextAreaElement).value).toBe("My edited finding");
    current = draft({ id: 8, summary: "A new review" });
    await again.slot.behavior.experimental_invalidateRpc(["prs"], "shuttle");
    await waitFor(() => expect((again.slot.getByRole("textbox", { name: "Summary" }) as HTMLTextAreaElement).value).toBe("A new review"));
  });

  it("clears a cancelled reply and restores drafts when posting fails", async () => {
    const subPath = formatRoute({ view: "mine", key: own.key });
    const custom = { ...rpc(), reply: () => { throw new Error("Server unavailable"); }, comment: () => { throw new Error("Server unavailable"); } };
    const first = await page(subPath, custom);
    const detail = await find(first.slot.container, "[data-detail]");
    await fill(detail);
    fireEvent.click(within(detail).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Reply" }));
    const reply = within(detail).getByRole("textbox", { name: "Reply to alice" }) as HTMLTextAreaElement;
    expect(reply.value).toBe("");
    fireEvent.change(reply, { target: { value: "Unfinished reply" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Reply" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(callsTo(first.slot, "reply")).toHaveLength(1));
    await waitFor(() => expect(callsTo(first.slot, "comment")).toHaveLength(1));
    first.slot.lifecycle.unmount();
    const again = await page(subPath, custom);
    const restored = await find(again.slot.container, "[data-detail]");
    await waitFor(() => expectRestored(restored));
  });

  it("does not resurrect a reply or comment after it has been sent", async () => {
    const custom = { ...rpc(), reply: () => ({ ok: true as const }), comment: () => ({ pr: own }) };
    const subPath = formatRoute({ view: "mine", key: own.key });
    const first = await page(subPath, custom);
    const detail = await find(first.slot.container, "[data-detail]");
    await fill(detail);
    fireEvent.click(within(detail).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(callsTo(first.slot, "reply")).toHaveLength(1));
    fireEvent.click(within(detail).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(callsTo(first.slot, "comment")).toHaveLength(1));
    first.slot.lifecycle.unmount();
    const again = await page(subPath, custom);
    const restored = await find(again.slot.container, "[data-detail]");
    await within(restored).findByRole("button", { name: "Reply" });
    expect(within(restored).queryByRole("textbox", { name: "Reply to alice" })).toBeNull();
    expect((within(restored).getByRole("textbox", { name: "Comment on bb#21" }) as HTMLTextAreaElement).value).toBe("");
  });
});
