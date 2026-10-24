import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { PrView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { callsTo, DAY, find, HOUR, lastNavigation, next, page, pr, unmountAll } from "./helpers";

afterEach(unmountAll);

const team = (teams: string[]) => ({ reasons: [{ reason: "team" as const, teams }], teams });
const post = pr({ number: 1, title: "Run contract-test Envoys natively", draft: { id: 3, findings: 4, at: Date.now() }, next: next({ kind: "post", tone: "info", label: "AI review ready: choose what to post", primary: { id: "choose", label: "Choose what to post" } }) });
const updated = pr({ number: 2, title: "Run Envoy Sorting Hat in the harness", ...team(["edge-infrastructure"]), tracked: true, myReview: { verdict: "changes", at: Date.now() - 2 * DAY, head: "abc" }, next: next({ kind: "rereview", tone: "warn", label: "Updated after your review", primary: { id: "review", label: "Re-review…" } }) });
const running = pr({ number: 3, title: "Native app routes", ...team(["edge-infrastructure", "core-applications"]), checks: "pending", checkCounts: { passed: 9, failed: 0, pending: 5, total: 14 }, lastReview: { threadId: "thr_r", title: "Review #3", state: "running", preset: "Security pass", trigger: "manual", head: null, at: Date.now() }, next: next({ kind: "running", label: "AI review running" }) });
const oldest = pr({ number: 4, title: "Remove log-only rate limits", requestedAt: Date.now() - 4 * DAY, additions: 12, deletions: 88, next: next({ kind: "not_reviewed", label: "Not reviewed · asked 4d ago", primary: { id: "review", label: "Start AI review" } }) });
const newest = pr({ number: 5, title: "Add administrators to the Playground account", requestedAt: Date.now() - 2 * HOUR, additions: 24, deletions: 0, checks: "failed", next: next({ kind: "new_request", tone: "info", label: "New review request", inbox: true, primary: { id: "review", label: "Start AI review" } }) });
const mentioned = pr({ number: 6, title: "Add global auth upstream keepalive", reasons: [{ reason: "mentioned", teams: [] }, { reason: "team", teams: ["edge-infrastructure"] }], teams: ["edge-infrastructure"], requestedAt: null, next: next({ kind: "not_reviewed", label: "Not reviewed" }) });
const approved = pr({ number: 7, title: "Remove Sorting Hat Lua", ...team(["edge-infrastructure"]), myReview: { verdict: "approve", at: Date.now() - DAY, head: "abc" }, next: next({ kind: "reviewed", tone: "ok", label: "You approved · 1d" }) });
const bot = pr({ number: 8, title: "Bump the minor_versions group", author: "dependabot", bot: true, next: next({ kind: "new_request", label: "New review request" }) });
const quiet = pr({ number: 9, title: "Clean up routing rules", ...team(["platform-protection"]), quiet: true, next: next({ kind: "not_reviewed", label: "Not reviewed" }) });
const quietBot = pr({ number: 10, title: "Old actuator clean-up", author: "terraform-actuator", bot: true, quiet: true, next: next({ kind: "not_reviewed", label: "Not reviewed" }) });
const everything = [post, updated, running, oldest, newest, mentioned, approved, bot, quiet, quietBot];

function reviewsPage(subPath = "reviews", prs: PrView[] = everything) {
  return page(subPath, {
    list: ({ area }) => ({ prs: area === "reviews" ? prs : [] }),
    detail: ({ key }) => ({ pr: prs.find((item) => item.key === key)!, events: [], body: "", draft: null }),
  });
}

const keysIn = (root: ParentNode, title: string) => [...(root.querySelector(`[data-group="${title}"]`)?.querySelectorAll("[data-pr]") ?? [])].map((node) => node.getAttribute("data-pr"));
const chip = (root: HTMLElement, name: RegExp) => within(within(root).getByRole("group", { name: "Source" })).getByRole("button", { name });

describe("Reviews", () => {
  it("groups one list by where your review stands, oldest request first, hiding bots and quiet PRs", async () => {
    const { slot } = await reviewsPage();
    await find(slot.container, "[data-group]");
    expect(callsTo(slot, "list")).toEqual([{ area: "reviews" }]);
    expect([...slot.container.querySelectorAll("[data-group]")].map((node) => node.getAttribute("data-group"))).toEqual([
      "Ready to post", "Updated since your review", "AI review running", "Not reviewed yet", "Reviewed, waiting on the author",
    ]);
    expect(keysIn(slot.container, "Ready to post")).toEqual([post.key]);
    expect(keysIn(slot.container, "Not reviewed yet")).toEqual([oldest.key, newest.key, mentioned.key]);
    expect(slot.container.querySelector(`[data-pr="${bot.key}"]`)).toBeNull();
    expect(slot.container.querySelector(`[data-pr="${quiet.key}"]`)).toBeNull();
  });

  it("shows each row's size, request age, your review, why it is here and failing checks", async () => {
    const { slot } = await reviewsPage();
    const row = (key: string) => slot.container.querySelector<HTMLElement>(`[data-pr="${key}"]`)!;
    await find(slot.container, `[data-pr="${oldest.key}"]`);
    expect(row(oldest.key).querySelector("[data-size]")!.textContent).toBe("M");
    expect(row(newest.key).querySelector("[data-size]")!.textContent).toBe("S");
    expect(row(oldest.key).textContent).toContain("asked 4d");
    expect(row(oldest.key).querySelector(".text-warning-text")!.textContent).toContain("asked 4d");
    expect(row(newest.key).querySelector(".text-warning-text")).toBeNull();
    expect(row(newest.key).textContent).toContain("Checks fail");
    expect(row(newest.key).textContent).toContain("You");
    expect(row(post.key).textContent).toContain("Draft ready");
    expect(row(updated.key).textContent).toContain("Updated since");
    expect(row(updated.key).textContent).toContain("Tracked");
    expect(row(running.key).textContent).toContain("AI reviewing");
    expect(row(running.key).textContent).toContain("edge-infrastructure +1");
    expect(row(running.key).textContent).toContain("Checks 9/14");
    expect(row(approved.key).textContent).toContain("You approved");
    expect(row(mentioned.key).textContent).toContain("Mentioned");
    expect(within(row(post.key)).getByRole("button", { name: "Choose what to post" })).toBeTruthy();
  });

  it("counts each source from the list and switches between them", async () => {
    const { slot } = await reviewsPage();
    await find(slot.container, "[data-group]");
    const source = within(slot.container).getByRole("group", { name: "Source" });
    expect(within(source).getAllByRole("button").map((button) => button.textContent)).toEqual(["Everything10", "Asked me5", "My teams5", "Mentioned1", "Tracked1"]);
    fireEvent.click(chip(slot.container, /Asked me/u));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviews~asked" } });
  });

  it("filters My teams by a team picked from the PRs' teams", async () => {
    const { slot } = await reviewsPage("reviews~team");
    await find(slot.container, "[data-group]");
    const select = within(slot.container).getByRole("combobox", { name: "Team" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "All my teams · 5", "edge-infrastructure · 4", "core-applications · 1", "platform-protection · 1",
    ]);
    expect(chip(slot.container, /My teams/u).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(select, { target: { value: "core-applications" } });
    await waitFor(() => expect([...slot.container.querySelectorAll("[data-pr]")].map((node) => node.getAttribute("data-pr"))).toEqual([running.key]));
  });

  it("says how many Hide bots and Hide quiet hide, and shows them when turned off", async () => {
    const { slot } = await reviewsPage();
    await find(slot.container, "[data-group]");
    const bots = within(slot.container).getByRole("checkbox", { name: /Hide bots/u }) as HTMLInputElement;
    const quietBox = within(slot.container).getByRole("checkbox", { name: /Hide quiet for 30\+ days/u }) as HTMLInputElement;
    expect(bots.checked).toBe(true);
    expect(quietBox.checked).toBe(true);
    expect(bots.closest("label")!.querySelector("[data-hidden-count]")!.textContent).toBe("2");
    expect(quietBox.closest("label")!.querySelector("[data-hidden-count]")!.textContent).toBe("1");
    fireEvent.click(bots);
    await waitFor(() => expect(slot.container.querySelector(`[data-pr="${bot.key}"]`)).not.toBeNull());
    expect(slot.container.querySelector(`[data-pr="${quietBot.key}"]`)).toBeNull();
    fireEvent.click(quietBox);
    await waitFor(() => expect(slot.container.querySelector(`[data-pr="${quietBot.key}"]`)).not.toBeNull());
    expect(slot.container.querySelector(`[data-pr="${quiet.key}"]`)).not.toBeNull();
  });

  it("says how to track a PR when nothing is tracked", async () => {
    const { slot } = await reviewsPage("reviews~tracked", [oldest]);
    await waitFor(() => expect(slot.container.textContent).toContain("Nothing tracked. Paste any PR link in the look-up field, then press Track."));
  });

  it("selects a PR in the source it was opened from", async () => {
    const { slot } = await reviewsPage("reviews~asked");
    fireEvent.click(await find(slot.container, `[data-pr="${oldest.key}"]`));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "reviews", source: "asked", key: oldest.key }) } });
  });
});
