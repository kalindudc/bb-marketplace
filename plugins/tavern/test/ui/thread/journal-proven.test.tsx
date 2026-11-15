// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDecor, fixtureJournal, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { JournalTab } from "../../../src/ui/thread/tabs";
import { journalSchema, type JournalEntry } from "../../../src/shared/schema";

afterEach(() => { cleanup(); localStorage.clear(); });
const base = fixtureJournal.entries[0]!;
const agent = { kind: "agent" as const, threadId: "k" };
const entry = (id: string, order: number, over: Partial<JournalEntry> = {}): JournalEntry => ({ ...base, threadId: "k", id, order, description: `Entry ${id}`, status: "todo", owner: null, report: null, createdBy: agent, ...over });
const make = (entries: JournalEntry[]) => journalSchema.parse({ ...fixtureJournal, threadId: "k", entries, changes: [], progress: { done: entries.filter(e => e.status === "done" || e.status === "verified").length, total: entries.length, blocked: entries.filter(e => e.status === "blocked").length, current: null } });
const open = (data: ReturnType<typeof make>) => renderSlot({ component: JournalTab }, { threadId: "k", environment: null, params: null }, { rpc: { journal: () => data, decor: () => fixtureDecor, registry: () => fixtureRegistry, crests: () => ({ crests: [] }) } });
const review = { actor: { kind: "agent" as const, threadId: "warden-1" }, at: 2000, evidence: [], reason: null, previousNote: null, memberEvidenceAt: null };

describe("proven work in the journal", () => {
  it("a finished journal names what a Warden verified, and never how long it took", async () => {
    const slot = open(make([entry("01", 0, { status: "verified", review }), entry("02", 1, { status: "verified", review }), entry("03", 2, { status: "done" })]));
    const line = await waitFor(() => { const el = slot.container.querySelector(".journal-alldone"); if (!el) throw new Error("no line"); return el; });
    expect(line.textContent).toBe("All 3 done · 2 verified by a Warden");
  });
  it("says only that it is done when nothing was verified", async () => {
    const slot = open(make([entry("01", 0, { status: "done" }), entry("02", 1, { status: "done" })]));
    const line = await waitFor(() => { const el = slot.container.querySelector(".journal-alldone"); if (!el) throw new Error("no line"); return el; });
    expect(line.textContent).toBe("All 2 done.");
  });
});

describe("the user's own entries", () => {
  it("carry a still pen mark named Added by you, and agent entries carry none", async () => {
    const slot = open(make([entry("01", 0, { createdBy: { kind: "user" }, description: "Mine" }), entry("02", 1, { description: "The agent's" })]));
    const mine = (await slot.findByText("Mine")).closest(".journal-row")!;
    const theirs = slot.getByText("The agent's").closest(".journal-row")!;
    const pen = mine.querySelector(".meta .pen")!;
    expect(pen.textContent).toBe("Added by you");
    expect(pen.classList.contains("wide")).toBe(true);
    expect(pen.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(theirs.querySelector(".pen")).toBeNull();
  });
});

describe("what the kit's journal cues read", () => {
  it("marks each entry with its id and state", async () => {
    const slot = open(make([entry("01", 0, { status: "blocked" }), entry("02", 1, { status: "doing" })]));
    await slot.findByText("Entry 01");
    expect([...slot.container.querySelectorAll(".journal-entry")].map(e => [(e as HTMLElement).dataset.entry, (e as HTMLElement).dataset.entryState])).toEqual([["01", "blocked"], ["02", "doing"]]);
  });
});
