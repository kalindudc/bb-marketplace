import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { PrView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { agent, callsTo, DAY, find, lastNavigation, mine, next, overview, page, unmountAll, type Handlers } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

const waiting = mine({
  number: 1, title: "Retire the legacy Sorting Hat route", review: "changes", agent: agent({ title: "Retire the Sorting Hat route", status: "waiting" }),
  next: next({ kind: "agent_waiting", tone: "warn", label: "The agent needs your answer", why: "It asks about the kill switch.", inbox: true, primary: { id: "open_agent", label: "Answer in the thread" } }),
});
const ready = mine({
  number: 2, title: "Fail a Cloudflare run once", review: "approved", checkCounts: { passed: 12, failed: 0, pending: 0, total: 12 }, agent: agent({ title: "CF 3" }),
  next: next({ kind: "ready_to_merge", tone: "ok", label: "Ready to merge", why: "Approved, and all 12 checks pass.", inbox: true, primary: { id: "merge", label: "Merge…" } }),
});
const fixing = mine({
  number: 3, title: "Retry WAF rule deletes", checks: "failed", checkCounts: { passed: 8, failed: 1, pending: 0, total: 9 }, review: "changes",
  agent: agent({ status: "working" }), next: next({ kind: "agent_on_it", tone: "info", label: "The agent is on it" }),
});
const waitingReview = mine({
  number: 4, title: "Page Edge Infrastructure when token checks fail", checks: "pending", checkCounts: { passed: 5, failed: 0, pending: 2, total: 7 },
  createdAt: Date.now() - 3 * DAY, labels: [{ name: "applications", color: "8b93b8" }],
  suggestedAgent: { threadId: "thr_cf4", title: "CF token containment 4", why: "Opened this PR: its id is in the branch name" },
  next: next({ kind: "waiting_review", more: [{ id: "nudge", label: "Nudge reviewers" }] }),
});
const drafted = mine({ number: 5, title: "Export only failed Monorail requests", state: "draft", agent: agent({ mode: "notify" }), next: next({ kind: "draft", label: "Draft", primary: { id: "ready", label: "Ready for review" } }) });
const open = [waiting, ready, fixing, waitingReview, drafted];

function minePage(rpc: Partial<Handlers> = {}, prs: PrView[] = open, subPath = "mine") {
  return page(subPath, {
    list: ({ area }) => ({ prs: area === "mine" ? prs : [] }),
    detail: ({ key }) => ({ pr: prs.find((item) => item.key === key)!, events: [], body: "", draft: null }),
    ...rpc,
  });
}

const group = (slot: Awaited<ReturnType<typeof minePage>>["slot"], title: string) => slot.container.querySelector<HTMLElement>(`[data-group="${title}"]`);
const keysIn = (element: HTMLElement | null) => [...(element?.querySelectorAll("[data-pr]") ?? [])].map((node) => node.getAttribute("data-pr"));

describe("My PRs", () => {
  it("groups the open PRs by their next step", async () => {
    const { slot } = await minePage();
    await find(slot.container, "[data-group]");
    expect([...slot.container.querySelectorAll("[data-group]")].map((node) => node.getAttribute("data-group"))).toEqual(["Needs you", "Ready to merge", "Agent on it", "Waiting for review", "Drafts"]);
    expect(keysIn(group(slot, "Needs you"))).toEqual([waiting.key]);
    expect(keysIn(group(slot, "Ready to merge"))).toEqual([ready.key]);
    expect(keysIn(group(slot, "Agent on it"))).toEqual([fixing.key]);
    expect(keysIn(group(slot, "Waiting for review"))).toEqual([waitingReview.key]);
    expect(keysIn(group(slot, "Drafts"))).toEqual([drafted.key]);
    expect(callsTo(slot, "list")).toEqual([{ area: "mine" }]);
  });

  it("shows each row's checks, review and agent, and its next step on the right", async () => {
    const { slot } = await minePage();
    const row = (key: string) => slot.container.querySelector<HTMLElement>(`[data-pr="${key}"]`)!;
    await find(slot.container, `[data-pr="${fixing.key}"]`);
    expect(row(fixing.key).textContent).toContain("1 check fail");
    expect(row(fixing.key).textContent).toContain("Changes requested");
    expect(row(fixing.key).textContent).toContain("Agent fixes · fixing");
    expect(row(waiting.key).textContent).toContain("Agent fixes · needs you");
    expect(row(waitingReview.key).textContent).toContain("Checks 5/7");
    expect(row(waitingReview.key).textContent).toContain("No review · 3d");
    expect(row(waitingReview.key).querySelector("[data-pill='none']")!.textContent).toBe("No agent");
    expect(row(waitingReview.key).querySelector("[data-label='applications']")).not.toBeNull();
    expect(row(drafted.key).textContent).toContain("Agent told");
    expect(within(row(ready.key)).getByRole("button", { name: "Merge…" })).toBeTruthy();
    expect(within(row(waitingReview.key)).queryByRole("button")).toBeNull();
  });

  it("hides the rows' actions while a PR is open beside the list", async () => {
    const { slot } = await minePage({}, open, formatRoute({ view: "mine", key: waiting.key }));
    await find(slot.container, `[data-detail="${waiting.key}"]`);
    const row = slot.container.querySelector<HTMLElement>(`[data-pr="${ready.key}"]`)!;
    expect(within(row).queryByRole("button", { name: "Merge…" })).toBeNull();
  });

  it("offers auto agent while PRs have no agent, and Undo turns it off again", async () => {
    let autoAgent = false;
    const { slot } = await minePage({
      overview: () => overview({ autoAgent }),
      setSettings: (input) => {
        autoAgent = input.autoAgent ?? autoAgent;
        return { ok: true };
      },
    });
    const banner = await find(slot.container, "[data-auto-agent='off']");
    expect(banner.textContent).toContain("1 of your 5 open PRs has no agent");
    expect(banner.textContent).toContain("1 of them was opened by a bb thread");
    fireEvent.click(within(banner).getByRole("button", { name: "Turn on auto agent" }));
    await waitFor(() => expect(callsTo(slot, "setSettings")).toEqual([{ autoAgent: true }]));
    await find(slot.container, "[data-auto-agent='on']");
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    toasts.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "setSettings")).toEqual([{ autoAgent: true }, { autoAgent: false }]));
  });

  it("marks a draft ready from its row", async () => {
    const { slot } = await minePage({ editPr: () => ({ pr: { ...drafted, state: "open" } }) });
    const row = await find(slot.container, `[data-pr="${drafted.key}"]`);
    fireEvent.click(within(row).getByRole("button", { name: "Ready for review" }));
    await waitFor(() => expect(callsTo(slot, "editPr")).toEqual([{ key: drafted.key, change: { kind: "ready" } }]));
  });

  it("puts a nudge for the requested people in the PR's composer", async () => {
    const asking = mine({
      ...waitingReview, can: { merge: false, comment: true, review: false, reply: false, resolve: false },
      reviewers: [{ login: "wnagele", team: false, state: "requested" }, { login: "Shopify/app-infra", team: true, state: "requested" }, { login: "pascal", team: false, state: "commented" }],
    });
    const { slot, route } = await minePage({}, [asking], formatRoute({ view: "mine", key: asking.key }));
    const view = await find(slot.container, `[data-detail="${asking.key}"]`);
    const banner = await find(view, "[data-banner]");
    fireEvent.click(within(banner).getByRole("button", { name: "Nudge reviewers" }));
    route(formatRoute({ view: "mine", key: asking.key }));
    const box = within(view).getByRole("textbox", { name: "Comment on bb#4" }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("@wnagele could one of you take a look when you have a moment? It is a M change: +86 −12."));
    expect(document.activeElement).toBe(box);
  });

  it("lists the merged and closed ones under their own tab", async () => {
    const merged = mine({ number: 145, title: "Vantage 0.6.2", state: "merged", next: next({ kind: "merged", label: "Merged" }) });
    const { slot } = await page("done", { list: ({ area }) => ({ prs: area === "done" ? [merged] : [] }) }, { settings: { doneDays: 14 } });
    const row = await find(slot.container, `[data-pr="${merged.key}"]`);
    expect(row.textContent).toContain("Merged");
    expect(slot.getByRole("heading", { name: "Merged and closed" })).toBeTruthy();
    expect(slot.getByText("Your PRs from the last 14 days.")).toBeTruthy();
    fireEvent.click(slot.getByRole("radio", { name: "Open" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "mine" } });
  });
});

