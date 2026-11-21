// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { receiveSpend } from "../../adapters/pi/spend";

function assistant(id: string, total?: number) {
  return { id, type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", ...(total === undefined ? {} : { usage: { cost: { total } } }) } };
}

it("records persisted assistant entry IDs, captures explicit zero, and never includes message data", () => {
  const dir = mkdtempSync(join(tmpdir(), "tavern-spend-"));
  try {
    const scope = join(dir, "lead.json"), rows = [assistant("old", 0.023), assistant("unknown"), { id: "user", type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } }];
    const sessionManager = { getSessionId: () => "s1", getSessionFile: () => join(dir, "session.jsonl"), getEntries: () => rows, getEntry: (id: string) => rows.find(row => row.id === id) };
    const clone = { ...sessionManager, getSessionId: () => "s2", getHeader: () => ({ timestamp: "2026-01-02T00:00:00.000Z", parentSession: "parent.jsonl" }) };
    receiveSpend(scope).backfill(clone);
    const recorder = receiveSpend(scope);
    recorder.backfill(sessionManager);
    rows.push(assistant("new", 0));
    recorder.turn(sessionManager, "new");
    recorder.turn(sessionManager, "new");
    const records = readFileSync(`${scope}.spend`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records).toEqual([
      { source: "Guarded local session", session: "s1", entry: "old", at: 1767225600000, usdNanos: 23_000_000 },
      { source: "Guarded local session", session: "s1", entry: "unknown", at: 1767225600000, usdNanos: null },
      { source: "Guarded local session", session: "s1", entry: "new", at: 1767225600000, usdNanos: 0 },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
