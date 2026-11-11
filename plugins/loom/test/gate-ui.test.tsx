// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { GateView, ProjectView, rpcContract } from "../src/contract";
import type { SpecReviewStatus } from "../src/spec-review";
import { reloadRemembered } from "../src/ui/remember";
import { palette, keysSheet, rewind } from "../src/ui/dispatch";
import { resetUnread } from "../src/ui/spec-read";
import { approveWords, changeFact, hiddenSummary, holdClock, proposedCards, waitWords } from "../src/ui/gate";
import { HOUR, NOW, card, overview, plannerViewOf, projectView, specVersionView } from "./fixtures";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }));

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const unexpected = (): never => {
  throw new Error("unexpected rpc call");
};
const handlers = (over: Partial<Handlers> = {}): Handlers => ({
  projects: unexpected,
  home: unexpected,
  badge: () => ({ needsYou: 0, blocked: false, threadIds: [] }),
  project: unexpected,
  ticket: unexpected,
  runOutput: unexpected,
  insights: unexpected,
  insightsAll: unexpected,
  timeline: () => ({ moments: [], events: [], from: NOW - HOUR, to: NOW }) as never,
  threadInfo: () => null,
  threadInfos: () => ({}),
  homeFeed: () => ({ rows: [], counts: { shipped: 0, sentBack: 0, blocked: 0, asks: 0, phase: 0, you: 0 }, matched: 0, partial: [] }),
  reply: unexpected,
  ticketAction: unexpected,
  confirmMerge: unexpected,
  releaseDraft: unexpected,
  control: unexpected,
  startPlanning: unexpected,
  bbProjects: () => [],
  planning: () => [],
  planningSession: () => null,
  plannerView: () => null,
  messagePlanner: unexpected,
  dismissAsk: unexpected,
  askStepDone: unexpected,
  ackBadge: unexpected,
  syncPullRequests: unexpected,
  markLive: unexpected,
  specVersion: unexpected,
  sendNotes: unexpected,
  changes: unexpected,
  changePatch: unexpected,
  forgeProfiles: () => [],
  saveForgeProfile: unexpected,
  deleteForgeProfile: unexpected,
  testForgeProfile: unexpected,
  exportForgeProfiles: () => ({ toml: "" }),
  importForgeProfiles: unexpected,
  ...over,
});

type Slot = ReturnType<typeof renderSlot>;
const mounts: Slot[] = [];
function reset() {
  vi.mocked(toast.success).mockClear();
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  cleanup();
  document.body.replaceChildren();
  palette.set(false);
  keysSheet.set(false);
  rewind.set(null);
  localStorage.clear();
  reloadRemembered();
  resetUnread();
}
afterEach(reset);

async function mountPage(subPath: string, rpc: Partial<Handlers> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const Panel = app.navPanels[0]!.component;
  const Header = app.navPanels[0]!.headerContent!;
  const Page = (props: PluginNavPanelProps) => (
    <>
      <Header {...props} />
      <Panel {...props} />
    </>
  );
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>({ component: Page }, { subPath }, { pluginId: "loom", rpc: handlers(rpc) });
  mounts.push(slot);
  return slot;
}
// The first page a file mounts pays for importing the whole app and for the first render of every component on the gate
// (about 0.5 s of work alone): one-time costs, not what a test checks. On a loaded machine that took 1.4 to 6.8 s inside
// the first test's 5 s, while the same mount in the next test took 0.2 to 1.7 s. So both happen once here, under their own
// deadline, and the page is reset as after any test.
beforeAll(async () => {
  const slot = await mountPage("edge", { project: () => edge() });
  await openSpec(slot);
  await found(slot, "[data-gate]");
  reset();
}, 60_000);

/** Waits until the selector matches, then returns the element. */
const found = (slot: Slot, selector: string) =>
  waitFor(() => {
    const element = slot.container.querySelector<HTMLElement>(selector);
    if (element === null) throw new Error(`no ${selector} yet`);
    return element;
  });
const calls = (slot: Slot, method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method);
async function openSpec(slot: Slot) {
  fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
}

