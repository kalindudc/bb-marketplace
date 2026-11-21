// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { makeHost } from "./host";
import { createJournalStore, reminderDue, REMIND_EVERY_MS, REPORT_GRACE_MS } from "../../src/server/journal/store";
import { dispatchCheck, isInboundRequest, isUserRequest, watchRequests } from "../../src/server/journal/requests";
import { MIGRATIONS as JOURNAL_MIGRATIONS } from "../../src/server/migrations";
import { registerJournal } from "../../src/server/journal";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map(f => f())); });
function fixture(deps: Partial<Parameters<typeof createJournalStore>[2]> = {}) {
  const host = makeHost(); cleanup.push(host.dispose);
  host.bb.storage.migrate(host.db, JOURNAL_MIGRATIONS);
  const store = createJournalStore(host.bb, host.db, { roleOf: () => null, invalidate: () => {}, ...deps });
  watchRequests(host.bb, store);
  const thread = { id: "t", providerId: "pi" };
  return { ...host, store, thread };
}
const user = (seq: number, at: number) => ({ seq, createdAt: at, type: "client/turn/requested", data: { initiator: "user", input: [{ type: "text", text: "continue" }] } });
const item = (seq: number, type: string, tool = "bash") => ({ seq, createdAt: 1000, type, data: { item: { id: "work", type: "toolCall", tool } } });
const work = (after: number, count = 15) => Array.from({ length: count }, (_, n) => {
  const seq = after + n * 2 + 1;
  return ["item/started", "item/completed"].map((type, i) => ({ seq: seq + i, createdAt: 1000, type, data: { item: { id: `work-${seq}`, type: "toolCall", tool: "bash" } } }));
}).flat();
const inProgress = (seq: number) => item(seq, "item/started");
const codemodeJournal = (seq: number) => {
  const row = item(seq, "item/started", "codemode");
  return { ...row, data: { item: { ...row.data.item, arguments: { code: 'await tools.journal({ action: "list" })' } } } };
};
async function staleFixture() {
  const f = fixture(); await f.store.ready("t");
  await f.store.runTool("t", { action: "add", descriptions: ["build"] });
  f.db.prepare("UPDATE questlog_logs SET agent_changed_at = 100, noted_at = NULL").run();
  // The agent's last state change (the add) happened at 100, before both requests below.
  f.db.prepare("UPDATE questlog_changes SET at = 100").run();
  return f;
}

