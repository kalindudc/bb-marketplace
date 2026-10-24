import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { InsightsView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { callsTo, CAN_ALL, DAY, event, find, HOUR, insights, lastNavigation, mine, page, unmountAll } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

const waiting = mine({ repo: "Shopify/terraform-the-cloud", number: 74066, can: CAN_ALL, reviewers: [{ login: "uzo", team: false, state: "requested" }, { login: "Shopify/edge", team: true, state: "requested" }] });

const full: InsightsView = insights({
  collectingSince: new Date(2026, 9, 1).getTime(),
  kpis: { merged: 11, opened: 18, timeToMerge: 2.6 * DAY, firstReviewWait: 21 * HOUR, reviewResponse: 1.9 * DAY },
  phases: { draft: 0.14, waiting: 0.41, fixing: 0.23, approved: 0.22 },
  feedback: { total: 46, fixed: 21, replied: 8, declined: 0, you: 11, open: 6, agentMedianMs: 41 * 60_000 },
  requests: [{ week: "Oct 6", asked: 6, team: 13, reviewed: 6 }, { week: "Oct 13", asked: 8, team: 16, reviewed: 5 }],
  openRequests: [{ day: "Oct 19", total: 289, bots: 80, quiet: 55 }, { day: "Oct 20", total: 298, bots: 81, quiet: 57 }],
  ai: [{ preset: "Standard review", drafts: 8, posted: 7, kept: 0.74 }, { preset: "Quick skim", drafts: 1, posted: 0, kept: null }],
  reviewers: [{ login: "binks-code-reviewer", bot: true, reviews: 14, medianMs: 4 * 60_000 }, { login: "pascal", bot: false, reviews: 9, medianMs: 6 * HOUR }],
  ideas: [
    { id: "wait", tone: "warn", title: "Waiting for a first review is 41% of your PRs' life.", detail: "terraform-the-cloud#74066 has waited 9 days.", action: { id: "nudge", label: "Nudge #74066's reviewers", key: waiting.key } },
    { id: "agents", tone: "info", title: "4 of your 10 open PRs have no agent.", detail: "Agents fix feedback in a median 41 minutes.", action: { id: "auto_agent", label: "Turn on auto agent", key: null } },
    { id: "bots", tone: "neutral", title: "81 of your 298 review requests come from bots.", detail: "dependabot and terraform-actuator.", action: { id: "hide_bots", label: "Hide bots in Reviews", key: null } },
    { id: "nits", tone: "neutral", title: "You post 12% of the nits.", detail: "Tell the preset to skip nits.", action: { id: "edit_preset", label: "Edit the preset", key: null } },
  ],
});

function insightsPage(subPath = "insights", data: InsightsView = full, rpc = {}) {
  return page(subPath, {
    insights: ({ range }) => ({ ...data, range }),
    detail: () => ({ pr: waiting, events: [], body: "", draft: null }),
    setSettings: () => ({ ok: true }),
    ...rpc,
  });
}

describe("Insights", () => {
  it("renders with no numbers yet", async () => {
    const { slot } = await insightsPage("insights", insights());
    const tiles = await waitFor(() => {
      const found = [...slot.container.querySelectorAll<HTMLElement>("[data-kpi]")];
      if (found.length === 0) throw new Error("no tiles yet");
      return found;
    });
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      "Your PRs merged0of 0 opened", "Median time to merge—from open to merge", "Median wait for a review—to the first review", "Your review response—from request to your review",
    ]);
    expect(slot.container.textContent).toContain("Not enough data yet");
    expect(slot.container.textContent).toContain("No feedback in this range.");
    expect(slot.container.textContent).toContain("No AI reviews in this range.");
    expect(slot.container.querySelector("[data-collecting]")).toBeNull();
    expect(callsTo(slot, "insights")).toEqual([{ range: "30d" }]);
  });

  it("shows the numbers, the charts, the tables and when Shuttle started keeping them", async () => {
    const { slot } = await insightsPage();
    const tiles = await waitFor(() => {
      const found = [...slot.container.querySelectorAll<HTMLElement>("[data-kpi]")];
      if (found[0]?.textContent !== "Your PRs merged11of 18 opened") throw new Error("not loaded");
      return found;
    });
    expect(tiles.map((tile) => tile.querySelector(".text-xl")!.textContent)).toEqual(["11", "2.6d", "21h", "1.9d"]);
    expect(slot.container.querySelectorAll("[data-collecting]")).toHaveLength(1);
    expect(slot.container.querySelector("[data-collecting]")!.textContent).toContain("Shuttle started keeping some of these on");
    expect(slot.container.querySelector("[data-segbar='Phases']")!.textContent).toContain("Waiting for first review 41%");
    expect(slot.container.querySelector("[data-segbar='Feedback']")!.textContent).toContain("Agent fixed 46%");
    expect(slot.container.textContent).toContain("41mmedian to fix, agent");
    expect(slot.container.querySelectorAll("[data-chart='bars'] rect")).toHaveLength(6);
    expect(slot.container.querySelectorAll("[data-chart='line'] circle")).toHaveLength(2);
    expect(slot.container.textContent).toContain("298 open now. 81 are bots and 57 are quiet for 30+ days.");
    expect(slot.container.textContent).toContain("Standard review8774%");
    expect(slot.container.textContent).toContain("Quick skim10—");
    const reviewers = [...slot.container.querySelectorAll("table")].at(-1)!;
    expect([...reviewers.querySelectorAll("tbody tr")].map((row) => row.textContent)).toEqual(["pascal96.0h", "binks-code-reviewer (bot)144m"]);
  });

  it("reads another range when it is picked", async () => {
    const { slot } = await insightsPage();
    await find(slot.container, "[data-kpi]");
    fireEvent.click(within(slot.getByRole("radiogroup", { name: "Range" })).getByRole("radio", { name: "7d" }));
    await waitFor(() => expect(callsTo(slot, "insights")).toContainEqual({ range: "7d" }));
  });

  it("acts on its ideas", async () => {
    const { slot, route } = await insightsPage();
    const idea = (id: string) => slot.container.querySelector<HTMLElement>(`[data-idea="${id}"]`)!;
    await find(slot.container, "[data-idea='agents']");
    fireEvent.click(within(idea("agents")).getByRole("button", { name: "Turn on auto agent" }));
    await waitFor(() => expect(callsTo(slot, "setSettings")).toEqual([{ autoAgent: true }]));
    expect(within(idea("nits")).getByRole("link", { name: "Edit the preset" }).getAttribute("href")).toBe("/settings/plugins/shuttle");
    fireEvent.click(within(idea("bots")).getByRole("button", { name: "Hide bots in Reviews" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviews" } });

    fireEvent.click(within(idea("wait")).getByRole("button", { name: "Nudge #74066's reviewers" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: waiting.key }) } });
    route(formatRoute({ view: "pr", key: waiting.key }));
    const view = await find(slot.container, `[data-detail="${waiting.key}"]`);
    const box = await waitFor(() => within(view).getByRole("textbox", { name: "Comment on terraform-the-cloud#74066" }) as HTMLTextAreaElement);
    await waitFor(() => expect(box.value).toBe("@uzo could one of you take a look when you have a moment? It is a M change: +86 −12."));
  });

  it("keeps the old Activity page as the Automation log", async () => {
    const { slot } = await insightsPage("insights/log", full, {
      activity: () => ({ events: [event({ id: 4, kind: "forwarded", text: "Sent 4 items on infra-central#29278 to its agent.", key: waiting.key, threadId: "thr_agent" })] }),
    });
    const row = await find(slot.container, "[data-event='forwarded']");
    expect(row.textContent).toContain("Sent 4 items on infra-central#29278 to its agent.");
    expect(callsTo(slot, "insights")).toEqual([]);
    fireEvent.click(within(row).getByRole("button", { name: "Open thread" }));
    expect(lastNavigation(slot)).toEqual({ method: "toThread", threadId: "thr_agent" });
    fireEvent.click(within(row).getByRole("button", { name: waiting.key }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: waiting.key }) } });
  });
});
