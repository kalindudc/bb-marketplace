import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import type { InboxRule, PrView } from "../../src/contract";
import { snoozeChoices } from "../../src/ui/inbox";
import { atNine } from "../../src/ui/format";
import { formatRoute, parseRoute } from "../../src/ui/route";
import { agent, callsTo, find, HOUR, inbox, lastNavigation, mine, next, NOW, page, pr, setViewport, unmountAll, type Handlers } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

const waiting = mine({
  repo: "Shopify/infrastructure", number: 85915, title: "Route bb plugin traffic through the shared egress proxy", unseen: true, updatedAt: NOW - 25 * 60_000,
  agent: agent({ title: "Fix egress proxy review", status: "waiting" }),
  next: next({ kind: "agent_waiting", tone: "warn", label: "The agent needs your answer", why: "“Fix egress proxy review” asked you something in its thread.", inbox: true, clears: "Leaves when you answer in the thread.", primary: { id: "open_agent", label: "Answer in the thread" } }),
});
const nobody = mine({
  repo: "kalindudc/bb-marketplace", number: 94, title: "Loom: retry queued checks after a forge timeout", checks: "failed", checkCounts: { passed: 12, failed: 2, pending: 0, total: 14 },
  review: "changes", reviewers: [{ login: "priya-s", team: false, state: "changes" }], updatedAt: NOW - 2 * HOUR,
  next: next({ kind: "nobody", tone: "bad", label: "Changes requested, and nobody is on it", why: "Changes requested by priya-s and 2 checks failing.", inbox: true, clears: "Leaves when an agent takes it.", primary: { id: "pick_agent", label: "Hand it to an agent" }, more: [{ id: "handle", label: "I'll do it" }] }),
});
const ready = mine({
  repo: "shop/world", server: "delta", serverName: "Delta", number: 2311622, title: "Storefront: cache the shop locale per request", unseen: true, updatedAt: NOW - HOUR,
  review: "approved", reviewers: [{ login: "dmorgan", team: false, state: "approved" }, { login: "ana-r", team: false, state: "approved" }],
  next: next({ kind: "ready_to_merge", tone: "ok", label: "Ready to merge", why: "Approved by dmorgan and ana-r, and all 41 checks pass.", inbox: true, clears: "Leaves when it merges.", primary: { id: "merge", label: "Merge…" } }),
});
const post = pr({
  repo: "Shopify/cli", number: 5120, title: "Theme check: stop flagging liquid-doc params", author: "rmartin", additions: 77, deletions: 19, files: 5, updatedAt: NOW - 40 * 60_000,
  draft: { id: 3, findings: 4, at: NOW - HOUR },
  next: next({ kind: "post", tone: "info", label: "AI review ready: choose what to post", why: "4 findings. Nothing is posted yet.", inbox: true, clears: "Leaves when you post it.", primary: { id: "choose", label: "Choose what to post" } }),
});
const rereview = pr({
  repo: "shop/world", server: "delta", serverName: "Delta", number: 2305510, title: "Admin: keyboard navigation in the bulk editor", author: "lpham", additions: 230, deletions: 88, updatedAt: NOW - 30 * 60_000,
  myReview: { verdict: "changes", at: NOW - 2 * 24 * HOUR, head: "aaa" },
  next: next({ kind: "rereview", tone: "warn", label: "Updated after your review", why: "lpham asked you again.", inbox: true, clears: "Leaves when you review again.", primary: { id: "review", label: "Re-review…" } }),
});
const request = pr({
  repo: "shop/world", server: "delta", serverName: "Delta", number: 2312065, title: "Routing: Lua contract spec and oracle", author: "elvin", checks: "pending", checkCounts: { passed: 8, failed: 0, pending: 4, total: 12 }, updatedAt: NOW - 2 * HOUR,
  next: next({ kind: "new_request", tone: "info", label: "New review request", why: "elvin asked you 2h ago.", inbox: true, clears: "Leaves when you start a review or say Not now.", primary: { id: "review", label: "Start AI review" }, more: [{ id: "not_now", label: "Not now" }] }),
});
const mention = pr({
  repo: "Shopify/infrastructure", number: 86110, title: "Egress: document the proxy allowlist", author: "tlee", reasons: [{ reason: "mentioned", teams: [] }], additions: 45, deletions: 3, updatedAt: NOW - 24 * HOUR,
  next: next({ kind: "new_request", tone: "info", label: "Mentioned you", why: "tlee mentioned you 1 day ago.", inbox: true, clears: "Leaves when you start a review.", primary: { id: "review", label: "Start AI review" }, more: [{ id: "not_now", label: "Not now" }] }),
});
const ALL = [waiting, nobody, ready, post, rereview, request, mention];

const snoozedLater = pr({ number: 77, title: "Inventory: move reservations to the new queue", author: "cdiaz", snoozed: true, snoozedUntil: NOW + 20 * HOUR, next: next({ kind: "new_request", inbox: false, clears: "Leaves when you start a review." }) });
const snoozedChange = pr({ number: 78, title: "hydrogen: drop the Node 18 shim", author: "bkim", snoozed: true, snoozedUntil: null, next: next({ kind: "rereview", inbox: false, clears: "Leaves when you review again." }) });
const dismissedNew = pr({ number: 90, title: "Docs: typo sweep across the admin guides", author: "hfox", dismissed: { at: NOW - 24 * HOUR, activity: true }, next: next({ kind: "new_request", inbox: false }) });
const dismissedQuiet = mine({ number: 88, title: "Lineup: try badges on tabs", dismissed: { at: NOW - 3 * 24 * HOUR, activity: false }, next: next({ kind: "ready_to_merge", inbox: false }) });
const rule: InboxRule = { id: 4, kind: "repo", server: "github", serverName: "GitHub", value: "Shopify/polaris", createdAt: NOW - 5 * 24 * HOUR, keeps: ["github:Shopify/polaris#1201", "github:Shopify/polaris#1188"] };
const mentionRule: InboxRule = { id: 5, kind: "mention", server: "github", serverName: "GitHub", value: "Shopify/web", createdAt: NOW - 14 * 24 * HOUR, keeps: [] };

