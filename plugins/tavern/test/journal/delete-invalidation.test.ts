// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { makeHost } from "./host";
import { createJournalStore } from "../../src/server/journal/store";
import { MIGRATIONS } from "../../src/server/migrations";
import type { JournalDeps } from "../../src/server/ports";
import { tags } from "../../src/shared/contract";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });
// The rule bb.rpc.experimental_invalidate applies: a nonempty list of nonempty tags. An empty list throws "too_small, minimum 1".
const sdkTags = z.array(z.string().min(1)).min(1);
function fixture() {
  const host = makeHost({}, false); cleanup.push(host.dispose); host.bb.storage.migrate(host.db, MIGRATIONS);
  const sent: string[][] = [];
  const roles: JournalDeps["roleOf"] = (threadId) => threadId === "w" ? { classId: "warden", keeperThreadId: "k" } as never : null;
  const store = createJournalStore(host.bb, host.db, { roleOf: roles, invalidate: (tags) => { sent.push([...sdkTags.parse(tags)]); } });
  return { ...host, store, sent };
}

describe("deleting a thread's journal", () => {
  it("never asks bb to refresh an empty tag list when no entry is linked to a board quest", async () => {
    const f = fixture();
    await f.store.ready("probe");
    await f.store.runTool("probe", { action: "add", descriptions: ["Probe the page"] });
    f.sent.length = 0;
    expect(() => f.store.deleteThread("probe")).not.toThrow();
    expect(f.sent.length).toBeGreaterThan(0);
    expect(f.sent.every((tags) => tags.length > 0)).toBe(true);
    expect(f.store.get("probe").entries).toEqual([]);
  });

  it("still refreshes the board quest of a linked entry", async () => {
    const f = fixture();
    await f.store.ready("s");
    f.store.linkWaypoint("s", { boardQuestId: "b", waypointId: "w1" }, "deliver", "s", { kind: "tavern" });
    f.sent.length = 0;
    f.store.deleteThread("s");
    expect(f.sent.flat()).toContain(tags.boardQuest("b"));
  });
});