const SHA = "7d1e3a9f00d1e2a3b4c5d6e7f8091a2b3c4d5e6f";
const recorded = (key: string, over: Partial<NonNullable<GateView["finished"]>["tickets"][number]> = {}): NonNullable<GateView["finished"]>["tickets"][number] => ({
  key,
  title: `${key}'s title`,
  repo: "edge-config",
  state: "done",
  prUrl: `https://github.com/acme/edge-config/pull/${800 + Number(key.split("-")[1])}`,
  mergeSha: SHA,
  checks: { passed: 4, failed: 0, pending: 0, at: NOW - 2 * HOUR },
  review: { verdict: "approved", round: 1, threadId: `thr_rev_${key}`, at: NOW - 3 * HOUR },
  cancel: null,
  ...over,
});
const proposed = (ref: string, key: string, over: Partial<GateView["proposed"]["tickets"][number]> = {}): GateView["proposed"]["tickets"][number] => ({ ref, key, title: `${ref} title`, repo: "edge-config", dependsOn: [], mergeAfter: [], requiresLive: [], ready: false, starts: false, ...over });

const gateOf = (over: Partial<GateView> = {}): GateView => ({
  version: 3,
  inForce: 2,
  proposedAt: NOW - 52 * 60_000,
  finished: {
    index: 1,
    ref: "keys",
    title: "Market-aware keys behind a flag",
    goal: "Build market-aware cache keys.",
    doneWhen: ["Every request carries a market key", "The canary's hit rate stays within 2 points"],
    report: "Phase 2 put market-aware keys behind the flag.\n\nEDGE-14 was cancelled: nothing to backfill.",
    closedAt: NOW - HOUR,
    tickets: [
      recorded("EDGE-9"),
      recorded("EDGE-11", { prUrl: "https://gitlab.example/acme/edge/-/merge_requests/12", checks: null, review: { verdict: "changes_requested", round: 2, threadId: null, at: NOW } }),
      recorded("EDGE-13", { mergeSha: null }),
      recorded("EDGE-14", { state: "cancelled", prUrl: null, mergeSha: null, checks: null, review: null, cancel: { reason: "No archived market serves traffic.", by: "planner", at: NOW - HOUR } }),
    ],
  },
  proposed: {
    index: 2,
    ref: "purge",
    title: "Purge by market",
    goal: "Let an operator purge one market's cache.",
    doneWhen: ["A purge removes only that market's keys", "Purges are refused without a token"],
    maxTickets: 8,
    tickets: [
      proposed("purge-auth", "EDGE-15", { dependsOn: ["EDGE-9"], ready: true, starts: true, title: "Operator tokens for the purge API, with a title long enough that a cut would hide the end of what you approve" }),
      proposed("purge-api", "EDGE-16", { dependsOn: ["EDGE-9", "EDGE-11"], ready: true, starts: true }),
      proposed("purge-queue", "EDGE-17", { dependsOn: ["EDGE-16"], requiresLive: ["EDGE-13"] }),
    ],
  },
  startNow: 2,
  wait: 1,
  maxWorkers: { before: 3, after: 4 },
  holdUntil: null,
  changes: [
    { path: "agents.max_workers", section: "settings", ref: null, kind: "value", before: 3, after: 4 },
    { path: "phase[1].report", section: "tickets", ref: null, kind: "text", before: "", after: "Phase 2 put market-aware keys behind the flag." },
    { path: "phase[3].outline", section: "tickets", ref: null, kind: "list", steps: [], added: 0, removed: 1 },
  ],
  ...over,
});

const edge = (over: Partial<ProjectView> = {}, gate: Partial<GateView> = {}): ProjectView =>
  projectView({
    overview: overview({ slug: "edge", name: "Edge keys", key: "EDGE", state: "running" }),
    board: ["EDGE-9", "EDGE-11", "EDGE-13"].map((key) => card({ key, title: `${key}'s title`, state: "done", phase: "keys" })),
    spec: { ...projectView().spec, version: 2, pendingVersion: 3 },
    next: { stage: 5, tone: "normal", title: "v3 waits for your approval.", text: "It fills phase 3.", action: { control: "approve", label: "Approve v3", version: 3, confirm: "Yes, approve v3" } },
    specReview: { kind: "approved", version: 3, round: 1, summary: "No findings." } satisfies SpecReviewStatus,
    gate: gateOf(gate),
    ...over,
  });

