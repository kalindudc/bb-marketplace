import { act, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JournalSegmentSummary } from "../../../src/ui/thread/journal-segment";
import { ReadAsTag } from "../../../src/ui/thread/metadata";
import { readRemembered, writeRemembered } from "../../../src/ui/kit/remember";
import { fixtureDecor, fixtureMember } from "../../../src/ui/thread/fixtures";

const observed = new Map<Element, ResizeObserverCallback>();
class Observer {
  private nodes = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) { this.nodes.add(target); observed.set(target, this.callback); }
  disconnect() { for (const node of this.nodes) observed.delete(node); }
}
const size = (target: Element, inlineSize: number) => act(() => {
  observed.get(target)?.([{ target, borderBoxSize: [{ inlineSize, blockSize: 20 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver);
});
beforeEach(() => {
  observed.clear();
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", Observer);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["segment", "metadata"] as const)("keeps %s skeleton width from resize entries without reading layout", async kind => {
  const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: 120 } as DOMRect));
  const decor = { ...fixtureDecor, member: { ...fixtureMember, role: "member" as const }, keeperView: null };
  const segment = { threadId: "t", projectId: "p", environment: null, segments: [], isExpanded: false, onToggle: () => {} };
  const message = { id: "m", threadId: "t", role: "user", initiator: "user", createdAt: 1 };
  const key = kind === "segment" ? "skel:thread:segment:t" : "skel:thread:readas-w:m";
  writeRemembered(key, 120);
  function Probe() {
    const [n, setN] = useState(0);
    return <><button onClick={() => setN(n + 1)}>Unrelated {n}</button>{kind === "segment"
      ? <JournalSegmentSummary {...segment} isExpanded={n % 2 === 1} />
      : <ReadAsTag message={{ ...message } as never} />}</>;
  }
  const slot = renderSlot({ component: Probe }, {}, { rpc: { decor: () => decor, routes: () => ({ routes: [], rules: [], boardQuests: [] }) } });
  try {
    const selector = kind === "segment" ? "button[data-segment-summary]" : ".readas.member";
    const node = await waitFor(() => { const found = slot.container.querySelector(selector); expect(found).not.toBeNull(); return found!; });
    const opening = rect.mock.calls.length;
    const saves = vi.spyOn(Storage.prototype, "setItem");
    rect.mockClear();
    fireEvent.click(slot.getByRole("button", { name: "Unrelated 0" }));
    fireEvent.click(slot.getByRole("button", { name: "Unrelated 1" }));
    const unchanged = rect.mock.calls.length;
    size(node, 120);
    size(node, 0);
    const duplicateWrites = saves.mock.calls.length;
    size(node, 152.2);
    size(node, 152.4);
    const saved = readRemembered(key);
    console.log("L1", JSON.stringify({ kind, opening, unchanged, duplicateWrites, saved, reads: rect.mock.calls.length }));
    expect(unchanged).toBe(0);
    expect(opening).toBe(0);
    expect(duplicateWrites).toBe(0);
    expect(saved).toBe(152);
    expect(saves.mock.calls.filter(([k]) => k.endsWith(key))).toHaveLength(1);
    expect(rect).not.toHaveBeenCalled();
  } finally { slot.lifecycle.unmount(); }
});
