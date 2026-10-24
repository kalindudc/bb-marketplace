import { describe, expect, it } from "vitest";
import { archivedLast, countArchived, isArchivedOnly } from "../src/archived";
import { overview, threadSummary } from "./fixtures";

const threads = [
  threadSummary({ id: "thr_live" }),
  threadSummary({ id: "thr_old", archived: true }),
  threadSummary({ id: "thr_older", archived: true }),
];
const byId = new Map(threads.map((thread) => [thread.id, thread]));

describe("isArchivedOnly", () => {
  it("is true only when every thread of the row is archived", () => {
    expect(isArchivedOnly({ threadIds: ["thr_old", "thr_older"] }, byId)).toBe(true);
    expect(isArchivedOnly({ threadIds: ["thr_old", "thr_live"] }, byId)).toBe(false);
    expect(isArchivedOnly({ threadIds: ["thr_live"] }, byId)).toBe(false);
  });

  it("treats a row with no threads or an unknown thread as active", () => {
    expect(isArchivedOnly({ threadIds: [] }, byId)).toBe(false);
    expect(isArchivedOnly({ threadIds: ["thr_unknown"] }, byId)).toBe(false);
  });
});

describe("archivedLast", () => {
  it("moves archived-only rows after the active ones and keeps the order within each part", () => {
    const rows = [
      { key: "a", threadIds: ["thr_old"] },
      { key: "b", threadIds: ["thr_live"] },
      { key: "c", threadIds: ["thr_older"] },
      { key: "d", threadIds: ["thr_live", "thr_old"] },
    ];
    expect(archivedLast(rows, threads).map((row) => row.key)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("countArchived", () => {
  it("counts the rows whose threads are all archived", () => {
    expect(countArchived([{ threadIds: ["thr_old"] }, { threadIds: ["thr_live"] }, { threadIds: ["thr_old", "thr_older"] }], threads)).toBe(2);
  });
});
