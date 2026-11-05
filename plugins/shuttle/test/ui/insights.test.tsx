import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { InsightsView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { autoPostInsights, shadowRepo, callsTo, CAN_ALL, config, DAY, event, find, HOUR, insights, lastNavigation, mine, page, unmountAll } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

const waiting = mine({ repo: "acme/terraform-the-cloud", number: 74066, can: CAN_ALL, reviewers: [{ login: "uzo", team: false, state: "requested" }, { login: "acme/edge", team: true, state: "requested" }] });

const full: InsightsView = insights({
  collectingSince: new Date(2026, 9, 1).getTime(),
  kpis: { merged: 11, opened: 18, timeToMerge: 2.6 * DAY, firstReviewWait: 21 * HOUR, reviewResponse: 1.9 * DAY },
  phases: { draft: 0.14, waiting: 0.41, fixing: 0.23, approved: 0.22 },
  feedback: { total: 46, fixed: 21, replied: 8, declined: 0, you: 11, open: 6, agentMedianMs: 41 * 60_000 },
  requests: [{ week: "Oct 6", asked: 6, team: 13, reviewed: 6 }, { week: "Oct 13", asked: 8, team: 16, reviewed: 5 }],
  openRequests: [{ day: "Oct 19", total: 289, bots: 80, quiet: 55 }, { day: "Oct 20", total: 298, bots: 81, quiet: 57 }],
  ai: [{ preset: "Standard review", drafts: 8, posted: 7, kept: 0.74 }, { preset: "Quick skim", drafts: 1, posted: 0, kept: null }],
  reviewers: [{ login: "review-bot", bot: true, reviews: 14, medianMs: 4 * 60_000 }, { login: "pascal", bot: false, reviews: 9, medianMs: 6 * HOUR }],
  ideas: [
    { id: "wait", tone: "warn", title: "Waiting for a first review is 41% of your PRs' life.", detail: "terraform-the-cloud#74066 has waited 9 days.", action: { id: "nudge", label: "Nudge #74066's reviewers", key: waiting.key } },
    { id: "agents", tone: "info", title: "4 of your 10 open PRs have no agent.", detail: "Agents fix feedback in a median 41 minutes.", action: { id: "auto_agent", label: "Turn on auto agent", key: null } },
    { id: "bots", tone: "neutral", title: "81 of your 298 review requests come from bots.", detail: "dependabot and deploy-bot.", action: { id: "hide_bots", label: "Hide bots in Reviews", key: null } },
    { id: "nits", tone: "neutral", title: "You post 12% of the nits.", detail: "Tell the preset to skip nits.", action: { id: "edit_preset", label: "Edit the preset", key: null } },
  ],
});

function insightsPage(subPath = "insights", data: InsightsView = full, rpc = {}) {
  return page(subPath, {
    insights: ({ range }) => ({ ...data, range }),
    detail: () => ({ pr: waiting, events: [], body: "", draft: null, drafts: 0 }),
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
    expect([...reviewers.querySelectorAll("tbody tr")].map((row) => row.textContent)).toEqual(["pascal96.0h", "review-bot (bot)144m"]);
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

  it("shows auto post's shadow record per repository, why drafts were held, and the latest decisions", async () => {
    const record = autoPostInsights({
      target: 0.9,
      repos: [shadowRepo({
        repo: "Shopify/terraform-the-cloud", drafts: 6,
        findings: { agreed: 9, edited: 2, against: 1, pending: 2, missed: 1, held: 4, precision: 0.9, lowerBound: 0.596, needed: 41, judged: 13 },
        policy: { drafts: 1, findings: 2, agreed: 1, against: 0 },
        approvals: { drafts: 12, wouldApprove: 5, agreed: 4, against: 1, pending: 0, missed: 3, held: 4, precision: 0.8, lowerBound: 0.38, needed: 190 },
      })],
      reasons: [{ check: "approval", reason: "checks are still running", count: 7 }, { check: "accuracy", reason: "no critic votes", count: 3 }],
      points: [{ holds: 0.9, worth: 0.8, label: "agreed" }, { holds: 0.75, worth: 0.72, label: "against" }],
      verifier: { runs: 11, failures: 1, medianMs: 8400 },
      recent: [{ draftId: 4, key: waiting.key, display: "terraform-the-cloud#74066", title: "Move the WAF rules", at: Date.now() - HOUR, verdict: "comment", decision: "hold", findings: 3, passing: 2, posting: 0, approval: "approve", outcome: "posted", posted: "approve", agreed: 2, against: 0, reason: "a bot wrote the PR" }],
    });
    const { slot } = await insightsPage("insights/autopost", full, { autoPostInsights: ({ range }: { range: "7d" | "30d" | "90d" }) => ({ ...record, range }), getConfig: () => ({ config: config() }) });
    const card = await find(slot.container, "[data-auto-post-repo='Shopify/terraform-the-cloud']");
    const comments = card.querySelector("[data-record='findings']")!;
    expect([...comments.querySelectorAll("[data-kpi]")].map((tile) => tile.textContent)).toEqual([
      "Precision90%9 of 10 decided findings", "Proven at least60%95% lower bound, target 90%", "Missed1held findings you posted", "Waiting on you2findings it would pass",
    ]);
    expect(comments.querySelector("[data-proof]")!.textContent).toContain("41 more agreeing findings in a row would prove the target.");
    expect(comments.querySelector("[data-confusion]")!.textContent).toContain("Would pass9 (2 edited)12");
    expect(comments.querySelector("[data-confusion]")!.textContent).toContain("Held14\u2014");
    expect(comments.querySelector("[data-policy]")!.textContent).toContain("1 draft with 2 findings; you posted 1 of those and dropped 0.");
    const approvals = card.querySelector("[data-record='approvals']")!;
    expect([...approvals.querySelectorAll("[data-kpi]")].map((tile) => tile.textContent)).toEqual([
      "Would approve5of 12 drafts checked", "Precision80%4 of 5 you approved", "Proven at least38%95% lower bound, target 98%", "Missed3held, and you approved",
    ]);
    expect(approvals.querySelector("[data-proof]")!.textContent).toContain("190 more agreeing approvals in a row would prove the target.");
    expect(card.textContent).toContain("13 findings judged");
    expect(slot.container.querySelectorAll("[data-chart='scatter'] circle")).toHaveLength(2);
    expect(slot.container.querySelector("[data-hold-reasons]")!.textContent).toContain("Approvalchecks are still running7");
    expect(callsTo(slot, "insights")).toEqual([]);
    expect(callsTo(slot, "autoPostInsights")).toEqual([{ range: "30d" }]);
    const recent = slot.container.querySelector("[data-recent-decisions]") as HTMLElement;
    expect(recent.textContent).toContain("2 of 3 pass the gate");
    expect(recent.textContent).toContain("Would approve");
    expect(recent.textContent).toContain("You approved");
    fireEvent.click(within(recent).getByRole("button", { name: "terraform-the-cloud#74066" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: waiting.key }) } });
  });

  it("lists what is waiting to post, each repository's modes and what Shuttle posted, and resumes a stopped kind", async () => {
    const record = autoPostInsights({
      repos: [shadowRepo({
        repo: "acme/app", mode: "countdown", approveMode: "auto", drafts: 4,
        posted: { reviews: 3, approvals: 1, findings: 5, marked: 1, mistakes: 1 },
        trips: [{ kind: "approve", reason: "you marked 2 approvals as mistakes", at: Date.now() - 2 * HOUR }],
      }), shadowRepo({ repo: "acme/docs" })],
      scheduled: [
        { draftId: 11, key: waiting.key, display: "terraform-the-cloud#74066", title: "Move the WAF rules", at: Date.now() + 12 * 60_000, verdict: "comment", findings: 2 },
        { draftId: 12, key: "github:acme/app#9", display: "app#9", title: "Bump locales", at: Date.now() + 90 * 60_000, verdict: "approve", findings: 0 },
      ],
    });
    const { slot } = await insightsPage("insights/autopost", full, {
      autoPostInsights: ({ range }: { range: "7d" | "30d" | "90d" }) => ({ ...record, range }), getConfig: () => ({ config: config() }), resumeAutoPost: () => ({ cleared: 1 }),
    });
    const scheduled = await find(slot.container, "[data-scheduled-posts]");
    const rows = [...scheduled.querySelectorAll<HTMLElement>("[data-scheduled-post]")];
    expect(rows.map((row) => row.getAttribute("data-scheduled-post"))).toEqual(["11", "12"]);
    expect(rows[0]!.textContent).toContain("Move the WAF rules");
    expect(rows[0]!.textContent).toContain("2 comments");
    expect(rows[0]!.textContent).toContain("12m");
    expect(rows[1]!.textContent).toContain("Approval");
    expect(rows[1]!.textContent).toContain("2h");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "terraform-the-cloud#74066" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: waiting.key }) } });

    const card = slot.container.querySelector<HTMLElement>("[data-auto-post-repo='acme/app']")!;
    expect([...card.querySelectorAll("[data-pill]")].slice(0, 2).map((pill) => pill.textContent)).toEqual(["Comments: Countdown", "Approvals: Auto"]);
    expect(card.querySelector("[data-posted]")!.textContent).toBe("Posted by Shuttle: 3 reviews (1 approval), 5 comments, 2 marked as mistakes");
    const trip = card.querySelector<HTMLElement>("[data-auto-post-trip='approve']")!;
    expect(trip.textContent).toContain("Posting approvals stopped: you marked 2 approvals as mistakes");
    fireEvent.click(within(trip).getByRole("button", { name: "Resume posting approvals in acme/app" }));
    await waitFor(() => expect(callsTo(slot, "resumeAutoPost")).toEqual([{ repo: "acme/app", kind: "approve" }]));

    const quiet = slot.container.querySelector<HTMLElement>("[data-auto-post-repo='acme/docs']")!;
    expect([...quiet.querySelectorAll("[data-pill]")].slice(0, 2).map((pill) => pill.textContent)).toEqual(["Comments: Shadow", "Approvals: Shadow"]);
    expect(quiet.querySelector("[data-posted]")!.textContent).toBe("Posted by Shuttle: 0 reviews (0 approvals), 0 comments, 0 marked as mistakes");
    expect(quiet.querySelector("[data-auto-post-trip]")).toBeNull();
  });

  it("shows no waiting list when nothing is scheduled", async () => {
    const record = autoPostInsights({ repos: [shadowRepo({ repo: "acme/app" })] });
    const { slot } = await insightsPage("insights/autopost", full, { autoPostInsights: ({ range }: { range: "7d" | "30d" | "90d" }) => ({ ...record, range }), getConfig: () => ({ config: config() }) });
    await find(slot.container, "[data-auto-post-repo='acme/app']");
    expect(slot.container.querySelector("[data-scheduled-posts]")).toBeNull();
  });

  it("says how to turn auto post on when no repository is in shadow mode", async () => {
    const { slot } = await insightsPage("insights/autopost", full, { getConfig: () => ({ config: config() }) });
    const empty = await find(slot.container, "[data-auto-post-empty]");
    expect(empty.textContent).toContain("Auto post is off");
    expect(empty.textContent).toContain("Settings › Automations › Auto post");
  });

  it("keeps the old Activity page as the Automation log", async () => {
    const { slot } = await insightsPage("insights/log", full, {
      activity: () => ({ events: [event({ id: 4, kind: "forwarded", text: "Sent 4 items on infra-portal#29278 to its agent.", key: waiting.key, threadId: "thr_agent" })] }),
    });
    const row = await find(slot.container, "[data-event='forwarded']");
    expect(row.textContent).toContain("Sent 4 items on infra-portal#29278 to its agent.");
    expect(callsTo(slot, "insights")).toEqual([]);
    fireEvent.click(within(row).getByRole("button", { name: "Open thread" }));
    expect(lastNavigation(slot)).toEqual({ method: "toThread", threadId: "thr_agent" });
    fireEvent.click(within(row).getByRole("button", { name: waiting.key }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: waiting.key }) } });
  });
});
