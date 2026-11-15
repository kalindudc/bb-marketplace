// @vitest-environment node
import { describe, expect, it } from "vitest";
import { currency, trackerGroups } from "../../src/shared/journal-tracker";
import { trackerMarkdown } from "../../src/server/journal/export";
import type { JournalEntry } from "../../src/shared/schema";

const NOW = 10_000_000_000;
const min = 60_000;
const agent = { kind: "agent" as const, threadId: "k" };
let order = 0;
function entry(id: string, over: Partial<JournalEntry> = {}): JournalEntry {
  return { threadId: "k", id, parentId: null, description: `Entry ${id}`, status: "todo", owner: null, after: [], links: [], doneAt: null, doneBy: null, note: null, evidence: [], review: null, link: null, boardQuestId: null, report: null, order: order++, createdAt: NOW - 120 * min, createdBy: agent, updatedAt: NOW - 120 * min, updatedBy: agent, ...over } as JournalEntry;
}
const report = (kind: "idle" | "settled" | "archived" | "deleted", ago: number, summary: string | null = null) => ({ kind, at: NOW - ago * min, threadId: "thr_g", summary, by: { kind: "tavern" as const } });

function journal() {
  order = 0;
  return [
    entry("01", { description: "Round 3", status: "doing" }),
    entry("02", { parentId: "01", description: "Owner hook", owner: "thr_g", status: "doing", report: report("idle", 12, "SOURCE SETTLED for the hook"), evidence: [{ kind: "file", ref: "src/a.ts", detail: "" }, { kind: "command", ref: "vitest run", detail: "", exitCode: 0 }] as never }),
    entry("03", { parentId: "01", description: "Title bar", owner: "thr_s", status: "doing" }),
    entry("04", { parentId: "01", description: "Away fix", owner: "thr_t", status: "blocked", note: "waiting on the combined check" }),
    entry("05", { description: "Write the plan", status: "doing" }),
    entry("06", { description: "Self-owned waypoint", owner: "k", status: "doing" }),
    entry("07", { description: "Done by Steve", owner: "thr_s", status: "done", doneAt: NOW - 30 * min, report: report("settled", 40) }),
    entry("08", { description: "Old close", status: "done", doneAt: NOW - 90 * min, createdAt: NOW - 300 * min }),
    entry("09", { description: "Fresh report", owner: "thr_m", status: "todo", report: report("settled", 2) }),
  ];
}

describe("the tracker groups", () => {
  it("holds only open entries owned by another thread, in journal order, Reported first", () => {
    const groups = trackerGroups(journal());
    expect(groups.map(g => [g.id, g.entries.map(e => e.id)])).toEqual([["reported", ["02", "09"]], ["working", ["03"]], ["blocked", ["04"]]]);
  });
  it("leaves out empty groups, and has none for a thread that delegates nothing", () => {
    order = 0;
    expect(trackerGroups([entry("01", { owner: "thr_s", status: "doing" })]).map(g => g.id)).toEqual(["working"]);
    expect(trackerGroups([entry("01"), entry("02", { owner: "k" })])).toEqual([]);
  });
});

describe("the currency", () => {
  it("names the last close, the oldest open entry and the reports waiting", () => {
    expect(currency(journal(), NOW)).toEqual({ lastDoneAt: NOW - 30 * min, oldestOpenAt: NOW - 120 * min, reported: 2, delegated: 4, stale: true });
  });
  it("is stale only once a report has waited past the reminder's grace period", () => {
    const fresh = journal().map(e => e.id === "02" ? { ...e, report: report("idle", 9) } : e);
    expect(currency(fresh, NOW).stale).toBe(false);
    expect(currency(fresh, NOW + 2 * min).stale).toBe(true);
  });
  it("is never stale, and counts nothing to check, for a journal with no delegates", () => {
    order = 0;
    expect(currency([entry("01"), entry("02", { status: "done", doneAt: NOW - 600 * min })] as JournalEntry[], NOW)).toEqual({ lastDoneAt: NOW - 600 * min, oldestOpenAt: NOW - 120 * min, reported: 0, delegated: 0, stale: false });
    expect(currency([], NOW)).toEqual({ lastDoneAt: null, oldestOpenAt: null, reported: 0, delegated: 0, stale: false });
  });
});

describe("the markdown export", () => {
  it("writes the tracker groups, then the agent's own open entries, with owners, reports, reasons and evidence", () => {
    const names: Record<string, string> = { thr_g: "Gaetano", thr_s: "Steve", thr_t: "Tim", thr_m: "Momo" };
    const text = trackerMarkdown(journal(), { title: "Coordinator", name: (id) => names[id] ?? id, now: NOW });
    expect(text).toBe([
      "# Journal: Coordinator",
      "",
      "2 of 9 done · last done 30 min ago · 2 reports in",
      "",
      "## Reported (2)",
      "",
      "- [02] Owner hook (Gaetano, step of [01] Round 3): went idle 12 min ago: \"SOURCE SETTLED for the hook\". Evidence: src/a.ts, vitest run",
      "- [09] Fresh report (Momo): reported settled 2 min ago",
      "",
      "## Working (1)",
      "",
      "- [03] Title bar (Steve, step of [01] Round 3)",
      "",
      "## Blocked (1)",
      "",
      "- [04] Away fix (Tim, step of [01] Round 3): blocked: waiting on the combined check",
      "",
      "## Your own open entries (3)",
      "",
      "- [01] Round 3 (doing)",
      "- [05] Write the plan (doing)",
      "- [06] Self-owned waypoint (doing)",
      "",
    ].join("\n"));
  });
});

describe("the store's export", () => {
  it("reads a journal without creating one, and names delegates", async () => {
    const { MIGRATIONS } = await import("../../src/server/migrations");
    const { createJournalStore } = await import("../../src/server/journal/store");
    const { makeHost } = await import("./host");
    const h = makeHost(); h.bb.storage.migrate(h.db, MIGRATIONS);
    try {
      const store = createJournalStore(h.bb, h.db, { roleOf: () => null, invalidate: () => {}, nameOf: (id) => ({ thr_g: "Gaetano", k: "Coordinator" } as Record<string, string>)[id] ?? null });
      expect(await store.exportMarkdown("k")).toBe("# Journal: Coordinator\n\n0 of 0 done\n");
      expect(h.db.prepare("SELECT count(*) AS n FROM questlog_logs").get()).toEqual({ n: 0 });
      await store.prepare("k");
      await store.runTool("k", { action: "add", descriptions: ["Owner hook"], owner: "thr_g" } as never);
      expect(await store.exportMarkdown("k")).toContain("## Working (1)\n\n- [00] Owner hook (Gaetano)\n");
    } finally { await h.dispose(); }
  });
});
