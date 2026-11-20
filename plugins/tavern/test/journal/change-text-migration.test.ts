// @vitest-environment node
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { applyAction } from "../../src/server/journal/engine";
import { MIGRATIONS } from "../../src/server/migrations";
import { JOURNAL_ACTION_PHRASES } from "../../src/server/journal/action-phrases";

it("stores an action phrase for both an agent and the user", () => {
  const add = (actor: { kind: "agent"; threadId: string } | { kind: "user" }) =>
    applyAction([], { action: "add", descriptions: ["Check the output"] }, { actor, threadId: "thr_x", now: 100, allocate: () => "ab", roleOf: () => null });
  expect([add({ kind: "agent", threadId: "thr_x" }).text, add({ kind: "user" }).text]).toEqual(Array(2).fill('added [ab] "Check the output" todo.'));
});

it("rewrites only the old generated agent and user prefixes", () => {
  const db = new Database(":memory:");
  try {
    db.exec(MIGRATIONS[0]!);
    db.exec("INSERT INTO questlog_logs (thread_id) VALUES ('thread')");
    const rows = [
      [{ kind: "agent", threadId: "thr_x" }, "note", 'Agent thr_x noted [ab] "Check the output".', 'noted [ab] "Check the output".'],
      [{ kind: "user" }, "add", 'You added [ab] "Check the output" todo.', 'added [ab] "Check the output" todo.'],
      [{ kind: "agent", threadId: "thr_x" }, "note", 'noted [ab] "You added something".', null],
      [{ kind: "tavern" }, "rebrief", "Tavern reopened [ab]: brief v2 arrived.", null],
      [{ kind: "agent", threadId: "thr_x" }, "link", 'Tavern assigned [ab] "Follow up" to waypoint w1.', 'assigned [ab] "Follow up" to waypoint w1.'],
      [{ kind: "tavern" }, "board-phase", "Board quest phases refreshed: [ab].", "refreshed board quest phases: [ab]."],
      [{ kind: "import", from: "pi-quests" }, "link", "Tavern assigned an old task.", null],
      [{ kind: "tavern" }, "note", 'noted [ab] "Board quest phases refreshed: [ab]."', null],
      [{ kind: "import", from: "pi-quests" }, "note", "You added this to the old journal.", null],
      [{ kind: "import", from: "pi-quests" }, "note", "Agent thr_x noted a legacy message.", null],
      [{ kind: "agent", threadId: "thr_x" }, "note", "Agent thr_xyz noted something.", null],
      [{ kind: "user" }, "add", "YouTube is not a prefix.", null],
    ] as const;
    const insert = db.prepare("INSERT INTO questlog_changes (thread_id, at, actor, action, entry_ids, text, seen) VALUES ('thread', 1, ?, ?, '[\"ab\"]', ?, 0)");
    for (const [actor, action, text] of rows) insert.run(JSON.stringify(actor), action, text);
    const read = () => db.prepare("SELECT * FROM questlog_changes ORDER BY id").all() as { id: number; text: string }[];
    const before = read();
    for (const sql of MIGRATIONS.slice(1)) db.exec(sql);
    expect(read()).toEqual(before.map((row, i) => ({ ...row, text: rows[i]![3] ?? row.text })));
    db.exec(JOURNAL_ACTION_PHRASES);
    expect(read()).toEqual(before.map((row, i) => ({ ...row, text: rows[i]![3] ?? row.text })));
  } finally { db.close(); }
});
