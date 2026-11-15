// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { OverflowMenu } from "../../../src/ui/kit";

afterEach(cleanup);

describe("OverflowMenu rich rows", () => {
  it("draws content rows with the label as their name, a tooltip, a divider and a custom trigger class", () => {
    const run = vi.fn();
    const view = render(<div className="tavern"><OverflowMenu label="Start a quest" triggerClassName="btn" trigger={<span>Start a quest</span>} items={[
      { id: "wren", label: "Wren, Keeper: Vault cutover, idle", title: "Opens Wren's thread, ready to start a quest", content: <span className="who"><b>Wren</b> Vault cutover</span>, run },
      { id: "new", label: "New Keeper…", divider: true, run: () => {} },
    ]} /></div>);
    const trigger = view.getByRole("button", { name: "Start a quest" });
    expect(trigger.className).toBe("btn");
    fireEvent.click(trigger);
    const wren = view.getByRole("menuitem", { name: "Wren, Keeper: Vault cutover, idle" });
    expect(wren.title).toBe("Opens Wren's thread, ready to start a quest");
    expect(wren.classList.contains("rich")).toBe(true);
    expect(wren.querySelector(".who")).not.toBeNull();
    expect(view.getAllByRole("separator")).toHaveLength(1);
    expect(view.getByRole("menuitem", { name: "New Keeper…" }).textContent).toBe("New Keeper…");
    fireEvent.click(wren);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps plain rows and the default trigger unchanged", () => {
    const view = render(<div className="tavern"><OverflowMenu label="More" items={[{ id: "a", label: "Edit", glyph: "edit", run: () => {} }]} /></div>);
    const trigger = view.getByRole("button", { name: "More" });
    expect(trigger.className).toBe("ibtn");
    fireEvent.click(trigger);
    const row = view.getByRole("menuitem", { name: "Edit" });
    expect(row.getAttribute("aria-label")).toBeNull();
    expect(row.classList.contains("rich")).toBe(false);
  });
});
