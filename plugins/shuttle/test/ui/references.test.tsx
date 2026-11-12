import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { ReferenceRecord } from "../../src/contract";
import { app, config, handlers, mount, page, unmountAll } from "./helpers";
import { registerBridge } from "../../src/ui/links/dom";
import { scanReferenceText } from "../../src/ui/links/reference-text";

afterEach(unmountAll);
const record: ReferenceRecord = { id: "a".repeat(64), threadId: "thr_1", messageId: "msg_1", number: 90386, excerpt: "PR #90386 (management)", status: "automatic", url: "https://github.com/acme/app/pull/90386", automaticUrl: "https://github.com/acme/app/pull/90386", reason: "Known PR in this thread’s repository", candidates: [], at: Date.now() };

describe("reference oversight", () => {
  it("preserves inline repository qualification and spans split reference text", () => {
    const row = document.createElement("div"); row.dataset.timelineRowId = "msg_inline";
    row.innerHTML = '<div data-message-column><p>acme/<strong>other</strong>#90386</p><p>PR #<strong>90387</strong></p></div>';
    document.body.append(row);
    const scan = scanReferenceText(row);
    expect(scan.text).toBe("acme/other#90386\nPR #90387");
    expect(scan.ranges.map((r) => [r.number, r.range.toString()])).toEqual([[90386, "acme/other#90386"], [90387, "#90387"]]);
  });

  it("does not merge numbers across hard line breaks", () => {
    const row = document.createElement("div"); row.dataset.timelineRowId = "msg_break";
    row.innerHTML = '<div data-message-column><p>#12<br>34</p></div>';
    document.body.append(row);
    const scan = scanReferenceText(row);
    expect(scan.text).toBe("#12\n34");
    expect(scan.ranges.map((r) => r.number)).toEqual([12]);
  });

  it("registers message metadata and does not rewrite streaming text", async () => {
    const loaded = await app();
    const registration = loaded.messageMetadata.find((r) => r.id === "references")!;
    const row = document.createElement("div"); row.dataset.timelineRowId = "msg_1";
    row.innerHTML = '<div data-message-column><p>PR #90386 (management)</p><code>#1059</code><a href="https://github.com/acme/app/pull/12">#12</a></div>';
    document.body.append(row);
    const text = row.querySelector("p")!.firstChild;
    const slot = mount(registration.component, { message: { id: "msg_1", threadId: "thr_1", role: "assistant" as const, turnId: null, createdAt: Date.now() } }, handlers({ resolveReferences: () => ({ rows: [record] }), getConfig: () => ({ config: config({ servers: [{ id: "github", name: "GitHub", kind: "github", enabled: true, sep: "#", commands: {} }] }) }) }));
    row.prepend(slot.container);
    await waitFor(() => expect(slot.getByRole("link", { name: "#90386" })).toBeTruthy());
    expect(row.querySelector("p")!.firstChild).toBe(text);
    const scan = scanReferenceText(row);
    expect(scan.text).toContain("PR #90386");
    expect(scan.text).not.toContain("#1059");
    expect(scan.text).not.toContain("#12");
    expect(scan.urls).toEqual(["https://github.com/acme/app/pull/12"]);
    const enter = vi.fn();
    const unregister = registerBridge({ read: () => null, enter, leave: vi.fn(), tap: vi.fn(), into: () => false, want: vi.fn() });
    const previous = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [{ left: 0, right: 100, top: 0, bottom: 30 }] });
    try {
      const move = new Event("pointermove", { bubbles: true });
      Object.assign(move, { pointerType: "mouse", clientX: 10, clientY: 10 });
      await waitFor(() => {
        row.querySelector("p")!.dispatchEvent(move);
        expect(enter).toHaveBeenCalledWith(expect.objectContaining({ url: record.url, referenceId: record.id }));
      });
      expect(row.querySelector("p")!.firstChild).toBe(text);
      fireEvent.click(slot.getByRole("link", { name: "#90386" }));
      expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "pr/github/acme/app/90386" } });
      row.querySelector("p")!.textContent = "Edited: PR #90386";
      await waitFor(() => expect(scanReferenceText(row).text).toContain("Edited:"));
    } finally {
      unregister();
      if (previous) Object.defineProperty(Range.prototype, "getClientRects", previous);
      else Reflect.deleteProperty(Range.prototype, "getClientRects");
    }
  });

  it("hides handled rows, supports search/grouping and opens PRs in Shuttle", async () => {
    let rows: ReferenceRecord[] = [record, { ...record, id: "b".repeat(64), number: 90387, excerpt: "Other reference", status: "confirmed" }];
    const { slot } = await page("insights/references", {
      getConfig: () => ({ config: config({ servers: [{ id: "github", name: "GitHub", kind: "github", enabled: true, sep: "#" as const, commands: {} }] }) }),
      referenceLog: ({ filter, query }) => {
        const filtered = rows.filter((r) => (filter !== "pending" || !["confirmed", "dismissed"].includes(r.status)) && r.excerpt.toLowerCase().includes((query ?? "").toLowerCase()));
        return { rows: filtered, total: rows.length, filteredTotal: filtered.length, counts: {}, events: [] };
      },
      referenceFeedback: ({ id, action }) => {
        rows = rows.map((r) => r.id !== id ? r : { ...r, status: action === "confirm" ? "confirmed" : "dismissed" });
        return rows.find((r) => r.id === id)!;
      },
    });
    const row = await waitFor(() => { const r = slot.container.querySelector<HTMLElement>(`[data-reference="${record.id}"]`); if (!r) throw new Error("no reference"); return r; });
    expect(slot.container.querySelector('[data-reference="' + "b".repeat(64) + '"]')).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "#90386" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "pr/github/acme/app/90386" } });
    fireEvent.change(slot.getByRole("combobox", { name: "Group references" }), { target: { value: "repo" } });
    await slot.findByRole("button", { name: /acme\/app/u });
    fireEvent.click(within(slot.container.querySelector<HTMLElement>(`[data-reference="${record.id}"]`)!).getByRole("button", { name: "Mark correct" }));
    await waitFor(() => expect(slot.container.querySelector(`[data-reference="${record.id}"]`)).toBeNull());
    fireEvent.click(slot.getByRole("radio", { name: "Handled" }));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-reference]")).toHaveLength(2));
    fireEvent.change(slot.getByRole("searchbox", { name: "Search references" }), { target: { value: "Other" } });
    await waitFor(() => expect(slot.container.querySelectorAll("[data-reference]")).toHaveLength(1));
  });

  it("offers correction and flags in Insights, with a retained history", async () => {
    let current = record;
    const { slot } = await page("insights/references", {
      referenceLog: () => ({ rows: [current], total: 1, filteredTotal: 1, counts: { [current.status]: 1 }, events: [] }),
      referenceFeedback: ({ action, query }) => {
        current = { ...current, status: action === "correct" ? "corrected" : "flagged", url: action === "correct" ? query : null };
        return current;
      },
    });
    await slot.findByText("Reference resolutions");
    fireEvent.click(await slot.findByRole("radio", { name: "All matches" }));
    await slot.findByText("PR #90386 (management)");
    fireEvent.click(slot.getByRole("button", { name: "Details for #90386" }));
    fireEvent.click(slot.getByRole("button", { name: "Flag incorrect" }));
    await slot.findByText("Flagged");
    fireEvent.click(slot.getByText("Correct this reference"));
    fireEvent.change(slot.getByRole("textbox", { name: "Correct reference target" }), { target: { value: "https://github.com/acme/other/issues/9" } });
    fireEvent.click(slot.getByRole("button", { name: "Save correction" }));
    await slot.findByText("Corrected");
    await waitFor(() => expect(slot.getByRole("link", { name: "Open externally ↗" }).getAttribute("href")).toBe("https://github.com/acme/other/issues/9"));
  });
});
