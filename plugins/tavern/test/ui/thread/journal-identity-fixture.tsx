import { fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { JournalTab } from "../../../src/ui/thread/tabs";
import { fixtureDecor, fixtureJournal, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import type { Journal, JournalEntry } from "../../../src/shared/schema";
import { rpcContract } from "../../../src/shared/contract";
import type { ThreadIdentity } from "../../../src/shared/identity";

export const journalViewer = fixtureJournal.threadId;
export const junoId = "thr_juno";
const juno = { threadId: junoId, name: "Juno", role: "member" as const, classId: fixtureRegistry.classes[0]!.id, className: "Smith", characterId: fixtureRegistry.characters[0]!.id,
  keeper: { threadId: journalViewer, name: "Wren", sameParty: true }, relation: "child of this thread" as const, life: "live" as const, canOpen: true };
const identities: ThreadIdentity[] = [
  juno,
  { ...juno, threadId: "thr_wren", name: "Wren II", role: "keeper" as const, keeper: null, relation: "other" as const, life: "archived" as const },
  { ...juno, threadId: "thr_deleted", name: "Fern", life: "deleted" as const, canOpen: false },
  { ...juno, threadId: "thr_moss_juno", keeper: { threadId: "thr_moss", name: "Moss", sameParty: false }, relation: "other" as const },
];
const rows = [
  ["01", "Check the output", junoId],
  ["02", "Review the notes", junoId],
  ["03", "Read the old report", "thr_wren"],
  ["04", "Pick up the audit", "thr_deleted"],
] as const;
const now = Date.now();
const entries = rows.map(([id, description, owner], order): JournalEntry => ({ ...fixtureJournal.entries[0]!, id, order, description, owner, updatedAt: now - 600_000,
  updatedBy: { kind: "agent", threadId: owner }, status: "doing" }));
const fixtureChanges = [
  { id: 1, entryIds: ["01"], actor: { kind: "agent" as const, threadId: junoId }, action: "start", text: 'started [01] "Check the output" doing.' },
  { id: 2, entryIds: ["01"], actor: { kind: "agent" as const, threadId: "thr_moss_juno" }, action: "note", text: 'Agent thr_moss_juno noted [01] "Check the output". Reason: "Reviewed with thr_juno".' },
  { id: 3, entryIds: ["03"], actor: { kind: "agent" as const, threadId: "thr_wren" }, action: "note", text: 'noted [03] "Read the old report".' },
  { id: 4, entryIds: ["04"], actor: { kind: "agent" as const, threadId: "thr_deleted" }, action: "note", text: 'noted [04] "Pick up the audit".' },
].map(change => ({ ...change, threadId: journalViewer, at: now - 600_000, seen: true }));

export function openIdentityJournal({
  rows = entries, identitiesOf = identities, changes = fixtureChanges, waitForIdentities,
}: { rows?: JournalEntry[]; identitiesOf?: ThreadIdentity[]; changes?: Journal["changes"]; waitForIdentities?: Promise<void> | ((ids: string[]) => Promise<void> | undefined) } = {}) {
  return renderSlot({ component: JournalTab }, { threadId: journalViewer, environment: null, params: null }, { rpc: {
    journal: () => ({ ...fixtureJournal, entries: rows, changes, progress: { total: rows.length, done: 0, blocked: 0, current: null } }),
    decor: () => fixtureDecor, registry: () => fixtureRegistry,
    identities: async input => {
      const { ids } = rpcContract.identities.input.parse(input);
      await (typeof waitForIdentities === "function" ? waitForIdentities(ids) : waitForIdentities);
      return { identities: identitiesOf.filter(identity => ids.includes(identity.threadId)) };
    },
  } });
}

export async function expandIdentityEntry(slot: ReturnType<typeof openIdentityJournal>, description: string) {
  fireEvent.click(await slot.findByRole("button", { name: new RegExp(`^0[1-4]\\s*${description}$`) }));
  return slot.getByRole("region", { name: `Details of ${description}` });
}
