// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  activeNativeTab,
  ensureMounts,
  findComposerRoot,
  nativeRowSlots,
  openPopover,
  readPicker,
  removeMounts,
} from "../src/picker";
import { buildPicker } from "./fake-picker";

afterEach(() => {
  document.body.replaceChildren();
});

const several = [
  { title: "Codex", rows: ["6.1-Sol", "5.5"] },
  { title: "Pi", rows: ["Claude Opus 5.5 · anthropic"] },
];

describe("picker", () => {
  it("finds the menu a composer's model button opened", () => {
    const fake = buildPicker(several);
    const anchor = document.createElement("span");
    fake.form.append(anchor);
    const root = findComposerRoot(anchor)!;
    expect(root).toBe(fake.form);
    expect(openPopover(root)).toBeNull();
    fake.open();
    expect(openPopover(root)).toBe(fake.popover);
  });

  it("reads bb's tab row, search box and list, and fails when a part is missing", () => {
    const fake = buildPicker(several);
    const parts = readPicker(fake.popover)!;
    expect(parts.search).toBe(fake.search);
    expect(parts.listbox).toBe(fake.listbox);
    expect(parts.nativeTabRow?.children).toHaveLength(2);
    expect(activeNativeTab(parts)?.title).toBe("Codex");
    fake.search.remove();
    expect(readPicker(fake.popover)).toBeNull();
  });

  it("puts Lineup's tabs first in bb's tab row and its list after bb's list, once", () => {
    const fake = buildPicker(several);
    const parts = readPicker(fake.popover)!;
    const first = ensureMounts(parts);
    const again = ensureMounts(readPicker(fake.popover)!);
    expect(again).toEqual(first);
    expect(parts.nativeTabRow!.firstElementChild).toBe(first.tabs);
    expect(fake.listbox.nextElementSibling).toBe(first.list);
    expect(readPicker(fake.popover)!.nativeTabRow).toBe(parts.nativeTabRow);
  });

  it("adds a tab row of its own when bb draws none", () => {
    const fake = buildPicker([several[0]!]);
    const parts = readPicker(fake.popover)!;
    expect(parts.nativeTabRow).toBeNull();
    const mounts = ensureMounts(parts);
    const row = fake.popover.firstElementChild as HTMLElement;
    expect(row.hasAttribute("data-lineup-tabrow")).toBe(true);
    expect(row.firstElementChild).toBe(mounts.tabs);
    expect(readPicker(fake.popover)!.nativeTabRow).toBeNull();
  });

  it("removes everything it added", () => {
    const fake = buildPicker(several);
    const before = fake.popover.outerHTML;
    const parts = readPicker(fake.popover)!;
    ensureMounts(parts);
    nativeRowSlots(parts.listbox);
    fake.popover.setAttribute("data-lineup-view", "recent");
    removeMounts(fake.popover);
    expect(fake.popover.outerHTML).toBe(before);
  });

  it("adds one pin slot before each row's check mark", () => {
    const fake = buildPicker(several);
    const rows = nativeRowSlots(fake.listbox);
    expect(rows.map((row) => row.title)).toEqual(["6.1-Sol", "5.5"]);
    expect(nativeRowSlots(fake.listbox).map((row) => row.slot)).toEqual(rows.map((row) => row.slot));
    expect(fake.rows()[0]!.lastElementChild!.firstElementChild).toBe(rows[0]!.slot);
  });
});
