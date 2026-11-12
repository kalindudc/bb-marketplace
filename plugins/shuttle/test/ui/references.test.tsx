import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { Dialog } from "../../src/ui/common";
import { clearReferenceHighlights, setReferenceHighlights } from "../../src/ui/links/reference-highlights";
import { rememberPanelReference } from "../../src/ui/prefs";
import type { ReferenceRecord } from "../../src/contract";
import { app, config, handlers, mount, page, pr, setViewport, unmountAll } from "./helpers";
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
    expect(scan.ranges.map((r) => [r.number, r.range.toString()])).toEqual([[90387, "#90387"]]);
  });

  it("uses complete links and keys as evidence without creating text ranges for them", () => {
    const row = document.createElement("div"); row.dataset.timelineRowId = "msg_complete";
    row.innerHTML = '<div data-message-column><p>Review <a href="https://github.com/Shopify/ingress-nginx/pull/711">https://github.com/Shopify/ingress-nginx/pull/711</a> (github:Shopify/ingress-nginx#711, head abc123)</p></div>';
    document.body.append(row);
    const scan = scanReferenceText(row);
    expect(scan.ranges).toEqual([]);
    expect(scan.urls).toEqual(["https://github.com/Shopify/ingress-nginx/pull/711"]);
    expect(scan.text).toContain("github:Shopify/ingress-nginx#711");
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
    expect(slot.getByRole("link", { name: "#90386" }).classList.contains("border")).toBe(false);
    expect(slot.getByRole("link", { name: "#90386" }).classList.contains("min-h-8")).toBe(false);
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
      expect(slot.inspection.navigateCalls.some((call) => call.method === "toPluginPanel")).toBe(false);
      expect(slot.inspection.experimental_panelCalls.at(-1)).toMatchObject({ method: "openTab", options: { tab: { id: "shuttle" }, params: { threadId: "thr_1" } } });
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
        const filtered = rows.filter((r) => (filter === "handled" ? ["confirmed", "dismissed", "corrected", "suppressed"].includes(r.status) : filter !== "pending" || !["confirmed", "dismissed", "corrected", "suppressed"].includes(r.status)) && r.excerpt.toLowerCase().includes((query ?? "").toLowerCase()));
        return { rows: filtered, total: rows.length, filteredTotal: filtered.length, counts: {}, events: [] };
      },
      referenceFeedback: ({ id, action }) => {
        rows = rows.map((r) => r.id !== id ? r : { ...r, status: action === "confirm" ? "confirmed" : "dismissed" });
        return rows.find((r) => r.id === id)!;
      },
    });
    const row = await waitFor(() => { const r = slot.container.querySelector<HTMLElement>(`[data-reference="${record.id}"]`); if (!r) throw new Error("no reference"); return r; });
    expect(slot.queryByRole("button", { name: "#90387" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "#90386" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: `insights/references/ref/${record.id}` } });
    fireEvent.change(slot.getByRole("combobox", { name: "Group references" }), { target: { value: "repo" } });
    await slot.findByRole("button", { name: /acme\/app/u });
    fireEvent.click(within(slot.container.querySelector<HTMLElement>(`[data-reference="${record.id}"]`)!).getByRole("button", { name: "Mark correct" }));
    await waitFor(() => expect(slot.queryByRole("button", { name: "#90386" })).toBeNull());
    fireEvent.click(slot.getByRole("radio", { name: "Handled" }));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-reference]")).toHaveLength(2));
    fireEvent.change(slot.getByRole("searchbox", { name: "Search references" }), { target: { value: "Other" } });
    await waitFor(() => expect(slot.container.querySelectorAll("[data-reference]")).toHaveLength(1));
  });

  it("keeps the list beside the matched PR and follows a correction", async () => {
    let current = record;
    const makePr = (number: number) => pr({ repo: "acme/app", number });
    const { slot } = await page(`insights/references/ref/${record.id}`, {
      getConfig: () => ({ config: config({ servers: [{ id: "github", name: "GitHub", kind: "github", enabled: true, sep: "#", commands: {} }] }) }),
      reference: () => current,
      referenceLog: ({ filter }) => { const include = filter === "handled" ? current.status === "corrected" : filter === "pending" ? current.status !== "corrected" : true; return { rows: include ? [current] : [], total: 1, filteredTotal: include ? 1 : 0, counts: {}, events: [] }; },
      detail: ({ key }) => ({ pr: makePr(key.endsWith("#90388") ? 90388 : 90386), events: [], body: "", draft: null, drafts: 0 }),
      referenceFeedback: () => { current = { ...current, status: "corrected", url: "https://github.com/acme/app/pull/90388" }; return current; },
    });
    const side = await waitFor(() => { const r = slot.container.querySelector<HTMLElement>('[data-panel] [data-detail="github:acme/app#90386"]'); if (!r) throw new Error("no reference side panel"); return r; });
    expect(slot.getByRole("searchbox", { name: "Search references" })).toBeTruthy();
    expect(within(side).queryByRole("button", { name: "Open as a full page" })).toBeNull();
    fireEvent.click(slot.getByText("Correct this reference"));
    fireEvent.change(slot.getByRole("textbox", { name: "Correct reference target" }), { target: { value: "https://github.com/acme/app/pull/90388" } });
    fireEvent.click(slot.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(slot.container.querySelector('[data-panel] [data-detail="github:acme/app#90388"]')).not.toBeNull());
    expect(slot.container.querySelector('[data-panel] [data-detail="github:acme/app#90386"]')).toBeNull();
    expect(slot.getByRole("searchbox", { name: "Search references" })).toBeTruthy();
  });

  it("opens an unlinked matched PR in the thread panel and follows corrections", async () => {
    let current = record;
    rememberPanelReference("thr_1", record.id);
    const loaded = await app();
    const slot = mount<ExperimentalThreadActionTabProps>(loaded.tabs[0]!.component as never, { threadId: "thr_1", environment: null, params: { threadId: "thr_1" } }, handlers({
      getConfig: () => ({ config: config({ servers: [{ id: "github", name: "GitHub", kind: "github", enabled: true, sep: "#", commands: {} }] }) }),
      reference: () => current,
      threadPrs: () => ({ prs: [], sent: [] }),
      detail: ({ key }) => ({ pr: pr({ repo: "acme/app", number: key.endsWith("#90388") ? 90388 : 90386 }), events: [], body: "", draft: null, drafts: 0 }),
      referenceFeedback: () => { current = { ...current, status: "corrected", url: "https://github.com/acme/app/pull/90388" }; return current; },
    }), { sdk: { threads: { get: async () => ({ environmentId: null }) as never } } });
    await waitFor(() => expect(slot.container.querySelector('[data-panel-pr="github:acme/app#90386"]')).not.toBeNull());
    expect(slot.queryByRole("button", { name: "Show in Shuttle" })).toBeNull();
    current = { ...current, status: "corrected", url: "https://github.com/acme/app/pull/90388" };
    await slot.behavior.experimental_invalidateRpc(["references"]);
    await waitFor(() => expect(slot.container.querySelector('[data-panel-pr="github:acme/app#90388"]')).not.toBeNull());
    expect(slot.container.querySelector('[data-panel-pr="github:acme/app#90386"]')).toBeNull();
  });

  it("keeps a selected reference in a sheet rather than a full PR page on phones", async () => {
    setViewport(390);
    const { slot } = await page(`insights/references/ref/${record.id}`, {
      getConfig: () => ({ config: config({ servers: [{ id: "github", name: "GitHub", kind: "github", enabled: true, sep: "#", commands: {} }] }) }),
      reference: () => record,
      referenceLog: () => ({ rows: [record], total: 1, filteredTotal: 1, counts: {}, events: [] }),
      detail: () => ({ pr: pr({ repo: "acme/app", number: 90386 }), events: [], body: "", draft: null, drafts: 0 }),
    });
    await slot.findByRole("dialog", { name: "Matched pull request" });
    expect(slot.container.querySelector("[data-phone-pr]")).toBeNull();
  });

  it("opens the selected handled reference and its status group after navigation", async () => {
    const saved = { ...record, status: "corrected" as const };
    const { slot } = await page(`insights/references/ref/${record.id}`, {
      getConfig: () => ({ config: config({ servers: [{ id: "github", name: "GitHub", kind: "github", enabled: true, sep: "#", commands: {} }] }) }),
      reference: () => saved,
      referenceLog: ({ filter }) => ({ rows: filter === "handled" ? [saved] : [], counts: { corrected: 1 }, total: 1, filteredTotal: filter === "handled" ? 1 : 0, events: [] }),
      detail: () => ({ pr: pr({ repo: "acme/app", number: 90386 }), events: [], body: "", draft: null, drafts: 0 }),
    });
    await waitFor(() => expect(slot.container.querySelector(`[data-reference="${record.id}"] button[aria-label="Details for #90386"]`)?.getAttribute("aria-expanded")).toBe("true"));
  });

  it("stops showing a cached PR when its selected reference disappears", async () => {
    let gone = false;
    const { slot } = await page(`insights/references/ref/${record.id}`, {
      getConfig: () => ({ config: config({ servers: [{ id: "github", name: "GitHub", kind: "github", enabled: true, sep: "#", commands: {} }] }) }),
      reference: () => { if (gone) throw Object.assign(new Error("Reference no longer in log"), { code: "not_found" }); return record; },
      detail: () => ({ pr: pr({ repo: "acme/app", number: 90386 }), events: [], body: "", draft: null, drafts: 0 }),
    });
    await waitFor(() => expect(slot.container.querySelector('[data-panel] [data-detail="github:acme/app#90386"]')).not.toBeNull());
    gone = true;
    await slot.behavior.experimental_invalidateRpc(["references"]);
    await waitFor(() => expect(slot.container.querySelector('[data-panel] [data-detail="github:acme/app#90386"]')).toBeNull());
  });

  it("lets the top dialog handle Escape above a matched PR sheet", () => {
    const close = vi.fn();
    const top = vi.fn();
    const Stack = () => <><Dialog title="Matched PR" onClose={close} escapeDisabled>Matched</Dialog><Dialog title="Action" onClose={top}>Action</Dialog></>;
    mount(Stack, {}, handlers());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(top).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("shares highlight ranges across messages without replacing their text", () => {
    const registry = new Map<string, Set<Range>>();
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", class extends Set<Range> { constructor(...values: Range[]) { super(values); } });
    const node = document.createTextNode("#90386 #90387"); document.body.append(node);
    const first = document.createRange(); first.setStart(node, 0); first.setEnd(node, 6);
    const second = document.createRange(); second.setStart(node, 7); second.setEnd(node, 13);
    const a = Symbol(), b = Symbol();
    try {
      setReferenceHighlights(a, [first]); setReferenceHighlights(b, [second]);
      expect(registry.get("shuttle-inferred-links")!.size).toBe(2);
      clearReferenceHighlights(a);
      expect(registry.get("shuttle-inferred-links")!.size).toBe(1);
      expect(node.data).toBe("#90386 #90387");
      clearReferenceHighlights(b);
      expect(registry.has("shuttle-inferred-links")).toBe(false);
    } finally { clearReferenceHighlights(a); clearReferenceHighlights(b); vi.unstubAllGlobals(); }
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
