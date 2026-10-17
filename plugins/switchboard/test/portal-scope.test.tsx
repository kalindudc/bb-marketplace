import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { portalScopeProps } from "../src/portal-scope";
import { BulkBar } from "../src/bulk-bar";
import { EMPTY_LAYOUT } from "../src/layout";
import { SectionMenu } from "../src/section-menu";
import { DEFAULT_SETTINGS } from "../src/settings";
import { buildGroups } from "../src/tree";
import { ViewMenu } from "../src/view-menu";
import { sidebarSection, sidebarThread } from "./fixtures";

installTestPluginRuntime();
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const portalled = /<(DropdownMenu\.(?:Content|SubContent)|AlertDialog\.(?:Content|Overlay))\b(\s+\{\.\.\.portalScopeProps\(\)\})?/g;
const sources = readdirSync(join(process.cwd(), "src")).filter((name) => name.endsWith(".tsx"))
  .map((name) => join(process.cwd(), "src", name));
const group = buildGroups({ layout: EMPTY_LAYOUT, sections: [sidebarSection("s", "Section")],
  threads: [sidebarThread({ sectionId: "s" })] })[0]!;
const openWithPointer = (name: string) => fireEvent.pointerDown(screen.getByRole("button", { name }),
  { button: 0, ctrlKey: false, pointerType: "mouse" });

describe("portal scope", () => {
  it("marks portalled content as this plugin's overlay root", () => {
    expect(portalScopeProps()).toMatchObject({ "data-bb-portaled-overlay": "", "data-bb-plugin-root": "" });
  });

  for (const path of sources) {
    it(`${path} scopes every portalled menu, overlay and dialog`, () => {
      for (const match of readFileSync(path, "utf8").matchAll(portalled)) {
        expect(match[2], `${match[1]} in ${path} must spread {...portalScopeProps()} right after its tag name`).toBeTruthy();
      }
    });
  }

  it("renders the view menu and its checked choices inside the plugin scope", () => {
    const slot = renderSlot({ component: ViewMenu }, { settings: DEFAULT_SETTINGS, onChange: vi.fn() });
    openWithPointer("View options");
    expect(screen.getByRole("menu").hasAttribute("data-bb-plugin-root")).toBe(true);
    const checked = screen.getByRole("menuitemradio", { name: "Comfortable" });
    expect(checked.getAttribute("aria-checked")).toBe("true");
    expect(checked.querySelector("[data-sb-check]")).not.toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Compact" }).querySelector("[data-sb-check]")).toBeNull();
    expect(screen.getByRole("menuitemcheckbox", { name: "Status chips" }).querySelector("[data-sb-check]")).not.toBeNull();
    expect(screen.getByRole("menuitemcheckbox", { name: "Branch names" }).querySelector("[data-sb-check]")).toBeNull();
    slot.unmount();
  });

  it("renders section dialogs and their overlay inside the plugin scope", () => {
    render(<SectionMenu group={group} unreadCount={0} hueOverride={null} onRename={vi.fn()}
      onSetHue={vi.fn()} onNewThread={vi.fn()} onMarkAllRead={vi.fn()} onDelete={vi.fn()} />);
    openWithPointer("Section actions");
    expect(screen.getByRole("menu").hasAttribute("data-bb-plugin-root")).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete section/ }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.hasAttribute("data-bb-plugin-root")).toBe(true);
    expect(document.querySelectorAll("[data-bb-portaled-overlay]").length).toBeGreaterThanOrEqual(2);
  });

  it("renders the selection bar's archive dialog inside the plugin scope", () => {
    render(<BulkBar count={2} childCount={1} groups={[group]} onMove={vi.fn()} onArchive={vi.fn()} onClear={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByRole("alertdialog").hasAttribute("data-bb-plugin-root")).toBe(true);
  });
});