describe("empty journal hint", () => {
  it.each(["pi", "claude-code", "codex"])("joins an existing %s turn after 15 completed pieces of work, without starting a turn", async providerId => {
    const f = fixture(), thread = { ...f.thread, providerId };
    f.setEvents([user(1, 100), ...work(1, 14), inProgress(30)]);
    await f.emit("thread.active", { thread });
    expect(f.sent).toEqual([]);
    f.setEvents([user(1, 100), ...work(1), item(32, "item/completed")]);
    await f.emit("experimental_thread.events", { thread });
    expect(f.sent).toEqual([]);
    f.setEvents([user(1, 100), ...work(1), item(32, "item/completed"), { ...inProgress(33), data: { item: { id: "next", type: "toolCall", tool: "bash" } } }]);
    await f.emit("experimental_thread.events", { thread });
    expect(f.sent).toEqual([expect.objectContaining({ threadId: "t", mode: "steer", input: [expect.objectContaining({ visibility: "agent-only", text: expect.stringMatching(/^\[Journal\].*empty/) })] })]);
  });
  it("sends once across ordinary turns and rearms after a human steer, never twice in the same turn", async () => {
    const f = fixture(), thread = f.thread;
    const first = [user(1, 100), ...work(1), inProgress(32)];
    f.setEvents(first);
    await f.emit("thread.active", { thread });
    expect(f.sent).toHaveLength(1);
    const second = [...first, user(40, 200), ...work(40), inProgress(71)];
    await f.emit("thread.idle", { thread });
    f.setEvents(second);
    await f.emit("thread.active", { thread });
    expect(f.sent).toHaveLength(1);
    const steer = { ...user(72, 300), data: { ...user(72, 300).data, requestId: "req-steer", target: { kind: "steer", expectedTurnId: "turn-2" } } };
    const accepted = { seq: 73, createdAt: 301, type: "turn/input/accepted", data: { clientRequestId: "req-steer" } };
    f.setEvents([...second, steer, accepted]);
    await f.emit("experimental_thread.events", { thread });
    await f.emit("thread.idle", { thread });
    const third = [...second, steer, accepted, user(80, 400), ...work(80), inProgress(111)];
    f.setEvents(third);
    await f.emit("thread.active", { thread });
    await f.emit("experimental_thread.events", { thread });
    expect(f.sent).toHaveLength(2);
    await f.emit("thread.idle", { thread });
    f.setEvents([...third, user(120, 500), ...work(120), inProgress(151)]);
    await f.emit("thread.active", { thread });
    expect(f.sent).toHaveLength(2);
  });
  it.each(["journal", "mcp__tavern__journal", "codemode", "quest"])("handles %s before the threshold", async tool => {
    const f = fixture();
    f.setEvents([user(1, 100), tool === "codemode" ? codemodeJournal(2) : item(2, "item/started", tool), item(3, "item/completed", tool), ...work(3), inProgress(34)]);
    await f.emit("thread.active", { thread: f.thread });
    expect(f.sent).toHaveLength(tool === "quest" ? 1 : 0);
  });
  it.each(["acp", "disabled", "keeper", "idle", "closed", "no-work-id"])("does not send in the %s case", async mode => {
    const f = fixture({
      ...(mode === "disabled" ? { settings: () => ({ journalReminders: false, journalQuietMinutes: 10 }) } : {}),
      ...(mode === "keeper" ? { roleOf: () => ({ classId: "keeper", role: "keeper", boardQuestId: null, waypointId: null }) } : {}),
    });
    if (mode === "idle") f.threads.set("t", { id: "t", status: "idle" });
    if (mode === "closed") {
      await f.store.ready("t");
      await f.store.runTool("t", { action: "add", descriptions: ["Already kept a journal"] });
      await f.store.runTool("t", { action: "done", id: "00" });
    }
    const rows = mode === "no-work-id" ? work(1).map(row => ({ ...row, data: { item: { ...row.data.item, id: undefined } } })) : work(1);
    f.setEvents([user(1, 100), ...rows, inProgress(32)]);
    await f.emit("thread.active", { thread: { ...f.thread, providerId: mode === "acp" ? mode : "pi" } });
    expect(f.sent).toEqual([]);
  });
});