/** A server that applies snoozes, dismissals and seen marks, so reads after a write agree with what the page predicted. */
function inboxPage(rpc: Partial<Handlers> = {}, prs: PrView[] = ALL, subPath = "inbox", extra: Partial<ReturnType<typeof inbox>> = {}) {
  let views = [...prs, ...(extra.snoozed ?? []), ...(extra.dismissed ?? [])];
  const patch = (keys: readonly string[], change: (view: PrView) => PrView) => {
    views = views.map((view) => (keys.includes(view.key) ? change(view) : view));
    return views.filter((view) => keys.includes(view.key));
  };
  return page(subPath, {
    inbox: () => inbox({
      olderRequests: 31, handled: 3, ...extra,
      prs: views.filter((view) => view.dismissed === null && !view.snoozed),
      snoozed: views.filter((view) => view.dismissed === null && view.snoozed),
      dismissed: views.filter((view) => view.dismissed !== null),
    }),
    detail: ({ key }) => ({ pr: views.find((item) => item.key === key)!, events: [], body: "", draft: null }),
    dismiss: ({ keys, on }) => ({ prs: patch(keys, (view) => ({ ...view, dismissed: on ? { at: NOW, activity: false } : null, next: { ...view.next, inbox: !on && view.next.clears !== null } })) }),
    snooze: ({ keys, until }) => ({
      prs: patch(keys, (view) => ({ ...view, snoozed: until !== null, snoozedUntil: typeof until === "number" ? until : null, next: { ...view.next, inbox: until === null && view.next.clears !== null } })),
    }),
    markSeen: ({ keys }) => {
      patch(keys, (view) => ({ ...view, unseen: false }));
      return { ok: true };
    },
    ...rpc,
  }, { settings: { inboxRequestDays: 3 } });
}

type Slot = Awaited<ReturnType<typeof inboxPage>>["slot"];
const row = (slot: Slot, key: string) => find(slot.container, `[data-row="${key}"]`);
const rowKeys = (slot: Slot) => [...slot.container.querySelectorAll("[data-row]")].map((node) => node.getAttribute("data-row"));
const facts = (node: HTMLElement) => [...node.querySelectorAll("[data-fact]")].map((fact) => fact.textContent);
const openMenu = (button: HTMLElement) => fireEvent.keyDown(button, { key: "Enter" });
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key, ...init });
/** Focus as Tab does: after a key, so the browser counts the focus as visible, as it does not after a click. */
const tabTo = (node: HTMLElement) => {
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => node.focus());
};

