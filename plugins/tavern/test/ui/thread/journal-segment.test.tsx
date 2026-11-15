// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactElement } from "react";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { definePluginApp, type ExperimentalThreadContextSegmentInput } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { fixtureDecor, fixtureJournal, fixtureMember, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { journalSchema, type JournalEntry } from "../../../src/shared/schema";
import { nextEntries } from "../../../src/ui/thread/journal-segment";

afterEach(cleanup);
const load = () => loadPluginApp(definePluginApp(registerThreadSurfaces));
const base = fixtureJournal.entries[0]!;
const entry = (id: string, order: number, over: Partial<JournalEntry> = {}): JournalEntry => ({ ...base, id, order, description: `Entry ${id}`, status: "todo", ...over });
const entries = [
  entry("a1", 0, { status: "done" }),
  entry("a2", 1, { description: "Wire the segment into bb's context row" }),
  entry("s1", 0, { parentId: "a2", status: "doing", description: "Write the summary" }),
  entry("a3", 2, { link: { boardQuestId: "vault", waypointId: "w1" }, description: "Linked work" }),
  entry("a4", 3, { status: "blocked" }),
  entry("a5", 4),
  entry("a6", 5),
];
const progress = { done: 1, total: 7, blocked: 1, current: { id: "s1", description: "Write the summary", status: "doing" as const } };
const journal = journalSchema.parse({ ...fixtureJournal, entries, progress });
const plainDecor = { ...fixtureDecor, member: null, keeperView: null, progress };
const props = (isExpanded: boolean) => ({ threadId: "t", projectId: "p", environment: null, segments: [], isExpanded, onToggle: vi.fn() });

