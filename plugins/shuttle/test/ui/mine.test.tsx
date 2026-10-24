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
