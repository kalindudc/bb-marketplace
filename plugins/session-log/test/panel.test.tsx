import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { requestPanelFocus } from "../src/commands";
import { LogRow, type LogRowProps } from "../src/log-row";
import { SessionLogPanel } from "../src/panel";
import { toLogEntries } from "../src/entries";
import { EXPANDED_STORAGE_KEY, createPreference } from "../src/preference";
import { DEFAULT_SETTINGS, SETTINGS_CHANNEL } from "../src/settings";
import type { SessionLogSdk, TimelineResponse } from "../src/types";
import {
  FakeResizeObserver, assistantRow, commandRow, fileChangeRow, reasoningRow, timelineResponse, toolRow, userRow,
} from "./fixtures";

const mounts: Array<ReturnType<typeof renderSlot>> = [];
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
  document.body.replaceChildren();
  window.localStorage.clear();
  delete (Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView;
});

function rowProps(entry: LogRowProps["entry"], overrides: Partial<LogRowProps> = {}): LogRowProps {
  return {
    entry, expanded: false, focused: true, query: "", turnStats: undefined, chatHref: null, settings: DEFAULT_SETTINGS,
    onToggle: vi.fn(), onFocusRow: vi.fn(), onCopy: vi.fn(), onOpenThread: vi.fn(),
    registerElement: vi.fn(),
    ...overrides,
  };
}

function renderRow(props: LogRowProps) {
  const slot = renderSlot({ component: LogRow }, props, { pluginId: "session-log" });
  mounts.push(slot);
  return slot;
}

