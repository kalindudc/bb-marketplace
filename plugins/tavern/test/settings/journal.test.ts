// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { makeHost } from "../journal/host";
import { MIGRATIONS } from "../../src/server/migrations";
import { createJournalStore } from "../../src/server/journal/store";
import { DEFAULT_SETTINGS } from "../../src/shared/settings";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(dispose => dispose())); vi.restoreAllMocks(); });
async function fixture() {
  const host = makeHost(); cleanup.push(host.dispose);
  host.bb.storage.migrate(host.db, MIGRATIONS);
  const prefs = { ...DEFAULT_SETTINGS.journal };
  const store = createJournalStore(host.bb, host.db, { roleOf: () => null, invalidate: () => {}, settings: () => prefs });
  await store.ready("thread");
  return { ...host, store, prefs };
}
it("applies the journal quiet interval live without changing the ten-minute default", async () => {
  let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const { store, prefs } = await fixture();
  await store.runTool("thread", { action: "add", descriptions: ["Build"] });
  await store.runTool("thread", { action: "start", id: "00" });
  now += 11 * 60_000;
  expect(store.progress("thread").quietSince).not.toBeNull();
  prefs.journalQuietMinutes = 20;
  expect(store.progress("thread").quietSince).toBeNull();
});
it("turns off stale reminders without suppressing unseen user edits", async () => {
  let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const { store, prefs } = await fixture(), send = vi.fn(async (_text: string) => {});
  await store.runTool("thread", { action: "add", descriptions: ["Build"] });
  now += 1000; prefs.journalReminders = false;
  expect(await store.deliverNote("thread", now, send)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  store.edit("thread", { op: "update", entryId: "00", description: "Build with a test" }, { kind: "user" });
  expect(await store.deliverNote("thread", now, send)).toBe(true);
  expect(send.mock.calls[0]![0]).not.toContain("You have not updated");
});
