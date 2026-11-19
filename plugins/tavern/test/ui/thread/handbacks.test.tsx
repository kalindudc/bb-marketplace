// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { KeeperNoteRows } from "../../../src/ui/kit/memory";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
const note = { id: "hb", keeperThreadId: "keeper-1", boardQuestId: "vault", kind: "waiting-on-user" as const, text: "Access is pending", action: "Approve access", why: "Work cannot start", dueAt: null, condition: null, validUntil: null, sourceMessageId: "message", routeId: null, state: "open" as const, createdAt: 1000, updatedAt: 1000, doneAt: null, dueNotifiedAt: null };
afterEach(cleanup);
it("old hand-backs without an action still offer Done", async () => {
  const slot = renderSlot({ component: () => <KeeperNoteRows notes={[{ ...note, action: undefined }]} label="Waiting on you" /> }, {}, { rpc: { resolveHandBack: () => ({ ok: true as const }) } } as any);
  fireEvent.click(slot.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual(expect.objectContaining({ method: "resolveHandBack", input: { noteId: note.id, how: "done" } })));
});
it("Reply quotes the hand-back in the Keeper composer and resolves only on successful send", async () => {
  function Surface() { const composer = useComposer(); return <><KeeperNoteRows notes={[note]} label="Waiting on you" /><ThreadWidget threadId="keeper-1" /><button onClick={() => void composer.submit()}>Send reply</button></>; }
  const slot = renderSlot({ component: Surface }, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" }, text: "Approved" }, rpc: { decor: () => fixtureDecor, registry: () => fixtureRegistry, resolveHandBack: () => ({ ok: true as const }) } } as any);
  fireEvent.click(slot.getByRole("button", { name: "Reply" }));
  await waitFor(() => expect(slot.inspection.composer.draft.text).toContain("> Approve access"));
  expect(slot.inspection.composer.draft.text).toContain("Approved");
  expect(slot.inspection.rpcCalls.some(call => call.method === "resolveHandBack")).toBe(false);
  await act(async () => { fireEvent.click(slot.getByText("Send reply")); });
  await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual(expect.objectContaining({ method: "resolveHandBack", input: expect.objectContaining({ noteId: note.id, how: "replied" }) })));
});
