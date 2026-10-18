import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderSlot, type PluginSdkTestFakes, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { useSdk, type PluginProvidersState, type PluginSidebarPullRequest, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { InfoCardProvider } from "../src/info-card";
import { resetInfoCache } from "../src/info-data";
import type { InfoCardMode } from "../src/settings";
import { ThreadRow, type ThreadRowProps } from "../src/thread-row";
import { DEFAULT_SETTINGS } from "../src/settings";
import { rowState } from "../src/status";
import { sidebarSection, sidebarThread } from "./fixtures";

const DAY = 86_400_000;
const NOW = 10 * DAY;
const environment = { id: "e", name: null, branchName: "kalindudc/hover-card", path: "/w", isWorktree: true, providerId: null, workspaceDisplayKind: null };
const host = { id: "h", name: "MacBook Pro" };
const thread = sidebarThread({ id: "t", displayTitle: "Hover card", title: "Hover card", sectionId: null, parentThreadId: "p",
  environment, host, createdAt: NOW - 2 * DAY, updatedAt: NOW - 4 * DAY, latestAttentionAt: NOW - 4 * DAY, lastReadAt: NOW - DAY });
const waiting = { ...thread, hasPendingInteraction: true, indicator: "waiting-for-input" as const };
const threads = [thread, sidebarThread({ id: "p", displayTitle: "Sidebar redesign", title: "Sidebar redesign", sectionId: "s" }),
  sidebarThread({ id: "c1", parentThreadId: "t", status: "active" }), sidebarThread({ id: "c2", parentThreadId: "t" })];
const providers = [{ id: "pi", displayName: "Pi", reasoningLevels: [{ id: "xhigh", label: "Extra high" }] }] as unknown as PluginProvidersState["providers"];
const pullRequest = { number: 12, title: "Card", url: "https://example.com/12", state: "open", attention: "review_requested",
  experimental_autoMerge: false, experimental_inMergeQueue: null, experimental_checks: { state: "passing" },
  experimental_review: { state: "approved" }, experimental_mergeability: { state: "mergeable" } } satisfies PluginSidebarPullRequest;

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const values = {
  options: { model: "anthropic/claude-opus-5", reasoningLevel: "xhigh", permissionMode: "full" as const, serviceTier: "default", source: "client/turn/start" as const },
  context: { usage: { usedTokens: 109_000, modelContextWindow: 1_000_000, estimated: false, cost: { amount: 1.5, currency: "USD" } } },
  outline: { maxSeq: 4, items: [
    { id: "1", role: "user" as const, preview: "Add a **hover** card", attachmentSummary: null },
    ...Array.from({ length: 2 }, (_, index) => ({ id: `u${index}`, role: "user" as const, preview: "More", attachmentSummary: null })),
    ...Array.from({ length: 99 }, (_, index) => ({ id: `a${index}`, role: "assistant" as const, preview: index === 98 ? "All `green`." : "Working", attachmentSummary: null })),
  ] },
  interactions: [{ id: "i", threadId: "t", turnId: "u", createdAt: 1, status: "pending", statusReason: null, resolvedAt: null, resolution: null,
    providerId: "pi", providerRequestId: "r", providerThreadId: "x", payload: { kind: "approval", availableDecisions: ["allow_once"], reason: null,
      subject: { kind: "command", itemId: "c", command: "terraform plan", cwd: null, actions: [], sessionGrant: null } } }],
  environment: { mergeBaseBranch: "origin/main" },
  status: { outcome: "available", workspace: { branch: { currentBranch: "b", defaultBranch: "main" }, checkout: { kind: "branch", branchName: "b", headSha: null },
    mergeBase: { aheadCount: 1, behindCount: 4, baseRef: "abc", commits: [], deletions: 71, fileCount: 21, files: [], hasCommittedUnmergedChanges: true,
      insertions: 2621, lineStatsComplete: true, mergeBaseBranch: "origin/main" },
    workingTree: { deletions: 0, fileCount: 0, files: [], hasUncommittedChanges: false, insertions: 0, lineStatsComplete: true, state: "committed_unmerged" } } },
};

function sdkFakes() {
  const pending = { options: deferred<unknown>(), context: deferred<unknown>(), outline: deferred<unknown>(),
    interactions: deferred<unknown>(), environment: deferred<unknown>(), status: deferred<unknown>() };
  const sdk = {
    threads: {
      defaultExecutionOptions: () => pending.options.promise, context: () => pending.context.promise,
      conversationOutline: () => pending.outline.promise, interactions: { list: () => pending.interactions.promise },
    },
    environments: { get: () => pending.environment.promise, status: () => pending.status.promise },
  } as unknown as PluginSdkTestFakes;
  const resolveAll = () => act(async () => {
    for (const key of Object.keys(pending) as (keyof typeof pending)[]) pending[key].resolve(values[key]);
  });
  return { sdk, pending, resolveAll };
}

function Harness({ mode, isSuppressed, ...props }: ThreadRowProps & { mode: InfoCardMode; isSuppressed(): boolean }) {
  return <InfoCardProvider mode={mode} sdk={useSdk()} isSuppressed={isSuppressed}><ThreadRow {...props} /></InfoCardProvider>;
}

function mount(mode: InfoCardMode, options: { row?: PluginSidebarThread; stale?: boolean; isSuppressed?: () => boolean } & Pick<RenderSlotOptions, "sdk"> = {}) {
  const shown = options.row ?? thread;
  const props = { mode, isSuppressed: options.isSuppressed ?? (() => false), settings: DEFAULT_SETTINGS, now: NOW, projectName: "Marketplace",
    isActive: false, onNavigate: vi.fn(), stale: options.stale ?? false,
    row: { thread: shown, state: rowState(shown), depth: 0, guides: "", isLast: true, childCount: 0, collapsed: false,
      rollup: null, rollupCount: 0, crossProject: null, dim: false } };
  const slot = renderSlot({ component: Harness }, props, { sidebarThreads: { threads, sections: [sidebarSection("s", "cortex")] },
    providers: { status: "ready", providers }, sidebarPullRequests: { t: pullRequest }, sdk: options.sdk ?? sdkFakes().sdk });
  const link = screen.getByRole("link", { name: "Hover card" });
  return { slot, link, row: slot.container.querySelector<HTMLElement>("[data-sb-row]")! };
}

function focus(link: HTMLElement) {
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => link.focus());
}
const card = () => document.querySelector<HTMLElement>(".sb-info-card");
const methods = (slot: ReturnType<typeof mount>["slot"]) => slot.inspection.sdkCalls.map((call) => call.method);