describe("the Inbox", () => {
  it("has a title without a count, its three tabs and a ⋯ menu, and no description", async () => {
    const { slot } = await inboxPage({}, ALL, "inbox", { snoozed: [snoozedLater, snoozedChange], dismissed: [dismissedNew] });
    await row(slot, waiting.key);
    const heading = slot.container.querySelector("h2")!;
    expect(heading.textContent).toBe("Inbox");
    const tabs = within(slot.getByRole("radiogroup", { name: "Inbox tabs" })).getAllByRole("radio");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Inbox", "Snoozed 2", "Dismissed 1"]);
    expect(tabs[0]!.getAttribute("aria-checked")).toBe("true");
    expect(slot.container.textContent).not.toContain("Decisions waiting on you");
    expect(slot.getByRole("button", { name: "Inbox options" })).toBeTruthy();
  });

  it("groups PRs by what to do, each heading an icon, its title and count, with its description only as a tooltip", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    const sections = [...slot.container.querySelectorAll<HTMLElement>("[data-section]")];
    expect(sections.map((section) => section.getAttribute("data-section"))).toEqual(["kind:needs", "kind:merge", "kind:post", "kind:rereview", "kind:new"]);
    const needs = within(sections[0]!).getByRole("button", { name: /Needs you/u });
    expect(needs.textContent).toBe("Needs you2");
    expect(needs.getAttribute("title")).toBeNull();
    expect(sections[0]!.textContent).not.toContain("feedback nobody is handling");
    tabTo(needs);
    expect((await screen.findByRole("tooltip")).textContent).toBe("An agent waits on your answer, or feedback nobody is handling. Fold this section");
    expect(rowKeys(slot)).toEqual([waiting.key, nobody.key, ready.key, post.key, rereview.key, request.key, mention.key]);
  });

  it("folds a section from its heading and remembers it", async () => {
    const { slot } = await inboxPage();
    const heading = within(await find(slot.container, "[data-section='kind:needs']")).getByRole("button", { name: /Needs you/u });
    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(slot.container.querySelector(`[data-row="${waiting.key}"]`)).toBeNull();
    expect(window.localStorage.getItem("bb-plugin-shuttle:folds")).toContain("inbox/kind:needs");
  });

  it("says on each row only what its heading, avatar and time do not", async () => {
    const { slot } = await inboxPage();
    const own = await row(slot, waiting.key);
    expect(own.querySelector("[data-mine-mark]")).not.toBeNull();
    expect(own.querySelector("[data-avatar]")).toBeNull();
    expect(facts(own)).toEqual(["“Fix egress proxy review” asked you something"]);
    expect(own.textContent).toContain("infrastructure");
    expect(own.textContent).toContain("#85915");
    expect(own.querySelector("[data-age]")!.textContent).toBe("25m");
    expect(own.querySelector("[data-age]")!.getAttribute("title")).toMatch(/^Last activity /u);
    expect(own.querySelector("[data-repo]")!.getAttribute("title")).toBe("Shopify/infrastructure on GitHub");
    expect(own.querySelector("[data-unseen]")).not.toBeNull();
    expect(own.querySelector("[data-title]")!.textContent).toBe("New: Route bb plugin traffic through the shared egress proxy");
    expect(own.querySelector("[data-title] .sr-only")!.textContent).toBe("New: ");

    expect(facts(await row(slot, nobody.key))).toEqual(["Changes requested by priya-s", "2 checks fail", "No agent"]);
    expect(facts(await row(slot, ready.key))).toEqual(["dmorgan and ana-r approved"]);
    const theirs = await row(slot, post.key);
    expect(theirs.querySelector("[data-avatar]")).not.toBeNull();
    expect(facts(theirs)).toEqual(["rmartin", "4 findings", "M+77−19"]);
    expect(theirs.querySelector("[data-unseen]")).toBeNull();
    expect(theirs.querySelector("[data-title]")!.textContent).toBe(post.title);
    expect(facts(await row(slot, rereview.key))).toEqual(["lpham", "Asked again since you requested changes", "L+230−88"]);
    expect(facts(await row(slot, request.key))).toEqual(["elvin", "Checks 8/12", "M+86−12"]);
    expect(facts(await row(slot, mention.key))).toEqual(["tlee", "Mentioned you", "S+45−3"]);
    for (const key of rowKeys(slot)) {
      const node = slot.container.querySelector<HTMLElement>(`[data-row="${key}"]`)!;
      expect(node.textContent).not.toContain("Checks pass");
      expect(node.querySelector("[data-kind-chip]")).toBeNull();
    }
  });

  it("shows each row's next step, Snooze, Dismiss and ⋯ in its hover overlay", async () => {
    const { slot } = await inboxPage();
    const overlay = (await row(slot, request.key)).querySelector<HTMLElement>("[data-overlay]")!;
    expect(within(overlay).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Start AI review", "Snooze world#2312065", "Dismiss world#2312065 from the Inbox", "More for world#2312065"]);
  });

  it("says what each overlay button does in a tooltip, with its key", async () => {
    const { slot } = await inboxPage();
    const overlay = (await row(slot, request.key)).querySelector<HTMLElement>("[data-overlay]")!;
    const tip = async (name: string) => {
      tabTo(within(overlay).getByRole("button", { name }));
      const shown = await screen.findByRole("tooltip");
      const text = shown.textContent;
      act(() => (document.activeElement as HTMLElement).blur());
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
      return text;
    };
    expect(await tip("Start AI review")).toBe("Start an AI review with one of your presets");
    // A tooltip's text ends with its key.
    expect(await tip("Snooze world#2312065")).toBe("Snooze: hide it until a time you pickS");
    expect(await tip("Dismiss world#2312065 from the Inbox")).toBe("Dismiss: keep it out of the Inbox for goodE");
    expect(await tip("More for world#2312065")).toBe("More: snooze, dismiss, or keep PRs like this out");
  });

  it("shows no tooltip for focus that follows a click, as when a menu closed by a click hands focus back, but does after a key", async () => {
    const { slot } = await inboxPage();
    const more = within(await row(slot, request.key)).getByRole("button", { name: "More for world#2312065" });
    fireEvent.click(document.body);
    act(() => more.focus());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => more.blur());
    tabTo(more);
    expect((await screen.findByRole("tooltip")).textContent).toBe("More: snooze, dismiss, or keep PRs like this out");
  });

  it("drops a row tooltip's key while rows are selected, since S and E then act on the selection", async () => {
    const { slot } = await inboxPage();
    fireEvent.click(within(await row(slot, waiting.key)).getByRole("checkbox"));
    tabTo(within(await row(slot, request.key)).getByRole("button", { name: "Dismiss world#2312065 from the Inbox" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Dismiss: keep it out of the Inbox for good");
  });

  it("clears the selection with one Escape even while a tooltip is open", async () => {
    const { slot } = await inboxPage();
    fireEvent.click(within(await row(slot, waiting.key)).getByRole("checkbox"));
    const clear = within(await find(slot.container, "[data-selection-bar]")).getByRole("button", { name: /Clear/u });
    tabTo(clear);
    await screen.findByRole("tooltip");
    fireEvent.keyDown(clear, { key: "Escape" });
    await waitFor(() => expect(slot.container.querySelector("[data-selection-bar]")).toBeNull());
  });

  it("leads line 2 with a kind chip, and headings with repo chips, when grouped by repository", async () => {
    const { slot } = await inboxPage();
    openMenu(await find(slot.container, "[data-view-button]"));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Repository" }));
    await waitFor(() => expect(slot.container.querySelector("[data-section='repo:delta:shop/world']")).not.toBeNull());
    const sections = [...slot.container.querySelectorAll<HTMLElement>("[data-section]")].map((section) => section.getAttribute("data-section"));
    expect(sections).toEqual(["repo:github:kalindudc/bb-marketplace", "repo:delta:shop/world", "repo:github:Shopify/cli", "repo:github:Shopify/infrastructure"]);
    const requestRow = await row(slot, request.key);
    expect(requestRow.querySelector("[data-kind-chip]")!.textContent).toBe("New request");
    // The heading names the repo, so its rows do not.
    expect(slot.container.querySelector("[data-section='repo:delta:shop/world'] > div [data-repo]")).not.toBeNull();
    expect(requestRow.querySelector("[data-repo]")).toBeNull();
    expect(requestRow.textContent).toContain("#2312065");
    // The chip says what the fact would, so the fact goes.
    const mentionRow = await row(slot, mention.key);
    expect(mentionRow.querySelector("[data-kind-chip]")!.textContent).toBe("Mentioned you");
    expect(facts(mentionRow)).toEqual(["tlee", "S+45−3"]);
  });

  it("remembers the View choice on this device and shows it on its button", async () => {
    const first = await inboxPage();
    const button = await find(first.slot.container, "[data-view-button]");
    expect(button.textContent).toContain("By what to do · Priority");
    openMenu(button);
    expect((await screen.findByRole("menuitemradio", { name: "What to do" })).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Repository" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "No groups" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Oldest activity" }));
    await waitFor(() => expect(button.textContent).toContain("No groups · Oldest activity"));
    expect(rowKeys(first.slot)).toEqual([mention.key, nobody.key, request.key, ready.key, post.key, rereview.key, waiting.key]);
    first.slot.lifecycle.unmount();
    const second = await page("inbox", { inbox: () => inbox({ prs: ALL }) });
    expect((await find(second.slot.container, "[data-view-button]")).textContent).toContain("No groups · Oldest activity");
  });

  it("sorts smallest first within each section", async () => {
    const { slot } = await inboxPage();
    openMenu(await find(slot.container, "[data-view-button]"));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Smallest first" }));
    await waitFor(() => expect(rowKeys(slot).slice(-2)).toEqual([mention.key, request.key]));
  });

  it("searches titles, repos, authors and numbers, and says when nothing matches", async () => {
    const { slot } = await inboxPage();
    const search = await find(slot.container, "input[type='search']");
    fireEvent.change(search, { target: { value: "elvin" } });
    expect(rowKeys(slot)).toEqual([request.key]);
    fireEvent.change(search, { target: { value: "#94" } });
    expect(rowKeys(slot)).toEqual([nobody.key]);
    fireEvent.change(search, { target: { value: "world locale" } });
    expect(rowKeys(slot)).toEqual([ready.key]);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(slot.container.textContent).toContain("Nothing matches “zzz”.");
    fireEvent.click(slot.getByRole("button", { name: "Clear" }));
    expect(rowKeys(slot)).toHaveLength(ALL.length);
  });

  it("selects rows, a range with Shift, or every row shown, and turns the toolbar into the selection bar", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    fireEvent.click(slot.getByRole("checkbox", { name: "Select infrastructure#85915" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Select world#2311622" }), { shiftKey: true });
    const bar = await find(slot.container, "[data-selection-bar]");
    expect(bar.textContent).toContain("3 selected");
    expect(slot.container.querySelector("input[type='search']")).toBeNull();
    fireEvent.click(within(bar).getByRole("checkbox", { name: "Select every PR shown" }));
    expect(bar.textContent).toContain(`${ALL.length} selected`);
    fireEvent.click(within(bar).getByRole("button", { name: /Clear/u }));
    expect(slot.container.querySelector("[data-selection-bar]")).toBeNull();
  });

  it("dismisses the selection at once, and Undo restores it", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    fireEvent.click(slot.getByRole("checkbox", { name: "Select infrastructure#85915" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Select bb-marketplace#94" }));
    fireEvent.click(within(await find(slot.container, "[data-selection-bar]")).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(callsTo(slot, "dismiss")).toEqual([{ keys: [waiting.key, nobody.key], on: true }]));
    await waitFor(() => expect(slot.container.querySelector(`[data-row="${waiting.key}"]`)).toBeNull());
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    const [message, options] = toasts.success.mock.calls[0]!;
    expect(message).toBe("Dismissed 2 PRs.");
    expect(options).toMatchObject({ duration: 5000, action: { label: "Undo" } });
    options.action.onClick();
    await waitFor(() => expect(callsTo(slot, "dismiss")[1]).toEqual({ keys: [waiting.key, nobody.key], on: false }));
  });

  it("snoozes the selection from the selection bar until it changes, and Undo brings it back", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    fireEvent.click(slot.getByRole("checkbox", { name: "Select world#2312065" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Select infrastructure#86110" }));
    openMenu(within(await find(slot.container, "[data-selection-bar]")).getByRole("button", { name: "Snooze 2 PRs" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Until it changes/u }));
    await waitFor(() => expect(callsTo(slot, "snooze")).toEqual([{ keys: [request.key, mention.key], until: "update" }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Snoozed 2 PRs until it changes.", expect.anything()));
    toasts.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "snooze")[1]).toEqual({ keys: [request.key, mention.key], until: null }));
  });

  it("dismisses one row from its overlay", async () => {
    const { slot } = await inboxPage();
    fireEvent.click(within(await row(slot, request.key)).getByRole("button", { name: "Dismiss world#2312065 from the Inbox" }));
    await waitFor(() => expect(callsTo(slot, "dismiss")).toEqual([{ keys: [request.key], on: true }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Dismissed world#2312065.", expect.anything()));
  });

  it("offers later today, tomorrow, next week and until it changes, at the times of the user's clock", async () => {
    // A Wednesday afternoon.
    const now = new Date(2026, 9, 28, 14, 5).getTime();
    const choices = snoozeChoices(now);
    expect(choices.map((choice) => choice.label)).toEqual(["Later today", "Tomorrow", "Next week", "Until it changes"]);
    expect(choices.map((choice) => choice.until)).toEqual([now + 3 * HOUR, new Date(2026, 9, 29, 9).getTime(), new Date(2026, 10, 2, 9).getTime(), "update"]);
    const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(choices.map((choice) => choice.hint)).toEqual([time(now + 3 * HOUR), `Thu ${time(new Date(2026, 9, 29, 9).getTime())}`, `Mon ${time(new Date(2026, 10, 2, 9).getTime())}`, ""]);
    // On a Monday, next week is the Monday after.
    expect(snoozeChoices(new Date(2026, 10, 2, 8).getTime())[2]!.until).toBe(new Date(2026, 10, 9, 9).getTime());
  });

  it("snoozes a row until tomorrow 9:00 from its snooze menu, which says something new brings it back sooner", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 28, 14, 5));
    const { slot } = await inboxPage();
    openMenu(within(await row(slot, request.key)).getByRole("button", { name: "Snooze world#2312065" }));
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("Something new brings it back sooner.");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Tomorrow/u }));
    await waitFor(() => expect(callsTo(slot, "snooze")).toEqual([{ keys: [request.key], until: new Date(2026, 9, 29, 9).getTime() }]));
  });

  it("keeps PRs like a row's out of the Inbox from its ⋯ menu, with how many leave now, and Undo removes the rule", async () => {
    const added: InboxRule = { id: 9, kind: "author", server: "delta", serverName: "Delta", value: "elvin", createdAt: NOW, keeps: [request.key] };
    const { slot } = await inboxPage({ inboxRuleAdd: () => ({ rule: added, created: true }), inboxRuleRemove: () => ({ ok: true }) });
    openMenu(within(await row(slot, request.key)).getByRole("button", { name: "More for world#2312065" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Snooze…", "Dismiss from the Inbox", "Every PR by @elvin1 in the Inbox", "Every PR from shop/world3 in the Inbox"]);
    expect(menu.textContent).toContain("Keep PRs like this out");
    expect(menu.textContent).toContain("They stay in My PRs and Reviews. Rules are listed under Dismissed, where you can remove them.");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Every PR by @elvin/u }));
    await waitFor(() => expect(callsTo(slot, "inboxRuleAdd")).toEqual([{ kind: "author", server: "delta", value: "elvin" }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("PRs by @elvin now stay out of the Inbox; 1 PR left it.", expect.anything()));
    toasts.success.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "inboxRuleRemove")).toEqual([{ id: 9 }]));
  });

  it("says a rule that already exists does, and offers no Undo for it", async () => {
    const existing: InboxRule = { id: 2, kind: "author", server: "delta", serverName: "Delta", value: "elvin", createdAt: NOW - HOUR, keeps: [request.key] };
    const { slot } = await inboxPage({ inboxRuleAdd: () => ({ rule: existing, created: false }), inboxRuleRemove: () => ({ ok: true }) });
    openMenu(within(await row(slot, request.key)).getByRole("button", { name: "More for world#2312065" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Every PR by @elvin/u }));
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith("PRs by @elvin already stay out of the Inbox."));
    expect(toasts.success).not.toHaveBeenCalled();
    press("u");
    expect(callsTo(slot, "inboxRuleRemove")).toEqual([]);
  });

  it("offers a mention rule only on a PR that mentions you without asking, and no author rule on yours", async () => {
    const { slot } = await inboxPage();
    const rules = async () => within(await screen.findByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent).slice(2);
    openMenu(within(await row(slot, mention.key)).getByRole("button", { name: "More for infrastructure#86110" }));
    expect(await rules()).toEqual(["Every PR by @tlee1 in the Inbox", "Every PR from Shopify/infrastructure2 in the Inbox", "Mentions in Shopify/infrastructure unless I'm asked1 in the Inbox"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    openMenu(within(await row(slot, waiting.key)).getByRole("button", { name: "More for infrastructure#85915" }));
    expect(await rules()).toEqual(["Every PR from Shopify/infrastructure2 in the Inbox"]);
  });

  it("snoozes or dismisses a row from its ⋯ menu", async () => {
    const { slot } = await inboxPage();
    openMenu(within(await row(slot, request.key)).getByRole("button", { name: "More for world#2312065" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Snooze…/u }));
    await waitFor(() => expect(screen.getByRole("menu").textContent).toContain("Until it changes"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Until it changes/u }));
    await waitFor(() => expect(callsTo(slot, "snooze")).toEqual([{ keys: [request.key], until: "update" }]));
    openMenu(within(await row(slot, mention.key)).getByRole("button", { name: "More for infrastructure#86110" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /Dismiss from the Inbox/u }));
    await waitFor(() => expect(callsTo(slot, "dismiss")).toEqual([{ keys: [mention.key], on: true }]));
  });

  it("ends with the older requests and what automation did, each linking to its place, and leaves out a zero", async () => {
    const { slot } = await inboxPage();
    const foot = await find(slot.container, "[data-foot]");
    expect(foot.textContent).toContain("31 older requests by name wait in Reviews");
    expect(foot.textContent).toContain("Automation did 3 things today: Automation log");
    fireEvent.click(within(foot).getByRole("button", { name: "wait in Reviews" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "reviews~asked" } });
    fireEvent.click(within(foot).getByRole("button", { name: "Automation log" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "insights/log" } });
    unmountAll();
    const quiet = await page("inbox", { inbox: () => inbox({ prs: ALL, olderRequests: 0, handled: 2 }) });
    const line = await find(quiet.slot.container, "[data-foot]");
    expect(line.textContent).toBe("Automation did 2 things today: Automation log");
  });

  it("says all clear when nothing waits", async () => {
    const { slot } = await page("inbox", { inbox: () => inbox() });
    expect((await find(slot.container, "[data-all-clear]")).textContent).toContain("Nothing waits on you.");
    expect(slot.container.querySelector("[data-foot]")).toBeNull();
  });

  it("opens a PR from a click on its row, tints that row, and opens Merge… without opening the PR", async () => {
    const { slot, route } = await inboxPage();
    fireEvent.click((await row(slot, ready.key)).querySelector<HTMLElement>("[data-title]")!);
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "inbox", key: ready.key }) } });
    route(formatRoute({ view: "inbox", key: ready.key }));
    await waitFor(async () => expect((await row(slot, ready.key)).getAttribute("aria-current")).toBe("true"));
    // The selected row is tinted and marked with the primary colour's edge; nothing else uses it.
    expect((await row(slot, ready.key)).className).toContain("[--row:var(--surface-selected)]");
    expect((await row(slot, ready.key)).innerHTML).toContain("var(--primary)");
    expect((await row(slot, waiting.key)).innerHTML).not.toContain("var(--primary)");
    expect((await row(slot, waiting.key)).getAttribute("aria-current")).toBeNull();
    const calls = slot.inspection.navigateCalls.length;
    fireEvent.click(within(await row(slot, nobody.key)).getByRole("button", { name: "Hand it to an agent" }));
    expect(await slot.findByRole("dialog")).toBeTruthy();
    expect(slot.inspection.navigateCalls.length).toBe(calls);
  });

  it("marks every PR seen from the header's ⋯ menu", async () => {
    const { slot } = await inboxPage();
    openMenu(await slot.findByRole("button", { name: "Inbox options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark all as seen" }));
    await waitFor(() => expect(callsTo(slot, "markSeen")).toEqual([{ keys: [waiting.key, ready.key] }]));
    await waitFor(() => expect(slot.container.querySelector("[data-unseen]")).toBeNull());
  });

  it("lists the keyboard shortcuts from the header's ⋯ menu", async () => {
    const { slot } = await inboxPage();
    openMenu(await slot.findByRole("button", { name: "Inbox options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Keyboard shortcuts" }));
    const dialog = await slot.findByRole("dialog", { name: "Keyboard shortcuts" });
    for (const text of ["Next and previous PR", "Open it", "Select it", "Dismiss", "Snooze", "Undo", "Search", "Close the menu, then clear the selection"]) expect(dialog.textContent).toContain(text);
  });
});

