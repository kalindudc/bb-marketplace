import { describe, expect, it } from "vitest";
import { IN_FLIGHT, budgetReason, idleAction, readyTickets, toLite, workerSlots, type TicketLite } from "../src/scheduler";
import { scopeReport } from "../src/scope";
import { parseSpec } from "../src/spec";
import { TICKET_STATES } from "../src/states";
import type { TicketRow } from "../src/db/store";
import { specToml, type Doc } from "./helpers";

let seq = 0;
const ticket = (over: Partial<TicketLite> = {}): TicketLite => {
  seq += 1;
  return { id: seq, key: `CSV-${seq}`, state: "queued", priority: 2, seq, deps: [], scope: [`area${seq}/**`], repo: null, ...over };
};
const keys = (tickets: TicketLite[]) => tickets.map((t) => t.key);

describe("readyTickets", () => {
  it("returns queued tickets whose dependencies are all done", () => {
    const base = ticket({ key: "A", state: "done", scope: ["a/**"] });
    const half = ticket({ key: "B", state: "working", scope: ["b/**"] });
    const ready = ticket({ key: "C", deps: ["A"], scope: ["c/**"] });
    const waiting = ticket({ key: "D", deps: ["A", "B"], scope: ["d/**"] });
    const dangling = ticket({ key: "E", deps: ["GONE"], scope: ["e/**"] });
    expect(keys(readyTickets([base, half, ready, waiting, dangling]))).toEqual(["C"]);
  });

  it("skips a ticket whose scope overlaps one in any in-flight state", () => {
    for (const state of IN_FLIGHT) {
      const held = ticket({ state, scope: ["src/api/**"] });
      const blocked = ticket({ scope: ["src/api/routes.ts"] });
      const free = ticket({ scope: ["docs/**"] });
      expect(keys(readyTickets([held, blocked, free]))).toEqual([free.key]);
    }
  });

  it("does not hold scope for tickets that are blocked, done, cancelled or queued", () => {
    const others = (["blocked", "done", "cancelled"] as const).map((state) => ticket({ state, scope: ["src/**"] }));
    const next = ticket({ scope: ["src/a.ts"] });
    expect(keys(readyTickets([...others, next]))).toEqual([next.key]);
  });

  it("does not pick two overlapping tickets in one call", () => {
    const first = ticket({ scope: ["src/**"], seq: 1 });
    const second = ticket({ scope: ["src/a/**"], seq: 2 });
    const third = ticket({ scope: ["docs/**"], seq: 3 });
    expect(keys(readyTickets([first, second, third]))).toEqual([first.key, third.key]);
  });

  it("orders by priority, then seq, and lets a lower ticket through when a higher one overlaps", () => {
    const late = ticket({ priority: 1, seq: 9, scope: ["z/**"] });
    const early = ticket({ priority: 2, seq: 2, scope: ["y/**"] });
    const later = ticket({ priority: 2, seq: 3, scope: ["x/**"] });
    const urgent = ticket({ priority: 0, seq: 10, scope: ["w/**"] });
    expect(keys(readyTickets([later, early, late, urgent]))).toEqual([urgent.key, late.key, early.key, later.key]);

    const held = ticket({ state: "working", scope: ["src/**"] });
    const overlapping = ticket({ priority: 0, scope: ["src/a.ts"] });
    const clear = ticket({ priority: 3, scope: ["docs/**"] });
    expect(keys(readyTickets([held, overlapping, clear]))).toEqual([clear.key]);
  });

  it("lets overlapping tickets in different repos start side by side, and only one of them within a repo", () => {
    const web = ticket({ repo: "web", scope: ["src/**"], seq: 1 });
    const api = ticket({ repo: "api", scope: ["src/**"], seq: 2 });
    const webAgain = ticket({ repo: "web", scope: ["src/a.ts"], seq: 3 });
    expect(keys(readyTickets([web, api, webAgain]))).toEqual([web.key, api.key]);

    for (const state of IN_FLIGHT) {
      const held = ticket({ state, repo: "web", scope: ["src/**"] });
      const sameRepo = ticket({ repo: "web", scope: ["src/a.ts"] });
      const otherRepo = ticket({ repo: "api", scope: ["src/a.ts"] });
      expect(keys(readyTickets([held, sameRepo, otherRepo]))).toEqual([otherRepo.key]);
    }
  });
});