describe("the gate's words", () => {
  it("names how many start and how many wait from the version on screen, and every other change", () => {
    const words = approveWords(gateOf(), false);
    expect(words.label).toBe("Approve v3 · create 3 tickets");
    expect(words.facts).toEqual(["2 start now", "1 waits", "max workers 3 to 4", "phase 4 outline"]);
    expect(words.yes).toBe("Yes, approve v3: 3 tickets, max workers 3 to 4 and phase 4's outline");
  });

  it("says none start while paused, and still names the version's other changes", () => {
    const words = approveWords(gateOf({ startNow: 0, wait: 3 }), true);
    expect(words.facts).toEqual(["paused", "3 tickets created", "none start", "max workers 3 to 4", "phase 4 outline"]);
    expect(words.yes).toBe("Yes, approve v3: 3 tickets, max workers 3 to 4 and phase 4's outline · stays paused");
  });

  it("counts from the displayed version alone, however many tickets the budget allows", () => {
    const many = gateOf();
    many.proposed.tickets = Array.from({ length: 6 }, (_, index) => proposed(`t${index}`, `EDGE-${15 + index}`, { ready: index < 2 }));
    expect(approveWords({ ...many, startNow: 2, wait: 4 }, false).label).toBe("Approve v3 · create 6 tickets");
    expect(approveWords({ ...many, startNow: 2, wait: 4 }, false).facts.slice(0, 2)).toEqual(["2 start now", "4 wait"]);
  });

  it("leaves the finished phase's report out of the facts, since the gate shows it already", () => {
    expect(changeFact({ path: "phase[1].report", section: "tickets", ref: null, kind: "text", before: "", after: "x" }, 1)).toBeNull();
    expect(changeFact({ path: "phase[1].report", section: "tickets", ref: null, kind: "text", before: "", after: "x" }, null)).toBe("phase 2 report");
  });

  it("puts a proposed ticket's prerequisites in words by kind, and draws only the ones it can", () => {
    expect(waitWords(proposed("a", "EDGE-17", { dependsOn: ["EDGE-16"], mergeAfter: ["EDGE-15"], requiresLive: ["EDGE-13"] }))).toBe("after EDGE-16 · merges after EDGE-15 · needs EDGE-13 live");
    expect(waitWords(proposed("a", "EDGE-17"))).toBeNull();
    const gate = gateOf();
    gate.proposed.tickets[2]!.requiresLive = ["edge-canary"];
    const cards = proposedCards(gate, edge().board);
    expect(cards.map((one) => one.key)).toEqual(["EDGE-15", "EDGE-16", "EDGE-17"]);
    expect(cards[2]!.prereqs).toEqual([{ key: "EDGE-16", kind: "work" }]);
    expect(cards.every((one) => one.phase === "purge" && one.state === "queued")).toBe(true);
  });

  it("sums up the side a narrow gate hides in one line", () => {
    expect(hiddenSummary(gateOf(), "finished")).toBe("Phase 3: 3 tickets, 2 start at once");
    expect(hiddenSummary(gateOf(), "proposed")).toBe("Phase 2: closed · 3 done · 1 cut");
    expect(hiddenSummary(gateOf(), "changes")).toBe("Phase 2: closed · 3 done · 1 cut · Phase 3: 3 tickets, 2 start at once");
  });
});

