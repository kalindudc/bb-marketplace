// @vitest-environment jsdom
// The dependency map against enlarged or spaced text: its ruler measures the nodes' fonts as the page renders them and
// the map is laid out again from that, so a key never ends outside its box (WCAG 1.4.4 and 1.4.12).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { BoardCard } from "../src/contract";
import { HopMap } from "../src/ui/dep-map";
import { depIndex } from "../src/ui/deps";
import { card } from "./fixtures";

type Kind = "work" | "merge" | "live";
const board = (rows: Array<[string, BoardCard["state"], Array<[string, Kind]>?]>) => rows.map(([key, state, prereqs = []]) => card({ key, title: `${key} title`, state, deps: prereqs.filter(([, kind]) => kind === "work").map(([dep]) => dep), prereqs: prereqs.map(([dep, kind]) => ({ key: dep, kind })) }));
const lane = board([
  ["LANE-4", "pr_open"],
  ["LANE-2", "done"],
  ["LANE-33", "queued", [["LANE-4", "work"], ["LANE-2", "work"]]],
  ["LANE-40", "queued", [["LANE-33", "work"]]],
]);

const mounts: Array<ReturnType<typeof renderSlot>> = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  cleanup();
  vi.restoreAllMocks();
});
const Map = () => <HopMap index={depIndex(lane)} focus="LANE-33" hops={1} onPick={() => undefined} label="LANE-33 and its neighbours" />;
const mount = () => {
  const slot = renderSlot({ component: Map }, {}, { pluginId: "loom" });
  mounts.push(slot);
  return slot;
};

/** The map's node boxes by id, as their inline styles place them. */
const boxes = (container: HTMLElement): Record<string, { width: number; height: number }> =>
  Object.fromEntries([...container.querySelectorAll<HTMLElement>("[data-map-node], [data-map-stub]")].map((node) => [node.dataset.mapNode ?? node.dataset.mapStub, { width: parseFloat(node.style.width), height: parseFloat(node.style.height) }]));

describe("the dependency map's text", () => {
  it("lays the map out again from its ruler: text drawn twice as wide and tall gives every node room for it", () => {
    const plain = mount();
    const before = boxes(plain.container);
    expect(plain.container.querySelector("[data-map-ruler]")?.getAttribute("aria-hidden")).toBe("true");
    plain.lifecycle.unmount();

    // The ruler's key is 10 characters of the 12 px monospace the widths assume at 7.3 px each, drawn here at twice that.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const inRuler = this.parentElement?.hasAttribute("data-map-ruler") ?? false;
      const width = inRuler ? (this.textContent === "in progress" ? 11 * 6.6 * 1.6 : 10 * 7.3 * 2) : 0;
      const height = inRuler ? 23 : 0;
      return { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) } as DOMRect;
    });
    const big = mount();
    const after = boxes(big.container);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [id, box] of Object.entries(after)) {
      expect(box.height, id).toBe(37);
      expect(box.width, id).toBeGreaterThan(before[id]!.width);
    }
    // LANE-33's key alone, at twice the width per character, fits inside its node with the mark and the padding.
    expect(after["LANE-33"]!.width).toBeGreaterThanOrEqual(Math.ceil(9 + 14 + 5 + 7 * 7.3 * 2 + 9));
  });
});
