import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { Config } from "../../src/config";
import { replaySettingsOf, withReplaySettings, type ReplaySettings } from "../../src/replay";
import type { ReplayDraft } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { autoPostInsights, autoPostRepo, callsTo, config, find, HOUR, lastNavigation, page, replayDraft, replayFinding, shadowRepo, unmountAll, type Handlers } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

/**
 * Six drafts under the default settings (comments hold description, scope and other concerns; approvals also unverified and
 * process; medium and above; floors 0.7; 800 lines for comments, 200 for approvals; checks must pass; approvals carry up to low):
 * only #1 posts and only #5 is approved.
 */
const DRAFTS: ReplayDraft[] = [
  replayDraft({ id: 1 }),
  replayDraft({ id: 2, title: "Bump locales", you: "pending", size: 40, concerns: ["other"], findings: [replayFinding({ id: "f2", holds: 0.8, worth: 0.75, you: "pending" })] }),
  replayDraft({ id: 3, title: "Add a taint zone action", you: "approved", size: 1500, checks: "none", risk: "medium", concerns: ["other", "unverified"], findings: [replayFinding({ id: "f3", holds: 0.6, worth: 0.8, you: "dropped" })] }),
  replayDraft({ id: 4, title: "Upgrade Ruby", verdict: "approve", you: "approved", size: 2, checks: "none", findings: [] }),
  replayDraft({ id: 5, repo: "beta/docs", title: "Fix a typo", verdict: "approve", you: "approved", size: 3, findings: [], blocking: 0.05, exact: false }),
  replayDraft({ id: 6, title: "Rework the queue", verdict: "changes", you: "discarded", size: 10, checks: "failed", risk: null, concerns: ["scope"], findings: [replayFinding({ id: "f6", severity: "low", holds: 0.95, worth: 0.9, you: "dropped" })] }),
];

const withRepos = (overrides: Partial<Config> = {}) => {
  const base = config(overrides);
  return { ...base, autoPost: { ...base.autoPost, repos: [autoPostRepo("acme/*"), autoPostRepo("beta/docs")] } };
};

async function autoPostPage(rpc: Partial<Handlers> = {}, drafts = DRAFTS, cfg = withRepos()) {
  const record = autoPostInsights({ repos: [shadowRepo({ repo: "acme/*" }), shadowRepo({ repo: "beta/docs" })] });
  // The server answers getConfig with what was last saved, as Shuttle's does.
  let current = cfg;
  const { slot, route } = await page("insights/autopost", {
    autoPostReplay: () => ({ drafts }),
    autoPostInsights: ({ range }) => ({ ...record, range }),
    getConfig: () => ({ config: current }),
    saveAutoPostSettings: ({ changes }) => {
      current = { ...current, autoPost: withReplaySettings(current.autoPost, { ...replaySettingsOf(current.autoPost), ...changes }) };
      return { config: current };
    },
    ...rpc,
  });
  await find(slot.container, "[data-hero]");
  return { slot, route, root: slot.container.querySelector<HTMLElement>("[data-auto-post-insights]")! };
}

const text = (node: ParentNode, selector: string) => node.querySelector(selector)?.textContent ?? null;
const groupRows = (root: ParentNode, group: string) => [...root.querySelectorAll<HTMLElement>(`[data-draft-group='${group}'] [data-draft]`)].map((row) => row.getAttribute("data-draft"));
const groupCount = (root: ParentNode, group: string) => text(root, `[data-draft-group='${group}'] [data-group-count]`);
const holdRow = (root: ParentNode, key: string) => root.querySelector<HTMLElement>(`[data-hold-row='${key}']`)!;
const saved = (slot: Awaited<ReturnType<typeof autoPostPage>>["slot"]) => callsTo(slot, "saveAutoPostSettings").map((input) => (input as { changes: Partial<ReplaySettings> }).changes);

