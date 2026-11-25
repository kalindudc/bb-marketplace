// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStudyCard } from "../../../src/ui/thread/study-cards";

const call = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => ({ call }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); call.mockClear(); });

it("waits for visibility, ignores repeat milestones and batches different cards' observations and clicks", () => {
  const observers = new Map<Element, (entries: { isIntersecting: boolean }[]) => void>();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe(el: Element) { observers.set(el, this.callback); }
    disconnect() {}
  });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  function Card({ messageId }: { messageId: string }) {
    const ref = useStudyCard({ threadId: "keeper", messageId, cardId: "v1", cardType: "questmap", questId: "quest" });
    return <article ref={ref} aria-label={messageId}><button aria-expanded={false}>Expand {messageId}</button><button>Act {messageId}</button></article>;
  }
  const scene = render(<><Card messageId="one" /><Card messageId="two" /></>);
  const visible = (name: string, isIntersecting: boolean) => observers.get(scene.getByRole("article", { name }))!([{ isIntersecting }]);
  visible("one", false);
  expect(frames).toHaveLength(0);
  visible("one", true);
  visible("one", true);
  visible("two", true);
  fireEvent.click(scene.getByRole("button", { name: "Expand one" }));
  fireEvent.click(scene.getByRole("button", { name: "Act one" }));
  expect(frames).toHaveLength(1);
  expect(call).not.toHaveBeenCalled();
  act(() => frames[0]!(0));
  expect(call).toHaveBeenCalledOnce();
  expect(call.mock.calls[0]).toEqual(["recordCardSignals", [
    expect.objectContaining({ messageId: "one", action: "first-seen" }),
    expect.objectContaining({ messageId: "two", action: "first-seen" }),
    expect.objectContaining({ messageId: "one", action: "expanded" }),
    expect.objectContaining({ messageId: "one", action: "acted" }),
  ]]);
});
