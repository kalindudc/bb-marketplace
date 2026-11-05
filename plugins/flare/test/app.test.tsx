// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type BannerDto, type FeedDto, type FlareDto } from "../src/contract";

const NOW = Date.parse("2026-11-05T12:00:00Z");

function flare(overrides: Partial<FlareDto> = {}): FlareDto {
  return {
    id: "fl_1",
    threadId: "thr_a",
    kind: "finding",
    title: "Root cause found",
    body: "",
    urgent: false,
    source: "tool",
    createdAt: NOW - 2 * 60_000,
    runId: "run_1",
    fromChild: null,
    pushed: false,
    forwarded: false,
    ...overrides,
  };
}

const run = { id: "run_1", startedAt: NOW - 10 * 60_000, endedAt: null, outcome: "running" as const, error: null, prompt: "Why is checkout slow?" };

async function app() {
  return loadPluginApp(() => import("../app"));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("registrations", () => {
  it("adds a banner to thread composers, a Flares tab and a palette command", async () => {
    const loaded = await app();
    expect(loaded.composerCustomizations).toEqual([expect.objectContaining({ id: "flare", scopes: ["thread"] })]);
    expect(loaded.tabs).toEqual([expect.objectContaining({ id: "flares", title: "Flares", icon: "flare/flare", availability: "action" })]);
  });
});

describe("the banner", () => {
  const render = async (banner: BannerDto, options: { dismiss?: () => unknown } = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const loaded = await app();
    const component = loaded.composerCustomizations[0]!.banners![0]!;
    return renderSlot(
      component,
      {},
      {
        experimental_rpcContract: rpcContract,
        rpc: { banner: () => banner, dismiss: options.dismiss ?? (() => ({ ok: true as const })) },
        composer: { scope: { kind: "thread", threadId: "thr_a" } },
        experimental_panel: { openTab: () => true },
      },
    );
  };

  it("shows nothing until a flare arrives", async () => {
    const slot = await render({ flare: null, count: 0, childCount: 0, run });
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(screen.queryByLabelText("Latest flare")).toBeNull();
  });

  it("shows the newest flare, how many more there are, and its detail on click", async () => {
    const slot = await render({ flare: flare({ body: "The **cache key** drops the locale." }), count: 3, childCount: 0, run });
    expect(await screen.findByText("Root cause found")).toBeTruthy();
    expect(screen.getByText("2 min ago")).toBeTruthy();
    fireEvent.click(screen.getByText("+2 more"));
    expect(slot.inspection.experimental_panelCalls).toEqual([expect.objectContaining({ method: "openTab" })]);
    fireEvent.click(screen.getByText("Root cause found"));
    expect(await screen.findByText(/drops the locale/)).toBeTruthy();
  });

  it("says when the turn failed and which child sent the flare", async () => {
    await render({
      flare: flare({ kind: "blocker", fromChild: { threadId: "thr_child", title: "Check the logs" } }),
      count: 1,
      childCount: 1,
      run: { ...run, outcome: "failed", endedAt: NOW, error: "Connection error." },
    });
    expect(await screen.findByText("Turn failed · Blocker")).toBeTruthy();
    expect(screen.getByText("from Check the logs")).toBeTruthy();
  });

  it("does not mark a flare that arrived after a failed turn as part of it", async () => {
    await render({
      flare: flare({ createdAt: NOW - 60_000 }),
      count: 1,
      childCount: 0,
      run: { ...run, outcome: "failed", endedAt: NOW - 120_000, error: "boom" },
    });
    expect(await screen.findByText("Finding")).toBeTruthy();
    expect(screen.queryByText(/Turn failed/)).toBeNull();
  });

  it("dismisses through the shown flare and hides at once", async () => {
    const dismiss = vi.fn(() => ({ ok: true as const }));
    await render({ flare: flare(), count: 1, childCount: 0, run }, { dismiss });
    fireEvent.click(await screen.findByLabelText("Dismiss"));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith({ threadId: "thr_a", through: NOW - 2 * 60_000 }));
  });
});

describe("the Flares tab", () => {
  const render = async (feed: FeedDto) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const loaded = await app();
    const tab = loaded.tabs[0]!;
    return renderSlot(tab as { component: React.ComponentType<{ threadId: string; params: null; environment: null }> }, { threadId: "thr_a", params: null, environment: null }, {
      experimental_rpcContract: rpcContract,
      rpc: { feed: () => feed },
    });
  };

  it("explains what flares are when there are none", async () => {
    await render({ flares: [], runs: [], truncated: false });
    expect(await screen.findByText("No flares yet")).toBeTruthy();
  });

  it("groups flares by turn, with the message that started it, and copies them as Markdown", async () => {
    const slot = await render({
      flares: [
        flare({ id: "fl_2", title: "Patch ready", kind: "progress", createdAt: NOW - 60_000 }),
        flare({ id: "fl_1", title: "Root cause found", body: "Cache key" }),
      ],
      runs: [run],
      truncated: false,
    });
    expect(await screen.findByText("Why is checkout slow?")).toBeTruthy();
    const titles = [...document.querySelectorAll("article p:first-child")].map((node) => node.textContent);
    expect(titles).toEqual(["Root cause found", "Patch ready"]);
    fireEvent.click(screen.getByText("Copy all"));
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toHaveLength(1));
    const text = slot.inspection.experimental_clipboardWrites[0]!.text;
    expect(text).toContain("> Why is checkout slow?");
    expect(text).toContain("- **Finding** · Root cause found");
    expect(text).toContain("  Cache key");
  });
});