describe("Insights › Auto post", () => {
  it("shows how many drafts would post with your settings, the three groups, and what holds them", async () => {
    const { slot, root } = await autoPostPage();
    expect(callsTo(slot, "autoPostReplay")).toEqual([{ range: "30d" }]);
    expect(callsTo(slot, "autoPostInsights")).toEqual([{ range: "30d" }]);
    expect(text(root, "[data-hero-count]")).toBe("1");
    expect(text(root, "[data-hero]")).toContain("1of 6 drafts would post");
    expect(root.querySelector("[data-hero-delta]")).toBeNull();
    expect(text(root, "[data-hero-facts]")).toBe("2 findings pass1 of them you posted0 you dropped");
    expect(text(root, "[data-changes]")).toBe("Your settings");
    expect(root.querySelector("[data-proof-ring] svg")!.getAttribute("aria-label")).toBe("Proven at least 21% of a 90% target: ~34 more to go");

    expect(groupCount(root, "post")).toBe("1");
    expect(groupCount(root, "settings")).toBe("2");
    expect(groupCount(root, "other")).toBe("3");
    expect(groupRows(root, "post")).toEqual(["1"]);
    expect(groupRows(root, "settings")).toEqual(["2", "3"]);
    expect(groupRows(root, "other")).toEqual([]);
    const other = root.querySelector<HTMLElement>("[data-draft-group='other']")!;
    fireEvent.click(within(other).getByRole("button", { name: /Held for another reason/u }));
    expect(groupRows(root, "other")).toEqual(["4", "5", "6"]);
    const row3 = root.querySelector<HTMLElement>("[data-draft='3']")!;
    expect(row3.textContent).toContain("acme/app#3");
    expect(row3.textContent).toContain("Add a taint zone action");
    expect(row3.textContent).toContain("Review: Comment");
    expect(row3.textContent).toContain("You: approved");
    expect([...row3.querySelectorAll("[data-hold]")].map((chip) => chip.textContent)).toEqual(["Over 800 lines"]);
    expect(text(root, "[data-draft='4']")).toContain("Suggested approving");
    expect(text(root, "[data-draft='1']")).toContain("1 finding passes");

    const rows = [...root.querySelectorAll("[data-hold-row]")].map((row) => [row.getAttribute("data-hold-row"), text(row, "[data-hold-count]"), text(row, "[data-hold-gain]")]);
    expect(rows).toEqual([["concern:other", "2", "+1"], ["concern:unverified", "1", null], ["concern:scope", "1", null], ["size", "1", null], ["findings", "2", null]]);
    expect(within(holdRow(root, "concern:other")).getByRole("switch", { name: "Hold comments for: Other concerns" }).getAttribute("aria-checked")).toBe("true");
    expect(within(holdRow(root, "concern:unverified")).getByRole("switch", { name: "Hold comments for: Couldn't verify" }).getAttribute("aria-checked")).toBe("false");
    expect((within(holdRow(root, "size")).getByRole("spinbutton", { name: "Largest PR for comments, in lines" }) as HTMLInputElement).value).toBe("800");
    expect([...root.querySelectorAll("[data-fixed-holds] [data-pill]")].map((chip) => chip.textContent)).toEqual(["Suggested approving 2", "No findings 2", "Asked for changes 1", "No risk rating 1"]);
    expect(text(root, "[data-exact-note]")).toBe("1 draft was checked before Shuttle kept the PR's checks and size; for those it uses the check's reasons or the PR as it is now.");
    expect(root.querySelectorAll("[data-chart='scatter'] circle")).toHaveLength(4);
    expect([...root.querySelectorAll("[data-finding-reasons] [data-pill]")].map((chip) => chip.textContent)).toEqual(["Not sure it's right 1", "Below lowest severity 1"]);
  });

  it("expands a draft to every hold and each finding's scores, and opens its PR", async () => {
    const { slot, root } = await autoPostPage();
    const row = within(root.querySelector<HTMLElement>("[data-draft='3']")!).getByRole("button", { name: /acme\/app#3/u });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const detail = root.querySelector<HTMLElement>("[data-draft='3'] [data-draft-detail]")!;
    expect([...detail.querySelectorAll("[data-draft-holds] [data-hold]")].map((chip) => [chip.getAttribute("data-hold"), chip.textContent, chip.querySelector("[data-pill]")!.getAttribute("data-pill")]))
      .toEqual([["size", "Over 800 lines", "warn"], ["concern", "Other concerns", "warn"], ["findings", "No finding passes", "warn"]]);
    const finding = detail.querySelector<HTMLElement>("[data-finding='f3']")!;
    expect(finding.textContent).toContain("medium");
    expect(finding.textContent).toContain("Not sure it's right");
    expect(finding.textContent).toContain("you dropped");
    expect([...finding.querySelectorAll("[role='img']")].map((bar) => bar.getAttribute("aria-label"))).toEqual(["Sure it's right 0.60, floor 0.70", "Worth posting 0.80, floor 0.70"]);
    fireEvent.click(within(detail).getByRole("button", { name: "Open acme/app#3" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: "github:acme/app#3" }) } });
    fireEvent.click(row);
    expect(root.querySelector("[data-draft='3'] [data-draft-detail]")).toBeNull();

    fireEvent.click(within(root.querySelector<HTMLElement>("[data-draft-group='other']")!).getByRole("button", { name: /Held for another reason/u }));
    fireEvent.click(within(root.querySelector<HTMLElement>("[data-draft='4']")!).getByRole("button", { name: /acme\/app#4/u }));
    expect([...root.querySelectorAll("[data-draft='4'] [data-draft-holds] [data-hold]")].map((chip) => [chip.textContent, chip.querySelector("[data-pill]")!.getAttribute("data-pill")]))
      .toEqual([["Suggested approving", "neutral"], ["No findings", "neutral"]]);
  });

  it("tries a concern switch and a floor, then saves only the replayed fields or resets", async () => {
    const { slot, root } = await autoPostPage();
    fireEvent.click(within(holdRow(root, "concern:other")).getByRole("switch", { name: "Hold comments for: Other concerns" }));
    expect(text(root, "[data-hero-count]")).toBe("2");
    expect(text(root, "[data-hero-delta]")).toBe("+1");
    expect(text(root, "[data-changes]")).toBe("Trying 1 changeResetSave");
    expect(groupRows(root, "post")).toEqual(["1", "2"]);
    expect(groupRows(root, "settings")).toEqual(["3"]);
    expect(holdRow(root, "concern:other").getAttribute("data-on")).toBe("false");
    expect(text(holdRow(root, "concern:other"), "[data-hold-gain]")).toBeNull();

    expect(text(root, "[data-hero-facts]")).toContain("2 findings pass");
    fireEvent.change(slot.getByRole("slider", { name: "Sure it's right, at least" }), { target: { value: "0.5" } });
    expect(text(root, "[data-hero-facts]")).toContain("3 findings pass");
    expect(text(root, "[data-changes]")).toContain("Trying 2 changes");
    expect([...root.querySelectorAll("[data-finding-reasons] [data-pill]")].map((chip) => chip.textContent)).toEqual(["Below lowest severity 1"]);
    expect(root.querySelector("[data-verifier]")!.textContent).toContain("Sure it's right, at least 0.50");

    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    // Only what changed is sent; the server merges it into the settings as they are then.
    expect(saved(slot)[0]).toEqual({ holdComment: ["description", "scope"], holds: 0.5 });
    await waitFor(() => expect(text(root, "[data-changes]")).toBe("Your settings"));
    expect(text(root, "[data-hero-count]")).toBe("2");
    expect(root.querySelector("[data-hero-delta]")).toBeNull();
    expect(toasts.success).toHaveBeenCalledWith("Saved auto post's settings");

    expect(groupRows(root, "settings")).toEqual(["3"]);
    expect([...root.querySelectorAll("[data-draft='3'] [data-hold]")].map((chip) => chip.textContent)).toEqual(["Over 800 lines"]);
    fireEvent.change(within(holdRow(root, "size")).getByRole("spinbutton", { name: "Largest PR for comments, in lines" }), { target: { value: "2000" } });
    expect(text(root, "[data-hero-count]")).toBe("3");
    expect(text(root, "[data-hero-delta]")).toBe("+1");
    expect(groupRows(root, "post")).toEqual(["1", "2", "3"]);
    expect(groupRows(root, "settings")).toEqual([]);
    expect(text(root, "[data-changes]")).toBe("Trying 1 changeResetSave");
    fireEvent.click(slot.getByRole("button", { name: "Reset" }));
    expect(text(root, "[data-changes]")).toBe("Your settings");
    expect(text(root, "[data-hero-count]")).toBe("2");
    expect((within(holdRow(root, "size")).getByRole("spinbutton", { name: "Largest PR for comments, in lines" }) as HTMLInputElement).value).toBe("800");
    expect(saved(slot)).toHaveLength(1);
  });

  it("refuses a size outside the schema's range without changing anything", async () => {
    const { root } = await autoPostPage();
    const field = within(holdRow(root, "size")).getByRole("spinbutton", { name: "Largest PR for comments, in lines" });
    fireEvent.change(field, { target: { value: "5" } });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(within(holdRow(root, "size")).getByRole("alert").textContent).toBe("10 to 100,000 lines");
    expect(text(root, "[data-changes]")).toBe("Your settings");
  });

  it("judges approvals on the Approvals tab, with the checks rule and the severity an approval may carry", async () => {
    const { slot, root } = await autoPostPage();
    fireEvent.click(within(slot.getByRole("radiogroup", { name: "Show" })).getByRole("radio", { name: "Approvals" }));
    expect(text(root, "[data-hero]")).toContain("1of 6 drafts would be approved");
    expect(text(root, "[data-hero-facts]")).toBe("1 you approved too0 undecided1 agree · 0 against on the record");
    expect(root.querySelector("[data-proof-ring] svg")!.getAttribute("aria-label")).toBe("Proven at least 21% of a 98% target: ~188 more to go");
    expect(groupRows(root, "post")).toEqual(["5"]);
    expect(groupRows(root, "settings")).toEqual(["4"]);
    expect(groupCount(root, "other")).toBe("4");
    expect(root.querySelector("[data-verifier]")).toBeNull();
    expect(text(root, "[data-draft='4']")).toContain("No checks reported");
    expect(text(root, "[data-draft='5']")).not.toContain("blocking check not run yet");

    const rows = [...root.querySelectorAll("[data-hold-row]")].map((row) => [row.getAttribute("data-hold-row"), text(row, "[data-hold-count]"), text(row, "[data-hold-gain]")]);
    expect(rows).toEqual([["concern:other", "2", null], ["concern:unverified", "1", null], ["concern:scope", "1", null], ["size", "1", null], ["checks", "2", "+1"], ["severity-above", "3", null]]);
    expect(within(holdRow(root, "concern:unverified")).getByRole("switch", { name: "Hold approvals for: Couldn't verify" }).getAttribute("aria-checked")).toBe("true");
    expect([...root.querySelectorAll("[data-fixed-holds] [data-pill]")].map((chip) => chip.textContent)).toEqual(["Suggested commenting 3", "Not low risk 1", "Asked for changes 1", "No risk rating 1", "Checks failed 1"]);

    fireEvent.click(within(slot.getByRole("radiogroup", { name: "Checks an approval needs" })).getByRole("radio", { name: "none failed" }));
    expect(text(root, "[data-hero-count]")).toBe("2");
    expect(text(root, "[data-hero-delta]")).toBe("+1");
    expect(groupRows(root, "post")).toEqual(["4", "5"]);
    expect(text(root, "[data-draft='4']")).toContain("blocking check not run yet");
    expect(holdRow(root, "checks").getAttribute("data-on")).toBe("false");
    expect(text(root, "[data-changes]")).toBe("Trying 1 changeResetSave");

    fireEvent.change(slot.getByRole("combobox", { name: "Highest finding severity an approval may carry" }), { target: { value: "medium" } });
    expect(text(root, "[data-changes]")).toBe("Trying 2 changesResetSave");
    expect(text(holdRow(root, "severity-above"), "[data-hold-count]")).toBe("0");
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved(slot)).toHaveLength(1));
    expect(saved(slot)[0]).toEqual({ checks: "not_failed", apprSeverity: "medium" });

    fireEvent.click(within(slot.getByRole("radiogroup", { name: "Show" })).getByRole("radio", { name: "Comments" }));
    expect(text(root, "[data-hero]")).toContain("1of 6 drafts would post");
  });

  it("keeps a change made while Save is on its way, and sends only what changed", async () => {
    let finish!: () => void;
    const { slot, root } = await autoPostPage({
      saveAutoPostSettings: ({ changes }) => new Promise((resolve) => { finish = () => resolve({ config: { ...withRepos(), autoPost: withReplaySettings(withRepos().autoPost, { ...replaySettingsOf(withRepos().autoPost), ...changes }) } }); }),
    });
    fireEvent.change(slot.getByRole("slider", { name: "Sure it's right, at least" }), { target: { value: "0.5" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved(slot)).toEqual([{ holds: 0.5 }]));
    fireEvent.change(slot.getByRole("slider", { name: "Worth posting, at least" }), { target: { value: "0.4" } });
    finish();
    await waitFor(() => expect(text(root, "[data-changes]")).toBe("Trying 1 changeResetSave"));
    expect(root.querySelector("[data-verifier]")!.textContent).toContain("Worth posting, at least 0.40");
    // Trying a setting back to its saved value is no change.
    fireEvent.change(slot.getByRole("slider", { name: "Worth posting, at least" }), { target: { value: "0.7" } });
    expect(text(root, "[data-changes]")).toBe("Your settings");
  });

  it("narrows to one repository and reads another range", async () => {
    const { slot, root } = await autoPostPage();
    const select = slot.getByRole("combobox", { name: "Repository" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["All repositories", "acme/*", "beta/docs"]);
    fireEvent.change(select, { target: { value: "beta/docs" } });
    expect(text(root, "[data-hero]")).toContain("0of 1 draft would post");
    expect([...root.querySelectorAll("[data-auto-post-repo]")].map((row) => row.getAttribute("data-auto-post-repo"))).toEqual(["beta/docs"]);
    fireEvent.change(select, { target: { value: "acme/*" } });
    expect(text(root, "[data-hero]")).toContain("1of 5 drafts would post");
    expect(root.querySelector("[data-exact-note]")).toBeNull();

    fireEvent.click(within(slot.getByRole("radiogroup", { name: "Range" })).getByRole("radio", { name: "7d" }));
    await waitFor(() => expect(callsTo(slot, "autoPostReplay")).toContainEqual({ range: "7d" }));
    await waitFor(() => expect(callsTo(slot, "autoPostInsights")).toContainEqual({ range: "7d" }));
  });

  it("lists what is waiting to post, each repository's modes and what Shuttle posted, and resumes a stopped kind", async () => {
    const record = autoPostInsights({
      repos: [shadowRepo({
        repo: "acme/*", mode: "countdown", approveMode: "auto", drafts: 4,
        posted: { reviews: 3, approvals: 1, findings: 5, marked: 1, mistakes: 1 },
        trips: [{ kind: "approve", reason: "you marked 2 approvals as mistakes", at: Date.now() - 2 * HOUR }],
      }), shadowRepo({ repo: "beta/docs" })],
      scheduled: [
        { draftId: 11, key: "github:acme/app#1", display: "acme/app#1", title: "Retry WAF deletes", at: Date.now() + 12 * 60_000, verdict: "comment", findings: 2 },
        { draftId: 12, key: "github:acme/app#9", display: "app#9", title: "Bump locales", at: Date.now() + 90 * 60_000, verdict: "approve", findings: 0 },
      ],
    });
    const { slot, root } = await autoPostPage({ autoPostInsights: ({ range }) => ({ ...record, range }), resumeAutoPost: () => ({ cleared: 1 }) });
    const scheduled = await find(slot.container, "[data-scheduled-posts]");
    const rows = [...scheduled.querySelectorAll<HTMLElement>("[data-scheduled-post]")];
    expect(rows.map((row) => row.getAttribute("data-scheduled-post"))).toEqual(["11", "12"]);
    expect(rows[0]!.textContent).toContain("Retry WAF deletes");
    expect(rows[0]!.textContent).toContain("2 comments");
    expect(rows[0]!.textContent).toContain("12m");
    expect(rows[1]!.textContent).toContain("Approval");
    expect(rows[1]!.textContent).toContain("2h");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "acme/app#1" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "pr", key: "github:acme/app#1" }) } });

    const card = root.querySelector<HTMLElement>("[data-auto-post-repo='acme/*']")!;
    expect([...card.querySelectorAll("[data-pill]")].slice(0, 2).map((pill) => pill.textContent)).toEqual(["Comments: Countdown", "Approvals: Auto"]);
    expect(card.querySelector("[data-posted]")!.textContent).toBe("Posted by Shuttle: 3 reviews (1 approval), 5 comments, 2 marked as mistakes");
    const trip = card.querySelector<HTMLElement>("[data-auto-post-trip='approve']")!;
    expect(trip.textContent).toContain("Posting approvals stopped: you marked 2 approvals as mistakes");
    fireEvent.click(within(trip).getByRole("button", { name: "Resume posting approvals in acme/*" }));
    await waitFor(() => expect(callsTo(slot, "resumeAutoPost")).toEqual([{ repo: "acme/*", kind: "approve" }]));

    const quiet = root.querySelector<HTMLElement>("[data-auto-post-repo='beta/docs']")!;
    expect([...quiet.querySelectorAll("[data-pill]")].slice(0, 2).map((pill) => pill.textContent)).toEqual(["Comments: Shadow", "Approvals: Shadow"]);
    expect(quiet.querySelector("[data-posted]")!.textContent).toBe("Posted by Shuttle: 0 reviews (0 approvals), 0 comments, 0 marked as mistakes");
    expect(quiet.querySelector("[data-auto-post-trip]")).toBeNull();
  });

  it("shows no waiting list when nothing is scheduled, and says so when no draft was checked", async () => {
    const { root } = await autoPostPage({}, []);
    expect(root.querySelector("[data-scheduled-posts]")).toBeNull();
    expect(text(root, "[data-hero]")).toContain("0of 0 drafts would post");
    expect(root.textContent).toContain("No drafts were checked in this range.");
    expect(root.querySelector("[data-proof-ring] [data-proof-status]")!.textContent).toBe("nothing decided yet");
  });

  it("says how to turn auto post on when no repository is configured", async () => {
    const { slot } = await page("insights/autopost", { getConfig: () => ({ config: config() }) });
    const empty = await find(slot.container, "[data-auto-post-empty]");
    expect(empty.textContent).toContain("Auto post is off");
    expect(empty.textContent).toContain("Settings › Automations › Auto post");
    expect(slot.container.querySelector("[data-hero]")).toBeNull();
  });
});
