// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { useReturnCue } from "../../../src/ui/kit/moves";
import { motion } from "../../../src/ui/kit/motion";
import { installAnimations } from "./motion-fakes";

type Row = { id: string; v: string; top: number };
let fx: ReturnType<typeof installAnimations>;
let reads = 0;
/** jsdom has no ResizeObserver; this one lets a test say "the list changed size". */
const resized: ResizeObserverCallback[] = [];
class FakeResizeObserver { constructor(private cb: ResizeObserverCallback) { resized.push(cb); } observe() {} unobserve() {} disconnect() { resized.splice(resized.indexOf(this.cb), 1); } }
const savedRO = globalThis.ResizeObserver;
/** Lets the frame after a commit be drawn, when the hook reads the rows' places. */
const drawn = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0))));
const saved = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  motion.reset(); motion.now = () => 1_000_000; fx = installAnimations();
  reads = 0; resized.length = 0;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  Element.prototype.getBoundingClientRect = function (this: Element) { reads++; const top = Number(((this as HTMLElement).closest?.("[data-top]") as HTMLElement | null)?.dataset.top ?? 0); return { top, left: 0, bottom: top + 28, right: 600, width: 600, height: 28, x: 0, y: top, toJSON: () => ({}) } as DOMRect; };
});
afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); Element.prototype.getBoundingClientRect = saved; globalThis.ResizeObserver = savedRO; });

