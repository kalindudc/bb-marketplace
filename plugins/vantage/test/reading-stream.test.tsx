import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Reading } from "../src/reading-state";
import { useReadingStream } from "../src/reading-stream";
import { readerFiles, reloadUiState } from "../src/ui-prefs";

type Stream = ReturnType<typeof useReadingStream>;

const FILES = ["a.ts", "b.ts", "c.ts"];

// Each card sits `gap` pixels below the previous one inside a stream whose top is at 100.
function mount(props: { ready: boolean; initial?: Reading; heights?: Record<string, number> }) {
  let stream!: Stream;
  const heights = props.heights ?? {};
  function Reader({ ready, initial }: { ready: boolean; initial?: Reading }) {
    stream = useReadingStream({
      surface: "test",
      key: "reading-stream-test",
      ...(initial === undefined ? {} : { initial }),
      fallback: { scope: "all" },
      ready,
    });
    return (
      <div data-diff-stream ref={stream.streamRef}>
        {FILES.map((file) => (
          <section key={file} data-file-card={file} data-reading-part="uncommitted" />
        ))}
      </div>
    );
  }
  const view = render(<Reader ready={props.ready} initial={props.initial} />);
  const element = view.container.querySelector<HTMLDivElement>("[data-diff-stream]")!;
  const layout = () => {
    let top = 100 - element.scrollTop;
    for (const card of element.querySelectorAll<HTMLElement>("[data-file-card]")) {
      const height = heights[card.dataset.fileCard!] ?? 300;
      const at = top;
      card.getBoundingClientRect = () => ({ top: at, bottom: at + height, height }) as DOMRect;
      top += height;
    }
  };
  element.getBoundingClientRect = () => ({ top: 100, bottom: 400, height: 300 }) as DOMRect;
  layout();
  return {
    element,
    layout,
    unmount: view.unmount,
    rerender: (ready: boolean) => view.rerender(<Reader ready={ready} initial={props.initial} />),
    get stream() {
      return stream;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  reloadUiState();
});

describe("reading stream", () => {
  it("coalesces scroll writes for 500 ms and flushes the latest reading state on pagehide and unmount", () => {
    vi.useFakeTimers();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const view = mount({ ready: true });
    const scroll = (offset: number) => {
      view.element.scrollTop = offset;
      view.layout();
      act(() => view.stream.updateAnchor());
    };
    scroll(10);
    scroll(20);
    expect(readerFiles.get("reading-stream-test")?.anchor?.offset).toBe(-20);
    expect(setItem).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem.mock.lastCall?.[1]).toContain('"offset":-20');
    scroll(30);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(setItem.mock.lastCall?.[1]).toContain('"offset":-30');
    scroll(40);
    view.unmount();
    expect(setItem).toHaveBeenCalledTimes(3);
    expect(setItem.mock.lastCall?.[1]).toContain('"offset":-40');
  });

  it("jumps to a file while the overview is still partial", () => {
    const view = mount({ ready: false });
    act(() => view.stream.select("c.ts", "uncommitted", true));
    expect(view.element.scrollTop).toBe(600);
  });

  it("keeps a restored card on screen when its saved offset is larger than the card now is", () => {
    const initial: Reading = {
      scope: "all",
      file: "a.ts",
      part: "uncommitted",
      anchor: { file: "a.ts", part: "uncommitted", offset: -410 },
    };
    const view = mount({ ready: false, initial, heights: { "a.ts": 70 } });
    view.rerender(true);
    view.layout();
    const card = view.element.querySelector<HTMLElement>('[data-file-card="a.ts"]')!;
    expect(card.getBoundingClientRect().bottom).toBeGreaterThan(100);
  });
});