describe("the phase gate", () => {
  it("opens Spec on the gate: the finished phase as recorded beside the proposed one, closed but never complete", async () => {
    const slot = await mountPage("edge", { project: () => edge() });
    await openSpec(slot);
    const gate = await found(slot, "[data-gate]");
    expect(gate.getAttribute("data-gate")).toBe("3");
    expect(gate.querySelector("[data-gate-version]")!.textContent).toMatch(/v3 pending.*proposed 52m ago.*vs v2 in force.*review passed/);
    const finished = gate.querySelector<HTMLElement>('[data-gate-side-panel="finished"]')!;
    expect(finished.querySelector('[data-gate-chip="closed"]')!.textContent).toBe("Closed");
    expect(finished.textContent).toContain("3done · 1 cut");
    expect(finished.textContent).not.toMatch(/complete|✓/i);
    expect(finished.querySelector('[data-recorded="EDGE-14"]')!.textContent).toBe("EDGE-14cancelled by the planner · “No archived market serves traffic.”".replace(/[“”]/g, ""));
    expect(finished.querySelector("[data-unverified]")!.textContent).toBe("unverified");
    const side = gate.querySelector<HTMLElement>('[data-gate-side-panel="proposed"]')!;
    expect(side.querySelector('[data-gate-chip="proposed"]')).not.toBeNull();
    expect(side.querySelector("[data-key-range]")!.textContent).toBe("EDGE-15 to EDGE-17 · provisional");
    expect([...side.querySelectorAll("[data-proposed]")].map((row) => row.textContent)).toEqual([
      "EDGE-15Operator tokens for the purge API, with a title long enough that a cut would hide the end of what you approvestarts nowafter EDGE-9edge-config",
      "EDGE-16purge-api titlestarts nowafter EDGE-9, EDGE-11edge-config",
      "EDGE-17purge-queue titleafter EDGE-16 · needs EDGE-13 liveedge-config",
    ]);
    // No proposed title is cut: nothing being approved hides its end.
    expect(side.querySelector('[data-proposed="purge-auth"] [data-content]')!.className).not.toMatch(/truncate|line-clamp/);
    // The page's lead points at the gate only from another view: on the gate, the footer approves.
    expect(slot.container.querySelector("[data-title-controls]")?.textContent ?? "").not.toContain("Open the gate");
    // Counted by each button's own words: a role query here named every one of the page's buttons.
    expect([...slot.container.querySelectorAll("button")].filter((button) => /^Approve v3/.test(button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""))).toHaveLength(1);
  });

  it("calls an all-cancelled phase closed with its cuts, never complete", async () => {
    const cut = gateOf();
    cut.finished!.tickets = cut.finished!.tickets.map((ticket) => ({ ...ticket, state: "cancelled", prUrl: null, mergeSha: null, checks: null, review: null, cancel: { reason: "Out of scope.", by: "human", at: NOW } }));
    const slot = await mountPage("edge", { project: () => edge({}, cut) });
    await openSpec(slot);
    const finished = await found(slot, '[data-gate-side-panel="finished"]');
    expect(finished.querySelector('[data-gate-chip="closed"]')!.textContent).toBe("Closed");
    expect(finished.textContent).toContain("0done · 4 cut");
    expect(finished.textContent).toContain("cancelled by you");
    expect(finished.textContent).not.toMatch(/complete|✓/i);
  });

  it("links each recorded ticket to its records, by pointer and keyboard, and says what Loom did not record", async () => {
    const slot = await mountPage("edge", { project: () => edge() });
    await openSpec(slot);
    const row = (key: string) => within(slot.container.querySelector<HTMLElement>(`[data-recorded="${key}"]`)!);
    expect(row("EDGE-9").getByRole("link", { name: "EDGE-9's pull request #809" }).getAttribute("href")).toBe("https://github.com/acme/edge-config/pull/809");
    expect(row("EDGE-9").getByRole("link", { name: "EDGE-9's merge commit 7d1e3a9" }).getAttribute("href")).toBe(`https://github.com/acme/edge-config/commit/${SHA}`);
    expect(row("EDGE-9").getByRole("link", { name: "EDGE-9's checks: 4 of 4 passed" }).getAttribute("href")).toBe("https://github.com/acme/edge-config/pull/809/checks");
    fireEvent.click(row("EDGE-9").getByRole("button", { name: /EDGE-9's review: approved in round 1/ }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "thr_rev_EDGE-9" });
    // A forge Loom has no page pattern for: the commit copies instead of linking, and an unread check says so.
    expect(row("EDGE-11").getByRole("button", { name: "Copy EDGE-11's merge commit 7d1e3a9" })).not.toBeNull();
    expect(row("EDGE-11").getByText("not read")).not.toBeNull();
    expect(row("EDGE-11").getByText("changes requested · round 2")).not.toBeNull();
    expect(row("EDGE-13").getByText("not recorded")).not.toBeNull();
    // At 200% text fixed rem columns ran the evidence 23 to 29 px out of the row: the row wraps, each cell has a floor.
    const recorded = slot.container.querySelector<HTMLElement>('[data-recorded="EDGE-9"]')!;
    const names = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);
    expect(names(recorded)).toEqual(expect.arrayContaining(["flex", "flex-wrap"]));
    expect(names(recorded).some((name) => name.startsWith("grid-cols-"))).toBe(false);
    const evidence = recorded.querySelector("[data-recorded-evidence]")!;
    expect(names(evidence)).toEqual(expect.arrayContaining(["flex-1", "min-w-[min(100%,14rem)]"]));
    for (const cell of evidence.children) expect(names(cell).some((name) => /^w-/.test(name))).toBe(false);
    for (const link of row("EDGE-9").getAllByRole("link")) expect(link.getAttribute("target")).toBe("_blank");
    fireEvent.click(row("EDGE-9").getByRole("button", { name: "EDGE-9: EDGE-9's title" }));
    await waitFor(() => expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "loom", options: { subPath: "edge/EDGE-9" } }));
  });

  it("approves the version on screen in place, armed with what it creates, starts and changes", async () => {
    const control = vi.fn(() => edge({ gate: null }));
    const slot = await mountPage("edge", { project: () => edge(), control });
    await openSpec(slot);
    const footer = await found(slot, "[data-gate-footer]");
    expect(footer.querySelector("[data-gate-facts]")!.textContent).toBe("2 start now·1 waits·max workers 3 to 4·phase 4 outline");
    fireEvent.click(within(footer).getByRole("button", { name: "Approve v3 · create 3 tickets" }));
    const yes = within(footer).getByRole("button", { name: "Yes, approve v3: 3 tickets, max workers 3 to 4 and phase 4's outline" });
    fireEvent.click(yes);
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "edge", action: "approve", version: 3, confirm: true }));
  });

  it("says none start while paused, on every row as in the footer and the phone summary", async () => {
    const paused = gateOf({ startNow: 0, wait: 3 });
    paused.proposed.tickets = paused.proposed.tickets.map((ticket) => ({ ...ticket, starts: false }));
    const slot = await mountPage("edge", { project: () => edge({ overview: overview({ slug: "edge", name: "Edge keys", key: "EDGE", state: "paused" }) }, paused) });
    await openSpec(slot);
    const gate = await found(slot, "[data-gate]");
    expect(gate.textContent).not.toContain("starts now");
    expect([...gate.querySelectorAll("[data-proposed] [data-start]")].map((row) => row.textContent)).toEqual(["ready when resumed", "ready when resumed", "after EDGE-16 · needs EDGE-13 live"]);
    expect(gate.querySelector("[data-gate-summary]")!.textContent).toBe("Phase 3: 3 tickets, none start while paused");
    const footer = await found(slot, "[data-gate-footer]");
    expect(footer.querySelector("[data-gate-facts]")!.textContent).toBe("paused·3 tickets created·none start·max workers 3 to 4·phase 4 outline");
    // Beside the pause icon the facts take the width the icon leaves; a floor of their own ran them past the footer at 200% text.
    const facts = footer.querySelector<HTMLElement>("[data-gate-facts]")!;
    expect(facts.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
    expect(facts.className).not.toContain("min-w-[");
    expect(facts.parentElement!.className).toContain("min-w-[min(100%,16rem)]");
    fireEvent.click(within(footer).getByRole("button", { name: "Approve v3 · create 3 tickets" }));
    expect(within(footer).getByRole("button", { name: /· stays paused$/ })).not.toBeNull();
  });

  it("names only the scheduler's starters when there are fewer free slots than ready tickets", async () => {
    const tight = gateOf({ startNow: 1, wait: 2 });
    tight.proposed.tickets[1] = { ...tight.proposed.tickets[1]!, starts: false };
    const slot = await mountPage("edge", { project: () => edge({}, tight) });
    await openSpec(slot);
    const gate = await found(slot, "[data-gate]");
    expect([...gate.querySelectorAll("[data-proposed] [data-start]")].map((row) => row.textContent)).toEqual(["starts now", "waits for a free slot", "after EDGE-16 · needs EDGE-13 live"]);
    expect(gate.querySelector("[data-gate-footer] [data-gate-facts]")!.textContent).toBe("1 starts now·2 wait·max workers 3 to 4·phase 4 outline");
    expect(gate.querySelector("[data-gate-summary]")!.textContent).toBe("Phase 3: 3 tickets, 1 starts at once");
  });

  it("promises no start while a rate-limit hold is on, and names when it ends", async () => {
    const until = NOW + 20 * 60_000;
    const held = gateOf({ startNow: 0, wait: 3, holdUntil: until });
    held.proposed.tickets = held.proposed.tickets.map((ticket) => ({ ...ticket, starts: false }));
    const slot = await mountPage("edge", { project: () => edge({}, held) });
    await openSpec(slot);
    const gate = await found(slot, "[data-gate]");
    expect(gate.textContent).not.toContain("starts now");
    const about = `about ${holdClock(until)}`;
    expect([...gate.querySelectorAll("[data-proposed] [data-start]")].map((row) => row.textContent)).toEqual([`waits for the rate limit, ${about}`, `waits for the rate limit, ${about}`, "after EDGE-16 · needs EDGE-13 live"]);
    expect(gate.querySelector("[data-gate-summary]")!.textContent).toBe(`Phase 3: 3 tickets, none start until ${about}`);
    const footer = gate.querySelector<HTMLElement>("[data-gate-footer]")!;
    expect(footer.querySelector("[data-gate-facts]")!.textContent).toBe(`rate limit until ${about}·3 tickets created·none start until then·max workers 3 to 4·phase 4 outline`);
    fireEvent.click(within(footer).getByRole("button", { name: "Approve v3 · create 3 tickets" }));
    expect(within(footer).getByRole("button", { name: /· starts after the rate limit$/ })).not.toBeNull();
  });

  it("replaces Approve with Discard and Send while comments are unsent, and sends them to the version on screen", async () => {
    const sendNotes = vi.fn(() => ({ sent: 1 }) as never);
    const slot = await mountPage("edge", { project: () => edge(), sendNotes });
    await openSpec(slot);
    const gate = await found(slot, "[data-gate]");
    fireEvent.click(gate.querySelector<HTMLElement>('[data-gate-part="phase[2].done_when[1]"]')!);
    const box = await slot.findByPlaceholderText("Comment for the planner");
    fireEvent.change(box, { target: { value: "Name who holds the token." } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    const footer = gate.querySelector<HTMLElement>("[data-gate-footer]")!;
    await waitFor(() => expect(footer.textContent).toContain("1 comment unsent"));
    expect(within(footer).queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(within(footer).getByRole("button", { name: "Discard" })).not.toBeNull();
    fireEvent.click(within(footer).getByRole("button", { name: "Send 1 comment" }));
    await waitFor(() => expect(sendNotes).toHaveBeenCalledTimes(1));
    expect(calls(slot, "sendNotes")[0]!.input).toMatchObject({ slug: "edge", notes: [{ version: 3, paths: ["phase[2].done_when[1]"], body: "Name who holds the token." }], confirm: true });
    await waitFor(() => expect(within(footer).getByRole("button", { name: "Approve v3 · create 3 tickets" })).not.toBeNull());
  });

  it("discards unsent comments only after a second click, then offers Approve again", async () => {
    const slot = await mountPage("edge", { project: () => edge() });
    await openSpec(slot);
    const gate = await found(slot, "[data-gate]");
    fireEvent.click(gate.querySelector<HTMLElement>('[data-gate-part="ticket[purge-api]"]')!);
    fireEvent.change(await slot.findByPlaceholderText("Comment for the planner"), { target: { value: "Split it." } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    const footer = gate.querySelector<HTMLElement>("[data-gate-footer]")!;
    fireEvent.click(await within(footer).findByRole("button", { name: "Discard" }));
    fireEvent.click(within(footer).getByRole("button", { name: "Yes, discard 1 comment" }));
    await waitFor(() => expect(within(footer).getByRole("button", { name: "Approve v3 · create 3 tickets" })).not.toBeNull());
  });

  it("waits for Loom's spec review before it offers Approve, and offers the CLI when the review did not finish", async () => {
    const slot = await mountPage("edge", { project: () => edge({ specReview: { kind: "failed", version: 3, round: 1, reason: "the reviewer timed out" } satisfies SpecReviewStatus }) });
    await openSpec(slot);
    const footer = await found(slot, "[data-gate-footer]");
    expect(within(footer).queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(footer.textContent).toContain("v3's spec review did not finish: the reviewer timed out");
    expect(within(footer).getByRole("button", { name: "Copy CLI approve" }).getAttribute("title")).toBe("bb loom approve edge --version 3 --skip-review");
  });

  it("reads the whole spec one step away and comes back to the gate", async () => {
    const slot = await mountPage("edge", { project: () => edge(), specVersion: () => specVersionView(), plannerView: () => plannerViewOf({ projectState: "running", approvedVersion: 2 }) });
    await openSpec(slot);
    fireEvent.click(await slot.findByRole("button", { name: "Read the whole spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-gate]")).toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "Back to the gate" }));
    await waitFor(() => expect(slot.container.querySelector("[data-gate]")).not.toBeNull());
  });

  it("leads the project line to the gate from another view, with no Approve of its own", async () => {
    const slot = await mountPage("edge", { project: () => edge() });
    const open = await slot.findByRole("button", { name: "Open the gate" });
    expect(slot.queryByRole("button", { name: /^Approve v3/ })).toBeNull();
    fireEvent.click(open);
    await waitFor(() => expect(slot.container.querySelector("[data-gate]")).not.toBeNull());
  });

  it("keeps the other changes, both sides and their summaries reachable as tabs on a narrow page", async () => {
    const slot = await mountPage("edge", { project: () => edge() });
    await openSpec(slot);
    const gate = await found(slot, "[data-gate]");
    const tabs = within(gate.querySelector<HTMLElement>('[role="tablist"][aria-label="Gate side"]')!);
    expect(tabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Phase 2 recorded", "Phase 3 proposed", "Other changes3"]);
    expect(gate.querySelector("[data-gate-summary]")!.textContent).toBe("Phase 3: 3 tickets, 2 start at once");
    fireEvent.click(tabs.getByRole("tab", { name: /Other changes/ }));
    expect(gate.querySelector("[data-gate-summary]")!.textContent).toBe("Phase 2: closed · 3 done · 1 cut · Phase 3: 3 tickets, 2 start at once");
    expect(gate.querySelector('[data-gate-side-panel="changes"]')!.className).toContain("@max-5xl/loom:flex");
    // Segment labels never wrap inside a fixed-height background.
    for (const tab of tabs.getAllByRole("tab")) expect(tab.className).toMatch(/whitespace-nowrap.*min-h-7|min-h-7.*whitespace-nowrap/);
  });
});

describe("a server older than this page", () => {
  it("opens the spec page when the project view has no gate field at all", async () => {
    const { gate: _gate, ...older } = edge();
    const slot = await mountPage("edge", { project: () => older as ProjectView, specVersion: () => specVersionView() });
    await openSpec(slot);
    await found(slot, "[data-spec-page]");
    expect(slot.container.querySelector("[data-gate]")).toBeNull();
    expect(slot.queryByRole("button", { name: "Open the gate" })).toBeNull();
  });
});

describe("Spec's error state", () => {
  it("says which version did not load, what still works and that comments are kept, with the raw error folded", async () => {
    const specVersion = vi.fn((input: { version?: number }) => {
      if (input.version === undefined) throw new Error("Unexpected token < in JSON at position 0");
      return specVersionView();
    });
    const project = projectView({ spec: { ...projectView().spec, version: 20, pendingVersion: 21 }, next: { stage: 5, tone: "normal", title: "v21 waits for your approval.", text: "", action: { control: "approve", label: "Approve v21", version: 21, confirm: "Yes, approve v21" } } });
    const slot = await mountPage("csv", { project: () => project, specVersion });
    await openSpec(slot);
    const error = await found(slot, "[data-spec-error]");
    expect(within(error).getByRole("heading", { name: "Spec v21 did not load" })).not.toBeNull();
    expect(error.querySelector("[data-kept-comments]")!.textContent).toBe("none unsent");
    expect(error.querySelector("[data-raw-error]")!.hasAttribute("open")).toBe(false);
    expect(error.querySelector("[data-raw-error]")!.textContent).toContain("Unexpected token <");
    expect(error.textContent).toContain("bb loom spec csv --version 21");
    // Approve from the project line now says the person approves v21 without having read it.
    const approve = slot.getAllByRole("button", { name: "Approve v21" })[0]!;
    fireEvent.click(approve);
    expect(slot.getByRole("button", { name: "Yes, approve v21 unread" })).not.toBeNull();
    // The version in force is one click away, and Retry reads the pending one again.
    fireEvent.click(within(error).getByRole("button", { name: "Read v20 · in force" }));
    await waitFor(() => expect(calls(slot, "specVersion").at(-1)!.input).toMatchObject({ slug: "csv", version: 20 }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-error]")).toBeNull());
  });
});

describe("review fixes", () => {
  // jsdom has no matchMedia: define one that answers the reduced-motion query, and take it away after.
  const reduce = (on: boolean) => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({ matches: on && query.includes("reduce"), media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) });
    return { mockRestore: () => Reflect.deleteProperty(window, "matchMedia") };
  };
  const pending = () => projectView({ spec: { ...projectView().spec, version: 1, pendingVersion: 2 } });
  const twoVersions = () => specVersionView({ versions: [{ version: 1, status: "approved" }, { version: 2, status: "pending" }] } as Partial<ReturnType<typeof specVersionView>>);

  it.each([
    [true, "auto"],
    [false, "smooth"],
  ])("jumps to a Spec section at once under reduced motion (%s), and smoothly otherwise", async (reduced, behavior) => {
    const spy = reduce(reduced);
    const scroll = vi.fn();
    const before = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    const slot = await mountPage("csv", { project: pending, specVersion: twoVersions });
    await openSpec(slot);
    const jump = await found(slot, '[data-section-jump="guardrails"]');
    fireEvent.click(jump);
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ behavior }));
    Element.prototype.scrollIntoView = before;
    spy.mockRestore();
  });

  it("gives a phone one version picker in place of a row of small buttons, and reads the version picked", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const specVersion = vi.fn(() => twoVersions());
    const slot = await mountPage("csv", { project: pending, specVersion });
    await openSpec(slot);
    const picker = (await found(slot, "[data-version-select]")) as HTMLSelectElement;
    expect(slot.queryByRole("group", { name: "Spec versions" })).toBeNull();
    expect([...picker.options].map((option) => option.textContent)).toEqual(["v1 approved", "v2 pending"]);
    expect(picker.className).toContain("min-h-11");
    fireEvent.change(picker, { target: { value: "1" } });
    await waitFor(() => expect(calls(slot, "specVersion").at(-1)!.input).toMatchObject({ slug: "csv", version: 1 }));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  });

  it("keeps a desktop version button at least 24 px high", async () => {
    const slot = await mountPage("csv", { project: pending, specVersion: twoVersions });
    await openSpec(slot);
    const group = await waitFor(() => slot.getByRole("group", { name: "Spec versions" }));
    for (const button of within(group).getAllByRole("button")) expect(button.className).toContain("min-h-6");
  });

  it("docks the gate's footer in a wrapper of its own on a phone, and sets its comment box at 16 px", async () => {
    const slot = await mountPage("edge", { project: () => edge() });
    await openSpec(slot);
    const dock = await found(slot, "[data-gate-dock]");
    expect(dock.className).toContain("@max-xl/loom:sticky");
    // The card's theme rule sets position: relative, so the card itself must not be the sticky part.
    expect(dock.querySelector("[data-gate-footer]")!.className).not.toContain("sticky");
    fireEvent.click(dock.closest("[data-gate]")!.querySelector<HTMLElement>('[data-gate-part="phase[2].goal"]')!);
    const box = await slot.findByPlaceholderText("Comment for the planner");
    expect(box.className).toContain("text-[16px]");
  });

  it("lets an armed Yes grow with its text instead of keeping the button's fixed height", async () => {
    const slot = await mountPage("edge", { project: () => edge({ overview: overview({ slug: "edge", name: "Edge keys", key: "EDGE", state: "paused" }) }) });
    await openSpec(slot);
    const footer = await found(slot, "[data-gate-footer]");
    fireEvent.click(within(footer).getByRole("button", { name: "Approve v3 · create 3 tickets" }));
    const wrapper = footer.querySelector("[data-confirm-armed]")!.parentElement!;
    expect(wrapper.className).toContain("[&_[data-confirming]]:h-auto");
    expect(wrapper.className).toContain("[&_[data-confirming]]:@max-xl/loom:flex-1");
    expect(wrapper.className).not.toContain("[&_button]:@max-xl/loom:flex-1");
  });

  it("draws a done ask step by colour, with no opacity over the whole step", async () => {
    const view = plannerViewOf({
      projectState: "running",
      approvedVersion: 2,
      ask: { id: 5, at: NOW - 60_000, why: "", open: true, steps: [{ action: "approve", version: 2, text: "Approve v2.", done: true }, { action: "other", text: "Tell the edge team.", done: false }] },
    });
    const slot = await mountPage("csv", { project: () => projectView(), plannerView: () => view, specVersion: () => specVersionView() });
    fireEvent.click(await slot.findByRole("tab", { name: "Planner" }));
    const done = await found(slot, '[data-ask-step="approve"][data-done]');
    expect(done.className).not.toMatch(/opacity-/);
    expect(done.querySelector("[data-ask-done]")!.className).toContain("text-[var(--loom-ok)]");
    expect(done.innerHTML).not.toContain("bg-success");
  });
});
