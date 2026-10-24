import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PrView } from "../../src/contract";
import { formatRoute } from "../../src/ui/route";
import { callsTo, event, find, inbox, lastNavigation, mine, next, page, pr, unmountAll, type Handlers } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

const ready = mine({
  repo: "Shopify/infra-central", number: 29281, title: "Fail a Cloudflare run once on a rejected token",
  review: "approved", reviewers: [{ login: "pascal", team: false, state: "approved" }],
  next: next({
    kind: "ready_to_merge", tone: "ok", label: "Ready to merge", why: "Approved by pascal, and all 12 checks pass.",
    clears: "Leaves when it merges, or when you snooze it.", inbox: true, primary: { id: "merge", label: "Merge…" }, more: [],
  }),
});
const nobody = mine({
  repo: "Shopify/terraform-the-cloud", number: 76810, title: "HIPAA-2: Keep the HIPAA test shop out of routing", checks: "failed",
  suggestedAgent: { threadId: "thr_hipaa", title: "HIPAA-2: keep the test shop out of routing", why: "Opened this PR: its id is in the branch name" },
  next: next({
    kind: "nobody", tone: "bad", label: "Checks fail, and nobody is on it", why: "terraform plan (production) failing. It has no agent, so nothing has been sent anywhere.",
    clears: "Leaves when an agent takes it or you say you'll do it. New feedback brings it back.", inbox: true,
    primary: { id: "assign_suggested", label: "Hand it to its thread" }, more: [{ id: "handle", label: "I'll do it" }],
  }),
});
const request = pr({
  repo: "shop/world", server: "delta", serverName: "Delta", number: 2311622, title: "Run contract-test Envoys natively", author: "elvin",
  next: next({ kind: "new_request", tone: "info", label: "New review request", why: "elvin asked you 5h ago · M change, 6 files.", clears: "Leaves when you start a review.", inbox: true, primary: { id: "review", label: "Start AI review" }, more: [{ id: "not_now", label: "Not now" }] }),
});
const quiet = mine({ number: 1, title: "Not a decision", next: next({ inbox: false }) });

function inboxPage(rpc: Partial<Handlers> = {}, prs: PrView[] = [ready, nobody, request, quiet]) {
  return page("", {
    inbox: () => inbox({
      prs,
      agents: { open: 10, withAgent: 6, working: 1, waiting: 1, none: 4 },
      olderRequests: 31,
      handled: [event({ id: 3, kind: "outcome", text: "The agent fixed rubocop on infra-central#29281 and pushed 7c41d2e.", key: ready.key, at: Date.now() - 3 * 60 * 60_000 })],
    }),
    detail: ({ key }) => ({ pr: prs.find((item) => item.key === key)!, events: [], body: "", draft: null }),
    ...rpc,
  }, { settings: { inboxRequestDays: 3 } });
}

const card = (slot: Awaited<ReturnType<typeof inboxPage>>["slot"], key: string) => find(slot.container, `[data-card="${key}"]`);