describe("the Inbox's keys", () => {
  it("moves a cursor with J and K, opens with Enter, selects with X and clears with Escape", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    press("j");
    expect((await row(slot, waiting.key)).hasAttribute("data-cursor")).toBe(true);
    press("j");
    press("ArrowDown");
    press("k");
    expect((await row(slot, nobody.key)).hasAttribute("data-cursor")).toBe(true);
    press("x");
    expect((await find(slot.container, "[data-selection-bar]")).textContent).toContain("1 selected");
    press("Escape");
    expect(slot.container.querySelector("[data-selection-bar]")).toBeNull();
    press("Enter");
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: formatRoute({ view: "inbox", key: nobody.key }) } });
  });

  it("dismisses with E, moves the cursor on, and undoes with U", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    press("j");
    press("e");
    await waitFor(() => expect(callsTo(slot, "dismiss")).toEqual([{ keys: [waiting.key], on: true }]));
    await waitFor(() => expect(slot.container.querySelector(`[data-row="${nobody.key}"]`)!.hasAttribute("data-cursor")).toBe(true));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    press("u");
    await waitFor(() => expect(callsTo(slot, "dismiss")[1]).toEqual({ keys: [waiting.key], on: false }));
  });

  it("opens the snooze menu with S, focuses search with /, and ignores keys typed in a field or with a modifier", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    press("j");
    press("s");
    expect((await screen.findByRole("menu")).textContent).toContain("Later today");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    press("/");
    const search = slot.container.querySelector<HTMLInputElement>("input[type='search']")!;
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "e" });
    fireEvent.keyDown(search, { key: "j" });
    press("e", { metaKey: true });
    expect(callsTo(slot, "dismiss")).toEqual([]);
    expect((await row(slot, waiting.key)).hasAttribute("data-cursor")).toBe(true);
  });
});