// A stream whose cards start as deferred placeholders and grow when their bodies mount, with a scroll extent that
// clamps scrollTop as a browser does. Layout is computed on every read, and the fake layout is in place before the
// hook's first layout effect runs. Growing a card does not re-render the reader, as a diff painting inside a card does not.
function staged(initial: Reading) {
  let stream!: Stream;
  const cards = new Map(FILES.map((file) => [file, { height: 68, deferred: true, loading: false }]));
  const observers = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly fire: () => void;
      constructor(callback: ResizeObserverCallback) {
        this.fire = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {
        observers.add(this.fire);
      }
      unobserve() {}
      disconnect() {
        observers.delete(this.fire);
      }
    },
  );
  let element!: HTMLDivElement;
  let scrollTop = 0;
  const total = () => [...cards.values()].reduce((sum, card) => sum + card.height, 0);
  const topOf = (file: string) => {
    let top = 100 - scrollTop;
    for (const name of FILES) {
      if (name === file) return top;
      top += cards.get(name)!.height;
    }
    return top;
  };
  const paint = (node: HTMLElement) => {
    const card = cards.get(node.dataset.fileCard!)!;
    if (card.deferred) node.dataset.bodyDeferred = "";
    else delete node.dataset.bodyDeferred;
    node.replaceChildren();
    if (card.loading) {
      const note = document.createElement("p");
      note.dataset.diffLoading = "";
      note.textContent = "Loading diff…";
      node.append(note);
    }
  };
  const attachStream = (node: HTMLDivElement | null) => {
    stream.streamRef.current = node;
    if (node === null || node === element) return;
    element = node;
    Object.defineProperty(node, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, total() - 300));
      },
    });
    Object.defineProperty(node, "scrollHeight", { configurable: true, get: total });
    node.getBoundingClientRect = () => ({ top: 100, bottom: 400, height: 300 }) as DOMRect;
  };
  const attachCard = (node: HTMLElement | null) => {
    if (node === null) return;
    const file = node.dataset.fileCard!;
    node.getBoundingClientRect = () => {
      const top = topOf(file);
      const { height } = cards.get(file)!;
      return { top, bottom: top + height, height } as DOMRect;
    };
    paint(node);
  };
  function Reader() {
    stream = useReadingStream({
      surface: "test",
      key: "reading-stream-test",
      initial,
      fallback: { scope: "all" },
      ready: true,
    });
    return (
      <div data-diff-stream ref={attachStream}>
        {FILES.map((file) => (
          <section key={file} ref={attachCard} data-file-card={file} data-reading-part="uncommitted" />
        ))}
      </div>
    );
  }
  render(<Reader />);
  return {
    get element() {
      return element;
    },
    topOf: (file: string) => topOf(file) - 100,
    grow(file: string, height: number, change: { deferred?: boolean; loading?: boolean } = {}) {
      Object.assign(cards.get(file)!, { height, deferred: false, loading: false, ...change });
      paint(element.querySelector<HTMLElement>(`[data-file-card="${file}"]`)!);
      act(() => {
        for (const fire of [...observers]) fire();
      });
    },
    get stream() {
      return stream;
    },
  };
}

describe("resuming a saved place with staged card bodies", () => {
  afterEach(() => vi.unstubAllGlobals());
  const AT_B: Reading = {
    scope: "all",
    file: "b.ts",
    part: "uncommitted",
    anchor: { file: "b.ts", part: "uncommitted", offset: -56 },
  };

  it("keeps the restore pending while the scroll is clamped, and lands on the saved offset once bodies mount", () => {
    const view = staged(AT_B);
    // Three 68 px placeholders do not fill the 300 px reader, so nothing can scroll yet.
    expect(view.element.scrollTop).toBe(0);
    view.grow("a.ts", 300);
    view.grow("b.ts", 300, { loading: true });
    view.grow("c.ts", 300);
    view.grow("b.ts", 300);
    expect(view.topOf("b.ts")).toBe(-56);
    expect(readerFiles.get("reading-stream-test")?.anchor).toEqual(AT_B.anchor);
  });

  it("uses the full saved offset once the anchored card's own body has painted, not the placeholder's height", () => {
    const view = staged(AT_B);
    view.grow("a.ts", 400);
    view.grow("c.ts", 300);
    // The anchored card is still a 68 px placeholder: it is kept on screen meanwhile.
    expect(view.topOf("b.ts")).toBeGreaterThan(-56);
    view.grow("b.ts", 300);
    expect(view.topOf("b.ts")).toBe(-56);
  });

  it("does not save the reader's own restoring scrolls as the place to resume", () => {
    const view = staged(AT_B);
    view.grow("a.ts", 300);
    act(() => view.stream.updateAnchor());
    expect(readerFiles.get("reading-stream-test")?.anchor).toEqual(AT_B.anchor);
  });

  it("stops restoring when the person scrolls, and after the reader has settled", () => {
    vi.useFakeTimers();
    const view = staged(AT_B);
    view.grow("a.ts", 300);
    view.grow("b.ts", 300);
    view.grow("c.ts", 300);
    expect(view.topOf("b.ts")).toBe(-56);
    act(() => vi.advanceTimersByTime(1_000));
    // Settled: a later change above no longer drags the reader back.
    const settledAt = view.element.scrollTop;
    view.grow("a.ts", 500);
    expect(view.element.scrollTop).toBe(settledAt);

    const again = staged(AT_B);
    again.grow("a.ts", 300);
    // Restoring as far as the reader can scroll so far.
    expect(again.element.scrollTop).toBe(136);
    fireEvent.wheel(again.element);
    again.grow("b.ts", 300);
    again.grow("c.ts", 300);
    expect(again.element.scrollTop).toBe(136);
  });
});
