import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SPIN_STEP_MS, SPIN_STEPS, StatusGlyph } from "../src/status-glyph";

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

  it("steps every running spinner together on one shared timer that stops with the last spinner", () => {
    vi.useFakeTimers();
    try {
      const first = render(<StatusGlyph state="running" label="first" spin={true} />);
      const second = render(<StatusGlyph state="running" label="second" spin={true} />);
      const angle = (name: string) => {
        const wrapper = screen.getByRole("img", { name }).closest<HTMLElement>(".sb-spin");
        return Number(wrapper?.style.transform.match(/^rotate\((\d+)deg\)$/)?.[1]);
      };
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(SPIN_STEP_MS);
      const start = angle("first");
      expect(Number.isInteger(start)).toBe(true);
      expect(angle("second")).toBe(start);
      vi.advanceTimersByTime(SPIN_STEP_MS);
      expect(angle("first")).toBe((start + 360 / SPIN_STEPS) % 360);
      expect(angle("second")).toBe(angle("first"));
      first.unmount();
      expect(vi.getTimerCount()).toBe(1);
      second.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the spin off CSS animations and image masks, on the compositor, and static for reduced motion", () => {
    const css = readFileSync("src/switchboard.css", "utf8");
    expect(css).not.toMatch(/animateTransform|mask-image|@keyframes sb-spin|animation: sb-spin/);
    expect(css).toContain(".sb-spin { will-change: transform; }");
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.sb-spin \{ transform: none !important; \}/);
  });
});