describe("workerSlots", () => {
  it("counts working and checking tickets and no others", () => {
    const states = TICKET_STATES.map((state) => ticket({ state }));
    expect(workerSlots(8, states)).toBe(6);
    expect(workerSlots(2, [ticket({ state: "working" }), ticket({ state: "checking" }), ticket({ state: "review" })])).toBe(0);
    expect(workerSlots(3, [ticket({ state: "review" }), ticket({ state: "working" })])).toBe(2);
    expect(workerSlots(1, [ticket({ state: "working" }), ticket({ state: "working" })])).toBe(0);
  });
});

describe("toLite", () => {
  it("parses the dependency and scope lists and keeps the repo", () => {
    const row = { id: 4, key: "CSV-4", state: "queued", priority: 1, seq: 4, deps_json: '["CSV-1"]', scope_json: '["src/**","docs/**"]', repo: null } as TicketRow;
    expect(toLite(row)).toEqual({ id: 4, key: "CSV-4", state: "queued", priority: 1, seq: 4, deps: ["CSV-1"], scope: ["src/**", "docs/**"], repo: null });
    expect(toLite({ ...row, repo: "api" }).repo).toBe("api");
  });
});

describe("idleAction", () => {
  it("nudges the first idle and abandons from the second", () => {
    expect(idleAction(0)).toBe("nudge");
    expect(idleAction(1)).toBe("abandon");
    expect(idleAction(5)).toBe("abandon");
  });
});

describe("budgetReason", () => {
  const spec = (edit: (doc: Doc) => void) => parseSpec(specToml(edit)).spec!;

  it("is null without a limit, or while under both limits", () => {
    expect(budgetReason(spec(() => {}), 9_999_999, Date.UTC(2090, 0, 1))).toBeNull();
    const limited = spec((doc) => (doc.budget = { max_tokens: 1000, deadline: "2030-06-30" }));
    expect(budgetReason(limited, 999, Date.UTC(2030, 5, 30, 23, 59))).toBeNull();
  });

  it("names the token budget once it is reached", () => {
    const limited = spec((doc) => (doc.budget = { max_tokens: 1000 }));
    expect(budgetReason(limited, 1000, 0)).toBe("The token budget is used up: 1000 of 1000 tokens.");
  });

  it("treats the deadline date as inclusive: reached when that day is over", () => {
    const limited = spec((doc) => (doc.budget = { deadline: "2030-06-30" }));
    expect(budgetReason(limited, 0, Date.UTC(2030, 5, 30, 23, 59, 59))).toBeNull();
    expect(budgetReason(limited, 0, Date.UTC(2030, 6, 1))).toBe("The deadline 2030-06-30 has passed.");
  });
});

describe("scopeReport", () => {
  it("separates files outside the ticket's scope from files under a protected path", () => {
    const report = scopeReport(["src/a.ts", "src/deep/b.ts", "docs/readme.md", "package-lock.json", ".github/ci.yml", "yarn.lock"], ["src/**"], [".github/**", "**/*.lock", "package-lock.json"]);
    expect(report.outside).toEqual(["docs/readme.md", "package-lock.json", ".github/ci.yml", "yarn.lock"]);
    expect(report.protectedHits).toEqual(["package-lock.json", ".github/ci.yml", "yarn.lock"]);
  });

  it("reports nothing when every file is in scope", () => {
    expect(scopeReport(["src/a.ts"], ["src/**"], [])).toEqual({ outside: [], protectedHits: [] });
    expect(scopeReport([], ["src/**"], ["x"])).toEqual({ outside: [], protectedHits: [] });
  });
});
