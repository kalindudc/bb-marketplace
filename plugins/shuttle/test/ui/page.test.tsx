import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { formatRoute } from "../../src/ui/route";
import { callsTo, find, lastNavigation, next, page, pr, unmountAll, type Handlers } from "./helpers";

afterEach(unmountAll);

const first = pr({ next: next({ kind: "new_request", label: "New review request" }) });
const second = pr({ repo: "Shopify/spy-v2", number: 88, title: "Add per-route sampling to the tracer", author: "mia-r", reasons: [{ reason: "team", teams: ["edge-routing"] }], teams: ["edge-routing"], next: next({ kind: "not_reviewed", label: "Not reviewed" }) });

function reviews(subPath: string, rpc: Partial<Handlers> = {}) {
  return page(subPath, {
    list: ({ area }) => ({ prs: area === "reviews" ? [first, second] : [] }),
    detail: ({ key }) => ({ pr: [first, second].find((item) => item.key === key)!, events: [], body: "## What changes\n\nAdds **compact** headers.", draft: null }),
    ...rpc,
  });
}

const selected = (key: string) => formatRoute({ view: "reviews", source: "all", key });

describe("Shuttle page", () => {
  it("lists the area in its path and selects the PR clicked", async () => {
    const { slot } = await reviews("reviews");
    const row = await find(slot.container, `[data-pr="${second.key}"]`);
    expect(slot.getByRole("heading", { name: "Reviews" })).toBeTruthy();
    expect(slot.container.querySelector("[data-detail]")).toBeNull();
    fireEvent.click(row);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "shuttle", options: { subPath: selected(second.key) } }]);
  });

  it("opens the PR its path selects beside the list, and closes it back to the list", async () => {
    const { slot } = await reviews(selected(second.key));
    const panel = await find(slot.container, `[data-panel] [data-detail="${second.key}"]`);
    const open = slot.container.querySelector<HTMLElement>(`[data-pr="${second.key}"]`)!;
    expect(open.getAttribute("aria-current")).toBe("true");
    // The same tint as an Inbox card, with a bar and a ring, so it never reads as a hovered row.
    expect(open.className).toContain("var(--primary)_12%");
    expect(open.className).toContain("inset_4px_0_0_var(--primary)");
    expect(open.className).not.toContain("hover:bg-accent");
    expect(callsTo(slot, "detail")).toEqual([{ key: second.key }]);
    fireEvent.click(within(panel).getByRole("button", { name: "Close details" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviews", replace: true } });
  });

  it("keeps the area nav out of the page on a desktop: bb's sidebar holds it", async () => {
    const { slot } = await reviews("reviews");
    await find(slot.container, `[data-pr="${first.key}"]`);
    expect(slot.queryByRole("navigation")).toBeNull();
  });

  it("opens 0.2's links in the new areas", async () => {
    const asked = await reviews("requested");
    await find(asked.slot.container, `[data-pr="${first.key}"]`);
    expect(callsTo(asked.slot, "list")).toEqual([{ area: "reviews" }]);
    expect(within(asked.slot.container).getByRole("button", { name: /Asked me/u }).getAttribute("aria-pressed")).toBe("true");
    expect(asked.slot.container.querySelector(`[data-pr="${second.key}"]`)).toBeNull();
    unmountAll();

    const kept = await reviews(`team/${formatRoute({ view: "pr", key: second.key }).slice(3)}`);
    await find(kept.slot.container, `[data-detail="${second.key}"]`);
    expect(within(kept.slot.container).getByRole("button", { name: /My teams/u }).getAttribute("aria-pressed")).toBe("true");
    unmountAll();

    const log = await page("activity", { activity: () => ({ events: [{ id: 1, at: Date.now(), kind: "forwarded", text: "Sent 3 comments to its agent.", key: null, threadId: null }] }) });
    await log.slot.findByText("Sent 3 comments to its agent.");
    expect(log.slot.getByRole("radio", { name: "Automation log" }).getAttribute("aria-checked")).toBe("true");
    unmountAll();

    const inflight = await page("inflight", { list: () => ({ prs: [] }) });
    await waitFor(() => expect(callsTo(inflight.slot, "list")).toEqual([{ area: "mine" }]));
    unmountAll();

    const needs = await page("needs", {});
    await waitFor(() => expect(callsTo(needs.slot, "inbox")).toEqual([{}]));
  });

  it("shows a looked-up PR from its path, and closes it to the Inbox", async () => {
    const { slot } = await reviews(formatRoute({ view: "pr", key: second.key }));
    expect(await slot.findByRole("heading", { name: "Look up" })).toBeTruthy();
    const view = await find(slot.container, `[data-detail="${second.key}"]`);
    expect(callsTo(slot, "list")).toEqual([]);
    fireEvent.click(within(view).getByRole("button", { name: "Close details" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "inbox", replace: true } });
  });

  it("fetches a looked-up PR the server does not know yet when asked", async () => {
    let known = false;
    const { slot } = await page(formatRoute({ view: "pr", key: second.key }), {
      detail: ({ key }) => {
        if (!known) throw Object.assign(new Error(`no pull request ${key}`), { code: "not_found" });
        return { pr: second, events: [], body: "", draft: null };
      },
      lookup: () => {
        known = true;
        return { pr: second };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Fetch it from its server" }));
    await find(slot.container, `[data-detail="${second.key}"]`);
    expect(callsTo(slot, "lookup")).toEqual([{ query: second.key }]);
  });

  it("shows the server's refusal when a list fails to load", async () => {
    const { slot } = await page("mine", { list: () => { throw new Error("gh: not logged in"); } });
    expect((await slot.findByRole("alert")).textContent).toContain("gh: not logged in");
  });

  it("refetches when the server invalidates its PR reads, as after a background sync", async () => {
    const { slot } = await reviews("reviews");
    await find(slot.container, `[data-pr="${first.key}"]`);
    const before = callsTo(slot, "list").length;
    await slot.behavior.experimental_invalidateRpc(["prs"], "shuttle");
    await waitFor(() => expect(callsTo(slot, "list").length).toBeGreaterThan(before));
  });

  it("shows the PR's description in the PR view, without opening Details", async () => {
    const { slot } = await reviews(selected(first.key));
    const view = await find(slot.container, `[data-detail="${first.key}"]`);
    const description = within(view).getByRole("region", { name: "Description" });
    expect((await find(description, "[data-description]")).textContent).toContain("Adds **compact** headers");
    expect(within(view).getByRole("region", { name: "Details" }).querySelector("[data-description]")).toBeNull();
  });
});
