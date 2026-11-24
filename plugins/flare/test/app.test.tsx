// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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
    drawn: false,
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

function banner(overrides: Partial<BannerDto> = {}): BannerDto {
  const top = overrides.flare === undefined ? flare() : overrides.flare;
  return { flare: top, flares: top === null ? [] : [top], count: top === null ? 0 : 1, childCount: 0, fresh: 0, run, ...overrides };
}

describe("registrations", () => {
  it("adds a segment to the thread's context row, a Flares tab and a palette command", async () => {
    const loaded = await app();
    expect(loaded.composerCustomizations).toEqual([]);
    expect(loaded.threadContextSegments).toEqual([expect.objectContaining({ id: "flares", title: "Flares", group: "2_flare" })]);
    expect(loaded.tabs).toEqual([expect.objectContaining({ id: "flares", title: "Flares", icon: "flare/flare", availability: "action" })]);
  });
});

describe("the context segment", () => {
  const render = async (data: BannerDto, options: { dismiss?: (input: unknown) => unknown; look?: (input: unknown) => unknown; expanded?: boolean } = {}) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const loaded = await app();
    const registration = loaded.threadContextSegments[0]!;
    const Summary = registration.summary;
    const Details = registration.details!;
    const useVisible = registration.useVisible!;
    function Segment() {
      const [expanded, setExpanded] = useState(options.expanded ?? false);
      const input = { threadId: "thr_a", projectId: "proj_a", environment: null };
      const visible = useVisible(input);
      const props = { ...input, segments: [], isExpanded: expanded, onToggle: () => setExpanded(!expanded) };
      return (
        <div data-visible={visible} data-expanded={expanded}>
          <Summary {...props} />
          <Details {...props} />
        </div>
      );
    }
    return renderSlot(
      { component: Segment },
      {},
      {
        experimental_rpcContract: rpcContract,
        rpc: {
          banner: () => data,
          dismiss: options.dismiss ?? (() => ({ ok: true as const })),
          look: options.look ?? (() => ({ ok: true as const })),
        },
        experimental_panel: { openTab: () => true },
      },
    );
  };

  it("is hidden until a flare arrives", async () => {
    const slot = await render(banner({ flare: null }));
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.container.querySelector("[data-visible]")?.getAttribute("data-visible")).toBe("false");
    expect(slot.container.querySelector("[data-flare-segment]")).toBeNull();
  });

  it("shows the newest flare with how many arrived since the last look", async () => {
    const slot = await render(banner({ fresh: 3, count: 3 }));
    expect(await screen.findByText("Root cause found")).toBeTruthy();
    expect(slot.container.querySelector("[data-visible]")?.getAttribute("data-visible")).toBe("true");
    expect(slot.container.querySelector("[data-flare-fresh]")?.textContent).toBe("· 3 new");
    const toggle = screen.getByRole("button", { name: /Flare: Finding: Root cause found, 2 min ago, 3 new since you last looked/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens to the newest flare, marks the new ones and records the look", async () => {
    const top = flare({ id: "fl_top", kind: "blocker", title: "Staging refuses connections", body: "The **pool** is full.", createdAt: NOW - 30_000 });
    const decision = flare({ id: "fl_d", kind: "decision", title: "Going with Postgres", createdAt: NOW - 60_000 });
    const old = flare({ id: "fl_old", title: "Pool size is 10", createdAt: NOW - 90_000 });
    const look = vi.fn(() => ({ ok: true as const }));
    const slot = await render(banner({ flare: top, flares: [top, decision, old], count: 3, fresh: 2 }), { look });
    fireEvent.click(await screen.findByRole("button", { name: /^Flare: Blocker: Staging refuses connections/ }));
    expect(await screen.findByText(/is full/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blocker: Staging refuses connections, just now, new since you last looked" }).getAttribute("aria-expanded")).toBe("true");
    expect(slot.container.querySelectorAll("[data-flare-marked]")).toHaveLength(2);
    await waitFor(() => expect(look).toHaveBeenCalledWith({ threadId: "thr_a", through: NOW - 30_000 }));
    // Another row opens in its place; the open one closes again.
    fireEvent.click(screen.getByRole("button", { name: /^Finding: Pool size is 10/ }));
    expect(screen.queryByText(/is full/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Finding: Pool size is 10/ }));
    expect(screen.getByRole("button", { name: /^Finding: Pool size is 10/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses an open list before dismissing, so the next flare is not counted as seen", async () => {
    const dismiss = vi.fn(() => ({ ok: true as const }));
    const look = vi.fn(() => ({ ok: true as const }));
    await render(banner(), { dismiss, look, expanded: true });
    expect(document.querySelector("[data-expanded]")?.getAttribute("data-expanded")).toBe("true");
    expect(await screen.findByRole("region", { name: "This turn's flares" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Flare until the next flare" }));
    await waitFor(() => expect(dismiss).toHaveBeenCalled());
    expect(document.querySelector("[data-expanded]")?.getAttribute("data-expanded")).toBe("false");
  });

  it("keeps flares newer than a pending dismissal or look in its prediction", async () => {
    const { dismissedThrough, lookedThrough } = await import("../src/ui/segment");
    const newer = flare({ id: "fl_new", title: "Arrived meanwhile", createdAt: NOW, fromChild: { threadId: "thr_c", title: "Child" } });
    const older = flare();
    const read = banner({ flare: newer, flares: [newer, older], count: 2, childCount: 1, fresh: 2 });
    expect(dismissedThrough(older.createdAt)(read)).toMatchObject({ flare: { id: "fl_new" }, flares: [{ id: "fl_new" }], count: 1, childCount: 1, fresh: 1 });
    expect(dismissedThrough(newer.createdAt)(read)).toMatchObject({ flare: null, flares: [], count: 0, fresh: 0 });
    expect(lookedThrough(older.createdAt)(read).fresh).toBe(1);
    expect(lookedThrough(newer.createdAt)(read).fresh).toBe(0);
  });

  it("dismisses from the row without opening the list", async () => {
    const dismiss = vi.fn(() => ({ ok: true as const }));
    await render(banner({ fresh: 1 }), { dismiss });
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss Flare until the next flare" }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith({ threadId: "thr_a", through: NOW - 2 * 60_000 }));
    expect(screen.queryByRole("region", { name: "This turn's flares" })).toBeNull();
  });

  it("opens the Flares tab and dismisses from the footer", async () => {
    const dismiss = vi.fn(() => ({ ok: true as const }));
    const look = vi.fn(() => ({ ok: true as const }));
    const slot = await render(banner({ count: 12 }), { dismiss, look, expanded: true });
    expect(await screen.findByText("11 earlier flares this turn in the Flares tab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Flares tab" }));
    expect(slot.inspection.experimental_panelCalls).toEqual([expect.objectContaining({ method: "openTab" })]);
    await waitFor(() => expect(look).toHaveBeenCalledWith({ threadId: "thr_a", through: NOW - 2 * 60_000 }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss until next flare" }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith({ threadId: "thr_a", through: NOW - 2 * 60_000 }));
  });

  it("says when the turn failed, and links the child that sent the flare", async () => {
    const slot = await render(
      banner({
        flare: flare({ kind: "blocker", body: "Cannot reach the database.", fromChild: { threadId: "thr_child", title: "Check the logs" } }),
        run: { ...run, outcome: "failed", endedAt: NOW, error: "Connection error." },
      }),
      { expanded: true },
    );
    expect((await screen.findByRole("alert")).textContent).toBe("Turn failed after its last flare. Connection error.");
    expect(screen.getByRole("button", { name: /^Flare: turn failed, Blocker/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open child thread: Check the logs" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_child" });
  });

  it("does not mark a flare that arrived after a failed turn as part of it", async () => {
    await render(banner({ flare: flare({ createdAt: NOW - 60_000 }), run: { ...run, outcome: "failed", endedAt: NOW - 120_000, error: "boom" } }), { expanded: true });
    expect(await screen.findByRole("region", { name: "This turn's flares" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /^Flare: Finding/ })).toBeTruthy();
  });

  it("previews only the prose and points at the Flares tab for blocks", async () => {
    await render(banner({ flare: flare({ body: "The chart is ready.\n\n```ui\nChart(\"bar\", [], [1])\n```" }) }), { expanded: true });
    expect(await screen.findByText("The chart is ready.")).toBeTruthy();
    expect(screen.getByText("1 view in the Flares tab")).toBeTruthy();
    expect(screen.queryByText(/Chart\(/)).toBeNull();
  });

  it("keeps narrow composers to the glyph, the count and the dismiss button", async () => {
    const slot = await render(banner({ flare: flare({ fromChild: { threadId: "thr_child", title: "Child" } }), fresh: 2 }));
    await screen.findByText("Root cause found");
    expect(slot.container.querySelector("[data-flare-title]")?.className).toContain("@max-[24rem]/promptbox-shell:hidden");
    expect(slot.container.querySelector("[data-flare-metadata]")?.className).toContain("@max-[44rem]/promptbox-shell:hidden");
    expect(slot.container.querySelector("[data-flare-fresh]")?.className).not.toContain("hidden");
  });
});

describe("dividers in the rendered view", () => {
  it("draws a divider with the flare's time over each companion message, and the turn's header over its first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const loaded = await app();
    const registration = loaded.messageMetadata.find((entry) => entry.id === "divider")!;
    expect(registration.placement).toBe("above");
    const { publishMarks } = await import("../src/ui/dividers");
    const section = { key: "run_1", run, flares: [], latestAt: 0 };
    publishMarks("thr_companion", new Map([["t1", { flare: flare({ createdAt: NOW - 14 * 60_000 }), section, first: true }], ["t2", { flare: flare({ id: "fl_2" }), section, first: false }]]));
    const message = (turnId: string | null, threadId = "thr_companion") => ({ id: `m_${turnId}`, threadId, createdAt: NOW, turnId, role: "assistant" as const });

    const first = renderSlot(registration, { message: message("t1") });
    expect(first.container.querySelector("[data-flare-turn]")?.textContent).toContain("Why is checkout slow?");
    expect(first.container.querySelector("[data-flare-divider]")?.textContent).toContain("14 min ago");
    first.lifecycle.unmount();

    const second = renderSlot(registration, { message: message("t2") });
    expect(second.container.querySelector("[data-flare-turn]")).toBeNull();
    expect(second.container.querySelector("[data-flare-divider]")?.textContent).toContain("2 min ago");
    second.lifecycle.unmount();

    publishMarks("thr_companion", new Map([["t3", { flare: flare({ kind: "blocker", fromChild: { threadId: "thr_child", title: "Check the logs" } }), section, first: false }]]));
    const child = renderSlot(registration, { message: message("t3") });
    expect(child.container.querySelector("[data-flare-divider]")?.textContent).toMatch(/^Blocker·.*2 min ago·from Check the logs$/);
    child.lifecycle.unmount();

    // Any other thread's messages, and turns Flare knows nothing about, get nothing.
    expect(renderSlot(registration, { message: message("t1", "thr_other") }).container.innerHTML).toBe("");
    expect(renderSlot(registration, { message: message("t9") }).container.innerHTML).toBe("");
    publishMarks("thr_companion", null);
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
      rpc: { feed: () => feed, marks: () => ({ companionThreadId: feed.companionThreadId, marks: {} }) },
    });
  };

  it("shows the companion as bb draws a reply, with flares it lacks as cards above, and switches to cards on request", async () => {
    await render({
      flares: [
        flare({ id: "fl_new", title: "Just sent", createdAt: NOW - 5_000 }),
        flare({ id: "fl_missed", title: "Sent before the companion", createdAt: NOW - 10 * 60_000 }),
        flare({ id: "fl_drawn", title: "Drawn", drawn: true }),
      ],
      runs: [run],
      truncated: false,
      companionThreadId: "thr_companion",
    });
    const chat = await screen.findByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-thread-id")).toBe("thr_companion");
    expect(chat.getAttribute("data-variant")).toBe("timeline");
    expect(chat.getAttribute("data-layout")).toBe("document");
    expect(screen.getByText("1 flare is on its way.")).toBeTruthy();
    expect(screen.getByTestId("bb-thread-chat-leading-content").textContent).toContain("Sent before the companion");
    expect(screen.getByTestId("bb-thread-chat-leading-content").textContent).not.toContain("Just sent");
    const toolbar = () =>
      [...document.querySelectorAll("button")]
        .map((button) => button.textContent?.trim() || button.getAttribute("aria-label") || "")
        .filter((text) => ["Rendered", "Cards"].includes(text) || /child threads' flares|Copy all/i.test(text))
        .map((text) => (/child threads/i.test(text) ? "Child threads" : text.startsWith("Copy all") ? "Copy all" : text));
    const before = toolbar();
    fireEvent.click(screen.getByText("Cards"));
    expect(screen.queryByTestId("bb-thread-chat")).toBeNull();
    expect(await screen.findByText("Drawn")).toBeTruthy();
    // The same buttons in the same places, whichever view is showing.
    expect(toolbar()).toEqual(before);
    expect(before).toEqual(["Rendered", "Cards", "Child threads", "Copy all"]);
    const titles = [...document.querySelectorAll("article p:first-child")].map((node) => node.textContent);
    expect(titles).toEqual(["Sent before the companion", "Drawn", "Just sent"]);
  });

  it("asks for child threads' flares by the toggle when there is no companion to render", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const asked: boolean[] = [];
    const own = flare({ id: "fl_own", title: "Own flare" });
    const child = flare({ id: "fl_child", title: "Child's flare", threadId: "thr_child", fromChild: { threadId: "thr_child", title: "Child" } });
    const loaded = await app();
    const tab = loaded.tabs[0]!;
    renderSlot(tab as { component: React.ComponentType<{ threadId: string; params: null; environment: null }> }, { threadId: "thr_a", params: null, environment: null }, {
      experimental_rpcContract: rpcContract,
      rpc: {
        feed: (input: unknown) => {
          const { children } = input as { children: boolean };
          asked.push(children);
          return { flares: children ? [child, own] : [own], runs: [], truncated: false, companionThreadId: null };
        },
        marks: () => ({ companionThreadId: null, marks: {} }),
      },
    });
    expect(await screen.findByText("Child's flare")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Hide child threads' flares"));
    expect(await screen.findByText("Own flare")).toBeTruthy();
    expect(screen.queryByText("Child's flare")).toBeNull();
    expect(asked.at(-1)).toBe(false);
  });

  it("counts as a look while it is showing, and not while it is hidden", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const loaded = await app();
    const tab = loaded.tabs[0]!;
    const feed = { flares: [flare({ createdAt: NOW - 5_000 }), flare({ id: "fl_2" })], runs: [run], truncated: false, companionThreadId: null };
    for (const tabVisible of [false, true]) {
      const look = vi.fn(() => ({ ok: true as const }));
      renderSlot(tab as { component: React.ComponentType<{ threadId: string; params: null; environment: null }> }, { threadId: "thr_a", params: null, environment: null }, {
        experimental_rpcContract: rpcContract,
        rpc: { feed: () => feed, marks: () => ({ companionThreadId: null, marks: {} }), look },
        tabVisible,
      });
      await screen.findAllByText("Root cause found");
      if (tabVisible) await waitFor(() => expect(look).toHaveBeenCalledWith({ threadId: "thr_a", through: NOW - 5_000 }));
      else expect(look).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("does not count a tab that hides child threads' flares as a look", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const loaded = await app();
    const tab = loaded.tabs[0]!;
    const look = vi.fn(() => ({ ok: true as const }));
    renderSlot(tab as { component: React.ComponentType<{ threadId: string; params: null; environment: null }> }, { threadId: "thr_a", params: null, environment: null }, {
      experimental_rpcContract: rpcContract,
      rpc: { feed: () => ({ flares: [flare({ title: "Own flare" })], runs: [run], truncated: false, companionThreadId: null }), marks: () => ({ companionThreadId: null, marks: {} }), look },
    });
    await screen.findByText("Own flare");
    await waitFor(() => expect(look).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText("Hide child threads' flares"));
    await screen.findByText("Own flare");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(look).toHaveBeenCalledTimes(1);
  });

  it("explains what flares are when there are none", async () => {
    await render({ flares: [], runs: [], truncated: false, companionThreadId: null });
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
      companionThreadId: null,
    });
    expect(await screen.findByText("Why is checkout slow?")).toBeTruthy();
    const titles = [...document.querySelectorAll("article p:first-child")].map((node) => node.textContent);
    expect(titles).toEqual(["Root cause found", "Patch ready"]);
    fireEvent.click(screen.getByLabelText("Copy all as Markdown"));
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toHaveLength(1));
    const text = slot.inspection.experimental_clipboardWrites[0]!.text;
    expect(text).toContain("> Why is checkout slow?");
    expect(text).toContain("- **Finding** · Root cause found");
    expect(text).toContain("  Cache key");
  });
});
