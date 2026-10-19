import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusGlyph } from "../src/status-glyph";

class FakeVisibility {
  static instances: FakeVisibility[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) { FakeVisibility.instances.push(this); }
  observe(target: Element) { this.observed.add(target); }
  unobserve(target: Element) { this.observed.delete(target); }
  disconnect() { this.observed.clear(); }
  report(...entries: [Element, boolean][]) {
    this.callback(entries.map(([target, isIntersecting]) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver);
  }
}

beforeAll(() => { vi.stubGlobal("IntersectionObserver", FakeVisibility); });
afterAll(() => { vi.unstubAllGlobals(); });

const spinnerOf = (name: string) => screen.getByRole("img", { name }).closest<HTMLElement>(".sb-spin")!;

describe("StatusGlyph", () => {
  it("gives all states accessible, different shapes; only running can spin", () => {
    for (const state of ["failed", "needs", "running", "unread", "idle"] as const) {
      const { unmount } = render(<StatusGlyph state={state} label={state} spin={true} />);
      const icon = screen.getByRole("img", { name: state });
      expect(icon.querySelector("circle")).toBeTruthy();
      expect(icon.classList.contains("sb-spin")).toBe(false);
      const wrapper = icon.closest(".sb-spin");
      expect(wrapper?.tagName ?? null).toBe(state === "running" ? "SPAN" : null);
      if (wrapper) {
        expect(wrapper.classList.contains("size-[14px]")).toBe(true);
        expect(wrapper.classList.contains("text-primary")).toBe(true);
        expect(wrapper.querySelector("svg")).toBe(icon);
      }
      unmount();
    }
    const { unmount } = render(<StatusGlyph state="running" label="steady" spin={false} />);
    expect(screen.getByRole("img", { name: "steady" }).closest(".sb-spin")).toBeNull();
    unmount();
  });

  it("animates a spinner only while it is on screen", () => {
    const first = render(<StatusGlyph state="running" label="first" spin={true} />);
    const second = render(<StatusGlyph state="running" label="second" spin={true} />);
    const [visibility] = FakeVisibility.instances;
    expect(FakeVisibility.instances).toHaveLength(1);
    expect(visibility.observed).toEqual(new Set([spinnerOf("first"), spinnerOf("second")]));
    expect(spinnerOf("first").hasAttribute("data-visible")).toBe(false);

    visibility.report([spinnerOf("first"), true], [spinnerOf("second"), false]);
    expect(spinnerOf("first").hasAttribute("data-visible")).toBe(true);
    expect(spinnerOf("second").hasAttribute("data-visible")).toBe(false);

    visibility.report([spinnerOf("first"), false]);
    expect(spinnerOf("first").hasAttribute("data-visible")).toBe(false);

    const firstSpinner = spinnerOf("first");
    first.unmount();
    expect(visibility.observed.has(firstSpinner)).toBe(false);
    expect(visibility.observed.has(spinnerOf("second"))).toBe(true);
    second.unmount();
    expect(visibility.observed.size).toBe(0);
    expect(FakeVisibility.instances).toHaveLength(1);
  });

  it("puts every spinner animation that starts, or restarts after a row moves, in the phase all spinners share", () => {
    const { unmount } = render(<StatusGlyph state="running" label="moved" spin={true} />);
    const spinner = spinnerOf("moved");
    const spin = { animationName: "sb-spin", startTime: 3628 as number | null };
    const other = { animationName: "sb-flash", startTime: 40 as number | null };
    spinner.getAnimations = () => [spin, other] as unknown as Animation[];
    const start = (animationName: string) =>
      spinner.dispatchEvent(Object.assign(new Event("animationstart", { bubbles: true }), { animationName }));
    start("sb-flash");
    expect(spin.startTime).toBe(3628);
    start("sb-spin");
    expect(spin.startTime).toBe(0);
    expect(other.startTime).toBe(40);
    unmount();
  });

  it("turns once a second in 30 compositor steps, rarely ends an iteration, and holds still for reduced motion", () => {
    const css = readFileSync("src/switchboard.css", "utf8");
    expect(css).not.toMatch(/animateTransform|mask-image/);
    expect(css).toContain("@keyframes sb-spin { to { transform: rotate(1000turn); } }");
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.sb-spin\[data-visible\] \{ animation: sb-spin 1000s steps\(30000\) infinite; \}/);
    expect(css.match(/animation: sb-spin/g)).toHaveLength(1);
    expect(readFileSync("src/status-glyph.tsx", "utf8")).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|style\.transform/);
  });
});
