import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import type { PrView } from "../../src/contract";
import { callsTo, DAY, find, HOUR, lastNavigation, next, page, pr, unmountAll } from "./helpers";

afterEach(unmountAll);

const reviewed = (verdict: NonNullable<PrView["myReview"]>["verdict"], ago: number) => ({ myReview: { verdict, at: Date.now() - ago, head: "abc" } });
const merged = pr({ number: 1, title: "Retry 429s in the edge router", state: "merged", closedAt: Date.now() - DAY, updatedAt: Date.now() - DAY, ...reviewed("approve", 3 * DAY), next: next({ kind: "merged", label: "Merged" }) });
const open = pr({ number: 2, title: "Edge cache keys", ...reviewed("changes", HOUR), updatedAt: Date.now() - 10 * 60_000, next: next({ kind: "reviewed", label: "Waiting on the author" }) });
const closed = pr({ number: 3, title: "Old WAF rules", state: "closed", closedAt: Date.now() - 20 * DAY, updatedAt: Date.now() - 20 * DAY, ...reviewed("comment", 30 * DAY), next: next({ kind: "closed", label: "Closed" }) });
const everything = [merged, open, closed];

function reviewedPage(prs: PrView[] = everything, subPath = "reviewed") {
  return page(subPath, {
    list: ({ area }) => ({ prs: area === "reviewed" ? prs : [] }),
    detail: ({ key }) => ({ pr: prs.find((item) => item.key === key)!, events: [], body: "", draft: null, drafts: 0 }),
  });
}

const listed = (root: HTMLElement) => [...root.querySelectorAll("ul[aria-label='Pull requests'] [data-pr]")].map((node) => node.getAttribute("data-pr"));
const stateChip = (root: HTMLElement, name: RegExp) => within(within(root).getByRole("group", { name: "State" })).getByRole("button", { name });

describe("Reviewed by me", () => {
  it("lists every PR you reviewed, most recent review first, with your verdict and where the PR went", async () => {
    const { slot } = await reviewedPage();
    const row = await find(slot.container, `[data-pr="${merged.key}"]`);
    expect(callsTo(slot, "list")).toContainEqual({ area: "reviewed" });
    expect(listed(slot.container)).toEqual([open.key, merged.key, closed.key]);
    expect(row.querySelector("[data-verdict]")!.textContent).toBe("You approved");
    expect(row.querySelector("[data-pill='merged']")!.textContent).toBe("Merged");
    expect(row.textContent).toContain("reviewed 3d ago");
    const other = slot.container.querySelector<HTMLElement>(`[data-pr="${open.key}"]`)!;
    expect(other.querySelector("[data-verdict]")!.textContent).toBe("You requested changes");
    expect(other.querySelector("[data-pill='open']")).not.toBeNull();
    expect(slot.getByRole("heading", { name: "Reviewed by me" })).toBeTruthy();
    expect(slot.getByText(/merged and closed ones from the last 90 days/u)).toBeTruthy();
  });

  it("filters by state and verdict with counts, sorts, and remembers all three", async () => {
    const first = await reviewedPage();
    await find(first.slot.container, `[data-pr="${merged.key}"]`);
    expect(stateChip(first.slot.container, /^All/u).textContent).toBe("All3");
    expect(stateChip(first.slot.container, /^Merged/u).textContent).toBe("Merged1");
    fireEvent.change(first.slot.getByRole("combobox", { name: "Sort by" }), { target: { value: "reviewedOldest" } });
    expect(listed(first.slot.container)).toEqual([closed.key, merged.key, open.key]);
    fireEvent.change(first.slot.getByRole("combobox", { name: "Verdict" }), { target: { value: "approve" } });
    expect(listed(first.slot.container)).toEqual([merged.key]);
    // The counts follow the verdict, so a state chip never promises rows the list will not show.
    expect(stateChip(first.slot.container, /^Closed/u).textContent).toBe("Closed0");
    fireEvent.click(stateChip(first.slot.container, /^Closed/u));
    expect(first.slot.container.querySelector("ul[aria-label='Pull requests']")).toBeNull();
    expect(first.slot.getByText("Nothing matches the filters above.")).toBeTruthy();
    first.slot.lifecycle.unmount();

    const again = await reviewedPage();
    await find(again.slot.container, "[data-state-filter]");
    expect(stateChip(again.slot.container, /^Closed/u).getAttribute("aria-pressed")).toBe("true");
    expect((again.slot.getByRole("combobox", { name: "Verdict" }) as HTMLSelectElement).value).toBe("approve");
    expect((again.slot.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement).value).toBe("reviewedOldest");
    fireEvent.click(stateChip(again.slot.container, /^Open/u));
    fireEvent.change(again.slot.getByRole("combobox", { name: "Verdict" }), { target: { value: "all" } });
    expect(listed(again.slot.container)).toEqual([open.key]);
    fireEvent.change(again.slot.getByRole("combobox", { name: "Sort by" }), { target: { value: "closed" } });
    expect(again.slot.container.querySelector(`[data-pr="${open.key}"]`)!.textContent).not.toContain("reviewed");
  });

  it("says so when you have reviewed nothing yet", async () => {
    const { slot } = await reviewedPage([]);
    expect(await slot.findByText(/No reviews yet/u)).toBeTruthy();
  });

  it("switches between the PRs to review and the ones you reviewed", async () => {
    const { slot } = await reviewedPage();
    await find(slot.container, `[data-pr="${merged.key}"]`);
    expect(slot.getByRole("radio", { name: "Reviewed" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(slot.getByRole("radio", { name: "To review" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviews" } });
    slot.lifecycle.unmount();
    const reviews = await reviewedPage([], "reviews");
    await reviews.slot.findByRole("heading", { name: "Reviews" });
    fireEvent.click(reviews.slot.getByRole("radio", { name: "Reviewed" }));
    expect(lastNavigation(reviews.slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviewed" } });
  });

  it("opens a row beside the list and keeps the list's place in the route", async () => {
    const { slot } = await reviewedPage();
    const row = await find(slot.container, `[data-pr="${merged.key}"]`);
    fireEvent.click(row);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviewed/github/get-bb/bb/1" } });
  });
});
