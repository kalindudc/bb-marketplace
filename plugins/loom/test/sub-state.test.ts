import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { readSub, SUB_COLUMNS, subProblem, warnSubStateWith, writeSub, type SubColumn } from "../src/sub-state";

afterEach(() => warnSubStateWith((message) => console.warn(message)));

describe("sub-state columns", () => {
  it("reads a stored value as its schema's shape and null as none", () => {
    const stack = { deps: { "CSV-1": "abc" }, base: "abc", synced: 5, cross: {} };
    expect(readSub({ key: "CSV-2", stack_json: JSON.stringify(stack) }, "stack_json")).toEqual(stack);
    expect(readSub({ key: "CSV-2", stack_json: null }, "stack_json")).toBeNull();
    expect(readSub({ key: "CSV-2", pr_seen_json: '["check:1"]' }, "pr_seen_json")).toEqual(["check:1"]);
  });

  it("reads a malformed value as it is stored, as Loom always has, with one warning per row and column", () => {
    const warnings: string[] = [];
    warnSubStateWith((message) => warnings.push(message));
    const bad = { key: "CSV-9", merge_wait_json: '{"failures":"two"}' };
    expect(readSub(bad, "merge_wait_json")).toEqual({ failures: "two" });
    expect(readSub(bad, "merge_wait_json")).toEqual({ failures: "two" });
    expect(readSub({ thread_id: "thr_9", resume_json: '{"sha":1}' }, "resume_json")).toEqual({ sha: 1 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^The merge_wait_json of ticket CSV-9 does not match its schema; Loom reads it as it is/u);
    expect(warnings[1]).toContain("resume_json of thread thr_9");
  });

  it("throws on JSON that does not parse, as JSON.parse did", () => {
    expect(() => readSub({ key: "CSV-2", handback_json: "{not json" }, "handback_json")).toThrow(SyntaxError);
  });

  it("writes a value as JSON, null as a cleared column, and refuses a malformed value", () => {
    const wait = { failures: 1, since: 1, until: 2, message: "busy" };
    expect(writeSub("merge_wait_json", wait)).toEqual({ merge_wait_json: JSON.stringify(wait) });
    expect(writeSub("merge_wait_json", null)).toEqual({ merge_wait_json: null });
    expect(() => writeSub("merge_wait_json", { ...wait, until: "later" } as never)).toThrow(/malformed merge_wait_json/u);
  });

  it("keeps keys it does not know, as the raw JSON it replaced did, so a value from a newer Loom survives a read and a write back", () => {
    const stored = { failures: 1, since: 1, until: 2, message: "busy", attempt: "from a newer Loom" };
    const read = readSub({ key: "CSV-1", merge_wait_json: JSON.stringify(stored) }, "merge_wait_json");
    expect(read).toEqual(stored);
    expect(writeSub("merge_wait_json", { ...read!, failures: 2 })).toEqual({ merge_wait_json: JSON.stringify({ ...stored, failures: 2 }) });
  });

  it("keeps the stored text of what it writes, so a stored value compares equal to the one it was written from", () => {
    const back = { thread: "thr_1", text: { summary: "Fix", detail: "Fix the tests." }, waiting: 3 };
    const patch = writeSub("handback_json", back);
    expect(patch.handback_json).toBe(JSON.stringify(back));
    expect(readSub({ key: "CSV-1", ...patch }, "handback_json")).toEqual(back);
  });
});

// A copy of a live database, when one is given: every stored sub-state value must match its schema, keys and all.
const snapshot = process.env.LOOM_SNAPSHOT_DB;
describe.skipIf(snapshot === undefined || !existsSync(snapshot))("a live database's sub-state", () => {
  it("matches every schema without dropping a key", () => {
    const db = new Database(snapshot!, { readonly: true });
    const tickets = db.prepare("SELECT * FROM tickets").all() as Array<Record<string, string | null> & { key: string }>;
    const threads = db.prepare("SELECT id, thread_id, resume_json FROM threads WHERE resume_json IS NOT NULL").all() as Array<{ id: number; thread_id: string | null; resume_json: string }>;
    db.close();
    let values = 0;
    const check = (row: Record<string, unknown>, column: SubColumn) => {
      const json = row[column] as string | null;
      if (json === null) return;
      values += 1;
      expect(subProblem(column, JSON.parse(json)), `${column} of ${String(row.key ?? row.thread_id)}`).toBeNull();
      expect(readSub(row as never, column)).toEqual(JSON.parse(json));
    };
    for (const ticket of tickets) for (const column of SUB_COLUMNS.filter((name) => name !== "resume_json")) check(ticket, column);
    for (const thread of threads) check(thread, "resume_json");
    expect(values).toBeGreaterThan(0);
  });
});
