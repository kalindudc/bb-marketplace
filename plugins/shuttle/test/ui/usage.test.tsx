import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { UsageView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { callsTo, DAY, find, HOUR, lastNavigation, NOW, page, unmountAll, usage } from "./helpers";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

afterEach(() => unmountAll());

const KEY = "github:acme/app#3";
const week: UsageView = usage({
  totals: { tokens: 152_300_000, cost: 87.12, calls: 1_204, reviews: 24, mix: { input: 1_000, output: 2_100_000, cacheRead: 146_000_000, cacheWrite: 4_199_000 }, estimated: false },
  previous: { tokens: 129_000_000, cost: 73.8, reviews: 19 },
  perReview: { medianTokens: 6_300_000, medianCost: 3.63, p90Cost: 7.2 },
  critics: { tokens: 30_000_000, cost: 11.5, threads: 61 },
  series: Array.from({ length: 7 }, (_, i) => ({ start: NOW - (6 - i) * DAY, tokens: 20_000_000 + i, cost: 12, critics: 4_000_000, reviews: 3 })),
  presets: [{ preset: "Thorough review", reviews: 18, tokens: 130_000_000, cost: 74, medianCost: 4.1, posted: 11 }, { preset: "Static review", reviews: 6, tokens: 22_300_000, cost: 13.12, medianCost: 2.2, posted: 4 }],
  models: [{ model: "anthropic/claude-fable-5-1", tokens: 150_000_000, cost: 85, calls: 1_100 }],
  triggers: [{ trigger: "auto", reviews: 20, tokens: 140_000_000, cost: 80 }, { trigger: "manual", reviews: 4, tokens: 12_300_000, cost: 7.12 }],
  repos: [{ repo: "acme/app", reviews: 24, tokens: 152_300_000, cost: 87.12 }],
  outcomes: [{ outcome: "posted", reviews: 15, tokens: 100_000_000, cost: 60 }, { outcome: "discarded", reviews: 3, tokens: 20_000_000, cost: 12 }, { outcome: "no_draft", reviews: 2, tokens: 10_000_000, cost: 5.5 }, { outcome: "waiting", reviews: 4, tokens: 22_300_000, cost: 9.62 }],
  reviews: Array.from({ length: 12 }, (_, i) => ({
    runId: i + 1, key: i === 0 ? KEY : `github:acme/app#${i + 10}`, display: i === 0 ? "acme/app#3" : `acme/app#${i + 10}`, title: `PR ${i}`, threadId: `thr_review${i}`,
    preset: "Thorough review", trigger: "auto" as const, at: NOW - i * HOUR, outcome: "posted" as const, tokens: 9_000_000 - i, cost: 5.74 - i * 0.1, calls: 66, critics: 3,
  })),
});

describe("Insights › Usage", () => {
  it("shows what reviews used this week against the week before, by preset, model and outcome, costliest review first", async () => {
    const { slot } = await page("insights/usage", { usage: ({ range }) => ({ ...week, range }) });
    const tiles = await waitFor(() => {
      const found = [...slot.container.querySelectorAll<HTMLElement>("[data-kpi]")];
      if (found.length === 0) throw new Error("no tiles yet");
      return found;
    });
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      "Tokens152M\u25b2 18% from the 7 days before",
      "Cost$87.12\u25b2 18% from the 7 days before",
      "Reviews241,204 model calls; 19 in the 7 days before",
      "Median per review$3.636.30M tokens; 90th percentile $7.20",
    ]);
    expect(callsTo(slot, "usage")).toEqual([{ range: "7d" }]);
    expect(slot.container.textContent).toContain("$17.50 went to 5 reviews that left you nothing to post");
    expect(slot.container.textContent).toContain("Critics 30.0M, $11.50, 61 threads");
    expect(slot.container.querySelector("[data-chart=usage]")!.querySelectorAll("rect")).toHaveLength(14);
    const rows = slot.container.querySelectorAll("[data-usage-review]");
    expect(rows).toHaveLength(10);
    expect(rows[0]!.textContent).toContain("acme/app#3");
    expect(rows[0]!.textContent).toContain("$5.74");
    fireEvent.click(within(slot.container).getByRole("button", { name: "Show all 12" }));
    expect(slot.container.querySelectorAll("[data-usage-review]")).toHaveLength(12);

    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "acme/app#3" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: KEY }) } });
    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "Open the review thread" }));
    expect(lastNavigation(slot)).toEqual({ method: "toThread", threadId: "thr_review0" });

    fireEvent.click(within(slot.container).getByRole("radio", { name: "Today" }));
    await waitFor(() => expect(callsTo(slot, "usage")).toContainEqual({ range: "today" }));
    fireEvent.click(within(slot.container).getByRole("radio", { name: "90 days" }));
    await waitFor(() => expect(callsTo(slot, "usage")).toContainEqual({ range: "90d" }));
  });

  it("says it needs Burn when bb has no Burn, and shows no figures", async () => {
    const { slot } = await page("insights/usage", { usage: () => usage({ source: { state: "missing", message: 'unknown plugin "burn"', at: NOW, unread: 7 } }) });
    const note = await find(slot.container, "[data-usage-source=missing]");
    expect(note.textContent).toContain("Token usage comes from the Burn plugin");
    expect(note.textContent).toContain('unknown plugin "burn"');
    expect(within(note).getByRole("link", { name: "Install Burn" })).toBeTruthy();
    expect(slot.container.querySelector("[data-kpi]")).toBeNull();
  });

  it("says when nothing was used, and which review threads are still being read", async () => {
    const { slot } = await page("insights/usage", { usage: () => usage({ source: { state: "ok", message: null, at: NOW, unread: 3 }, unmeasured: 1 }) });
    const note = await find(slot.container, "[data-usage-source=ok]");
    expect(note.textContent).toContain("Reading 3 review threads from Burn");
    expect(note.textContent).toContain("1 review started in this range has no figures in Burn.");
    expect(slot.container.textContent).toContain("No AI review used anything in this range.");
  });
});