describe("LogRow", () => {
  it("previews command output with status, exit code, duration and a focusable row", () => {
    const output = Array.from({ length: 12 }, (_, index) => `output ${index}`).join("\n");
    const entry = toLogEntries([commandRow("failed", { output, exitCode: 3 })])[0]!;
    const props = rowProps(entry);
    const slot = renderRow(props);
    const row = slot.container.querySelector('[data-entry-id="failed"]') as HTMLElement;
    expect(row.tabIndex).toBe(0);
    expect(row.dataset.slTint).toBe("error");
    expect(row.classList.contains("sl-tinted")).toBe(true);
    expect(row.classList.contains("hover:bg-state-hover")).toBe(false);
    expect(row.classList.contains("focus:bg-surface-selected")).toBe(false);
    expect(row.classList.contains("bg-surface-selected")).toBe(false);
    expect(row.style.contentVisibility).toBe("auto");
    expect(row.style.containIntrinsicSize).toBe("auto 48px");
    expect(slot.getByText("✗ exit 3")).toBeTruthy();
    expect(slot.getByText("500ms")).toBeTruthy();
    expect(slot.container.textContent).toContain("… 4 more lines …");
    expect(slot.container.textContent).not.toContain("output 5");
    expect(slot.container.textContent).toMatch(/\d\d:\d\d:\d\d/);
    const toggle = row.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(within(row).getByRole("button", { name: "$ npm test" })).toBe(toggle);
    expect(toggle.hasAttribute("aria-label")).toBe(false);
    fireEvent.click(toggle);
    expect(props.onToggle).toHaveBeenCalledWith("failed");
  });

  it("tints rows by kind, keeps icons colored when tints are off, and leaves thinking and dividers alone", () => {
    const rowOf = (slot: ReturnType<typeof renderRow>) => slot.container.querySelector("[data-entry-id]") as HTMLElement;
    const tool = toLogEntries([toolRow("tool")])[0]!;
    const tinted = rowOf(renderRow(rowProps(tool)));
    expect(tinted.dataset.slTint).toBe("tool");
    expect(tinted.classList.contains("sl-tinted")).toBe(true);
    expect(tinted.querySelector("[data-icon]")?.classList.contains("sl-tint-icon")).toBe(true);

    const plain = rowOf(renderRow(rowProps(tool, { settings: { ...DEFAULT_SETTINGS, tintRows: false } })));
    expect(plain.dataset.slTint).toBe("tool");
    expect(plain.classList.contains("sl-tinted")).toBe(false);
    expect(plain.classList.contains("hover:bg-state-hover")).toBe(true);
    expect(plain.classList.contains("focus:bg-surface-selected")).toBe(true);
    expect(plain.querySelector("[data-icon]")?.classList.contains("sl-tint-icon")).toBe(true);

    const [thought, divider] = [reasoningRow("thought"), userRow("request")]
      .map((row) => rowOf(renderRow(rowProps(toLogEntries([row])[0]!))));
    for (const row of [thought!, divider!]) {
      expect(row.hasAttribute("data-sl-tint")).toBe(false);
      expect(row.classList.contains("sl-tinted")).toBe(false);
      expect(row.querySelector(".sl-tint-icon")).toBeNull();
    }
    expect(divider!.classList.contains("bg-surface-recessed")).toBe(true);
  });

  it("clips long incoming Markdown but renders agent replies in full", () => {
    const text = Array.from({ length: 14 }, (_, index) => `paragraph ${index}`).join("\n");
    const incoming = toLogEntries([userRow("request", { text })])[0]!;
    const incomingProps = rowProps(incoming);
    const slot = renderRow(incomingProps);
    expect(slot.container.querySelector(".max-h-48.overflow-hidden")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Show more" }));
    expect(incomingProps.onToggle).toHaveBeenCalledWith("request");

    const reply = toLogEntries([assistantRow("reply", { text })])[0]!;
    const full = renderRow(rowProps(reply));
    expect(full.container.querySelector(".max-h-48.overflow-hidden")).toBeNull();
    expect(full.container.textContent).toContain("paragraph 13");
  });

  it("clamps a collapsed thought to three visual lines without repeating its duration", () => {
    const thought = toLogEntries([reasoningRow("thought", { detail: "one\ntwo\nthree\nfour\nfive" })])[0]!;
    const collapsed = renderRow(rowProps(thought));
    const body = collapsed.container.querySelector("pre")!;
    expect(body.style.getPropertyValue("-webkit-line-clamp")).toBe("3");
    expect(body.textContent).toBe("one\ntwo\nthree\nfour\nfive");
    expect(collapsed.container.textContent).not.toContain("more lines");
    expect(collapsed.queryByText("✓")).toBeNull();
    expect(collapsed.queryByText("1s")).toBeNull();
    const expandedThought = renderRow(rowProps(thought, { expanded: true }));
    expect(expandedThought.container.querySelector("pre")!.style.getPropertyValue("-webkit-line-clamp")).toBe("");
    const titleOnly = renderRow(rowProps(thought, { settings: { ...DEFAULT_SETTINGS, thinkingLines: 0 } }));
    expect(titleOnly.container.querySelector("pre")).toBeNull();
  });

  it("uses the preview sizes and time format from settings", () => {
    const output = Array.from({ length: 12 }, (_, index) => `output ${index}`).join("\n");
    const entry = toLogEntries([commandRow("cmd", { output })])[0]!;
    const slot = renderRow(rowProps(entry, {
      settings: { ...DEFAULT_SETTINGS, outputHeadLines: 1, outputTailLines: 2, timeFormat: "12h" },
    }));
    const text = slot.container.textContent ?? "";
    expect(text).toContain("output 0");
    expect(text).not.toContain("output 1\n");
    expect(text).toContain("… 9 more lines …");
    expect(text).toContain("output 10");
    expect(text).toContain("output 11");
    expect(slot.container.querySelector("time")?.textContent).toMatch(/\b(am|pm|a\.m\.|p\.m\.)/i);
  });

  it("clamps a collapsed title to two lines and shows it whole when expanded", () => {
    const entry = toLogEntries([commandRow("long", { command: `echo ${"x".repeat(300)}` })])[0]!;
    const titleOf = (slot: ReturnType<typeof renderRow>) => slot.container.querySelector("button[aria-expanded] > span:last-child")!;
    expect(titleOf(renderRow(rowProps(entry))).className).toContain("line-clamp-2");
    expect(titleOf(renderRow(rowProps(entry, { expanded: true }))).className).not.toContain("line-clamp-2");
  });

  it("shows tool output edges, with pretty args when expanded", () => {

    const output = Array.from({ length: 12 }, (_, index) => `result ${index}`).join("\n");
    const tool = toLogEntries([toolRow("tool", { output, toolArgs: { path: "src/file.ts" } })])[0]!;
    const expanded = renderRow(rowProps(tool, { expanded: true }));
    expect(expanded.container.textContent).toContain('"path": "src/file.ts"');
    expect(expanded.container.textContent).toContain("result 5");
  });

  it("colors patch preview lines and renders the host diff when expanded", () => {
    const patch = "@@ -1 +1 @@\n-old\n+new\n context";
    const entry = toLogEntries([fileChangeRow("edit", { change: {
      kind: "edit", path: "src/file.ts", movePath: null,
      diff: patch, diffStats: { added: 1, removed: 1 },
    } })])[0]!;
    const preview = renderRow(rowProps(entry));
    expect(preview.getByText("+new").className).toContain("text-diff-added");
    expect(preview.getByText("-old").className).toContain("text-diff-removed");
    const expanded = renderRow(rowProps(entry, { expanded: true }));
    expect(expanded.container.textContent).toContain("+new");
  });

  it("highlights plain-text matches, links messages, and exposes copy/open controls", () => {
    const tool = toLogEntries([toolRow("tool", { output: "Matching output", toolName: "match" })])[0]!;
    const text = renderRow(rowProps(tool, { query: "match" }));
    expect(text.container.querySelectorAll("mark")).toHaveLength(2);
    const message = toLogEntries([userRow("other", { senderThreadId: "thr_sender", text: "Matching message" })])[0]!;
    const props = rowProps(message, {
      query: "match", chatHref: "/projects/proj_1/threads/thr_1#msg=10",
    });
    const slot = renderRow(props);
    expect(slot.container.querySelectorAll("mark")).toHaveLength(0);
    expect(within(slot.container).getByRole("link", { name: "Show in chat" }).getAttribute("href"))
      .toBe("/projects/proj_1/threads/thr_1#msg=10");
    fireEvent.click(within(slot.container).getByRole("button", { name: "Copy row" }));
    expect(props.onCopy).toHaveBeenCalledWith(message);
    fireEvent.click(within(slot.container).getByRole("button", { name: "Open thread" }));
    expect(props.onOpenThread).toHaveBeenCalledWith("thr_sender");
  });
});

type TimelineArgs = Parameters<SessionLogSdk["threads"]["timeline"]>[0];
function panelFake(
  initial: TimelineResponse, refreshed?: TimelineResponse, projectId = "proj_1", settings: Record<string, unknown> = {},
) {
  const callbacks = new Map<string, (event: unknown) => void>();
  const timeline = vi.fn(async (args: TimelineArgs) => args.afterSequence
    ? refreshed ?? timelineResponse([], { maxSeq: initial.maxSeq, delta: { upsertRows: [] } })
    : initial);
  const get = vi.fn(async () => ({ projectId }) as Awaited<ReturnType<SessionLogSdk["threads"]["get"]>>);
  const getSettings = vi.fn(async () => ({ ok: true, schema: {}, values: settings }));
  const subscribe = vi.fn((args: { event: string; callback: (event: unknown) => void }) => {
    callbacks.set(args.event, args.callback);
    return () => { callbacks.delete(args.event); };
  });
  return {
    sdk: { threads: { timeline, get }, plugins: { getSettings }, subscribe } as unknown as SessionLogSdk,
    timeline, get, getSettings, subscribe,
    emitThread() {
      callbacks.get("thread:changed")?.({ type: "changed", entity: "thread", id: "thr_1", changes: ["events-appended"] });
    },
  };
}

function renderPanel(fake: ReturnType<typeof panelFake>, threadId = "thr_1") {
  const preference = createPreference(window);
  function Component(props: PluginThreadPanelProps) {
    return <SessionLogPanel {...props} preference={preference} />;
  }
  const slot = renderSlot({ component: Component }, { threadId, params: null }, {
    pluginId: "session-log", sdk: fake.sdk,
  });
  mounts.push(slot);
  return slot;
}

function cursorId(container: HTMLElement): string | null {
  return container.querySelector('[data-entry-id][tabindex="0"]')?.getAttribute("data-entry-id") ?? null;
}

describe("SessionLogPanel", () => {
  it("shows every row in server order under labeled dividers", async () => {
    const fake = panelFake(timelineResponse([
      userRow("request"), reasoningRow("thought"), commandRow("command"),
      userRow("steer", { turnRequest: { kind: "steer", status: "accepted", isGrouped: false } }),
      assistantRow("reply"),
    ]));
    const slot = renderPanel(fake);
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(5));
    expect([...slot.container.querySelectorAll("[data-entry-id]")].map((node) => node.getAttribute("data-entry-id")))
      .toEqual(["request", "thought", "command", "steer", "reply"]);
    expect(slot.container.textContent).toContain("You · steer");
    expect(slot.inspection.sdkCalls.map((call) => call.method)).toContain("threads.timeline");
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
  });

  it("shows totals only on each turn's opening divider, including first messages and new steers", async () => {
    const slot = renderPanel(panelFake(timelineResponse([
      userRow("request", { turnId: null }),
      commandRow("first-work"),
      commandRow("first-fail", { exitCode: 1 }),
      userRow("child-report", { initiator: "system", systemMessageKind: "child-completed" }),
      userRow("mid-turn-steer", { turnRequest: { kind: "steer", status: "accepted", isGrouped: false } }),
      userRow("new-turn-steer", { turnId: "turn-2", turnRequest: { kind: "steer", status: "accepted", isGrouped: false } }),
      toolRow("second-work", { turnId: "turn-2" }),
    ])));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(7));
    const rowText = (id: string) => slot.container.querySelector(`[data-entry-id="${id}"]`)?.textContent;
    expect(rowText("request")).toContain("2 tools · 1 error ·");
    expect(rowText("child-report")).not.toContain(" tools · ");
    expect(rowText("mid-turn-steer")).not.toContain(" tools · ");
    expect(rowText("new-turn-steer")).toContain("1 tool · 0 errors");
  });

  it("expands failed commands by default while previewing successful output", async () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    const slot = renderPanel(panelFake(timelineResponse([
      userRow("request"), commandRow("failed", { exitCode: 1, output }),
      commandRow("passed", { output }),
    ])));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(3));
    const failed = slot.container.querySelector('[data-entry-id="failed"]')!;
    const passed = slot.container.querySelector('[data-entry-id="passed"]')!;
    expect(failed.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    expect(failed.textContent).toContain("line 5");
    expect(passed.textContent).not.toContain("line 5");
    expect(passed.textContent).toContain("… 4 more lines …");
  });

  it("toggles category chips and narrows Errors to failures plus dividers", async () => {
    const slot = renderPanel(panelFake(timelineResponse([
      userRow("request"), reasoningRow("thought"), toolRow("ok"),
      commandRow("failed", { exitCode: 1 }), assistantRow("reply"),
    ])));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(5));
    fireEvent.click(within(slot.container).getByRole("button", { name: "Thinking" }));
    expect(slot.container.querySelector('[data-entry-id="thought"]')).toBeNull();
    expect(slot.container.textContent).toContain("4 of 5 rows");
    fireEvent.click(within(slot.container).getByRole("button", { name: "Errors" }));
    expect([...slot.container.querySelectorAll("[data-entry-id]")].map((node) => node.getAttribute("data-entry-id")))
      .toEqual(["request", "failed"]);
    fireEvent.click(within(slot.container).getByRole("button", { name: "Messages" }));
    expect(slot.container.querySelector('[data-entry-id="request"]')).toBeTruthy();
  });

  it("debounces search, counts matches, highlights plain text and expands them", async () => {
    const slot = renderPanel(panelFake(timelineResponse([
      userRow("request", { text: "Needle in Markdown" }),
      commandRow("command", { output: "Needle in output", command: "run checks" }),
      assistantRow("reply", { text: "No match here" }),
    ])));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(3));
    fireEvent.change(within(slot.container).getByRole("searchbox"), { target: { value: "NEEDLE" } });
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(2));
    expect(slot.container.textContent).toContain("2 of 3 rows");
    expect(slot.container.querySelector('[data-entry-id="command"] mark')?.textContent).toBe("Needle");
    expect(slot.container.querySelector('[data-entry-id="request"] mark')).toBeNull();
    expect(slot.container.querySelector('[data-entry-id="command"] button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
  });

  it("starts roving focus at newest, moves with k/j, Enter, n, e and G, and handles / and Escape", async () => {
    const slot = renderPanel(panelFake(timelineResponse([
      userRow("request"), commandRow("failed", { exitCode: 2 }), assistantRow("reply"), toolRow("last"),
    ])));
    await waitFor(() => expect(cursorId(slot.container)).toBe("last"));
    const root = slot.container.querySelector("[data-session-log-panel]") as HTMLElement;
    root.focus();
    fireEvent.keyDown(root, { key: "k" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("reply");
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("last");
    fireEvent.keyDown(document.activeElement!, { key: "n" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("reply");
    fireEvent.keyDown(document.activeElement!, { key: "e" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("failed");
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(slot.container.querySelector('[data-entry-id="failed"] button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(document.activeElement!, { key: "G" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("last");
    fireEvent.keyDown(document.activeElement!, { key: "/" });
    expect(document.activeElement).toBe(within(slot.container).getByRole("searchbox"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(root);
  });

  it("tracks new rows until keyboard movement and resumes tracking after G", async () => {
    const initial = timelineResponse([userRow("first"), assistantRow("second")], { maxSeq: 10 });
    const fake = panelFake(initial);
    fake.timeline.mockResolvedValueOnce(initial);
    for (const [index, id] of ["third", "fourth", "fifth"].entries()) {
      const seq = 11 + index;
      fake.timeline.mockResolvedValueOnce(timelineResponse([], {
        maxSeq: seq,
        delta: {
          upsertRows: [toolRow(id, { sourceSeqStart: seq, sourceSeqEnd: seq })],
          rowOrder: ["first", "second", "third", "fourth", "fifth"].slice(0, index + 3),
        },
      }));
    }
    const slot = renderPanel(fake);
    await waitFor(() => expect(cursorId(slot.container)).toBe("second"));
    fake.emitThread();
    await waitFor(() => expect(cursorId(slot.container)).toBe("third"), { timeout: 2_000 });

    const root = slot.container.querySelector("[data-session-log-panel]") as HTMLElement;
    root.focus();
    fireEvent.keyDown(root, { key: "k" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("second");
    fake.emitThread();
    await waitFor(() => expect(slot.container.querySelector('[data-entry-id="fourth"]')).toBeTruthy(), { timeout: 2_000 });
    expect(cursorId(slot.container)).toBe("second");

    fireEvent.keyDown(document.activeElement!, { key: "G" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("fourth");
    fake.emitThread();
    await waitFor(() => expect(cursorId(slot.container)).toBe("fifth"), { timeout: 2_000 });
  });

  it("moves keyboard focus with the newest row after G, so Enter acts on it", async () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    const initial = timelineResponse([userRow("first"), toolRow("second", { output })], { maxSeq: 10 });
    const third = toolRow("third", { output, sourceSeqStart: 11, sourceSeqEnd: 11 });
    const fake = panelFake(initial, timelineResponse([], {
      maxSeq: 11, delta: { upsertRows: [third], rowOrder: ["first", "second", "third"] },
    }));
    const slot = renderPanel(fake);
    await waitFor(() => expect(cursorId(slot.container)).toBe("second"));
    const root = slot.container.querySelector("[data-session-log-panel]") as HTMLElement;
    root.focus();
    fireEvent.keyDown(root, { key: "G" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("second");
    fake.emitThread();
    await waitFor(() => expect((document.activeElement as HTMLElement).dataset.entryId).toBe("third"), { timeout: 2_000 });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(slot.container.querySelector('[data-entry-id="third"] button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
    expect(within(slot.container).queryByRole("button", { name: /Latest/ })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "k" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("second");
    expect(within(slot.container).getByRole("button", { name: /Latest/ })).toBeTruthy();
  });

  it("applies settings when the tab opens and again when they change", async () => {
    const fake = panelFake(timelineResponse([
      userRow("request"), reasoningRow("thought"), commandRow("failed", { exitCode: 1 }),
    ]), undefined, "proj_1", { showThinking: false, expandFailures: false });
    const slot = renderPanel(fake);
    await waitFor(() => expect(slot.container.querySelector('[data-entry-id="failed"]')).toBeTruthy());
    expect(slot.container.querySelector('[data-entry-id="thought"]')).toBeNull();
    expect(within(slot.container).getByRole("button", { name: "Thinking" }).getAttribute("aria-pressed")).toBe("false");
    const failedToggle = () => slot.container.querySelector('[data-entry-id="failed"] button[aria-expanded]')?.getAttribute("aria-expanded");
    expect(failedToggle()).toBe("false");
    const failedTinted = () => slot.container.querySelector('[data-entry-id="failed"]')?.classList.contains("sl-tinted");
    expect(failedTinted()).toBe(true);
    fake.getSettings.mockResolvedValue({
      ok: true, schema: {}, values: { showThinking: false, expandFailures: true, tintRows: false },
    });
    await slot.behavior.emitRealtime(SETTINGS_CHANNEL, {});
    await waitFor(() => expect(failedToggle()).toBe("true"));
    expect(failedTinted()).toBe(false);
    expect(fake.getSettings).toHaveBeenCalledTimes(2);
    expect(fake.getSettings).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "session-log" }));
  });

  it("re-pins to the bottom when the content or panel resizes while following, but not after scrolling up", async () => {
    const slot = renderPanel(panelFake(timelineResponse([userRow("first"), assistantRow("reply")])));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(2));
    const list = slot.container.querySelector("[data-session-log-list]") as HTMLElement;
    const observed = FakeResizeObserver.instances.flatMap((observer) => observer.targets);
    expect(observed).toContain(list);
    expect(observed).toContain(list.firstElementChild);
    let height = 500;
    let top = 400;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => 100 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(height - 100, Math.max(0, value)); } },
    });
    height = 900;
    FakeResizeObserver.resizeAll();
    expect(list.scrollTop).toBe(800);
    top = 300;
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(800);
    expect(within(slot.container).queryByRole("button", { name: /Latest/ })).toBeNull();
    fireEvent.wheel(list);
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(within(slot.container).getByRole("button", { name: /Latest/ })).toBeTruthy();
    height = 1_200;
    FakeResizeObserver.resizeAll();
    expect(list.scrollTop).toBe(0);
  });

  it("stops tracking on row focus and resumes if filters or search hide the cursor", async () => {
    const initial = timelineResponse([
      userRow("request"), commandRow("match", { command: "find needle" }),
      assistantRow("reply"), toolRow("last"),
    ], { maxSeq: 10 });
    const latest = toolRow("newest", { sourceSeqStart: 11, sourceSeqEnd: 11 });
    const fake = panelFake(initial, timelineResponse([], {
      maxSeq: 11, delta: { upsertRows: [latest], rowOrder: ["request", "match", "reply", "last", "newest"] },
    }));
    const slot = renderPanel(fake);
    await waitFor(() => expect(cursorId(slot.container)).toBe("last"));
    (slot.container.querySelector('[data-entry-id="last"]') as HTMLElement).focus();
    fake.emitThread();
    await waitFor(() => expect(slot.container.querySelector('[data-entry-id="newest"]')).toBeTruthy(), { timeout: 2_000 });
    expect(cursorId(slot.container)).toBe("last");

    (slot.container.querySelector('[data-entry-id="reply"]') as HTMLElement).focus();
    await waitFor(() => expect(cursorId(slot.container)).toBe("reply"));
    fireEvent.click(within(slot.container).getByRole("button", { name: "Messages" }));
    await waitFor(() => expect(cursorId(slot.container)).toBe("newest"));
    const search = within(slot.container).getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "needle" } });
    await waitFor(() => expect(cursorId(slot.container)).toBe("match"));
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(cursorId(slot.container)).toBe("newest"));
  });

  it("shows live thinking's last three lines and takes focus only on request", async () => {
    const composer = document.createElement("input");
    document.body.append(composer);
    composer.focus();
    const thinking = { id: "live", startedAt: 1_000, updatedAt: 1_500, text: "one\ntwo\nthree\nfour\nfive" };
    const slot = renderPanel(panelFake(timelineResponse([userRow("request")], { activeThinking: thinking })));
    await waitFor(() => expect(slot.container.querySelector("[data-live-thinking]")).toBeTruthy());
    expect(document.activeElement).toBe(composer);
    expect(slot.container.querySelector("[data-live-thinking]")?.textContent).toContain("three\nfour\nfive");
    expect(slot.container.querySelector("[data-live-thinking]")?.textContent).not.toContain("one\ntwo");
    requestPanelFocus("thr_1");
    await waitFor(() => expect(document.activeElement).toBe(slot.container.querySelector("[data-session-log-panel]")));
    fireEvent.click(within(slot.container).getByRole("button", { name: "Thinking" }));
    expect(slot.container.querySelector("[data-live-thinking]")).toBeNull();
  });

  it("persists x-expanded mode and clears per-row overrides when toggled", async () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    const slot = renderPanel(panelFake(timelineResponse([userRow("request"), commandRow("cmd", { output })])));
    await waitFor(() => expect(slot.container.querySelector('[data-entry-id="cmd"]')).toBeTruthy());
    const root = slot.container.querySelector("[data-session-log-panel]") as HTMLElement;
    const toggle = slot.container.querySelector('[data-entry-id="cmd"] button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(root, { key: "x" });
    expect(window.localStorage.getItem(EXPANDED_STORAGE_KEY)).toBe("true");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(root, { key: "x" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(root, { key: "x" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(slot.container.querySelector('[data-entry-id="cmd"]')?.textContent).toContain("line 5");
  });

  it("moves Enter from search to its first match and Escape clears or exits it", async () => {
    const slot = renderPanel(panelFake(timelineResponse([
      userRow("request", { text: "First" }), commandRow("match", { command: "find marker" }),
    ])));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(2));
    const search = within(slot.container).getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "marker" } });
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(1));
    fireEvent.keyDown(search, { key: "Enter" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("match");
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(2));
    fireEvent.keyDown(search, { key: "Escape" });
    expect(document.activeElement).toBe(slot.container.querySelector("[data-session-log-panel]"));
  });

  it("copies the focused command and s clicks the chat link for a message", async () => {
    const command = commandRow("cmd", { command: "npm test", output: "all green" });
    const slot = renderPanel(panelFake(timelineResponse([userRow("request"), command])));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(2));
    const commandElement = slot.container.querySelector('[data-entry-id="cmd"]') as HTMLElement;
    commandElement.focus();
    fireEvent.keyDown(commandElement, { key: "c" });
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([
      { text: "npm test\n\nall green" },
    ]));
    const request = slot.container.querySelector('[data-entry-id="request"]') as HTMLElement;
    const link = within(request).getByRole("link", { name: "Show in chat" }) as HTMLAnchorElement;
    const click = vi.spyOn(link, "click").mockImplementation(() => {});
    request.focus();
    fireEvent.keyDown(request, { key: "s" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("links messages to the correct project route or personal route", async () => {
    const project = renderPanel(panelFake(timelineResponse([userRow("project")]), undefined, "proj_1"));
    await waitFor(() => expect(project.container.querySelector('[data-entry-id="project"]')).toBeTruthy());
    expect(within(project.container).getByRole("link", { name: "Show in chat" }).getAttribute("href"))
      .toBe("/projects/proj_1/threads/thr_1#msg=10");
    const personal = renderPanel(panelFake(timelineResponse([assistantRow("personal", { messageSeq: 42 })]), undefined, "proj_personal"));
    await waitFor(() => expect(personal.container.querySelector('[data-entry-id="personal"]')).toBeTruthy());
    expect(within(personal.container).getByRole("link", { name: "Show in chat" }).getAttribute("href"))
      .toBe("/threads/thr_1#msg=42");
  });

  it("shows one new row while paused, then resumes bottom follow and cursor tracking", async () => {
    const first = userRow("first");
    const latest = assistantRow("new", { sourceSeqStart: 11, sourceSeqEnd: 11 });
    const after = toolRow("after", { sourceSeqStart: 12, sourceSeqEnd: 12 });
    const initial = timelineResponse([first], { maxSeq: 10 });
    const fake = panelFake(initial);
    fake.timeline.mockResolvedValueOnce(initial);
    fake.timeline.mockResolvedValueOnce(timelineResponse([], {
      maxSeq: 11, delta: { upsertRows: [latest], rowOrder: ["first", "new"] },
    }));
    fake.timeline.mockResolvedValueOnce(timelineResponse([], {
      maxSeq: 12, delta: { upsertRows: [after], rowOrder: ["first", "new", "after"] },
    }));
    const slot = renderPanel(fake);
    await waitFor(() => expect(cursorId(slot.container)).toBe("first"));
    (slot.container.querySelector('[data-entry-id="first"]') as HTMLElement).focus();
    const list = slot.container.querySelector("[data-session-log-list]") as HTMLElement;
    let top = 400;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, get: () => 500 },
      clientHeight: { configurable: true, get: () => 100 },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(400, Math.max(0, value)); } },
    });
    fireEvent.scroll(list);
    fireEvent.wheel(list);
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(within(slot.container).getByRole("button", { name: /Latest/ })).toBeTruthy();
    fake.emitThread();
    await waitFor(() => expect(slot.container.querySelector('[data-entry-id="new"]')).toBeTruthy(), { timeout: 2_000 });
    expect(cursorId(slot.container)).toBe("first");
    expect(within(slot.container).getByRole("button", { name: /1 new/ })).toBeTruthy();
    expect(list.scrollTop).toBe(0);
    const followButton = within(slot.container).getByRole("button", { name: /1 new/ });
    expect(followButton.textContent).toBe("↓ 1 new");
    expect(followButton.children).toHaveLength(0);
    fireEvent.click(followButton);
    expect(cursorId(slot.container)).toBe("new");
    expect(document.activeElement).toBe(slot.container.querySelector("[data-session-log-panel]"));
    await waitFor(() => expect(list.scrollTop).toBe(400));
    fake.emitThread();
    await waitFor(() => expect(cursorId(slot.container)).toBe("after"), { timeout: 2_000 });
  });

  it("supports previous reply/error, first row, help and ignores modified shortcuts", async () => {
    const slot = renderPanel(panelFake(timelineResponse([
      userRow("first"), assistantRow("reply-a"), commandRow("bad", { exitCode: 1 }),
      assistantRow("reply-b"), toolRow("last"),
    ])));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(5));
    const root = slot.container.querySelector("[data-session-log-panel]") as HTMLElement;
    fireEvent.keyDown(root, { key: "G" });
    fireEvent.keyDown(document.activeElement!, { key: "N" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("reply-b");
    fireEvent.keyDown(document.activeElement!, { key: "E" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("bad");
    fireEvent.keyDown(document.activeElement!, { key: "g" });
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe("first");
    fireEvent.keyDown(document.activeElement!, { key: "?" });
    expect(slot.container.textContent).toContain("j/k move");
    fireEvent.keyDown(root, { key: "x", metaKey: true });
    expect(window.localStorage.getItem(EXPANDED_STORAGE_KEY)).toBeNull();
  });

  it("shows empty and failed-load states with a working Retry", async () => {
    const fake = panelFake(timelineResponse([]));
    fake.timeline.mockRejectedValueOnce(new Error("HTTP 400 snapshot changed"));
    fake.timeline.mockRejectedValueOnce(new Error("HTTP 400 snapshot changed"));
    const slot = renderPanel(fake);
    await waitFor(() => expect(within(slot.container).getByRole("alert").textContent).toContain("HTTP 400 snapshot changed"));
    expect(fake.timeline).toHaveBeenCalledTimes(2);
    fireEvent.click(within(slot.container).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(slot.container.textContent).toContain("Nothing has happened in this thread yet."));
    expect(fake.timeline).toHaveBeenCalledTimes(3);
  });

  it("focuses the newly typed match when Enter beats the search debounce", async () => {
    const slot = renderPanel(panelFake(timelineResponse([
      userRow("first", { text: "unrelated" }), commandRow("match", { command: "find needle" }),
    ])));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(2));
    const search = within(slot.container).getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "needle" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect((document.activeElement as HTMLElement).dataset.entryId).toBe("match"));
    expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(1);
    search.focus();
    fireEvent.change(search, { target: { value: "unrelated" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect((document.activeElement as HTMLElement).dataset.entryId).toBe("first"));
    expect(slot.container.querySelectorAll("[data-entry-id]")).toHaveLength(1);
  });
});