describe("the Inbox", () => {
  it("shows a card per decision in the server's order and words, with when it leaves", async () => {
    const { slot } = await inboxPage();
    const first = await card(slot, ready.key);
    expect([...slot.container.querySelectorAll("[data-card]")].map((node) => node.getAttribute("data-card"))).toEqual([ready.key, nobody.key, request.key]);
    expect(first.textContent).toContain("Your PR · Ready to merge");
    expect(first.textContent).toContain("Approved by pascal, and all 12 checks pass.");
    expect(first.textContent).toContain("Leaves when it merges, or when you snooze it.");
    expect(first.textContent).toContain("infra-central#29281 · GitHub");
    expect(within(first).getByRole("button", { name: "Merge…" })).toBeTruthy();
    const review = await card(slot, request.key);
    expect(review.textContent).toContain("Review · New review request");
    expect(review.textContent).toContain("· elvin");
    expect(within(review).getAllByRole("button").map((button) => button.textContent)).toEqual(["Snooze", request.title, "Start AI review", "Not now"]);
    // Snooze sits in the card's top row, beside its kind, so it never wraps under the actions.
    expect(within(review).getByRole("button", { name: "Snooze" }).parentElement!.textContent).toContain("Review · New review request");
  });

  it("sums up the agents, the older requests and what automation handled", async () => {
    const { slot } = await inboxPage();
    const agents = await find(slot.container, "[data-agents]");
    expect(agents.textContent).toContain("Agents are on 6 of your 10 open PRs: 1 fixing, 1 waiting on you, 4 idle.");
    fireEvent.click(within(agents).getByRole("button", { name: "4 have none" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "mine" } });

    const older = slot.container.querySelector<HTMLElement>("[data-older]")!;
    expect(older.textContent).toContain("31 requests by name have waited more than 3 days.");
    fireEvent.click(within(older).getByRole("button", { name: "Triage them in Reviews" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviews~asked" } });

    const handled = slot.getByRole("region", { name: "Handled for you" });
    expect(handled.textContent).toContain("The agent fixed rubocop on infra-central#29281 and pushed 7c41d2e.");
    expect(handled.querySelector("[data-icon='GitCommit']")).not.toBeNull();
    fireEvent.click(within(handled).getByRole("button", { name: "Show" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "inbox", key: ready.key }) } });
  });

  it("says all clear when nothing waits", async () => {
    const { slot } = await page("", { inbox: () => inbox() });
    expect((await find(slot.container, "[data-all-clear]")).textContent).toContain("Nothing waits on you.");
    expect(slot.container.querySelector("[data-older]")).toBeNull();
    expect(slot.container.querySelector("[data-agents]")).toBeNull();
  });

  it("opens the merge dialog from Merge…, without opening the PR too", async () => {
    const { slot } = await inboxPage();
    fireEvent.click(within(await card(slot, ready.key)).getByRole("button", { name: "Merge…" }));
    const dialog = await slot.findByRole("dialog", { name: "Merge infra-central#29281" });
    await waitFor(() => expect(callsTo(slot, "mergeOptions")).toEqual([{ key: ready.key }]));
    expect(within(dialog).getByRole("button", { name: "Merge" })).toBeTruthy();
    expect(lastNavigation(slot)).toBeUndefined();
  });

  it("opens the PR from a click anywhere on its card, and the older requests from theirs", async () => {
    const { slot } = await inboxPage();
    const first = await card(slot, nobody.key);
    fireEvent.click(first.querySelector<HTMLElement>("[data-card] > div:nth-of-type(3)") ?? first);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "inbox", key: nobody.key }) } });
    fireEvent.click(slot.container.querySelector<HTMLElement>("[data-older]")!);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviews~asked" } });
    const handled = slot.getByRole("region", { name: "Handled for you" });
    fireEvent.click(handled.querySelector<HTMLElement>("[data-event]")!);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "inbox", key: ready.key }) } });
  });

  it("hands a PR to the thread that opened it, with Undo back to no agent", async () => {
    const { slot } = await inboxPage({
      setAgent: ({ target }) => ({ pr: { ...nobody, agent: target.kind === "existing" ? { threadId: target.threadId, title: "HIPAA-2: keep the test shop out of routing", mode: "fix", status: "working", auto: false, lastSent: null } : null }, threadId: target.kind === "existing" ? target.threadId : null }),
    });
    fireEvent.click(within(await card(slot, nobody.key)).getByRole("button", { name: "Hand it to its thread" }));
    await waitFor(() => expect(callsTo(slot, "setAgent")).toEqual([{ key: nobody.key, target: { kind: "existing", threadId: "thr_hipaa" } }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    const [message, options] = toasts.success.mock.calls[0]!;
    expect(message).toBe("“HIPAA-2: keep the test shop out of routing” is the agent of terraform-the-cloud#76810.");
    expect(options).toMatchObject({ duration: 5000, action: { label: "Undo" } });
    options.action.onClick();
    await waitFor(() => expect(callsTo(slot, "setAgent")[1]).toEqual({ key: nobody.key, target: { kind: "none" } }));
    await waitFor(() => expect(toasts.success).toHaveBeenLastCalledWith("terraform-the-cloud#76810 has no agent."));
  });

  it("snoozes a card at once, and Undo brings it back", async () => {
    let release: () => void = () => {};
    const { slot } = await inboxPage({
      snooze: ({ until }) => new Promise((resolve) => {
        release = () => resolve({ pr: { ...request, snoozedUntil: until === null ? null : Date.now() + 60_000 } });
      }),
    });
    fireEvent.click(within(await card(slot, request.key)).getByRole("button", { name: "Snooze" }));
    await waitFor(() => expect(callsTo(slot, "snooze")).toEqual([{ key: request.key, until: "tomorrow" }]));
    await waitFor(() => expect(slot.container.querySelector(`[data-card="${request.key}"]`)).toBeNull());
    release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    const [message, options] = toasts.success.mock.calls[0]!;
    expect(message).toBe("Snoozed world#2311622 until tomorrow 9:00, or until something new happens.");
    options.action.onClick();
    await waitFor(() => expect(callsTo(slot, "snooze")).toEqual([{ key: request.key, until: "tomorrow" }, { key: request.key, until: null }]));
    release();
    await waitFor(() => expect(toasts.success).toHaveBeenLastCalledWith("world#2311622 is back in your Inbox."));
  });

  it("takes feedback with I'll do it, and Undo hands it back", async () => {
    const { slot } = await inboxPage({ handle: ({ on }) => ({ pr: { ...nobody, handled: on } }) });
    fireEvent.click(within(await card(slot, nobody.key)).getByRole("button", { name: "I'll do it" }));
    await waitFor(() => expect(callsTo(slot, "handle")).toEqual([{ key: nobody.key, on: true }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    const [message, options] = toasts.success.mock.calls[0]!;
    expect(message).toBe("terraform-the-cloud#76810 is yours. It leaves the Inbox until new feedback arrives.");
    options.action.onClick();
    await waitFor(() => expect(callsTo(slot, "handle")).toEqual([{ key: nobody.key, on: true }, { key: nobody.key, on: false }]));
    await waitFor(() => expect(toasts.success).toHaveBeenLastCalledWith("terraform-the-cloud#76810 is back in your Inbox."));
  });

  it("puts a refused snooze back and shows the server's message", async () => {
    const { slot } = await inboxPage({ snooze: () => { throw Object.assign(new Error("no pull request github:get-bb/bb#9"), { code: "not_found" }); } });
    fireEvent.click(within(await card(slot, request.key)).getByRole("button", { name: "Snooze" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("no pull request github:get-bb/bb#9"));
    expect(slot.container.querySelector(`[data-card="${request.key}"]`)).not.toBeNull();
  });

  it("starts a review from a card with the preset picked in its dialog", async () => {
    const { slot } = await inboxPage({ review: () => ({ threadId: "thr_review" }) });
    fireEvent.click(within(await card(slot, request.key)).getByRole("button", { name: "Start AI review" }));
    const dialog = await slot.findByRole("dialog", { name: "Start an AI review of world#2311622" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Quick skim/u }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(callsTo(slot, "review")).toEqual([{ key: request.key, presetId: "quick" }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