function List({ rows }: { rows: Row[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useReturnCue(ref, { also: ".more" });
  return <div ref={ref} className="tavern">{rows.map(r => <div key={r.id} data-quest={r.id} data-variant={r.v} data-top={r.top} />)}<div className="more" data-top={rows.length * 30} /></div>;
}
const kinds = () => [...motion.cues].map(c => c.kind);
const moved = (id: string) => fx.all.filter(a => (a.target as HTMLElement).dataset.quest === id);

function Split({ rows }: { rows: Row[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useReturnCue(ref);
  const row = (r: Row) => <div key={r.id} data-quest={r.id} data-variant={r.v} data-top={r.top}><button type="button" data-quest-name>{r.id}</button></div>;
  return <div ref={ref} className="tavern"><div className="live">{rows.filter(r => r.v !== "returned").map(row)}</div><div className="done">{rows.filter(r => r.v === "returned").map(row)}</div><button type="button">elsewhere</button></div>;
}

describe("useReturnCue", () => {
  it("moves focus with a returned row into its returned list", async () => {
    const v = render(<Split rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "active", top: 30 }]} />);
    await drawn();
    v.getByRole("button", { name: "b" }).focus();
    v.rerender(<Split rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "returned", top: 30 }]} />);
    const b = v.getByRole("button", { name: "b" });
    expect(b.closest(".done")).not.toBeNull();
    expect(document.activeElement).toBe(b);
  });

  it("scrolls a returned row's focus into view only when it lands out of sight", async () => {
    const seen: ScrollIntoViewOptions[] = [];
    const proto = Element.prototype as { scrollIntoView?: (o?: ScrollIntoViewOptions) => void };
    const saved = proto.scrollIntoView;
    proto.scrollIntoView = function (o?: ScrollIntoViewOptions) { seen.push(o ?? {}); };
    try {
      for (const [top, scrolls] of [[30, false], [window.innerHeight + 200, true]] as const) {
        seen.length = 0; cleanup();
        const v = render(<Split rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "active", top: 30 }]} />);
        await drawn();
        v.getByRole("button", { name: "b" }).focus();
        v.rerender(<Split rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "returned", top }]} />);
        expect(document.activeElement).toBe(v.getByRole("button", { name: "b" }));
        expect(seen, `row at ${top}px`).toEqual(scrolls ? [{ block: "nearest" }] : []);
      }
    } finally { proto.scrollIntoView = saved; }
  });

  it("never takes focus back after the user moved it elsewhere", async () => {
    const v = render(<Split rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "active", top: 30 }]} />);
    await drawn();
    v.getByRole("button", { name: "b" }).focus();
    v.getByRole("button", { name: "elsewhere" }).focus();
    (document.activeElement as HTMLElement).blur();
    await Promise.resolve();
    v.rerender(<Split rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "returned", top: 30 }]} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("slides a short return and the rows below as one group", async () => {
    const v = render(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "active", top: 30 }, { id: "c", v: "returned", top: 60 }]} />);
    await drawn();
    v.rerender(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "c", v: "returned", top: 30 }, { id: "b", v: "returned", top: 60 }]} />);
    expect(kinds()).toEqual(["quest returns", "rows settle"]);
    expect(JSON.stringify(moved("b")[0]!.keyframes)).toContain("translate(0px, -30px)");
    expect(moved("c")).toHaveLength(1);
  });

  it("fades and rises a long return that would cross other rows", async () => {
    const v = render(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "x", v: "active", top: 60 }, { id: "y", v: "active", top: 120 }, { id: "z", v: "active", top: 180 }]} />);
    await drawn();
    v.rerender(<List rows={[{ id: "x", v: "active", top: 0 }, { id: "y", v: "active", top: 60 }, { id: "z", v: "active", top: 120 }, { id: "a", v: "returned", top: 242 }]} />);
    const a = moved("a")[0]!;
    expect(a.keyframes[0]).toMatchObject({ opacity: 0, transform: "translateY(8px)" });
  });

  it("holds the group still when it contains a your-move row", async () => {
    const v = render(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "y", v: "your-move", top: 30 }]} />);
    await drawn();
    v.rerender(<List rows={[{ id: "y", v: "your-move", top: 0 }, { id: "a", v: "returned", top: 30 }]} />);
    expect(kinds()).toEqual(["quest returns"]);
    expect(moved("y")).toHaveLength(0);
  });

  it("moves nothing for a reflow that is not a return, nor on first render", async () => {
    const v = render(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "active", top: 30 }]} />);
    await drawn();
    expect(motion.cues.size).toBe(0);
    v.rerender(<List rows={[{ id: "b", v: "active", top: 0 }, { id: "a", v: "active", top: 30 }]} />);
    expect(motion.cues.size).toBe(0);
  });

  it("reads no layout while committing a change that returns nothing", async () => {
    const v = render(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "active", top: 30 }]} />);
    await drawn();
    reads = 0;
    v.rerender(<List rows={[{ id: "b", v: "active", top: 0 }, { id: "a", v: "active", top: 30 }]} />);
    v.rerender(<List rows={[{ id: "b", v: "your-move", top: 0 }, { id: "a", v: "active", top: 30 }]} />);
    expect(reads).toBe(0);
    await drawn();
    expect(reads).toBeGreaterThan(0);
  });

  it("slides from the place last drawn after the list scrolled", async () => {
    const v = render(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "active", top: 100 }]} />);
    await drawn();
    const b = v.container.querySelector<HTMLElement>("[data-quest=b]")!;
    b.dataset.top = "140";
    b.dispatchEvent(new Event("scroll"));
    await drawn();
    v.rerender(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "returned", top: 170 }]} />);
    expect(JSON.stringify(moved("b")[0]!.keyframes)).toContain("translate(0px, -30px)");
  });

  it("slides from the new place after the list changed width with no window resize", async () => {
    const v = render(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "active", top: 100 }]} />);
    await drawn();
    // bb's side panel opens: the column narrows and b wraps lower, with no commit and no window resize.
    v.container.querySelector<HTMLElement>("[data-quest=b]")!.dataset.top = "140";
    for (const cb of [...resized]) cb([], {} as ResizeObserver);
    await drawn();
    v.rerender(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "b", v: "returned", top: 170 }]} />);
    expect(JSON.stringify(moved("b")[0]!.keyframes)).toContain("translate(0px, -30px)");
  });

  it("fades in a row that returns in the frame it first appears", async () => {
    const v = render(<List rows={[{ id: "a", v: "active", top: 0 }]} />);
    await drawn();
    v.rerender(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "n", v: "active", top: 30 }]} />);
    v.rerender(<List rows={[{ id: "a", v: "active", top: 0 }, { id: "n", v: "returned", top: 30 }]} />);
    expect(moved("n")[0]!.keyframes[0]).toMatchObject({ opacity: 0, transform: "translateY(8px)" });
  });
});
