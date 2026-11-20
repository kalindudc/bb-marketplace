// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { fixtureJournal } from "../../../src/ui/thread/fixtures";
import { expandIdentityEntry, journalViewer, junoId, openIdentityJournal } from "./journal-identity-fixture";

afterEach(() => { cleanup(); localStorage.clear(); });

it("names a child member on the owner line, with a crest and link to its thread", async () => {
  const slot = openIdentityJournal();
  const detail = within(await expandIdentityEntry(slot, "Check the output"));
  const owner = await detail.findByText("Owner: Juno, a child of this thread");
  await waitFor(() => expect(owner.closest(".journal-owner")?.querySelector("svg")).not.toBeNull());
  fireEvent.click(detail.getByRole("button", { name: "Open thread: Juno" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: junoId }]);
});

it("opens the owning thread from the compact delegated row without expanding it", async () => {
  const slot = openIdentityJournal();
  fireEvent.click(await slot.findByRole("button", { name: /^Delegated/ }));
  const row = (await slot.findByText("Review the notes")).closest(".journal-row") as HTMLElement;
  fireEvent.click(await within(row).findByRole("button", { name: "Open thread: Juno" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: junoId }]);
  expect(slot.queryByRole("region", { name: "Details of Review the notes" })).toBeNull();
});

it("names the actor in both history views without a raw thread id or claiming the actor is this thread", async () => {
  const slot = openIdentityJournal();
  const detail = within(await expandIdentityEntry(slot, "Check the output"));
  const recent = detail.getByRole("list", { name: "Recent changes" });
  expect(await within(recent).findByText("Juno, Moss's Smith")).toBeTruthy();
  const history = slot.getByText(/^History · /).closest("details")!;
  history.open = true;
  for (const view of [recent, history]) {
    expect(within(view).getByText("Juno")).toBeTruthy();
    expect(view.textContent).not.toMatch(/this thread.s agent|thr_/i);
  }
});

