import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusGlyph } from "../src/status-glyph";

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

  it("keeps the continuous spin in an image mask with a static reduced-motion glyph", () => {
    const css = readFileSync("src/switchboard.css", "utf8");
    expect(css).toContain('mask-image: url("data:image/svg+xml,');
    expect(css).not.toContain("animation: sb-spin");
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.sb-spin > svg \{ opacity: 1; \}/);
  });
});
