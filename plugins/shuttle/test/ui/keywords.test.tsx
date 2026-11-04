import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { PrView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { callsTo, DAY, find, HOUR, inbox, mine, next, page, pr, unmountAll, type Handlers } from "./helpers";

afterEach(unmountAll);

// "envoy" is in #1's title, #2's repository, #3's author and only #4's description.
const inTitle = mine({ number: 1, title: "Upgrade Envoy to 1.31", updatedAt: Date.now() - 5 * DAY });
const inRepo = mine({ number: 2, repo: "acme/envoy-config", title: "Bump the routes", updatedAt: Date.now() - HOUR });
const byAuthor = mine({ number: 3, title: "Docs for the router", headRef: "envoy/docs", updatedAt: Date.now() - 2 * HOUR });
const inBody = mine({ number: 4, title: "Tidy the logs", updatedAt: Date.now() - 10 * 60_000 });
const other = mine({ number: 5, title: "Retry WAF rule deletes", updatedAt: Date.now() - 3 * HOUR });
const all = [inBody, inRepo, byAuthor, other, inTitle];

// The server's side: the PRs whose descriptions hold a word nothing else on them does.
const DESCRIPTIONS: Record<string, string> = { [inBody.key]: "moves the envoy filters into one place" };
const answer = (query: string) => {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return Object.entries(DESCRIPTIONS).flatMap(([key, body]) => {
    const item = all.find((candidate) => candidate.key === key)!;
    const rest = `${item.title} ${item.repo} ${item.author} ${item.headRef}`.toLowerCase();
    return words.every((word) => rest.includes(word) || body.includes(word)) && words.some((word) => !rest.includes(word)) ? [key] : [];
  });
};
const described: Handlers["descriptionMatches"] = ({ query }) => ({ keys: answer(query) });

function listPage(subPath: string, area: string, prs: PrView[] = all, rpc: Partial<Handlers> = {}) {
  return page(subPath, {
    list: (input) => ({ prs: input.area === area ? prs : [] }),
    descriptionMatches: described,
    ...rpc,
  });
}

const keys = (root: ParentNode) => [...root.querySelectorAll("[data-pr]")].map((node) => node.getAttribute("data-pr"));
type Slot = Awaited<ReturnType<typeof listPage>>["slot"];
const field = (slot: Slot, name: string) => slot.getByRole("searchbox", { name }) as HTMLInputElement;
const type = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });

describe("keyword filters", () => {
  it("ranks My PRs by where the words are: title, repository, the rest, then descriptions once the server names them", async () => {
    const { slot } = await listPage("mine", "mine");
    await find(slot.container, `[data-pr="${inTitle.key}"]`);
    fireEvent.click(slot.getByRole("radio", { name: "List" }));
    const input = field(slot, "Filter your PRs");
    type(input, "envoy");
    // At once, from what every row carries: the description match comes when the server answers.
    expect(keys(slot.container)).toEqual([inTitle.key, inRepo.key, byAuthor.key]);
    await waitFor(() => expect(keys(slot.container)).toEqual([inTitle.key, inRepo.key, byAuthor.key, inBody.key]));
    expect(callsTo(slot, "descriptionMatches")).toContainEqual({ query: "envoy" });
    expect(slot.container.querySelector("[data-keyword-count]")!.textContent).toBe("4 of 5");
    type(input, "#5");
    expect(keys(slot.container)).toEqual([other.key]);
    type(input, "zebra");
    await waitFor(() => expect(slot.container.querySelector("[data-no-matches]")!.textContent).toContain("Nothing here matches \u201czebra\u201d."));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(keys(slot.container)).toHaveLength(all.length);
  });

  it("never shows a description match for words its description is not known to hold, while the server answers", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { slot } = await listPage("mine", "mine", all, {
      descriptionMatches: async ({ query }) => {
        if (query !== "envoy") await gate;
        return { keys: answer(query) };
      },
    });
    await find(slot.container, `[data-pr="${inTitle.key}"]`);
    fireEvent.click(slot.getByRole("radio", { name: "List" }));
    const input = field(slot, "Filter your PRs");
    type(input, "envoy");
    await waitFor(() => expect(keys(slot.container)).toContain(inBody.key));
    // "zebra" is in no description the last answer knows of, so #4 goes at once.
    type(input, "envoy zebra");
    expect(keys(slot.container)).toEqual([]);
    // Every word of "envo" is inside "envoy", which #4's description holds, so it stays while the server is asked.
    type(input, "envo");
    expect(keys(slot.container)).toEqual([inTitle.key, inRepo.key, byAuthor.key, inBody.key]);
    release();
    await waitFor(() => expect(callsTo(slot, "descriptionMatches")).toContainEqual({ query: "envo" }));
    expect(keys(slot.container)).toEqual([inTitle.key, inRepo.key, byAuthor.key, inBody.key]);
  });

  it("says when descriptions could not be searched, and still matches the rest", async () => {
    const { slot } = await listPage("mine", "mine", all, { descriptionMatches: () => { throw new Error("down"); } });
    await find(slot.container, `[data-pr="${inTitle.key}"]`);
    type(field(slot, "Filter your PRs"), "envoy");
    await find(slot.container, "[data-keyword-unavailable]");
    expect(keys(slot.container)).not.toContain(inBody.key);
    expect(keys(slot.container)).toContain(inTitle.key);
  });

  it("keeps My PRs' groups and puts the best match first in each", async () => {
    const tidyWaiting = { ...inBody, title: "Envoy: tidy the logs", next: next({ kind: "waiting_review" }) };
    const repoWaiting = { ...inRepo, next: next({ kind: "waiting_review" }) };
    const { slot } = await listPage("mine", "mine", [repoWaiting, tidyWaiting, other]);
    await find(slot.container, "[data-group]");
    type(field(slot, "Filter your PRs"), "envoy");
    expect(keys(slot.container.querySelector("[data-group='Waiting for review']")!)).toEqual([tidyWaiting.key, repoWaiting.key]);
  });

  it("remembers each list's words for the session", async () => {
    const merged = mine({ number: 6, title: "Retry the edge", state: "merged", closedAt: Date.now() - DAY });
    const first = await page("mine", { list: ({ area }) => ({ prs: area === "mine" ? all : area === "done" ? [merged] : [] }), descriptionMatches: described });
    await find(first.slot.container, `[data-pr="${inTitle.key}"]`);
    type(field(first.slot, "Filter your PRs"), "retry");
    first.route("done");
    await waitFor(() => expect(field(first.slot, "Filter your merged and closed PRs").value).toBe(""));
    first.route("mine");
    await waitFor(() => expect(field(first.slot, "Filter your PRs").value).toBe("retry"));
  });

  it("puts the cursor in the filter on /, unless you are typing elsewhere", async () => {
    const { slot } = await listPage("mine", "mine");
    await find(slot.container, `[data-pr="${inTitle.key}"]`);
    const input = field(slot, "Filter your PRs");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(input);
    const header = document.createElement("input");
    document.body.append(header);
    header.focus();
    fireEvent.keyDown(header, { key: "/" });
    expect(document.activeElement).toBe(header);
  });

  it("filters Reviews inside its groups and says how many matches the bot and quiet filters hide", async () => {
    const asked = pr({ number: 11, title: "Envoy filters", next: next({ kind: "not_reviewed", label: "Not reviewed" }) });
    const bot = pr({ number: 12, title: "Bump envoy", author: "dependabot", bot: true, next: next({ kind: "not_reviewed", label: "Not reviewed" }) });
    const unrelated = pr({ number: 13, title: "Native app routes", next: next({ kind: "not_reviewed", label: "Not reviewed" }) });
    const { slot } = await listPage("reviews", "reviews", [asked, bot, unrelated], { descriptionMatches: () => ({ keys: [] }) });
    await find(slot.container, `[data-pr="${asked.key}"]`);
    const input = field(slot, "Filter the PRs to review");
    type(input, "envoy");
    expect(keys(slot.container)).toEqual([asked.key]);
    expect(slot.container.querySelector("[data-hidden-matches]")!.textContent).toBe("1 more PR matches, hidden by the filters above.");
    type(input, "dependabot");
    await waitFor(() => expect(slot.container.querySelector("[data-no-matches]")!.textContent).toContain("but 1 PR the filters above hide does"));
  });

  it("filters Reviewed by me after its state and verdict filters", async () => {
    const review = (verdict: "approve" | "changes", at: number) => ({ myReview: { verdict, at: Date.now() - at, head: "abc" } });
    const a = pr({ number: 21, title: "Edge cache keys", ...review("changes", HOUR), next: next({ kind: "reviewed" }) });
    const b = pr({ number: 22, title: "Retry 429s in the edge router", state: "merged", closedAt: Date.now() - DAY, ...review("approve", DAY), next: next({ kind: "merged" }) });
    const { slot } = await listPage("reviewed", "reviewed", [a, b], { descriptionMatches: () => ({ keys: [] }) });
    await find(slot.container, `[data-pr="${a.key}"]`);
    type(field(slot, "Filter the PRs you reviewed"), "router");
    expect(keys(slot.container)).toEqual([b.key]);
    fireEvent.click(within(slot.getByRole("group", { name: "State" })).getByRole("button", { name: /^Open/u }));
    await waitFor(() => expect(slot.container.querySelector("[data-no-matches]")).not.toBeNull());
  });

  it("shares the Inbox's words across its tabs", async () => {
    const waiting = pr({ number: 31, title: "Envoy filters", next: next({ kind: "new_request", inbox: true }) });
    const snoozedEnvoy = pr({ number: 32, title: "Envoy routes", snoozed: true, snoozedUntil: Date.now() + HOUR, next: next({ kind: "new_request" }) });
    const snoozedOther = pr({ number: 33, title: "Native app routes", snoozed: true, snoozedUntil: Date.now() + 2 * HOUR, next: next({ kind: "new_request" }) });
    const { slot, route } = await page("inbox", { inbox: () => inbox({ prs: [waiting], snoozed: [snoozedEnvoy, snoozedOther] }), descriptionMatches: () => ({ keys: [] }) });
    const rows = () => [...slot.container.querySelectorAll("[data-row]")].map((node) => node.getAttribute("data-row"));
    await find(slot.container, `[data-row="${waiting.key}"]`);
    type(field(slot, "Search the Inbox"), "envoy");
    // Selecting a row swaps the field for the selection bar, which still shows the words and clears them.
    fireEvent.click(slot.getByRole("checkbox", { name: /^Select /u }));
    const bar = await find(slot.container, "[data-selection-bar]");
    expect(bar.querySelector("[data-selection-filter]")!.textContent).toContain("\u201cenvoy\u201d");
    fireEvent.click(within(bar).getByRole("button", { name: "Clear" }));
    await find(slot.container, "[data-toolbar]");
    route(formatRoute({ view: "inbox", tab: "snoozed", key: null }));
    await find(slot.container, `[data-row="${snoozedEnvoy.key}"]`);
    expect(rows()).toEqual([snoozedEnvoy.key]);
    expect(field(slot, "Search the Inbox").value).toBe("envoy");
  });
});