afterEach(() => { cleanup(); resetInfoCache(); vi.useRealTimers(); });

describe("info card", () => {
  it("opens nothing when off, and keeps the stale row's browser tooltip only then", () => {
    const off = mount("off", { stale: true });
    focus(off.link);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(off.row.getAttribute("title")).toBe("Idle for 4 days");
    off.slot.unmount();
    const on = mount("glance", { stale: true });
    expect(on.row.hasAttribute("title")).toBe(false);
    focus(on.link);
    expect(within(card()!).getByText("Idle for 4 days")).toBeTruthy();
  });

  it("paints free fields at once and fills fetched ones in place, without the outline, at a glance", async () => {
    const { sdk, resolveAll } = sdkFakes();
    const { slot, link } = mount("glance", { sdk });
    focus(link);
    await screen.findByRole("tooltip");
    const view = within(card()!);
    expect(card()!.className).toContain("sb-info-glance");
    expect(view.getByText("Hover card")).toBeTruthy();
    expect(view.getByText("Marketplace › cortex")).toBeTruthy();
    expect(view.getByText("↳ Child of Sidebar redesign")).toBeTruthy();
    expect(view.getByText("kalindudc/hover-card")).toBeTruthy();
    expect(view.getByText("#12 Open")).toBeTruthy();
    expect(card()!.querySelectorAll(".sb-info-skeleton")).toHaveLength(3);
    await resolveAll();
    expect(await view.findByText("claude-opus-5 · Extra high")).toBeTruthy();
    expect(view.getByText("109k / 1M · 11%")).toBeTruthy();
    expect(await view.findByText(/· 21 files/)).toBeTruthy();
    expect(card()!.querySelectorAll(".sb-info-skeleton")).toHaveLength(0);
    expect(methods(slot)).not.toContain("threads.conversationOutline");
    expect(methods(slot).filter((method) => method.includes("interactions"))).toEqual([]);
  });

  it("summarises the conversation and says what a waiting thread needs, in the briefing", async () => {
    const { sdk, resolveAll } = sdkFakes();
    const { link } = mount("briefing", { sdk, row: waiting });
    focus(link);
    await screen.findByRole("tooltip");
    const view = within(card()!);
    await resolveAll();
    expect(await view.findByText("Add a hover card")).toBeTruthy();
    expect(view.getByText("All green.")).toBeTruthy();
    expect(view.getByText("3 prompts · 99 replies")).toBeTruthy();
    expect(view.getByText(/Approve command: terraform plan/)).toBeTruthy();
    expect(view.getByText("Full Access")).toBeTruthy();
    expect(view.getByText("worktree").parentElement!.classList.contains("sb-info-single")).toBe(true);
    const css = readFileSync(join(process.cwd(), "src/switchboard.css"), "utf8");
    expect(css.match(/\.sb-info-single\s*\{([^}]*)\}/)?.[1]).toMatch(/flex-wrap:\s*nowrap/);
    expect(view.getByText("↳ 2 children · 1 running")).toBeTruthy();
    expect(view.getByText("Checks passing")).toBeTruthy();
    expect(view.getByText("Created 2d ago · MacBook Pro")).toBeTruthy();
  });

  it("shows provider, permissions and cost in full details", async () => {
    const { sdk, resolveAll } = sdkFakes();
    const { link } = mount("full", { sdk });
    focus(link);
    await screen.findByRole("tooltip");
    const view = within(card()!);
    expect(card()!.className).toContain("sb-info-full");
    expect(view.getByText("Pi")).toBeTruthy();
    await resolveAll();
    expect(await view.findByText("Full Access")).toBeTruthy();
    const cost = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(1.5);
    expect(view.getByText(new RegExp(`· ${cost.replace(/[$.]/g, "\\$&")}`))).toBeTruthy();
    expect(await view.findByText("↑1 ↓4 vs origin/main")).toBeTruthy();
    expect(view.getByText("Managed worktree")).toBeTruthy();
    expect(view.getByText("#12 Open · Checks passing · Approved")).toBeTruthy();
  });

  it("delays git status by 250 ms, reuses results when reopened, and marks failures unavailable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    const calls: string[] = [];
    const sdk = {
      threads: { defaultExecutionOptions: async () => { calls.push("options"); throw new Error("down"); },
        context: async () => { calls.push("context"); return values.context; } },
      environments: { get: async () => { calls.push("get"); return values.environment; },
        status: async () => { calls.push("status"); return values.status; } },
    } as unknown as PluginSdkTestFakes;
    const { link } = mount("glance", { sdk });
    focus(link);
    await act(async () => { await Promise.resolve(); });
    expect(calls).toEqual(["options", "context"]);
    await act(async () => { vi.advanceTimersByTime(249); });
    expect(calls).not.toContain("get");
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(calls).toEqual(["options", "context", "get", "status"]);
    const view = within(card()!);
    expect(view.getByText("Unavailable")).toBeTruthy();
    expect(view.getByText("109k / 1M · 11%")).toBeTruthy();
    expect(view.getByText(/· 21 files/)).toBeTruthy();
    act(() => link.blur());
    expect(card()).toBeNull();
    calls.length = 0;
    await act(async () => { vi.advanceTimersByTime(1_000); });
    focus(link);
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(calls).toEqual(["options"]);
    expect(within(card()!).getByText("109k / 1M · 11%")).toBeTruthy();
  });

  it("closes on pointer down, stays closed while suppressed, and holds only labelled text", async () => {
    const { slot, link } = mount("glance");
    focus(link);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("Idle, Marketplace, branch kalindudc/hover-card");
    expect(within(card()!).queryAllByRole("link")).toEqual([]);
    expect(within(card()!).queryAllByRole("button")).toEqual([]);
    act(() => link.blur());
    // Press before Radix's outside-press listener registers (one tick after opening), and with
    // the default prevented as the drag handler does, so only the trigger's own handler can close it.
    focus(link);
    expect(card()).not.toBeNull();
    link.addEventListener("pointerdown", (event) => event.preventDefault(), { once: true });
    fireEvent.pointerDown(link, { pointerType: "mouse", button: 0 });
    expect(card()).toBeNull();
    slot.unmount();
    const suppressed = mount("glance", { isSuppressed: () => true });
    focus(suppressed.link);
    expect(card()).toBeNull();
  });
});