describe("the Inbox's keys and focus", () => {
  it("makes a row that takes focus the cursor, so E dismisses the row that has focus", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    press("j");
    const target = await row(slot, nobody.key);
    act(() => target.focus());
    expect(target.hasAttribute("data-cursor")).toBe(true);
    fireEvent.keyDown(target, { key: "e" });
    await waitFor(() => expect(callsTo(slot, "dismiss")).toEqual([{ keys: [nobody.key], on: true }]));
  });

  it("moves focus with J and K when a row has it, so Enter and E act on the same row", async () => {
    const { slot } = await inboxPage();
    const first = await row(slot, waiting.key);
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "j" });
    const second = await row(slot, nobody.key);
    expect(document.activeElement).toBe(second);
    expect(second.hasAttribute("data-cursor")).toBe(true);
    fireEvent.keyDown(second, { key: "e" });
    await waitFor(() => expect(callsTo(slot, "dismiss")).toEqual([{ keys: [nobody.key], on: true }]));
  });

  it("matches letter keys with Caps Lock or Shift", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    press("J");
    press("J", { shiftKey: true });
    expect((await row(slot, nobody.key)).hasAttribute("data-cursor")).toBe(true);
    press("E");
    await waitFor(() => expect(callsTo(slot, "dismiss")).toEqual([{ keys: [nobody.key], on: true }]));
  });

  it("ignores J, E and S while the snooze menu or the shortcuts dialog is open", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    press("j");
    press("s");
    await screen.findByRole("menu");
    for (const key of ["j", "e", "s"]) press(key);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    press("?");
    await slot.findByRole("dialog", { name: "Keyboard shortcuts" });
    for (const key of ["j", "e", "s"]) press(key);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(callsTo(slot, "dismiss")).toEqual([]);
    expect((await row(slot, waiting.key)).hasAttribute("data-cursor")).toBe(true);
  });

  it("forgets a cursor whose row search hides: X, S, E and Enter do nothing, and J starts at the first row shown", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    press("j");
    const search = slot.container.querySelector<HTMLInputElement>("input[type='search']")!;
    fireEvent.change(search, { target: { value: "elvin" } });
    search.blur();
    const navigations = slot.inspection.navigateCalls.length;
    for (const key of ["x", "s", "e", "Enter"]) press(key);
    expect(slot.container.querySelector("[data-selection-bar]")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(callsTo(slot, "dismiss")).toEqual([]);
    expect(slot.inspection.navigateCalls.length).toBe(navigations);
    press("j");
    expect((await row(slot, request.key)).hasAttribute("data-cursor")).toBe(true);
  });

  it("forgets a cursor whose section is folded", async () => {
    const { slot } = await inboxPage();
    await row(slot, waiting.key);
    press("j");
    fireEvent.click(within(await find(slot.container, "[data-section='kind:needs']")).getByRole("button", { name: /Needs you/u }));
    press("x");
    expect(slot.container.querySelector("[data-selection-bar]")).toBeNull();
    press("s");
    expect(screen.queryByRole("menu")).toBeNull();
    press("k");
    expect((await row(slot, ready.key)).hasAttribute("data-cursor")).toBe(true);
  });
});

