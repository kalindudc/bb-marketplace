import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountFollowThinking } from "../src/follow-thinking";
import { createPreference, type FollowThinkingPreference } from "../src/preference";
import {
  commandRow,
  createRow,
  flush,
  lines,
  liveThinking,
  maxScrollTop,
  thoughtRow,
  userScrollTo,
} from "./fake-timeline";

let timeline: HTMLElement;
let preference: FollowThinkingPreference;
let controller: AbortController;

beforeEach(() => {
  window.localStorage.clear();
  document.body.replaceChildren();
  timeline = document.createElement("div");
  document.body.append(timeline);
  preference = createPreference(window);
  controller = new AbortController();
});

afterEach(() => {
  controller.abort();
});

function mount() {
  return mountFollowThinking({
    document,
    preference,
    signal: controller.signal,
    scanDelayMs: 0,
  });
}

describe("expanding thinking blocks", () => {
  it("expands thinking rows that are already on screen", () => {
    const row = thoughtRow("row-1");
    timeline.append(row.element);

    mount();

    expect(row.isExpanded()).toBe(true);
  });

  it("expands a thinking row that appears later", async () => {
    mount();
    const row = thoughtRow("row-1");

    timeline.append(row.element);
    await flush();

    expect(row.isExpanded()).toBe(true);
  });

  it("leaves other timeline rows collapsed", async () => {
    mount();
    const row = commandRow("row-1");
    const lookalike = createRow({
      title: "Thinking about tests",
      rowId: "row-2",
      icon: "Wrench",
      text: "tool output",
    });

    timeline.append(row.element, lookalike.element);
    await flush();

    expect(row.isExpanded()).toBe(false);
    expect(lookalike.isExpanded()).toBe(false);
  });

  it("keeps a block collapsed after the user collapses it", async () => {
    const row = thoughtRow("row-1");
    timeline.append(row.element);
    mount();

    row.header.click();
    timeline.append(commandRow("row-2").element);
    await flush();

    expect(row.isExpanded()).toBe(false);
  });

  it("remembers a user collapse when the row remounts with the same id", async () => {
    const first = thoughtRow("row-1");
    timeline.append(first.element);
    mount();
    first.header.click();

    first.element.remove();
    const remounted = thoughtRow("row-1");
    timeline.append(remounted.element);
    await flush();

    expect(remounted.isExpanded()).toBe(false);
  });
});

describe("following streaming thinking", () => {
  it("expands the live Thinking… indicator and keeps the newest text in view", async () => {
    mount();
    const live = liveThinking(lines(10));
    timeline.append(live.element);
    await flush();

    const detail = live.detail();
    expect(live.isExpanded()).toBe(true);
    expect(detail).not.toBeNull();
    expect(detail!.scrollTop).toBe(maxScrollTop(detail!));

    live.appendText(`\n${lines(5, "more")}`);
    await flush();

    expect(detail!.scrollTop).toBe(maxScrollTop(detail!));
    expect(detail!.scrollTop).toBeGreaterThan(0);
  });

  it("does not jump to the end of a completed thought", async () => {
    mount();
    const row = thoughtRow("row-1", lines(20));

    timeline.append(row.element);
    await flush();

    expect(row.isExpanded()).toBe(true);
    expect(row.detail()!.scrollTop).toBe(0);
  });

  it("stops following when the user scrolls up and resumes at the bottom", async () => {
    mount();
    const live = liveThinking(lines(10));
    timeline.append(live.element);
    await flush();
    const detail = live.detail()!;

    userScrollTo(detail, 0);
    await flush();
    live.appendText(`\n${lines(5, "more")}`);
    await flush();

    expect(detail.scrollTop).toBe(0);

    userScrollTo(detail, maxScrollTop(detail));
    await flush();
    live.appendText(`\n${lines(5, "even more")}`);
    await flush();

    expect(detail.scrollTop).toBe(maxScrollTop(detail));
  });
});

describe("the on and off toggle", () => {
  it("does nothing while off and expands everything when switched on", async () => {
    preference.setEnabled(false);
    const row = thoughtRow("row-1");
    timeline.append(row.element);
    mount();
    await flush();

    expect(row.isExpanded()).toBe(false);

    preference.setEnabled(true);
    await flush();

    expect(row.isExpanded()).toBe(true);
  });

  it("collapses the blocks it opened when switched off and keeps the ones the user opened", async () => {
    preference.setEnabled(false);
    const opened = thoughtRow("row-1");
    const userOpened = thoughtRow("row-2");
    timeline.append(opened.element, userOpened.element);
    mount();
    userOpened.header.click();

    preference.setEnabled(true);
    await flush();
    expect(opened.isExpanded()).toBe(true);

    preference.setEnabled(false);
    await flush();

    expect(opened.isExpanded()).toBe(false);
    expect(userOpened.isExpanded()).toBe(true);
  });

  it("stops following when switched off, even in a block the user opened", async () => {
    preference.setEnabled(false);
    const live = liveThinking(lines(10));
    timeline.append(live.element);
    mount();
    live.header.click();
    preference.setEnabled(true);
    await flush();
    const detail = live.detail()!;
    expect(detail.scrollTop).toBe(maxScrollTop(detail));

    preference.setEnabled(false);
    const before = detail.scrollTop;
    live.appendText(`\n${lines(5, "more")}`);
    await flush();

    expect(live.isExpanded()).toBe(true);
    expect(detail.scrollTop).toBe(before);
    expect(detail.scrollTop).toBeLessThan(maxScrollTop(detail));
  });
});

describe("cleanup", () => {
  it("stops reacting after the signal aborts", async () => {
    mount();
    controller.abort();
    const row = thoughtRow("row-1");

    timeline.append(row.element);
    await flush();

    expect(row.isExpanded()).toBe(false);
  });

  it("stops reacting after the disposer runs", async () => {
    const dispose = mount();
    dispose();
    const row = thoughtRow("row-1");

    timeline.append(row.element);
    await flush();

    expect(row.isExpanded()).toBe(false);
  });
});
