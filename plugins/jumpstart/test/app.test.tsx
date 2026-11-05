// @vitest-environment jsdom
import type { ExperimentalSidebarFooterDisclosureProps, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type KickResult } from "../src/contract";
import type { Failure } from "../src/failure";

const NOW = Date.parse("2026-11-05T12:00:00Z");

function sidebarThread(overrides: Partial<PluginSidebarThread>): PluginSidebarThread {
  const id = overrides.id ?? "thr";
  return {
    id, projectId: "p", title: "Thread", titleFallback: null, displayTitle: overrides.title ?? "Thread",
    parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null, parentNotifications: "auto",
    sectionId: null, originKind: null, originPluginId: null, providerId: "pi",
    status: "error", runtimeStatus: "error", queuedWork: "none", hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false, pinnedAt: null,
    pinSortKey: null, isArchived: false, archivedAt: null, href: `/projects/p/threads/${id}`,
    isHidden: false, environment: null, host: null, createdAt: 1000, updatedAt: 1000,
    lastReadAt: null, latestAttentionAt: 1000,
    ...overrides,
  };
}

const threads = [
  sidebarThread({ id: "thr_net", title: "Fix the flaky test" }),
  sidebarThread({ id: "thr_model", title: "Pick a model" }),
  sidebarThread({ id: "thr_queued", title: "Already waiting", queuedWork: "waiting" }),
  sidebarThread({ id: "thr_older", title: "Older blip" }),
  sidebarThread({ id: "thr_idle", title: "Finished", status: "idle" }),
  sidebarThread({ id: "thr_hidden", title: "Worker", isHidden: true }),
  sidebarThread({ id: "thr_archived", title: "Archived", isArchived: true, archivedAt: 1 }),
];

const failures: Record<string, Failure> = {
  thr_net: { reason: "Connection error.", failedAt: NOW - 2 * 60_000, network: true, restart: false },
  thr_model: { reason: "Ambiguous Pi model", failedAt: NOW - 5 * 60_000, network: false, restart: false },
  thr_queued: { reason: "Request timed out.", failedAt: NOW - 10 * 60_000, network: true, restart: false },
  thr_older: { reason: "socket hang up", failedAt: NOW - 3 * 3_600_000, network: true, restart: false },
};

async function panel(options: { threads?: PluginSidebarThread[]; kick?: (threadIds: string[]) => KickResult[] } = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("expected the footer disclosure");
  const kick = vi.fn(({ threadIds }: { threadIds: string[] }) => ({
    results: options.kick?.(threadIds) ?? threadIds.map((threadId) => ({ threadId, outcome: "sent" as const })),
  }));
  const slot = renderSlot<ExperimentalSidebarFooterDisclosureProps, typeof rpcContract>(item, { dismiss: () => {} }, {
    pluginId: "jumpstart",
    experimental_rpcContract: rpcContract,
    rpc: {
      failures: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, failures[key]!])),
      kick,
    },
    sidebarThreads: { status: "ready", threads: options.threads ?? threads },
  });
  await screen.findByText("Connection error.");
  return { slot, kick };
}

const box = (title: string) => screen.getByRole("checkbox", { name: new RegExp(title) });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Resume failed threads panel", () => {
  it("lists visible, unarchived failed threads, newest first, with why each failed", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    await panel();
    const titles = screen.getAllByRole("checkbox").map((checkbox) => checkbox.id);
    expect(titles).toEqual(["jumpstart-thr_net", "jumpstart-thr_model", "jumpstart-thr_queued", "jumpstart-thr_older"]);
    expect(screen.getByText("Ambiguous Pi model")).toBeTruthy();
    expect(screen.getByText("A message is already queued · Request timed out.")).toBeTruthy();
    expect(screen.getByText("2m")).toBeTruthy();
    expect(screen.getByText("3h")).toBeTruthy();
    expect(screen.queryByText("Finished")).toBeNull();
    expect(screen.queryByText("Worker")).toBeNull();
    expect(screen.queryByText("Archived")).toBeNull();
  });

  it("ticks network failures with nothing queued, and leaves the rest unticked", async () => {
    await panel();
    expect(box("Fix the flaky test").getAttribute("aria-checked")).toBe("true");
    expect(box("Older blip").getAttribute("aria-checked")).toBe("true");
    expect(box("Pick a model").getAttribute("aria-checked")).toBe("false");
    expect(box("Already waiting").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: /Resume 2 threads/ })).toBeTruthy();
  });

  it("resumes the ticked threads, including ones the user ticks and not ones they untick", async () => {
    const { kick } = await panel();
    fireEvent.click(box("Pick a model"));
    fireEvent.click(box("Older blip"));
    fireEvent.click(screen.getByRole("button", { name: /Resume 2 threads/ }));
    await waitFor(() => expect(kick).toHaveBeenCalledTimes(1));
    expect(kick.mock.calls[0]?.[0]).toEqual({ threadIds: ["thr_net", "thr_model"] });
  });

  it("selects every row with All and none with None", async () => {
    await panel();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("button", { name: /Resume 4 threads/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    const resume = screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
  });

  it("shows what happened to each thread it could not start", async () => {
    await panel({
      kick: () => [
        { threadId: "thr_net", outcome: "queued", waitingOn: "waiting for aquifer-1 to come online" },
        { threadId: "thr_older", outcome: "failed", message: "Turn req_1 already has a retry waiting." },
      ],
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Resume 2 threads/ })));
    expect(await screen.findByText("Queued: waiting for aquifer-1 to come online")).toBeTruthy();
    expect(screen.getByText("Could not resume: Turn req_1 already has a retry waiting.")).toBeTruthy();
    expect(box("Older blip").getAttribute("aria-checked")).toBe("true");
  });

  it("opens a thread from its row", async () => {
    const { slot } = await panel();
    fireEvent.click(screen.getByRole("button", { name: "Open Pick a model" }));
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread", threadId: "thr_model" }));
  });

  it("says so when nothing failed", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const item = app.experimentalSidebarFooterItems[0];
    if (item?.kind !== "disclosure") throw new Error("expected the footer disclosure");
    renderSlot<ExperimentalSidebarFooterDisclosureProps, typeof rpcContract>(item, { dismiss: () => {} }, {
      pluginId: "jumpstart",
      experimental_rpcContract: rpcContract,
      rpc: { failures: () => ({}), kick: () => ({ results: [] }) },
      sidebarThreads: { status: "ready", threads: [sidebarThread({ id: "thr_idle", status: "idle" })] },
    });
    expect(await screen.findByText("No failed threads.")).toBeTruthy();
  });
});