describe("the Snoozed and Dismissed tabs", () => {
  it("lists snoozed PRs with when each comes back, and wakes one now", async () => {
    const { slot } = await inboxPage({}, ALL, "inbox~snoozed", { snoozed: [snoozedLater, snoozedChange] });
    const later = await row(slot, snoozedLater.key);
    expect(slot.container.textContent).toContain("They come back at the time shown, or sooner if something new happens.");
    expect(facts(later)[0]).toMatch(/^Back (today|tomorrow), /u);
    expect(facts(await row(slot, snoozedChange.key))).toEqual(["Back when it changes"]);
    expect(slot.getByRole("radio", { name: "Snoozed 2" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(later).getByRole("button", { name: "Wake now" }));
    await waitFor(() => expect(callsTo(slot, "snooze")).toEqual([{ keys: [snoozedLater.key], until: null }]));
  });

  it("takes a woken or restored PR out of its list at once, and leaves where it goes to the server", async () => {
    // Approved, so its step has a clears line but no Inbox card.
    const approved = { kind: "rereview" as const, inbox: false, clears: "Leaves when you review again." };
    const woken = pr({ number: 61, title: "Woken but approved", snoozed: true, snoozedUntil: null, myReview: { verdict: "approve", at: NOW - HOUR, head: "aaa" }, next: next(approved) });
    const restored = pr({ number: 62, title: "Restored but approved", dismissed: { at: NOW - HOUR, activity: false }, myReview: { verdict: "approve", at: NOW - HOUR, head: "aaa" }, next: next(approved) });
    let reads = 0;
    const data = inbox({ prs: [request], snoozed: [woken], dismissed: [restored] });
    const { slot, route } = await page("inbox~snoozed", {
      // Only the first read answers, so the page shows what it predicted until the server's refetch.
      inbox: () => (reads++ === 0 ? data : new Promise<never>(() => {})),
      snooze: () => ({ prs: [{ ...woken, snoozed: false }] }),
      dismiss: () => ({ prs: [{ ...restored, dismissed: null }] }),
    });
    fireEvent.click(within(await row(slot, woken.key)).getByRole("button", { name: "Wake now" }));
    await waitFor(() => expect(slot.container.querySelector(`[data-row="${woken.key}"]`)).toBeNull());
    route("inbox~dismissed");
    fireEvent.click(within(await row(slot, restored.key)).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(slot.container.querySelector(`[data-row="${restored.key}"]`)).toBeNull());
    route("inbox");
    await row(slot, request.key);
    expect(rowKeys(slot)).toEqual([request.key]);
  });

  it("says when nothing is snoozed", async () => {
    const { slot } = await inboxPage({}, ALL, "inbox~snoozed");
    expect((await find(slot.container, "[data-empty]")).textContent).toBe("Nothing is snoozed.");
  });

  it("lists dismissed PRs with New activity on those that changed, a dot on the tab, Restore, and the rules", async () => {
    const { slot } = await inboxPage({
      inboxRuleRemove: () => ({ ok: true }),
      inboxRuleAdd: () => ({ rule, created: true }),
    }, ALL, "inbox~dismissed", { dismissed: [dismissedNew, dismissedQuiet], rules: [rule, mentionRule] });
    const changed = await row(slot, dismissedNew.key);
    expect(slot.container.textContent).toContain("They stay out of the Inbox, even when they change. My PRs and Reviews still list them.");
    expect(changed.querySelector("[data-new-activity]")!.textContent).toBe("New activity");
    expect((await row(slot, dismissedQuiet.key)).querySelector("[data-new-activity]")).toBeNull();
    expect(facts(changed)[0]).toBe("Dismissed 1d ago");
    expect(slot.getByRole("radio", { name: /Dismissed 2/u }).querySelector("[data-activity-dot]")).not.toBeNull();

    const rules = slot.getByRole("region", { name: "Rules" });
    const items = [...rules.querySelectorAll<HTMLElement>("[data-rule]")];
    expect(items.map((item) => item.querySelector("[data-rule-text]")!.textContent)).toEqual(["PRs from Shopify/polaris", "Mentions in Shopify/web, when you are not asked to review"]);
    expect(items[0]!.textContent).toContain("Keeps out polaris#1201, polaris#1188");
    expect(items[1]!.textContent).toContain("Keeps nothing out right now");

    fireEvent.click(within(changed).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(callsTo(slot, "dismiss")).toEqual([{ keys: [dismissedNew.key], on: false }]));
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(callsTo(slot, "inboxRuleRemove")).toEqual([{ id: 4 }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("PRs from Shopify/polaris can come to the Inbox again.", expect.anything()));
    toasts.success.mock.calls.at(-1)![1].action.onClick();
    await waitFor(() => expect(callsTo(slot, "inboxRuleAdd")).toEqual([{ kind: "repo", server: "github", value: "Shopify/polaris" }]));
  });

  it("puts no dot on the tab when no dismissed PR changed, and says when nothing is dismissed or ruled out", async () => {
    const { slot } = await inboxPage({}, ALL, "inbox~dismissed");
    await find(slot.container, "[data-empty]");
    expect([...slot.container.querySelectorAll("[data-empty]")].map((node) => node.textContent)).toEqual(["Nothing is dismissed.", "No rules. A row's ⋯ menu makes one."]);
    expect(slot.container.querySelector("[data-activity-dot]")).toBeNull();
  });

  it("switches tabs through the route, so Back returns to the last one", async () => {
    const { slot } = await inboxPage({}, ALL, "inbox", { snoozed: [snoozedLater] });
    fireEvent.click(await slot.findByRole("radio", { name: "Snoozed 1" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "inbox~snoozed" } });
  });
});

describe("the Inbox on a phone", () => {
  it("swipes a row left to dismiss it and right to snooze it; a short swipe springs back", async () => {
    setViewport(390);
    const { slot } = await inboxPage();
    const swipe = (node: HTMLElement, dx: number) => {
      fireEvent.pointerDown(node, { clientX: 200, clientY: 20, pointerId: 1 });
      fireEvent.pointerMove(node, { clientX: 200 + dx / 2, clientY: 22, pointerId: 1 });
      fireEvent.pointerMove(node, { clientX: 200 + dx, clientY: 22, pointerId: 1 });
      fireEvent.pointerUp(node, { clientX: 200 + dx, clientY: 22, pointerId: 1 });
    };
    const target = await row(slot, request.key);
    expect(target.querySelector("[data-overlay]")).toBeNull();
    expect(within(target).getByRole("button", { name: "More for world#2312065" })).toBeTruthy();
    swipe(target, -40);
    expect(callsTo(slot, "dismiss")).toEqual([]);
    swipe(target, 120);
    const sheet = await slot.findByRole("dialog", { name: "Snooze until…" });
    expect(sheet.textContent).toContain("Until it changes");
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    swipe(target, -120);
    await waitFor(() => expect(callsTo(slot, "dismiss")).toEqual([{ keys: [request.key], on: true }]));
  });

  it("lets a tap after a swipe open the PR", async () => {
    setViewport(390);
    const { slot } = await inboxPage();
    const target = await row(slot, request.key);
    const title = target.querySelector<HTMLElement>("[data-title]")!;
    const opened = () => slot.inspection.navigateCalls.filter((call) => JSON.stringify(call).includes("2312065")).length;
    fireEvent.pointerDown(target, { clientX: 200, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(target, { clientX: 240, clientY: 22, pointerId: 1 });
    fireEvent.pointerUp(target, { clientX: 240, clientY: 22, pointerId: 1 });
    // A touch browser sends no click after a pan; the next tap starts with its own pointerdown.
    fireEvent.pointerDown(title, { clientX: 200, clientY: 20, pointerId: 2 });
    fireEvent.pointerUp(title, { clientX: 200, clientY: 20, pointerId: 2 });
    fireEvent.click(title);
    expect(opened()).toBe(1);
    fireEvent.pointerDown(target, { clientX: 200, clientY: 20, pointerId: 3 });
    fireEvent.pointerMove(target, { clientX: 240, clientY: 22, pointerId: 3 });
    fireEvent.pointerUp(target, { clientX: 240, clientY: 22, pointerId: 3 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    fireEvent.click(title);
    expect(opened()).toBe(2);
  });

  it("shows the swipe hint once, until closed", async () => {
    setViewport(390);
    const first = await inboxPage();
    const hint = await find(first.slot.container, "[data-swipe-hint]");
    expect(hint.textContent).toContain("Swipe a row left to dismiss it, or right to snooze it.");
    fireEvent.click(within(hint).getByRole("button", { name: "Got it" }));
    expect(first.slot.container.querySelector("[data-swipe-hint]")).toBeNull();
    first.slot.lifecycle.unmount();
    const second = await page("inbox", { inbox: () => inbox({ prs: ALL }) });
    await find(second.slot.container, `[data-row="${waiting.key}"]`);
    expect(second.slot.container.querySelector("[data-swipe-hint]")).toBeNull();
  });
});

describe("the PR view and the Inbox", () => {
  const view = (start: PrView, rpc: Partial<Handlers> = {}) => {
    let current = start;
    return page(formatRoute({ view: "reviews", source: "all", key: start.key }), {
      list: ({ area }) => ({ prs: area === "reviews" ? [current] : [] }),
      detail: () => ({ pr: current, events: [], body: "", draft: null }),
      snooze: ({ until }) => {
        current = { ...current, snoozed: until !== null, snoozedUntil: typeof until === "number" ? until : null };
        return { prs: [current] };
      },
      dismiss: ({ on }) => {
        current = { ...current, dismissed: on ? { at: NOW, activity: false } : null };
        return { prs: [current] };
      },
      markSeen: () => {
        current = { ...current, unseen: false };
        return { ok: true };
      },
      ...rpc,
    });
  };
  const menu = async (slot: Slot) => {
    openMenu(await slot.findByRole("button", { name: /^More for/u }));
    return screen.findByRole("menu", { name: /^More for/u });
  };

  it("marks the PR seen once when it opens, and only when it changed since", async () => {
    const fresh = pr({ unseen: true });
    const { slot } = await view(fresh);
    await find(slot.container, `[data-detail="${fresh.key}"]`);
    await waitFor(() => expect(callsTo(slot, "markSeen")).toEqual([{ keys: [fresh.key] }]));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(callsTo(slot, "markSeen")).toHaveLength(1);
    unmountAll();
    const seen = await view(pr());
    await find(seen.slot.container, "[data-detail]");
    expect(callsTo(seen.slot, "markSeen")).toEqual([]);
  });

  it("does not mark a PR seen that was seen when it opened and changed while it stayed open", async () => {
    let current = pr();
    const { slot } = await page(formatRoute({ view: "reviews", source: "all", key: current.key }), {
      list: ({ area }) => ({ prs: area === "reviews" ? [current] : [] }),
      detail: () => ({ pr: current, events: [], body: "", draft: null }),
      markSeen: () => ({ ok: true }),
    });
    await find(slot.container, `[data-detail="${current.key}"]`);
    current = { ...current, unseen: true, title: "Changed while open" };
    await slot.behavior.experimental_invalidateRpc(["prs"], "shuttle");
    await waitFor(() => expect(slot.container.textContent).toContain("Changed while open"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(callsTo(slot, "markSeen")).toEqual([]);
  });

  it("offers no Dismiss from the Inbox on a PR that is not in it", async () => {
    const { slot } = await view(pr());
    await find(slot.container, "[data-detail]");
    const open = await menu(slot);
    expect(within(open).getByRole("menuitem", { name: "Copy link" })).toBeTruthy();
    expect(within(open).queryByRole("menuitem", { name: "Dismiss from the Inbox" })).toBeNull();
  });

  it("snoozes until 9:00 tomorrow from its ⋯ menu, as the Inbox's Tomorrow does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 28, 14, 5));
    const { slot } = await view(request);
    await find(slot.container, "[data-detail]");
    fireEvent.click(within(await menu(slot)).getByRole("menuitem", { name: "Snooze until tomorrow" }));
    const tomorrow = snoozeChoices(Date.now())[1]!.until;
    expect(tomorrow).toBe(atNine(Date.now(), 1));
    await waitFor(() => expect(callsTo(slot, "snooze")).toEqual([{ keys: [request.key], until: tomorrow }]));
  });

  it("offers Dismiss from the Inbox, then Restore to the Inbox, in its ⋯ menu", async () => {
    const { slot } = await view(request);
    await find(slot.container, "[data-detail]");
    fireEvent.click(within(await menu(slot)).getByRole("menuitem", { name: "Dismiss from the Inbox" }));
    await waitFor(() => expect(callsTo(slot, "dismiss")).toEqual([{ keys: [request.key], on: true }]));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const open = await menu(slot);
    expect(within(open).queryByRole("menuitem", { name: /Snooze/u })).toBeNull();
    expect(within(open).queryByRole("menuitem", { name: "Dismiss from the Inbox" })).toBeNull();
    fireEvent.click(within(open).getByRole("menuitem", { name: "Restore to the Inbox" }));
    await waitFor(() => expect(callsTo(slot, "dismiss")[1]).toEqual({ keys: [request.key], on: false }));
  });

  it("keeps Not now on a new request: it snoozes the request until it changes", async () => {
    const { slot } = await view(request);
    fireEvent.click(within(await find(slot.container, "[data-detail]")).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(callsTo(slot, "snooze")).toEqual([{ keys: [request.key], until: "update" }]));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Snoozed world#2312065 until it changes.", expect.anything()));
  });

  it("offers Bring back to the Inbox on a PR snoozed until it changes", async () => {
    const { slot } = await view({ ...request, snoozed: true, snoozedUntil: null, next: { ...request.next, inbox: false } });
    await find(slot.container, "[data-detail]");
    const open = await menu(slot);
    expect(within(open).queryByRole("menuitem", { name: /^Snooze/u })).toBeNull();
    fireEvent.click(within(open).getByRole("menuitem", { name: "Bring back to the Inbox" }));
    await waitFor(() => expect(callsTo(slot, "snooze")).toEqual([{ keys: [request.key], until: null }]));
  });
});

describe("Inbox routes", () => {
  it("carries the tab and a selected PR", () => {
    const key = "delta:shop/world#2261179";
    expect(parseRoute("inbox~snoozed")).toEqual({ view: "inbox", tab: "snoozed", key: null });
    expect(parseRoute("inbox~dismissed/delta/shop/world/2261179")).toEqual({ view: "inbox", tab: "dismissed", key });
    expect(parseRoute("inbox~nonsense")).toEqual({ view: "inbox", key: null });
    expect(formatRoute({ view: "inbox", tab: "dismissed", key })).toBe("inbox~dismissed/delta/shop/world/2261179");
    expect(formatRoute({ view: "inbox", tab: "snoozed", key: null })).toBe("inbox~snoozed");
    expect(formatRoute({ view: "inbox", key: null })).toBe("inbox");
  });
});
