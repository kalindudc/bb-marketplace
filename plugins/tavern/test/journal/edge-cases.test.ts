// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHost } from "./host";
import { createJournalStore, readJournalSkill } from "../../src/server/journal/store";
import { MIGRATIONS as JOURNAL_MIGRATIONS } from "../../src/server/migrations";
import { journalSchema } from "../../src/shared/schema";
import type { JournalDeps } from "../../src/server/ports";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map(f => f())); });
function fixture(roles: JournalDeps["roleOf"] = () => null) {
  const host = makeHost(); cleanup.push(host.dispose); host.bb.storage.migrate(host.db, JOURNAL_MIGRATIONS);
  const invalidate = vi.fn();
  const store = createJournalStore(host.bb, host.db, { roleOf: roles, invalidate });
  return { ...host, store, invalidate };
}
const proof = [{ kind: "command" as const, ref: "npm test", detail: "pass", exitCode: 0 }];
const legacy = { log: { version: 1, quests: [{ id: "a1", description: "legacy", done: false, createdAt: 10 }], steps: [], usedIds: ["a1"] } };

describe("journal persistence and race edges", () => {
  it("reads the router and all references in order from source and bundled layouts", () => {
    const expected = [
      "SKILL.md",
      "references/actions-and-evidence.md",
      "references/coordinating-agents.md",
      "references/rules-and-audit.md",
    ].map(path => readFileSync(new URL(`../../skills/journal/${path}`, import.meta.url), "utf8").trimEnd()).join("\n\n");
    expect(readJournalSkill().trimEnd()).toBe(expected);
    expect(readJournalSkill(new URL("../../dist/server.js", import.meta.url).href).trimEnd()).toBe(expected);
  });
  it.each(["skill", "rules"] as const)("returns the complete guide for %s", async action => {
    const f = fixture();
    const result = await f.store.runTool("t", { action });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(readJournalSkill());
    expect(result.text).toContain("## Evidence format and post-rejection rule");
    expect(result.text).toContain("## Coordinating other agents");
    expect(result.text).toContain("## Auditing journal habits");
  });
  it("copies fork entries, undo and reserved ids but not pending edits; side chats stay empty", async () => {
    const f = fixture(); await f.store.ready("source");
    await f.store.runTool("source", { action: "add", descriptions: ["source"] });
    f.store.edit("source", { op: "note", entryId: "00", note: "unseen" }, { kind: "user" });
    f.threads.set("fork", { originKind: "fork", originPluginId: null, sourceThreadId: "source" });
    f.threads.set("side", { originKind: "fork", originPluginId: "side-chat", sourceThreadId: "source" });
    await f.store.ready("fork"); await f.store.ready("side");
    expect(f.store.get("fork").entries[0]).toMatchObject({ threadId: "fork", description: "source", note: "unseen" });
    expect(f.store.pending("fork")).toEqual([]);
    expect(f.store.get("fork").canUndo).toBe(true);
    expect(f.store.get("side").entries).toEqual([]);
    await f.store.runTool("fork", { action: "clear", all: true });
    await f.store.runTool("fork", { action: "add", descriptions: ["new"] });
    expect(f.store.get("fork").entries[0]?.id).toBe("01");
    expect(f.store.get("source").entries[0]?.description).toBe("source");
  });
  it("hydrates after a synchronous first read and invalidates the view", async () => {
    const f = fixture();
    f.bb.sdk.threads.getPluginMetadata = async () => legacy;
    expect(f.store.get("t").entries).toEqual([]);
    await f.store.ready("t");
    expect(f.store.get("t").entries[0]?.id).toBe("a1");
    expect(f.invalidate).toHaveBeenCalledWith(expect.arrayContaining(["tavern:journal:t"]));
  });
  it("waits for import before allocating a waypoint and preserves imported entries on trusted undo", async () => {
    const f = fixture(); await f.store.ready("warm-ownership");
    let release!: () => void;
    const waiting = new Promise<void>(r => { release = r; });
    f.bb.sdk.threads.getPluginMetadata = async () => { await waiting; return legacy; };
    expect(() => f.store.linkWaypoint("cold", { boardQuestId: "b", waypointId: "w1" }, "waypoint", "cold", { kind: "tavern" })).toThrow(/prepare/);
    release(); await f.store.prepare("cold");
    const id = f.store.linkWaypoint("cold", { boardQuestId: "b", waypointId: "w1" }, "waypoint", "cold", { kind: "tavern" });
    expect(id).toBe("00");
    expect(f.store.get("cold").entries).toHaveLength(2);
    f.store.edit("cold", { op: "undo" }, { kind: "tavern" });
    expect(f.store.get("cold").entries.map(e => e.id)).toEqual(["a1"]);
  });
  it("rolls back ids, changes and history when the final batch fails", async () => {
    const f = fixture(); await f.store.ready("t");
    await f.store.runTool("t", { action: "add", descriptions: ["parent"] });
    await f.store.runTool("t", { action: "split", id: "00", descriptions: ["step"] });
    const before = f.store.get("t");
    expect((await f.store.runTool("t", { action: "toggle", id: "00" })).isError).toBe(true);
    expect(f.store.get("t")).toEqual(before);
    expect((await f.store.runTool("t", { action: "add", descriptions: Array(199).fill("too many") })).isError).toBe(true);
    await f.store.runTool("t", { action: "add", descriptions: ["next"] });
    expect(f.store.get("t").entries.at(-1)?.id).toBe("02");
  });
  it("delivers unseen edit descriptions and note text even on a failed action", async () => {
    const f = fixture(); await f.store.ready("t");
    f.store.edit("t", { op: "add", descriptions: ["retry"], parentId: null }, { kind: "user" });
    f.store.edit("t", { op: "note", entryId: "00", note: "use exponential backoff" }, { kind: "user" });
    const result = await f.store.runTool("t", { action: "done", id: "zz" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("use exponential backoff");
    expect(f.store.pending("t")).toEqual([]);
  });
  it("serializes tool results behind notes so edits are not delivered twice", async () => {
    const f = fixture(); await f.store.ready("t");
    f.store.edit("t", { op: "add", descriptions: ["edit"], parentId: null }, { kind: "user" });
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(r => { release = r; });
    const inSend = new Promise<void>(r => { started = r; });
    const note = f.store.deliverNote("t", null, async () => { started(); await waiting; });
    await inSend;
    const result = f.store.runTool("t", { action: "list" });
    release(); await note;
    expect((await result).text).not.toContain("Your journal changed");
  });
  it("validates persisted rows and snapshots instead of silently replacing corrupted data", async () => {
    const f = fixture(); await f.store.ready("t");
    await f.store.runTool("t", { action: "add", descriptions: ["entry"] });
    f.db.prepare("UPDATE questlog_entries SET data = ?").run('{"id":"00"}');
    expect(() => f.store.get("t")).not.toThrow();
    expect(f.store.get("t").problem).toBeTruthy();
    expect((await f.store.runTool("t", { action: "clear", all: true })).isError).toBe(true);
    expect(f.db.prepare("SELECT data FROM questlog_entries").get()).toEqual({ data: '{"id":"00"}' });
  });
  it("filters mine on child entries without losing them when the parent has another owner", async () => {
    const f = fixture(); await f.store.ready("t");
    f.store.edit("t", { op: "add", descriptions: ["parent"], parentId: null }, { kind: "user" });
    await f.store.runTool("t", { action: "split", id: "00", descriptions: ["my step"] });
    expect((await f.store.runTool("t", { action: "list", filter: "mine" })).text).toContain("my step");
  });
  it("restricts Warden verdicts to their assigned waypoint and never trusts actor metadata", async () => {
    const f = fixture(t => t === "w" ? { classId: "warden", role: "member", boardQuestId: "b", waypointId: "w2" } : null);
    await f.store.ready("s");
    const id = f.store.linkWaypoint("s", { boardQuestId: "b", waypointId: "w1" }, "ship", "s", { kind: "tavern" });
    await f.store.runTool("s", { action: "done", id, evidence: proof });
    expect((await f.store.runTool("w", { action: "verify", id, threadId: "s", evidence: proof })).isError).toBe(true);
    expect((await f.store.runTool("w", { action: "reject", id, threadId: "s", reason: "bad" })).isError).toBe(true);
    expect((await f.store.runTool("w", { action: "update", id, threadId: "s", description: "attack" })).isError).toBe(true);
    expect(() => f.store.edit("s", { op: "status", entryIds: [id], status: "verified" }, { kind: "user" })).toThrow(/Warden/);
  });
  it("keeps exact schema-valid progress including blocked count and completion attribution", async () => {
    const f = fixture(); await f.store.ready("t");
    await f.store.runTool("t", { action: "add", descriptions: ["a", "b"] });
    await f.store.runTool("t", { action: "done", id: "00", evidence: proof });
    await f.store.runTool("t", { action: "block", id: "01", reason: "owner" });
    const log = journalSchema.parse(f.store.get("t"));
    expect(log.progress).toMatchObject({ done: 1, total: 2, blocked: 1, current: { id: "01", status: "blocked" } });
    expect(log.entries[0]?.doneBy).toEqual({ kind: "agent", threadId: "t" });
  });
  it("notifies changes once, can unsubscribe, and isolates listener failures", async () => {
    const f = fixture(); await f.store.ready("t");
    const listener = vi.fn(), unsub = f.store.onChange(listener);
    f.store.onChange(() => { throw new Error("listener failure"); });
    await f.store.runTool("t", { action: "add", descriptions: ["one"] });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub(); await f.store.runTool("t", { action: "done", id: "00" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.warnings.some(w => w.includes("listener failure"))).toBe(true);
  });
  it("derives quiet doing work from server events and log changes, not browser state", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = fixture(); await f.store.ready("t");
    await f.store.runTool("t", { action: "add", descriptions: ["work"] });
    await f.store.runTool("t", { action: "start", id: "00" });
    vi.setSystemTime(1_700_000);
    expect(f.store.progress("t").quietSince).toBe(1_000_000);
    f.store.touchWork("t", 1_650_000);
    expect(f.store.progress("t").quietSince).toBeNull();
    vi.setSystemTime(2_300_000);
    expect(f.store.progress("t").quietSince).toBe(1_650_000);
    f.store.edit("t", { op: "note", entryId: "00", note: "new detail" }, { kind: "user" });
    expect(f.store.progress("t").quietSince).toBeNull();
  });
  it("never calls a thread quiet for delegated work it is only waiting on", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = fixture(); await f.store.ready("t");
    await f.store.runTool("t", { action: "add", descriptions: ["Class editor, Gaetano", "Title bar, Steve"], owner: "Gaetano" });
    await f.store.runTool("t", { action: "start", id: "00" }); await f.store.runTool("t", { action: "start", id: "01" });
    vi.setSystemTime(1_700_000);
    expect(f.store.progress("t").quietSince).toBeNull();
    await f.store.runTool("t", { action: "add", descriptions: ["Review the plan"] });
    await f.store.runTool("t", { action: "start", id: "02" });
    vi.setSystemTime(2_400_000);
    expect(f.store.progress("t").quietSince).toBe(1_700_000);
  });
  it("keeps a member's own linked waypoint in the quiet signal", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = fixture(); await f.store.ready("t");
    await f.store.runTool("t", { action: "add", descriptions: ["Waypoint"], owner: "t" });
    await f.store.runTool("t", { action: "start", id: "00" });
    vi.setSystemTime(1_700_000);
    expect(f.store.progress("t").quietSince).toBe(1_000_000);
  });
  it("keeps imported pending edits and stale-note timestamps without altering legacy metadata", async () => {
    const f = fixture();
    f.bb.sdk.threads.getPluginMetadata = async () => ({ ...legacy, agentChangedAt: 100, notedAt: 50, pendingUserChanges: ["You ticked legacy"] });
    await f.store.ready("t");
    expect(f.store.pending("t")[0]?.text).toBe("You ticked legacy");
    expect(f.db.prepare("SELECT agent_changed_at, noted_at FROM questlog_logs WHERE thread_id = ?").get("t")).toEqual({ agent_changed_at: 100, noted_at: 50 });
    const result = await f.store.runTool("t", { action: "rules" });
    expect(result.text).toContain("The user ticked legacy");
    expect(result.text).toContain("## When and how to keep it current");
    expect((await f.store.runTool("t", { action: "skill" })).text).toContain("references/actions-and-evidence.md");
    await f.store.flush("t");
    expect(f.mirrors).not.toEqual([]);
    expect(f.mirrors.every(w => Object.keys((w as { set: object }).set).join() === "progress")).toBe(true);
  });
  it("lets a Warden read and verify only assigned entries, without exposing the private next item", async () => {
    const f = fixture(t => t === "w" ? { classId: "warden", role: "member", boardQuestId: "b", waypointId: "w1" } : null);
    await f.store.ready("s");
    const id = f.store.linkWaypoint("s", { boardQuestId: "b", waypointId: "w1" }, "shared work", "s", { kind: "tavern" });
    f.store.linkWaypoint("s", { boardQuestId: "b", waypointId: "w2" }, "other waypoint", "s", { kind: "tavern" });
    await f.store.runTool("s", { action: "add", descriptions: ["private work"] });
    await f.store.runTool("s", { action: "done", id, evidence: proof });
    const list = await f.store.runTool("w", { action: "list", threadId: "s" });
    expect(list.isError).toBe(false); expect(list.text).toContain("shared work");
    expect(list.text).not.toContain("private work"); expect(list.text).not.toContain("other waypoint");
    const verdict = await f.store.runTool("w", { action: "verify", id, threadId: "s", evidence: proof });
    expect(verdict.isError).toBe(false); expect(verdict.text).toContain("verified");
    expect(verdict.text).not.toContain("private work"); expect(verdict.text).not.toContain("other waypoint");
  });
});
