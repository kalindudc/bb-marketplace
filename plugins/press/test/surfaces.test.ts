import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings";
import { mergeThreadOverride, resolvePressPolicy } from "../src/policy";
import { emptyLedger, lookupSummaryPath, type LedgerHistoryRow } from "../src/ledger";
import { pickBoundary, scanTimeline } from "../src/snapshot";
import { placeInFooter } from "../src/ui/footer";
import { chatText, chipText, numberText } from "../src/ui/model";

const at = "2026-11-22T00:00:00.000Z";
const summaryPath = ".bb/press/summaries/press-abc.md";

const historyRow: LedgerHistoryRow = {
  id: "press-abc", at, summaryPath, point: "manual", tokensBefore: 209_544, tokensAfter: 3_227,
  ms: 78_600, model: null, summaryHash: "", keptTurns: null,
};

const message = (createdAt: number, role: string) => ({ id: `message-${createdAt}`, kind: "conversation", role, createdAt });

describe("thread controls", () => {
  it("merges mode and one point without replacing raw arrays or other overrides", () => {
    const original = { custom: { retained: 1 }, points: [{ id: "idle", when: "idleSeconds", value: 12 }], pointOverrides: { phase: false } };
    const mode = mergeThreadOverride(JSON.stringify(original), { mode: "auto" });
    const point = mergeThreadOverride(JSON.stringify(mode), { pointOverrides: { idle: false } });
    expect(point).toEqual({ ...original, mode: "auto", pointOverrides: { phase: false, idle: false } });
    expect(resolvePressPolicy([], DEFAULT_SETTINGS, { source: "test", value: point }).points)
      .toEqual([{ ...original.points[0], enabled: false }]);
  });

  it("keeps untouched defaults live and can explicitly enable an absent point", () => {
    const lookup = (value: unknown) => resolvePressPolicy([], { ...DEFAULT_SETTINGS, turnsBetween: 11 }, { source: "test", value });
    const value = mergeThreadOverride(null, { pointOverrides: { volume: false } });
    expect(lookup(value).points.find((p) => p.id === "turns")?.value).toBe(11);
    const missing = mergeThreadOverride('{"points":[]}', { pointOverrides: { turns: true } });
    expect(lookup(missing).points).toEqual([{ id: "turns", when: "turnsSinceCompaction", enabled: true, value: 11 }]);
    expect(() => mergeThreadOverride("[]", { mode: "auto" })).toThrow("JSON object");
  });
});

describe("chat boundary", () => {
  it("selects the earliest user or assistant creation timestamp after completion, including nested turns", () => {
    const rows = [message(40, "assistant"), message(21, "system"), message(20, "user"),
      { ...message(22, "user"), initiator: "system" },
      { kind: "turn", children: [message(17, "user"), message(23, "user")] }];
    expect(pickBoundary(rows, 20)).toEqual({ createdAt: 23, id: "message-23" });
    expect(pickBoundary(rows, 40)).toBeNull();
  });

  it("uses the SDK operation completion time, ignoring pending and failed operations", () => {
    const operation = (completedAt: number, status: string) => ({ kind: "system", systemKind: "operation", operationKind: "compaction", createdAt: 5, completedAt, status });
    expect(scanTimeline([{ kind: "turn", children: [operation(20, "completed"), operation(30, "error"), operation(40, "pending")] }]).lastCompactionEventAt).toBe(20);
    expect(pickBoundary([operation(20, "completed"), message(16, "user"), { ...message(21, "assistant"), startedAt: 19 }], 15))
      .toEqual({ createdAt: 21, id: "message-21" });
  });
});

describe("summary lookup", () => {
  it("selects the exact, thread-owned summary and rejects unreadable or untrusted paths", () => {
    const ledger = { ...emptyLedger("thr_a", at), history: [historyRow] };
    expect(lookupSummaryPath(ledger, "thr_a", at)).toBe(summaryPath);
    expect(lookupSummaryPath(ledger, "thr_b", at)).toBeNull();
    expect(lookupSummaryPath(ledger, "thr_a", "unknown")).toBeNull();
    expect(lookupSummaryPath(null, "thr_a", at)).toBeNull();
    for (const path of [null, "/tmp/press.md", ".bb/press/summaries/../secret.md", ".bb\\press\\summaries\\..\\secret.md"]) {
      expect(lookupSummaryPath({ ...ledger, history: [{ ...historyRow, summaryPath: path }] }, "thr_a", at)).toBeNull();
    }
  });
});

describe("surface copy", () => {
  it("prints the percent first and reports historical duration as rounded seconds", () => {
    expect(chipText({ percent: 77.1, nextPoint: "window", mode: "auto" })).toBe("77% · window");
    // No point pending: the mode, because the bare percent repeats bb's own circle beside the chip.
    expect(chipText({ percent: 11.2, nextPoint: null, mode: "auto" })).toBe("11% · auto");
    expect(chipText({ percent: 11.2, nextPoint: null, mode: "advisor" })).toBe("11% · advisor");
    expect(chatText({ ...historyRow, outcome: "ok", boundaryAt: 100, boundaryMessageId: null, summaryPath })).toBe("Pressed · 209k to 3k · 79s · manual");
    expect(chatText({ ...historyRow, point: "native", tokensBefore: null, tokensAfter: null, ms: 17_540,
      outcome: "ok", boundaryAt: 100, boundaryMessageId: null, summaryPath: null })).toBe("Pressed · 18s · native");
    expect(numberText(null)).toBe("—");
  });
});

describe("footer placement", () => {
  it("inserts before the circle, stays still when connected, and follows Burn if it mounts later", () => {
    const circle: { previousElementSibling: { hasAttribute(name: string): boolean } | null } = { previousElementSibling: null };
    let found: typeof circle | null = circle;
    const chip = { parentElement: null as object | null, remove() { this.parentElement = null; } };
    const insertions: Array<typeof circle> = [];
    const group = { querySelector: () => found, insertBefore: (_node: object, before: typeof circle) => {
      chip.parentElement = group;
      circle.previousElementSibling = { hasAttribute: () => false };
      insertions.push(before);
    } };
    let footer: { lastElementChild: typeof group } | null = { lastElementChild: group };
    const pane = { querySelector: () => footer } as unknown as ParentNode;
    const node = chip as unknown as HTMLElement;
    expect(placeInFooter(node, pane)).not.toBeNull();
    expect(placeInFooter(node, pane)).not.toBeNull();
    expect(insertions).toEqual([circle]);
    circle.previousElementSibling = { hasAttribute: (name) => name === "data-burn-chip" };
    expect(placeInFooter(node, pane)).not.toBeNull();
    expect(placeInFooter(node, pane)).not.toBeNull();
    expect(insertions).toEqual([circle, circle]);
    found = null;
    expect(placeInFooter(node, pane)).toBeNull();
    expect(chip.parentElement).toBeNull();
    footer = null;
    expect(placeInFooter(node, pane)).toBeNull();
  });
});