describe("no-wake journal notes", () => {
  it("rejects only agent-only [Journal] notes that would start turns and never throws", () => {
    const ctx = (attempt: string, visibility: string, text = "[Journal] plan") => ({ attempt, originPluginId: "tavern", queuedMessages: [], input: { blocks: [{ type: "text", visibility, text }] } }) as unknown as MessageDispatchHookContext;
    expect(dispatchCheck(ctx("start-turn", "agent-only"))).toContain("running turn");
    expect(dispatchCheck(ctx("join-turn", "agent-only"))).toBeNull();
    expect(dispatchCheck(ctx("start-turn", "user"))).toBeNull();
    expect(dispatchCheck(ctx("start-turn", "agent-only", "[Tavern tick] facts"))).toBeNull();
    expect(dispatchCheck(null as unknown as MessageDispatchHookContext)).toBeNull();
  });
  it("recognizes human requests, not agent-only notes or plugin reports", () => {
    expect(isUserRequest(user(1, 1))).toBe(true);
    expect(isUserRequest({ ...user(1, 1), data: { initiator: "user", input: [{ type: "text", text: "note", visibility: "agent-only" }] } })).toBe(false);
    expect(isUserRequest({ ...user(1, 1), data: { initiator: "agent", input: [] } })).toBe(false);
  });
  it("is due once per stale stretch, at most every 15 minutes, and again when a delegate's report waits unchecked", async () => {
    const f = await staleFixture(), entries = f.store.get("t").entries;
    const at = (over: Partial<Parameters<typeof reminderDue>[0]>) => reminderDue({ stateChangedAt: 100, notedAt: null, reportAt: null, now: 10_000_000, ...over }, entries, 200);
    expect(at({})).toBe(true);
    expect(at({ stateChangedAt: null })).toBe(false);
    expect(reminderDue({ stateChangedAt: 100, notedAt: null, reportAt: null, now: 10_000_000 }, entries, null)).toBe(false);
    expect(at({ stateChangedAt: 300 })).toBe(false);
    // Once per stretch: noted after the last state change.
    expect(at({ notedAt: 150 })).toBe(false);
    // A report the agent hasn't checked re-arms it, after a grace period and never within 15 minutes of the last note.
    const now = 10_000_000;
    expect(at({ stateChangedAt: 300, notedAt: 150, reportAt: now - REPORT_GRACE_MS })).toBe(true);
    expect(at({ stateChangedAt: 300, notedAt: 150, reportAt: now - REPORT_GRACE_MS + 1 })).toBe(false);
    expect(at({ notedAt: now - REMIND_EVERY_MS + 1, reportAt: now - REPORT_GRACE_MS })).toBe(false);
    expect(reminderDue({ stateChangedAt: 100, notedAt: null, reportAt: null, now }, entries.map((e) => ({ ...e, status: "done" as const })), 200)).toBe(false);
    const send = vi.fn(async () => {});
    expect(await f.store.deliverNote("t", 200, send)).toBe(true);
    expect(await f.store.deliverNote("t", 300, send)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("uses the chosen repeat and unchecked-report intervals", async () => {
    const f = await staleFixture(), entries = f.store.get("t").entries, now = 10_000_000;
    const state = {stateChangedAt:null,notedAt:now-6*60_000,reportAt:now-3*60_000,now};
    expect(reminderDue(state, entries, null)).toBe(false);
    expect(reminderDue(state, entries, null, 5*60_000, 3*60_000)).toBe(true);
    expect(reminderDue(state, entries, null, 7*60_000, 3*60_000)).toBe(false);
    expect(reminderDue(state, entries, null, 5*60_000, 4*60_000)).toBe(false);
  });
  it("treats any visible inbound message as a request, but not retries or agent-only plugin context", () => {
    const req = (data: Record<string, unknown>) => ({ seq: 1, createdAt: 1, type: "client/turn/requested", data: { input: [{ type: "text", text: "x" }], ...data } });
    expect(isInboundRequest(req({ initiator: "user" }))).toBe(true);
    expect(isInboundRequest(req({ initiator: "agent", senderThreadId: "thr_builder" }))).toBe(true);
    expect(isInboundRequest(req({ initiator: "system" }))).toBe(true);
    expect(isInboundRequest(req({ initiator: "user", originPluginId: "wakeup" }))).toBe(true);
    expect(isInboundRequest(req({ initiator: "user", retryOfRequestId: "r1" }))).toBe(false);
    expect(isInboundRequest(req({ initiator: "user", originPluginId: "cortex", input: [{ type: "text", text: "memory", visibility: "agent-only" }] }))).toBe(false);
    expect(isInboundRequest(req({ initiator: "user", input: [{ type: "localImage", path: "a.png" }] }))).toBe(false);
  });
  it("reminds after an agent's message too, and names the stale entries", async () => {
    const f = await staleFixture();
    await f.store.runTool("t", { action: "update", id: "00", description: "build, live since 17:05" });
    for (const d of ["build, waiting for the gate", "build, settled"]) await f.store.runTool("t", { action: "update", id: "00", description: d });
    f.db.prepare("UPDATE questlog_changes SET at = 100").run();
    const agent = { seq: 2, createdAt: 300, type: "client/turn/requested", data: { initiator: "agent", senderThreadId: "thr_builder", input: [{ type: "text", text: "SOURCE SETTLED" }] } };
    f.setEvents([user(1, 200), agent, item(3, "item/started")]);
    await f.emit("thread.active", { thread: f.thread });
    expect(f.sent).toHaveLength(1);
    const text = (f.sent[0] as { input: { text: string }[] }).input[0]!.text;
    expect(text).toMatch(/\[00\] reworded 3 times without a status change/);
    expect(text).toMatch(/\[00\] reads as finished \("settled"\) and is still open/);
    expect(text).toMatch(/You have not updated the journal's statuses since the previous message/);
  });
  it("sends a steer only while a non-journal tool is still running", async () => {
    const f = await staleFixture();
    f.setEvents([user(1, 200), user(2, 300), item(3, "item/started")]);
    await f.emit("thread.active", { thread: f.thread });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ threadId: "t", mode: "steer", input: [{ type: "text", visibility: "agent-only", text: expect.stringContaining("[Journal]") }] });
    expect(f.sent[0]).toMatchObject({ input: [{ text: expect.stringContaining("previous message") }] });
  });
  it.each(["completed", "quest-first", "codemode-first", "idle", "acp"])("does not send after %s", async mode => {
    const f = await staleFixture();
    if (mode === "idle") f.threads.set("t", { id: "t", status: "idle" });
    f.setEvents([user(1, 200), user(2, 300), mode === "codemode-first" ? codemodeJournal(3) : item(3, "item/started", mode === "quest-first" ? "tavern.quest" : "bash"), ...(mode === "completed" ? [item(4, "item/completed")] : [])]);
    await f.emit("thread.active", { thread: { ...f.thread, providerId: mode === "acp" ? "acp" : "pi" } });
    expect(f.sent).toEqual([]);
  });
  it.each([
    ["acp", "provider acp can't be steered into a running turn"],
    ["quest-first", "the agent called the journal first in this turn"],
    ["completed", "the turn ended before a tool call was running to join"],
    ["idle", "the turn ended before the note could join it"],
    ["agent-request", "this turn was started by a retry or by agent-only plugin context, not a message"],
  ])("logs why the reminder was skipped: %s", async (mode, reason) => {
    const f = await staleFixture();
    if (mode === "idle") f.threads.set("t", { id: "t", status: "idle" });
    const latest = mode === "agent-request" ? { ...user(2, 300), data: { initiator: "user", retryOfRequestId: "r1", input: [{ type: "text", text: "continue" }] } } : user(2, 300);
    f.setEvents([user(1, 200), latest, item(3, "item/started", mode === "quest-first" ? "tavern.journal" : "bash"), ...(mode === "completed" ? [item(4, "item/completed")] : [])]);
    await f.emit("thread.active", { thread: { ...f.thread, providerId: mode === "acp" ? "acp" : "pi" } });
    if (mode === "completed") await f.emit("thread.idle", { thread: f.thread });
    expect(f.sent).toEqual([]);
    expect(f.infos).toEqual([`Journal reminder skipped for t: ${reason}.`]);
    expect(f.warnings).toEqual([]);
  });
  it("logs a reminder skipped because the journal is current, and nothing for a thread with no open entries", async () => {
    const f = await staleFixture();
    f.db.prepare("UPDATE questlog_changes SET at = 250").run();
    f.setEvents([user(1, 200), user(2, 300), item(3, "item/started")]);
    await f.emit("thread.active", { thread: f.thread });
    expect(f.infos).toEqual(["Journal reminder skipped for t: no reminder is due (statuses changed since the previous message, or one went out in the last 15 minutes), and no user edits are waiting."]);
    const plain = fixture(); await plain.store.ready("t");
    plain.setEvents([user(1, 200), user(2, 300), item(3, "item/started")]);
    await plain.emit("thread.active", { thread: { ...plain.thread, providerId: "acp" } });
    await plain.emit("thread.active", { thread: plain.thread });
    expect(plain.infos).toEqual([]);
  });
  it("does not install a watch from an async read that crossed a turn boundary", async () => {
    const f = await staleFixture();
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    const list = f.bb.sdk.threads.events.list;
    f.bb.sdk.threads.events.list = async args => { await wait; return list(args); };
    f.setEvents([user(1, 200), user(2, 300), item(3, "item/started")]);
    const active = f.emit("thread.active", { thread: f.thread });
    await f.emit("thread.idle", { thread: f.thread });
    release(); await active;
    await f.emit("experimental_thread.events", { thread: f.thread });
    expect(f.sent).toEqual([]);
  });
  it("retains unseen edits when send fails, and does not clear edits added while sending", async () => {
    const f = await staleFixture();
    f.store.edit("t", { op: "note", entryId: "00", note: "first" }, { kind: "user" });
    await expect(f.store.deliverNote("t", null, async () => { throw new Error("dispatch rejected"); })).rejects.toThrow("dispatch rejected");
    expect(f.store.pending("t")).toHaveLength(1);
    await f.store.deliverNote("t", null, async () => { f.store.edit("t", { op: "note", entryId: "00", note: "second" }, { kind: "user" }); });
    expect(f.store.pending("t")).toHaveLength(1);
    expect(f.store.pending("t")[0]?.text).toContain("note");
  });
  it("registers journal with bounded results and returns a port matching the shared interface", async () => {
    const host = makeHost(); cleanup.push(host.dispose); host.bb.storage.migrate(host.db, JOURNAL_MIGRATIONS);
    const port = registerJournal(host.bb, host.db, { roleOf: () => null, invalidate: () => {} });
    const tool = host.tools.get("journal");
    expect(tool.presentation.label.completed).toBe("Updated the journal");
    const result = await tool.execute({ action: "add", descriptions: ["ship"] }, { threadId: "t" });
    expect(result).toContain("1");
    expect(port.progress("t").total).toBe(1);
    expect(port.instructions("t")).toContain("ship");
    expect(port.dispatchCheck({ attempt: "start-turn", input: { blocks: [] } } as unknown as MessageDispatchHookContext)).toBeNull();
  });
});