describe("My PRs, sorted and folded", () => {
  const aged = (pr: PrView, ago: number) => ({ ...pr, createdAt: Date.now() - ago });
  const byAge = [aged(waiting, 5 * DAY), aged(ready, 60 * 60_000), aged(fixing, 2 * DAY), aged(waitingReview, 3 * DAY), aged(drafted, 10 * 60_000)];
  const listed = (slot: Awaited<ReturnType<typeof minePage>>["slot"]) => keysIn(slot.container.querySelector<HTMLElement>("ul[aria-label='Pull requests']"));
  const sortBy = (slot: Awaited<ReturnType<typeof minePage>>["slot"], value: string) => fireEvent.change(slot.getByRole("combobox", { name: "Sort by" }), { target: { value } });

  it("flips to one sorted list and back to the groups, and remembers both choices", async () => {
    const first = await minePage({}, byAge);
    await find(first.slot.container, "[data-group]");
    fireEvent.click(first.slot.getByRole("radio", { name: "List" }));
    expect(first.slot.container.querySelector("[data-group]")).toBeNull();
    sortBy(first.slot, "newest");
    expect(listed(first.slot)).toEqual([drafted.key, ready.key, fixing.key, waitingReview.key, waiting.key]);
    const row = first.slot.container.querySelector<HTMLElement>(`[data-pr="${waiting.key}"]`)!;
    expect(row.querySelector("[data-row-group]")!.textContent).toBe("Needs you");
    expect(row.textContent).toContain("opened 5d ago");
    first.slot.lifecycle.unmount();

    const again = await minePage({}, byAge);
    await find(again.slot.container, "ul[aria-label='Pull requests']");
    expect(listed(again.slot)).toEqual([drafted.key, ready.key, fixing.key, waitingReview.key, waiting.key]);
    expect((again.slot.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement).value).toBe("newest");
    fireEvent.click(again.slot.getByRole("radio", { name: "Grouped" }));
    expect([...again.slot.container.querySelectorAll("[data-group]")].map((node) => node.getAttribute("data-group"))).toEqual(["Needs you", "Ready to merge", "Agent on it", "Waiting for review", "Drafts"]);
    expect(again.slot.container.querySelector("[data-row-group]")).toBeNull();
  });

  it("sorts the rows inside each group", async () => {
    const older = mine({ number: 6, title: "Drain the old edge pool", createdAt: Date.now() - 9 * DAY, next: next({ kind: "waiting_review" }) });
    const newer = mine({ number: 7, title: "Add a canary for the new pool", createdAt: Date.now() - DAY, next: next({ kind: "waiting_review" }) });
    const { slot } = await minePage({}, [older, newer]);
    await find(slot.container, "[data-group]");
    sortBy(slot, "oldest");
    expect(keysIn(group(slot, "Waiting for review"))).toEqual([older.key, newer.key]);
    sortBy(slot, "newest");
    expect(keysIn(group(slot, "Waiting for review"))).toEqual([newer.key, older.key]);
  });

  it("folds a section to its title, remembers it, and folds or unfolds them all", async () => {
    const first = await minePage();
    await find(first.slot.container, "[data-group]");
    const header = within(group(first.slot, "Needs you")!).getByRole("button", { name: /Needs you/u });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(keysIn(group(first.slot, "Needs you"))).toEqual([]);
    expect(group(first.slot, "Needs you")!.textContent).toContain("1");
    expect(keysIn(group(first.slot, "Ready to merge"))).toEqual([ready.key]);
    first.slot.lifecycle.unmount();

    const { slot } = await minePage();
    await find(slot.container, "[data-group]");
    expect(group(slot, "Needs you")!.hasAttribute("data-folded")).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Collapse all" }));
    expect(slot.container.querySelectorAll("[data-group] [data-pr]")).toHaveLength(0);
    fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
    expect(slot.container.querySelectorAll("[data-group] [data-pr]")).toHaveLength(5);
    expect(slot.container.querySelector("[data-folded]")).toBeNull();
  });

  it("sorts the merged and closed ones by when they merged, or as picked", async () => {
    const early = mine({ number: 140, title: "Vantage 0.6.0", state: "merged", closedAt: Date.now() - 5 * DAY, createdAt: Date.now() - 6 * DAY, next: next({ kind: "merged", label: "Merged" }) });
    const late = mine({ number: 141, title: "Vantage 0.6.1", state: "closed", closedAt: Date.now() - DAY, createdAt: Date.now() - 9 * DAY, next: next({ kind: "closed", label: "Closed" }) });
    const { slot } = await page("done", { list: ({ area }) => ({ prs: area === "done" ? [early, late] : [] }) });
    await find(slot.container, `[data-pr="${early.key}"]`);
    const select = slot.getByRole("combobox", { name: "Sort by" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual(["Recently merged", "Newest first", "Oldest first", "Repository", "Largest first"]);
    expect(slot.queryByRole("radio", { name: "List" })).toBeNull();
    expect(listed(slot)).toEqual([late.key, early.key]);
    expect(slot.container.querySelector(`[data-pr="${late.key}"]`)!.textContent).toContain("closed 1d ago");
    sortBy(slot, "newest");
    expect(listed(slot)).toEqual([early.key, late.key]);
    expect(slot.container.querySelector(`[data-pr="${late.key}"]`)!.textContent).toContain("opened 9d ago");
  });
});