describe("journal context segment", () => {
  it("registers beside Shuttle's pull requests and as a card section", async () => {
    const app = await load();
    const segment = app.threadContextSegments.find(s => s.id === "journal")!;
    expect(segment).toMatchObject({ title: "Journal (checklist)", group: "2_tavern-journal" });
    expect(segment.group > "2_pullRequest" && segment.group < "3_git").toBe(true);
    expect(app.threadContextCardSections.find(s => s.id === "journal")?.title).toBe("Journal");
  });

  it("shows only for threads whose journal has entries", async () => {
    const app = await load();
    const useVisible = app.threadContextSegments.find(s => s.id === "journal")!.useVisible!;
    const Probe = (input: ExperimentalThreadContextSegmentInput) => <span data-testid="v">{String(useVisible(input))}</span>;
    for (const [total, expected] of [[7, "true"], [0, "false"]] as const) {
      const slot = renderSlot({ component: Probe }, { threadId: "t", projectId: "p", environment: null }, { threadContextKind: "banner", rpc: { decor: () => ({ ...plainDecor, progress: { ...progress, total, done: 0, blocked: 0, current: null } }) } });
      await waitFor(() => expect(slot.getByTestId("v").textContent).toBe(expected));
      slot.lifecycle.unmount();
    }
  });

  // bb reports "card" for wide panes even while the card is hidden, so the segment follows the card's own `hidden` attribute.
  describe("in exactly one place: the segment or the shown card", () => {
    const scene = (useVisible: (i: ExperimentalThreadContextSegmentInput) => boolean, Section: (p: { threadId: string; projectId: string; environment: null }) => ReactElement | null, card: "shown" | "hidden" | "none") => (input: ExperimentalThreadContextSegmentInput) => {
      const [hidden, setHidden] = useState(card === "hidden");
      const section = <Section threadId={input.threadId} projectId="p" environment={null} />;
      return <>
        <span data-testid="v">{String(useVisible(input))}</span>
        <button type="button" onClick={() => setHidden(h => !h)}>toggle card</button>
        {card === "none" ? section : <div data-thread-context-card="" hidden={hidden}>{section}</div>}
      </>;
    };
    const run = async (kind: "card" | "banner", card: "shown" | "hidden" | "none", threadId: string) => {
      const app = await load();
      const useVisible = app.threadContextSegments.find(s => s.id === "journal")!.useVisible!;
      const Section = app.threadContextCardSections.find(s => s.id === "journal")!.component as never;
      return renderSlot({ component: scene(useVisible, Section, card) }, { threadId, projectId: "p", environment: null }, { threadContextKind: kind, rpc: { decor: () => plainDecor, journal: () => journal } });
    };
    it("shows the segment in a card pane whose card is hidden, and hides it when the card is shown", async () => {
      const slot = await run("card", "hidden", "card-hidden");
      await slot.findByText("1 of 7 done · 1 blocked");
      await waitFor(() => expect(slot.getByTestId("v").textContent).toBe("true"));
      fireEvent.click(slot.getByRole("button", { name: "toggle card" }));
      await waitFor(() => expect(slot.getByTestId("v").textContent).toBe("false"));
      slot.lifecycle.unmount();
    });
    it("hides the segment while the card is shown", async () => {
      const slot = await run("card", "shown", "card-shown");
      await slot.findByText("1 of 7 done · 1 blocked");
      await waitFor(() => expect(slot.getByTestId("v").textContent).toBe("false"));
      slot.lifecycle.unmount();
    });
    it("shows the segment in a banner pane even when a card is drawn", async () => {
      const slot = await run("banner", "shown", "banner-pane");
      await slot.findByText("1 of 7 done · 1 blocked");
      await waitFor(() => expect(slot.getByTestId("v").textContent).toBe("true"));
      slot.lifecycle.unmount();
    });
    it("shows the segment when the probe finds no card container", async () => {
      const slot = await run("card", "none", "no-card");
      await slot.findByText("1 of 7 done · 1 blocked");
      await waitFor(() => expect(slot.getByTestId("v").textContent).toBe("true"));
      slot.lifecycle.unmount();
    });
  });

  it("summarises with the mark, the count and blocked work, and toggles the details", async () => {
    const app = await load();
    const segment = app.threadContextSegments.find(s => s.id === "journal")!;
    const p = props(false);
    const slot = renderSlot({ component: segment.summary }, p, { rpc: { decor: () => plainDecor } });
    const button = await slot.findByRole("button", { name: "Journal (checklist): 1 of 7 done, 1 blocked" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("data-segment-summary")).toBe(true);
    expect(button.textContent).toContain("1 of 7");
    expect(button.textContent).toContain("1/7");
    fireEvent.click(button);
    expect(p.onToggle).toHaveBeenCalledTimes(1);
    slot.lifecycle.unmount();
    const empty = renderSlot({ component: segment.summary }, props(false), { rpc: { decor: () => ({ ...plainDecor, progress: { ...progress, total: 0, done: 0 } }) } });
    await waitFor(() => expect(empty.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(empty.queryByRole("button")).toBeNull();
    empty.lifecycle.unmount();
  });

  it("lists the current entry first, then the next open ones in journal order", () => {
    const { shown, more } = nextEntries(entries, "s1", 4);
    expect(shown.map(e => e.id)).toEqual(["s1", "a2", "a3", "a4"]);
    expect(more).toBe(2);
  });

  it("details tick an entry, open linked work in the journal, and open the journal", async () => {
    const app = await load();
    const segment = app.threadContextSegments.find(s => s.id === "journal")!;
    const journalEdit = vi.fn(() => ({ ok: true, message: "Done" }));
    const openTab = vi.fn(() => true);
    const collapsed = renderSlot({ component: segment.details! }, props(false), { rpc: { journal: () => journal, journalEdit } });
    expect(collapsed.container.textContent).toBe("");
    collapsed.lifecycle.unmount();
    const slot = renderSlot({ component: segment.details! }, props(true), { rpc: { journal: () => journal, journalEdit }, experimental_panel: { openTab } });
    const list = await slot.findByRole("list", { name: "Next in the journal" });
    expect(list.querySelectorAll("li")).toHaveLength(4);
    expect(slot.getByText("+2 more open")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Mark “Write the summary” done" }));
    await waitFor(() => expect(journalEdit).toHaveBeenCalled());
    expect(slot.inspection.rpcCalls.find(c => c.method === "journalEdit")?.input).toMatchObject({ threadId: "t", edit: { op: "status", entryIds: ["s1"], status: "done" } });
    fireEvent.click(slot.getByRole("button", { name: /Mark “Linked work” done: add evidence/ }));
    expect(journalEdit).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenLastCalledWith(expect.objectContaining({ tab: expect.objectContaining({ id: "journal" }), params: { focus: "a3" } }));
    fireEvent.click(slot.getByRole("button", { name: /Open “Entry a4” in the journal, blocked/ }));
    expect(openTab).toHaveBeenLastCalledWith(expect.objectContaining({ params: { focus: "a4" } }));
    fireEvent.click(slot.getByRole("button", { name: "Open the journal" }));
    expect(openTab).toHaveBeenLastCalledWith({ tab: expect.objectContaining({ id: "journal" }) });
    slot.lifecycle.unmount();
  });
});

describe("Tavern's widget row without the journal", () => {
  const banner = async () => (await load()).composerCustomizations.find(c => c.id === "tavern-thread")!.banners![0]!;
  it("draws no Tavern row for a plain thread that has only a journal", async () => {
    const slot = renderSlot(await banner(), {}, { composer: { scope: { kind: "thread", threadId: "t" } }, rpc: { decor: () => plainDecor, registry: () => fixtureRegistry } });
    await waitFor(() => expect(slot.inspection.rpcCalls.some(c => c.method === "decor")).toBe(true));
    expect(slot.queryByLabelText("Tavern widget")).toBeNull();
    expect(slot.container.textContent).toBe("");
    slot.lifecycle.unmount();
  });
  it("keeps a member's row but without a journal button", async () => {
    const member = { ...fixtureMember, role: "member" as const };
    const slot = renderSlot(await banner(), {}, { composer: { scope: { kind: "thread", threadId: "m" } }, rpc: { decor: () => ({ ...plainDecor, threadId: "m", member }), registry: () => fixtureRegistry } });
    await slot.findByLabelText("Tavern widget");
    expect(slot.queryByRole("button", { name: /journal/i })).toBeNull();
    expect(slot.container.textContent).not.toContain("1 of 7");
    slot.lifecycle.unmount();
  });
  it("has no crest toggle in a plain thread, where there is no row to hide", async () => {
    const thread = (await load()).composerCustomizations.find(c => c.id === "tavern-thread")!;
    const slot = renderSlot(thread.actions![0]!, {}, { composer: { scope: { kind: "thread", threadId: "t" } }, rpc: { decor: () => plainDecor, registry: () => fixtureRegistry } });
    await waitFor(() => expect(slot.inspection.rpcCalls.some(c => c.method === "decor")).toBe(true));
    expect(slot.queryByRole("button")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("journal tab opened on one entry", () => {
  it("expands the entry named by params.focus", async () => {
    const { JournalTab } = await import("../../../src/ui/thread/journal");
    const slot = renderSlot({ component: JournalTab }, { threadId: "t", environment: null, params: { focus: "a4" } }, { rpc: { journal: () => journal, decor: () => plainDecor, registry: () => fixtureRegistry } });
    const detail = await slot.findByRole("region", { name: "Details of Entry a4" });
    expect(detail).toBeTruthy();
    expect(slot.getByRole("button", { name: /Entry a4/, expanded: true })).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
