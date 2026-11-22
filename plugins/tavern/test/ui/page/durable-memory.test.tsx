import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { memoryContract, memoryNote } from "../../../src/shared/memory";
import { MemoryPage } from "../../../src/ui/page/durable-memory";
import { MemorySettings } from "../../../src/ui/page/memory-settings";

const config = { active: "builtin", profiles: [{ id: "field-notes", name: "Field notes", save: "/opt/notes/save", find: "/opt/notes/find", curate: "/opt/notes/curate", timeoutSeconds: 15 }] };
it("makes the active store an explicit settings change", async () => {
  const save = vi.fn(() => ({ revision: 4, config: { ...config, active: "field-notes" } }));
  const view = renderSlot({ component: MemorySettings }, {}, { pluginId: "tavern", experimental_rpcContract: memoryContract,
    rpc: { memorySettings: () => ({ revision: 3, config }), memoryConfigure: save } });
  try {
    fireEvent.change(await view.findByLabelText("Active store"), { target: { value: "field-notes" } });
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Save memory settings" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ revision: 3, config: { ...config, active: "field-notes" } }));
  } finally { view.lifecycle.unmount(); }
});
it("filters notes on submit and says when external notes are managed elsewhere", async () => {
  const list = vi.fn(() => ({ store: "Field notes", external: true, notes: [], unreviewed: [], more: false }));
  const view = renderSlot({ component: MemoryPage }, {}, { pluginId: "tavern", experimental_rpcContract: memoryContract,
    rpc: { memoryProjects: () => [{ id: "demo", name: "Sample project" }], memoryList: list } });
  try {
    expect(await view.findByText(/manage notes in Field notes/i)).toBeTruthy();
    fireEvent.change(view.getByRole("searchbox", { name: "Search notes" }), { target: { value: "index" } });
    fireEvent.change(view.getByLabelText("Kind"), { target: { value: "finding" } });
    fireEvent.click(view.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ project: "demo", text: "index", kind: "finding" })));
  } finally { view.lifecycle.unmount(); }
});
it("shows named authors and reviewers, opens the predecessor, and can exclude an external note", async () => {
  const note = memoryNote.parse({
    id: "demo-note", project: "demo", quest: null, kind: "finding", title: "New timing", body: "Recent timings",
    source: { kind: "command", value: "npm test" }, appliesTo: { kind: "date", value: "2026-06-12" }, tags: [],
    author: { thread: "maker", classId: "smith" }, curator: "lead", status: "accepted", memory: "included",
    exclusionReason: null, supersedes: "old-note", reviewedBy: "lead", reviewedAt: 2, createdAt: 1, updatedAt: 2,
  });
  const prior = { ...note, id: "old-note", title: "Initial timing", body: "Earlier result", supersedes: null, status: "superseded" as const };
  const manage = vi.fn(() => ({ ...note, memory: "excluded", exclusionReason: "Noisy", updatedAt: 3 }));
  const view = renderSlot({ component: MemoryPage }, {}, { pluginId: "tavern", experimental_rpcContract: memoryContract,
    rpc: { memoryProjects: () => [{ id: "demo", name: "Sample project" }],
      memoryList: () => ({ store: "Field notes", external: true, notes: [note], unreviewed: [], more: false,
        people: { maker: "Juno (Smith)", lead: "Wren (Keeper)" }, previousTitles: { [prior.id]: prior.title } }),
      memoryPrevious: () => prior, memoryManage: manage } });
  try {
    const title = await view.findByText(note.title);
    title.closest("details")!.open = true;
    expect(view.getByText("Juno (Smith)")).toBeTruthy();
    expect(view.getByText(/^Wren \(Keeper\)/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: prior.title }));
    expect(await view.findByText(prior.body)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Exclude" }));
    fireEvent.change(view.getByLabelText("Reason"), { target: { value: "Noisy" } });
    fireEvent.click(view.getByRole("button", { name: "Confirm exclude" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ id: note.id, expectedUpdatedAt: 2, action: "exclude", reason: "Noisy" }));
  } finally { view.lifecycle.unmount(); }
});

it("re-includes a note with its observed revision", async () => {
  const note = memoryNote.parse({
    id: "demo-note", project: "demo", quest: null, kind: "finding", title: "Benchmarked result", body: "Recent timings",
    source: { kind: "command", value: "npm test" }, appliesTo: { kind: "date", value: "2026-06-12" }, tags: [],
    author: { thread: "maker", classId: "smith" }, curator: "lead", status: "accepted", memory: "excluded",
    exclusionReason: "No longer relevant", supersedes: null, reviewedBy: "lead", reviewedAt: 2, createdAt: 1, updatedAt: 2,
  });
  const manage = vi.fn(() => ({ ...note, memory: "included", exclusionReason: null, updatedAt: 3 }));
  const view = renderSlot({ component: MemoryPage }, {}, { pluginId: "tavern", experimental_rpcContract: memoryContract,
    rpc: { memoryProjects: () => [{ id: "demo", name: "Sample project" }],
      memoryList: () => ({ store: "Built-in", external: false, notes: [note], unreviewed: [], more: false }), memoryManage: manage } });
  try {
    const title = await view.findByText(note.title);
    title.closest("details")!.open = true;
    fireEvent.click(view.getByRole("button", { name: "Re-include" }));
    fireEvent.click(view.getByRole("button", { name: "Re-include note" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ id: note.id, expectedUpdatedAt: 2, action: "include" }));
  } finally { view.lifecycle.unmount(); }
});
