// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { readRemembered, writeRemembered } from "../../../src/ui/kit/remember";
import { QueryState, SKELETON_DELAY_MS, SkCard, SkDecided, SkKeeperRow, SkQuestRow, SkReport, rememberCount, useSkeletonCount } from "../../../src/ui/kit/skeleton";

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });
beforeEach(() => vi.useFakeTimers());

const region = (c: HTMLElement) => c.querySelector<HTMLElement>(".sk-region");

describe("QueryState with a skeleton", () => {
  it("holds the skeleton's space hidden until 150 ms, then shows it in a busy region that names what is coming", () => {
    const view = render(<div className="tavern"><QueryState error={null} loading skeleton={<SkCard />} label="the ledger" /></div>);
    expect(region(view.container)?.dataset.skeleton).toBe("held");
    expect(region(view.container)?.getAttribute("aria-busy")).toBe("true");
    expect(view.queryByRole("status")?.textContent).toBe("");
    act(() => { vi.advanceTimersByTime(SKELETON_DELAY_MS - 1); });
    expect(region(view.container)?.dataset.skeleton).toBe("held");
    act(() => { vi.advanceTimersByTime(1); });
    expect(region(view.container)?.dataset.skeleton).toBe("shown");
    expect(view.getByRole("status").textContent).toBe("Loading the ledger");
  });

  it("hides the shapes from assistive technology and puts no text in them", () => {
    const view = render(<div className="tavern"><QueryState error={null} loading skeleton={<><SkQuestRow /><SkQuestRow live={false} /><SkKeeperRow /><SkReport section /><SkDecided rows={3} seenable /></>} /></div>);
    act(() => { vi.advanceTimersByTime(SKELETON_DELAY_MS); });
    const shapes = view.container.querySelector(".sk")!;
    expect(shapes.getAttribute("aria-hidden")).toBe("true");
    expect(shapes.textContent).toBe("");
    expect(shapes.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0);
  });

  it("draws the real parts' own classes, so the swap keeps their size", () => {
    const view = render(<div className="tavern"><SkQuestRow /><SkQuestRow live={false} /><SkKeeperRow /></div>);
    expect(view.container.querySelector(".qrow.qrow-live > .qrow-l2")).not.toBeNull();
    expect(view.container.querySelector(".qrow.qrow-done > .qrow-name")).not.toBeNull();
    expect(view.container.querySelector(".krow > .krow-who .krow-l2 > .krow-t")).not.toBeNull();
  });

  it("puts the error with Retry in the skeleton's place, and shows nothing once loading ends", () => {
    const retry = vi.fn();
    const view = render(<div className="tavern"><QueryState error={new Error("Tavern is not responding")} loading skeleton={<SkCard />} retry={retry} /></div>);
    expect(view.getByRole("alert").textContent).toMatch(/Tavern is not responding/);
    expect(region(view.container)).toBeNull();
    view.rerender(<div className="tavern"><QueryState error={null} loading={false} skeleton={<SkCard />} /></div>);
    expect(view.container.textContent).toBe("");
  });

  it("keeps the old words for a surface that passes no skeleton yet", () => {
    const view = render(<div className="tavern"><QueryState error={null} loading /></div>);
    expect(view.getByRole("status").textContent).toBe("Loading Tavern…");
  });
});

describe("useSkeletonCount", () => {
  function Rows({ k, current, fallback }: { k: string; current?: number; fallback?: number }) {
    const n = useSkeletonCount(k, current, fallback);
    return <p>{n}</p>;
  }
  it("falls back to 2, then draws the count this device last saw, capped at 8", () => {
    expect(render(<Rows k="skel:test:a" />).container.textContent).toBe("2");
    cleanup();
    render(<Rows k="skel:test:a" current={5} />); cleanup();
    expect(render(<Rows k="skel:test:a" />).container.textContent).toBe("5");
    cleanup();
    rememberCount("skel:test:a", 40);
    expect(render(<Rows k="skel:test:a" />).container.textContent).toBe("8");
  });
  it("remembers 0, so a surface can draw no skeleton where this device saw nothing", () => {
    rememberCount("skel:test:b", 0);
    expect(render(<Rows k="skel:test:b" fallback={1} />).container.textContent).toBe("0");
  });
  it("keeps counts in their own store, so a long chat's cards never push out a remembered filter", () => {
    localStorage.clear();
    writeRemembered("journal:filter:t1", "open");
    for (let i = 0; i < 300; i++) rememberCount(`skel:thread:card:ask:a${i}`, 1);
    expect(readRemembered("journal:filter:t1")).toBe("open");
    expect(readRemembered("skel:thread:card:ask:a299")).toBe(1);
    expect(readRemembered("skel:thread:card:ask:a60")).toBe(1);
    expect(readRemembered("skel:thread:card:ask:a59")).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("tavern:skel-index")!)).toHaveLength(240);
    expect(JSON.parse(localStorage.getItem("tavern:view-index")!)).toEqual(["journal:filter:t1"]);
  });
});
