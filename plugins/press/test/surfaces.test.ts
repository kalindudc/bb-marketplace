import { describe, expect, it } from "vitest";
import { placeInFooter } from "../src/ui/footer";
import { chatText, chipBusy, chipText, numberText, statusLines, usageTone } from "../src/ui/model";

const at = "2026-11-22T00:00:00.000Z";

describe("surface copy", () => {
  it("shows only the rounded percent on the chip and reports historical duration as rounded seconds", () => {
    expect(chipText({ percent: 77.1 })).toBe("77%");
    expect(chipText({ percent: null })).toBe("—");
    expect(chatText({ point: "manual", tokensBefore: 209_544, tokensAfter: 3_227, ms: 78_600 })).toBe("Pressed · 209k to 3k · 79s · manual");
    expect(chatText({ point: "native", tokensBefore: null, tokensAfter: null, ms: 17_540 })).toBe("Pressed · 18s · native");
    expect(numberText(null)).toBe("—");
  });
});

describe("chip state", () => {
  const thresholds = { softPercent: 55, hardPercent: 80, floorTokens: 150_000 };

  it("turns from calm to near at compact-at and to over at force-at", () => {
    expect(usageTone({ percent: null, thresholds })).toBe("calm");
    expect(usageTone({ percent: 54.9, thresholds })).toBe("calm");
    expect(usageTone({ percent: 55, thresholds })).toBe("near");
    expect(usageTone({ percent: 80, thresholds })).toBe("over");
  });

  it("spins while Press compacts the thread or holds its next message", () => {
    expect(chipBusy({ compacting: null, held: null })).toBe(false);
    expect(chipBusy({ compacting: { since: at, point: "window" }, held: null })).toBe(true);
    expect(chipBusy({ compacting: null, held: { since: at, reason: "Press is compacting this thread before the next turn", count: 1 } })).toBe(true);
  });

  it("moves the mode, the thresholds, the hold and the next point into the full description", () => {
    const base = { percent: 37.4, tokens: 374_000, window: 1_000_000, providerEnabled: true, mode: "advisor" as const, thresholds, compacting: null, held: null, nextPoint: null, lastCompaction: null };
    expect(statusLines(base)).toEqual([
      "37% of the context window (374k of 1M tokens)",
      "Advisor: proposes, you compact, from 55%, forced at 80%",
      "Not compacted yet",
    ]);
    const lines = statusLines({ ...base, nextPoint: "phase", compacting: { since: at, point: "window" } });
    expect(lines[1]).toMatch(/^Compacting since /);
    expect(lines).toContain("Next point: phase");
    expect(statusLines({ ...base, nextPoint: "window" })).toContain("Next point: force at 80%");
    const held = statusLines({ ...base, compacting: { since: at, point: "window" }, held: { since: at, reason: "r", count: 1 } });
    expect(held[1]).toMatch(/^Holding the next message since .+, until the compaction lands$/);
    expect(held.filter((line) => line.startsWith("Compacting since"))).toEqual([]);
  });
});

describe("footer placement", () => {
  it("inserts before the circle, stays still when connected, and follows Burn if it mounts later", () => {
    const circle: { previousElementSibling: { hasAttribute(name: string): boolean } | null } = { previousElementSibling: null };
    let found: typeof circle | null = circle;
    const chip = { parentElement: null as object | null, remove() { this.parentElement = null; } };
    const insertions: Array<typeof circle> = [];
    const group = { querySelector: () => found, insertBefore: (_node: object, before: typeof circle) => {
      chip.parentElement = group;
      circle.previousElementSibling = { hasAttribute: () => false };
      insertions.push(before);
    } };
    let footer: { lastElementChild: typeof group } | null = { lastElementChild: group };
    const pane = { querySelector: () => footer } as unknown as ParentNode;
    const node = chip as unknown as HTMLElement;
    expect(placeInFooter(node, pane)).not.toBeNull();
    expect(placeInFooter(node, pane)).not.toBeNull();
    expect(insertions).toEqual([circle]);
    circle.previousElementSibling = { hasAttribute: (name) => name === "data-burn-chip" };
    expect(placeInFooter(node, pane)).not.toBeNull();
    expect(placeInFooter(node, pane)).not.toBeNull();
    expect(insertions).toEqual([circle, circle]);
    found = null;
    expect(placeInFooter(node, pane)).toBeNull();
    expect(chip.parentElement).toBeNull();
    footer = null;
    expect(placeInFooter(node, pane)).toBeNull();
  });
});
