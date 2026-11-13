// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/db/store";
import { memoryDb } from "./helpers";

describe("number-specific PR lookup", () => {
  it("returns only reference fields for matching numbers across repositories and servers", () => {
    const db = memoryDb();
    const store = new Store(db, () => 0);
    const insert = db.prepare("INSERT INTO prs (key, server, repo, number, url, title, author, state, checks, review, fetched_at) VALUES (?, ?, ?, ?, ?, 'Title', 'sam', 'open', 'none', 'none', 0)");
    const rows = [
      { server: "forge", repo: "acme/app", number: 7, url: "https://forge.test/acme/app/pull/7" },
      { server: "forge", repo: "other/repo", number: 7, url: "https://forge.test/other/repo/pull/7" },
      { server: "github", repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" },
      { server: "forge", repo: "acme/app", number: 8, url: "https://forge.test/acme/app/pull/8" },
    ];
    for (const row of rows) insert.run(`${row.server}:${row.repo}#${row.number}`, row.server, row.repo, row.number, row.url);
    const version = store.version;
    expect(store.prsByNumbers([7, 999, 7])).toEqual(expect.arrayContaining(rows.slice(0, 3)));
    expect(store.prsByNumbers([7, 999, 7])).toHaveLength(3);
    expect(store.prsByNumbers([])).toEqual([]);
    expect(store.version).toBe(version);
    db.close();
  });

  it("caches one statement regardless of the number of requested numbers", () => {
    const db = memoryDb();
    const store = new Store(db, () => 0);
    const prepare = vi.spyOn(db, "prepare");
    store.prsByNumbers([7]);
    store.prsByNumbers([7, 8, 9]);
    store.prsByNumbers([]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]![0]).toContain("json_each(?)");
    db.close();
  });

  it("uses a number index rather than scanning the PR table", () => {
    const db = memoryDb();
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT server, repo, number, url FROM prs WHERE number IN (SELECT value FROM json_each(?))").all("[7,8]") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain("SEARCH prs USING INDEX prs_number (number=?)");
    db.close();
  });
});
