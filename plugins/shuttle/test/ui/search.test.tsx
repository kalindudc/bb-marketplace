import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import type { PrView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { callsTo, find, lastNavigation, mine, page, pr, unmountAll, type Handlers } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(unmountAll);

const yours = mine({ number: 1, title: "Retry 429s in the edge router" });
const theirs = pr({ number: 2, title: "Edge cache keys", author: "dana" });
const merged = mine({ number: 3, title: "Edge logging", state: "merged" });
const all = [yours, theirs, merged];

function searchPage(subPath: string, rpc: Partial<Handlers> = {}, prs: PrView[] = all, total = prs.length) {
  return page(subPath, {
    search: ({ query }) => (query === "" ? { prs: [], total: 0 } : { prs, total }),
    detail: ({ key }) => ({ pr: prs.find((item) => item.key === key)!, events: [], body: "", draft: null }),
    ...rpc,
  });
}

const keysIn = (root: ParentNode, title: string) => [...(root.querySelector(`[data-group="${title}"]`)?.querySelectorAll("[data-pr]") ?? [])].map((node) => node.getAttribute("data-pr"));

describe("the Search page", () => {
  it("groups the matches into your open PRs, other people's, and merged and closed", async () => {
    const { slot } = await searchPage(formatRoute({ view: "search", query: "edge", key: null }));
    await find(slot.container, "[data-group]");
    expect(callsTo(slot, "search")).toEqual([{ query: "edge" }]);
    expect(slot.getByRole("heading", { name: "Search: \u201cedge\u201d" })).toBeTruthy();
    expect(slot.container.querySelector("[data-search-count]")!.textContent).toBe("3 matches");
    expect(keysIn(slot.container, "Your open PRs")).toEqual([yours.key]);
    expect(keysIn(slot.container, "Other people's open PRs")).toEqual([theirs.key]);
    expect(keysIn(slot.container, "Merged and closed")).toEqual([merged.key]);
  });

  it("opens a match beside the results, keeping the words in the path", async () => {
    const { slot } = await searchPage(formatRoute({ view: "search", query: "edge", key: null }));
    fireEvent.click(await find(slot.container, `[data-pr="${theirs.key}"]`));
    await waitFor(() => expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "search", query: "edge", key: theirs.key }) } }));
  });

  it("asks for words before searching, and says when nothing matches", async () => {
    const empty = await searchPage("search");
    expect(empty.slot.getByText("Type in the search box to find a PR.")).toBeTruthy();
    expect(callsTo(empty.slot, "search")).toEqual([]);
    unmountAll();
    const none = await searchPage(formatRoute({ view: "search", query: "zebra", key: null }), {}, []);
    await waitFor(() => expect(none.slot.getByText("No PR Shuttle has matches \u201czebra\u201d.")).toBeTruthy());
  });

  it("says when it shows only the best matches", async () => {
    const { slot } = await searchPage(formatRoute({ view: "search", query: "e", key: null }), {}, all, 120);
    await waitFor(() => expect(slot.container.querySelector("[data-search-count]")!.textContent).toBe("The 3 best of 120 matches. Add a word to narrow it down."));
  });
});