it("marks an archived owner and still navigates to it", async () => {
  const slot = openIdentityJournal();
  const detail = within(await expandIdentityEntry(slot, "Read the old report"));
  expect(await detail.findByText("Owner: Wren II (archived)")).toBeTruthy();
  fireEvent.click(detail.getByRole("button", { name: "Open thread: Wren II" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_wren" }]);
});

it("calls a deleted owner a deleted thread and never offers its link, even on the chip", async () => {
  const slot = openIdentityJournal();
  const detail = within(await expandIdentityEntry(slot, "Pick up the audit"));
  expect(await detail.findByText("Owner: a deleted thread")).toBeTruthy();
  expect(detail.queryByRole("button", { name: /open .*thread/i })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /^Delegated/ }));
  const row = (await slot.findByText("Pick up the audit")).closest(".journal-row") as HTMLElement;
  expect(await within(row).findByText("a deleted thread")).toBeTruthy();
  expect(within(row).queryByRole("button", { name: /open .*thread/i })).toBeNull();
});

it.each([3, 52])("requests one identity page per 50 visible delegated owners (%i owners)", async count => {
  const ids = Array.from({ length: count }, (_, i) => `thr_owner_${i}`);
  const rows = ids.map((owner, i) => ({ ...fixtureJournal.entries[0]!, id: i.toString(36).padStart(2, "0"), description: `Delegated work ${i}`, owner, order: i, status: "todo" as const }));
  const slot = openIdentityJournal({ rows, changes: [], identitiesOf: ids.map((threadId, i) => ({
    threadId, name: `Owner ${i}`, role: "thread", relation: "other", life: "live",
    classId: null, className: null, characterId: null, keeper: null, canOpen: true,
  })) });
  fireEvent.click(await slot.findByRole("button", { name: /^Delegated/ }));
  await slot.findByText(`Owner ${count - 1}`);
  const calls = slot.inspection.rpcCalls.filter(c => c.method === "identities");
  expect(calls).toHaveLength(Math.ceil(count / 50));
  expect(calls.flatMap(c => (c.input as { ids: string[] }).ids).sort()).toEqual(ids.sort());
});

it("does not guess an owner or a history actor while identities load", async () => {
  let resolve!: () => void;
  const waitForIdentities = new Promise<void>(settle => { resolve = settle; });
  const slot = openIdentityJournal({ waitForIdentities });
  const detail = within(await expandIdentityEntry(slot, "Check the output"));
  const owner = detail.getByText(/^Owner:\s*$/).closest(".journal-owner");
  expect(owner?.querySelector(".sk-l")).toBeTruthy();
  const recent = detail.getByRole("list", { name: "Recent changes" });
  expect(recent.querySelectorAll(".who-n .sk-l")).toHaveLength(2);
  expect(recent.textContent).not.toMatch(/a thread|deleted thread/i);
  expect(detail.queryByRole("button", { name: /^Open thread/ })).toBeNull();
  if (process.env.TAVERN_JOURNAL_HARNESS === "1") process.stdout.write("JOURNAL_LOADING_HARNESS=" + JSON.stringify(slot.container.innerHTML) + "\n");
  resolve();
  expect(await detail.findByText("Owner: Juno, a child of this thread")).toBeTruthy();
});

it("keeps resolved names while a larger history page loads", async () => {
  let resolve!: () => void;
  const pending = new Promise<void>(settle => { resolve = settle; });
  const changes = Array.from({ length: 21 }, (_, i) => ({
    id: i + 1, entryIds: ["01"], threadId: journalViewer, at: Date.now(), seen: true,
    actor: { kind: "agent" as const, threadId: i === 0 ? "thr_older" : junoId },
    action: "note", text: i === 0 ? "noted older work." : "noted current work.",
  }));
  const slot = openIdentityJournal({ changes, waitForIdentities: ids => ids.includes("thr_older") ? pending : undefined });
  const fold = (await slot.findByText(/^History · /)).closest("details")!;
  fold.open = true;
  await within(fold).findAllByText("Juno");
  fireEvent.click(within(fold).getByRole("button", { name: "Show all 21" }));
  expect(within(fold).queryAllByText("Juno")).toHaveLength(20);
  expect(within(fold).getByText("noted older work.").closest("li")?.querySelector(".who-n .sk-l")).toBeTruthy();
  resolve();
  expect(await within(fold).findByText("A thread")).toBeTruthy();
  expect(within(fold).getAllByText("Juno")).toHaveLength(20);
});

it("labels the last update and de-duplicates the expanded row's open control", async () => {
  const slot = openIdentityJournal();
  fireEvent.click(await slot.findByRole("button", { name: /^Delegated/ }));
  const detail = await expandIdentityEntry(slot, "Check the output");
  await within(detail).findByRole("button", { name: "Open thread: Juno" });
  const entry = detail.closest(".journal-entry") as HTMLElement;
  expect(within(entry).getAllByRole("button", { name: "Open thread: Juno" })).toHaveLength(1);
  expect(within(detail).getByText(/^Updated$/)).toBeTruthy();
});

it("keeps a literal owner verbatim and never requests or opens it", async () => {
  const owner = "External maintainer Name";
  const rows = [{ ...fixtureJournal.entries[0]!, id: "01", description: "Check the output", owner, updatedBy: { kind: "user" as const } }];
  const slot = openIdentityJournal({ rows, changes: [] });
  fireEvent.click(await slot.findByRole("button", { name: /^Delegated/ }));
  const detail = within(await expandIdentityEntry(slot, "Check the output"));
  expect(detail.getByText(`Owner: ${owner}`)).toBeTruthy();
  expect(detail.getByText("Updated by you")).toBeTruthy();
  expect(slot.queryByRole("button", { name: /^Open thread/ })).toBeNull();
  expect(slot.inspection.rpcCalls.filter(c => c.method === "identities")).toEqual([]);
});

it("cuts a long chip at a word but keeps the full owner title", async () => {
  const name = "Operations and resilience checklist owner";
  const rows = [{ ...fixtureJournal.entries[0]!, id: "01", description: "Check the output", owner: junoId }];
  const slot = openIdentityJournal({ rows, changes: [], identitiesOf: [{ threadId: junoId, name, role: "thread", relation: "other", life: "live", classId: null, className: null, characterId: null, keeper: null, canOpen: true }] });
  fireEvent.click(await slot.findByRole("button", { name: /^Delegated/ }));
  expect((await slot.findByText("Operations and…")).closest("[title]")?.getAttribute("title")).toBe(`Owner: ${name}`);
});

it("capitalises fallback actors and normalises old link and phase text", async () => {
  const threadId = journalViewer, entryIds = ["04"], at = Date.now(), seen = true;
  const slot = openIdentityJournal({ changes: [
    { id: 1, entryIds, threadId, at, seen, action: "link", actor: { kind: "agent", threadId: "thr_deleted" }, text: 'Tavern assigned [04] "Audit" to waypoint w1.' },
    { id: 2, entryIds, threadId, at, seen, action: "board-phase", actor: { kind: "tavern" }, text: "Board quest phases refreshed: [04]." },
    { id: 3, entryIds, threadId, at, seen, action: "note", actor: { kind: "agent", threadId: "thr_missing" }, text: "noted [04]." },
  ] });
  const detail = within(await expandIdentityEntry(slot, "Pick up the audit"));
  const recent = within(detail.getByRole("list", { name: "Recent changes" }));
  const deleted = await recent.findByText("A deleted thread");
  expect(deleted.closest("li")?.textContent).toContain("A deleted thread assigned");
  expect(recent.getByText("Tavern").closest("li")?.textContent).toContain("Tavern refreshed board quest phases");
  expect(recent.getByText("A thread").closest("li")?.textContent).toContain("A thread noted");
});

it.runIf(process.env.TAVERN_JOURNAL_HARNESS === "1")("renders journal identities for the browser layout harness", async () => {
  const slot = openIdentityJournal();
  fireEvent.click(await slot.findByRole("button", { name: /^Delegated/ }));
  for (const description of ["Check the output", "Read the old report", "Pick up the audit"]) {
    await expandIdentityEntry(slot, description);
  }
  const fold = slot.getByText(/^History · /).closest("details")!;
  fold.open = true;
  await within(fold).findByText("Juno, Moss's Smith");
  await slot.findByText("Owner: a deleted thread");
  await slot.findByText("Owner: Wren II (archived)");
  const owner = await slot.findByText("Owner: Juno, a child of this thread");
  await waitFor(() => expect(owner.closest(".journal-owner")?.querySelector("svg")).not.toBeNull());
  process.stdout.write("JOURNAL_HARNESS=" + JSON.stringify(slot.container.innerHTML) + "\n");
});
