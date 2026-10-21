import { describe, expect, it } from "vitest";
import {
  EMPTY_TREE, FILE_LIMIT, LOG_FORMAT, PATCH_LIMIT, REFLOG_SLACK_MS, commitsInWindows, countDiffLines, isSafeRef, isSafeRelativePath, isSafeSha,
  parseLog, parseNameStatusZ, parseNumstatZ, parseReflog, parseStatusZ, splitToplevel, statusFromCode, truncatePatch,
} from "../src/git";

const z = (...parts: string[]) => parts.map((part) => `${part}\0`).join("");

describe("constants", () => {
  it("names the empty tree and the limits", () => {
    expect(EMPTY_TREE).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(PATCH_LIMIT).toBe(1_048_576);
    expect(FILE_LIMIT).toBe(2000);
  });
});

describe("parseStatusZ", () => {
  it("reads modified, added, deleted and untracked entries", () => {
    const output = z(" M src/a.ts", "A  src/b.ts", "D  src/c.ts", "?? notes.md", "UU conflict.ts");
    expect(parseStatusZ(output)).toEqual([
      { path: "src/a.ts", previousPath: null, code: " M" },
      { path: "src/b.ts", previousPath: null, code: "A " },
      { path: "src/c.ts", previousPath: null, code: "D " },
      { path: "notes.md", previousPath: null, code: "??" },
      { path: "conflict.ts", previousPath: null, code: "UU" },
    ]);
  });

  it("pairs a rename with its old path, which follows the new one", () => {
    const output = z("R  new name.ts", "old name.ts", " M after.ts");
    expect(parseStatusZ(output)).toEqual([
      { path: "new name.ts", previousPath: "old name.ts", code: "R " },
      { path: "after.ts", previousPath: null, code: " M" },
    ]);
  });

  it("reads an empty output as no entries", () => {
    expect(parseStatusZ("")).toEqual([]);
  });
});

describe("parseNameStatusZ", () => {
  it("reads plain entries and rename pairs, where the old path comes first", () => {
    const output = z("M", "a.ts", "A", "b.ts", "D", "c.ts", "R087", "old.ts", "new.ts", "T", "link");
    expect(parseNameStatusZ(output)).toEqual([
      { path: "a.ts", previousPath: null, code: "M" },
      { path: "b.ts", previousPath: null, code: "A" },
      { path: "c.ts", previousPath: null, code: "D" },
      { path: "new.ts", previousPath: "old.ts", code: "R087" },
      { path: "link", previousPath: null, code: "T" },
    ]);
  });

  it("reads a copy as an old and a new path", () => {
    expect(parseNameStatusZ(z("C100", "from.ts", "to.ts"))).toEqual([
      { path: "to.ts", previousPath: "from.ts", code: "C100" },
    ]);
  });
});

describe("parseNumstatZ", () => {
  it("reads counts, binary dashes and rename triples", () => {
    const output = `1\t2\ta.ts\0-\t-\timage.png\0` + `3\t0\t\0old.ts\0new.ts\0` + `4\t5\tlast.ts\0`;
    const stats = parseNumstatZ(output);
    expect(stats.get("a.ts")).toEqual({ additions: 1, deletions: 2, previousPath: null });
    expect(stats.get("image.png")).toEqual({ additions: null, deletions: null, previousPath: null });
    expect(stats.get("new.ts")).toEqual({ additions: 3, deletions: 0, previousPath: "old.ts" });
    expect(stats.get("last.ts")).toEqual({ additions: 4, deletions: 5, previousPath: null });
    expect(stats.has("old.ts")).toBe(false);
  });

  it("keeps a path that contains a tab", () => {
    expect(parseNumstatZ("1\t1\ta\tb.ts\0").get("a\tb.ts")).toEqual({ additions: 1, deletions: 1, previousPath: null });
  });
});

describe("statusFromCode", () => {
  it.each([
    [" M", "modified"], ["M ", "modified"], ["MM", "modified"], ["A ", "added"], ["D ", "deleted"], [" D", "deleted"],
    ["R ", "renamed"], ["R087", "renamed"], ["C ", "copied"], [" T", "type-changed"], ["??", "untracked"],
    ["UU", "unmerged"], ["AA", "unmerged"], ["DD", "unmerged"], ["AU", "unmerged"], ["U", "unmerged"],
  ])("maps %j to %s", (code, status) => {
    expect(statusFromCode(code)).toBe(status);
  });

  it("falls back to modified for an unknown letter", () => {
    expect(statusFromCode("X ")).toBe("modified");
  });
});

describe("splitToplevel", () => {
  it("reads the root and the prefix lines", () => {
    expect(splitToplevel("/repo\nsrc/lib/\n")).toEqual({ root: "/repo", prefix: "src/lib/" });
    expect(splitToplevel("/repo\n\n")).toEqual({ root: "/repo", prefix: "" });
    expect(splitToplevel("/private/tmp/r\n")).toEqual({ root: "/private/tmp/r", prefix: "" });
  });

  it("returns null without a root", () => {
    expect(splitToplevel("")).toBeNull();
    expect(splitToplevel("\n\n")).toBeNull();
  });
});

describe("isSafeRelativePath", () => {
  it.each(["a", "src/a.ts", "a b/c d.txt", ".github/x.yml", "..a/b"])("accepts %j", (path) => {
    expect(isSafeRelativePath(path)).toBe(true);
  });

  it.each(["", "../a", "/a", "a/../../b", "a/..", "./a", "a//b", "C:/a", "a\0b", "a\\..\\b"])("rejects %j", (path) => {
    expect(isSafeRelativePath(path)).toBe(false);
  });
});

describe("isSafeRef", () => {
  it.each(["main", "origin/main", "feature/a-b_c.d", "user@host/x", "v1.2.3"])("accepts %j", (ref) => {
    expect(isSafeRef(ref)).toBe(true);
  });

  it.each(["", "-x", "--upload-pack=x", "a..b", "a b", "a;b", "a$(b)", "a\nb"])("rejects %j", (ref) => {
    expect(isSafeRef(ref)).toBe(false);
  });
});

describe("truncatePatch", () => {
  it("returns a short patch unchanged", () => {
    expect(truncatePatch("a\nb\n", 100)).toEqual({ patch: "a\nb\n", truncated: false });
  });

  it("cuts on the last newline before the limit", () => {
    expect(truncatePatch("aaaa\nbbbb\ncccc\n", 12)).toEqual({ patch: "aaaa\nbbbb\n", truncated: true });
  });

  it("cuts at the limit when no newline comes before it", () => {
    expect(truncatePatch("abcdefghij", 4)).toEqual({ patch: "abcd", truncated: true });
  });

  it("uses the 1 MiB limit by default", () => {
    const line = `${"x".repeat(1023)}\n`;
    const result = truncatePatch(line.repeat(1100));
    expect(result.truncated).toBe(true);
    expect(result.patch.length).toBeLessThanOrEqual(PATCH_LIMIT);
    expect(result.patch.endsWith("\n")).toBe(true);
  });
});

describe("countDiffLines", () => {
  it("counts added and removed lines and skips the file headers", () => {
    const diff = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n+more";
    expect(countDiffLines(diff)).toEqual({ added: 2, removed: 1 });
  });

  it("counts a diff without headers", () => {
    expect(countDiffLines("+a\n+b\n-c")).toEqual({ added: 2, removed: 1 });
  });

  it("returns zero for nothing", () => {
    expect(countDiffLines(undefined)).toEqual({ added: 0, removed: 0 });
    expect(countDiffLines(null)).toEqual({ added: 0, removed: 0 });
    expect(countDiffLines("")).toEqual({ added: 0, removed: 0 });
  });
});

describe("parseLog", () => {
  const line = (...parts: string[]) => parts.join("\x1f");

  it("names the format it parses", () => {
    expect(LOG_FORMAT).toBe("%H%x1f%h%x1f%an%x1f%at%x1f%s");
  });

  it("reads commits newest first and turns the author time into milliseconds", () => {
    const output = [
      line("a".repeat(40), "aaaaaaa", "Ada", "1700000100", "Second: fix it"),
      line("b".repeat(40), "bbbbbbb", "Grace Hopper", "1700000000", "First"),
    ].join("\n") + "\n";
    expect(parseLog(output)).toEqual([
      { sha: "a".repeat(40), shortSha: "aaaaaaa", authorName: "Ada", authoredAt: 1_700_000_100_000, subject: "Second: fix it" },
      { sha: "b".repeat(40), shortSha: "bbbbbbb", authorName: "Grace Hopper", authoredAt: 1_700_000_000_000, subject: "First" },
    ]);
  });

  it("skips malformed lines and reads an empty output as no commits", () => {
    const output = ["junk", line("c".repeat(40), "ccccccc", "Ada", "not-a-number", "Bad time"), line("d".repeat(40), "ddddddd", "Ada", "5", "Ok")].join("\n");
    expect(parseLog(output).map((commit) => commit.subject)).toEqual(["Ok"]);
    expect(parseLog("")).toEqual([]);
  });
});

describe("isSafeSha", () => {
  it("accepts 7 to 64 lowercase hex characters only", () => {
    expect(isSafeSha("abc1234")).toBe(true);
    expect(isSafeSha("a".repeat(64))).toBe(true);
    expect(isSafeSha("abc123")).toBe(false);
    expect(isSafeSha("a".repeat(65))).toBe(false);
    expect(isSafeSha("ABC1234")).toBe(false);
    expect(isSafeSha("-abc1234")).toBe(false);
    expect(isSafeSha("HEAD~1")).toBe(false);
  });
});

describe("parseReflog", () => {
  const entry = (sha: string, seconds: string, subject: string) => [sha, `HEAD@{${seconds}}`, subject].join("\x1f");

  it("reads each entry's commit, time and action, newest first", () => {
    const output = [
      entry("a".repeat(40), "1700000200", "commit (amend): two, amended"),
      entry("b".repeat(40), "1700000100", "pull --ff-only: Fast-forward"),
      entry("c".repeat(40), "1700000000", "commit (initial): one"),
    ].join("\n");
    expect(parseReflog(output)).toEqual([
      { sha: "a".repeat(40), at: 1_700_000_200_000, action: "commit (amend)" },
      { sha: "b".repeat(40), at: 1_700_000_100_000, action: "pull --ff-only" },
      { sha: "c".repeat(40), at: 1_700_000_000_000, action: "commit (initial)" },
    ]);
  });

  it("skips malformed lines and an empty output", () => {
    const output = ["junk", entry("not-a-sha", "1", "commit: x"), entry("d".repeat(40), "HEAD~1", "commit: x"), entry("e".repeat(40), "5", "commit: ok")].join("\n");
    expect(parseReflog(output)).toEqual([{ sha: "e".repeat(40), at: 5000, action: "commit" }]);
    expect(parseReflog("")).toEqual([]);
  });
});

describe("commitsInWindows", () => {
  const at = (sha: string, ms: number, action = "commit") => ({ sha: sha.repeat(40), at: ms, action });

  it("keeps commits git commit made while a window was open, newest first and each once", () => {
    const entries = [
      at("a", 50_000), at("b", 40_000, "commit (amend)"), at("c", 30_000, "pull --ff-only"), at("d", 20_000, "checkout"),
      at("e", 10_000, "commit (merge)"), at("a", 9_000), at("f", 1_000, "commit (initial)"),
    ];
    expect(commitsInWindows(entries, [{ start: 9_000, end: 50_000 }])).toEqual(["a".repeat(40), "b".repeat(40), "e".repeat(40)]);
  });

  it("allows for whole-second reflog times at both edges, and nothing beyond", () => {
    const windows = [{ start: 100_000, end: 200_000 }];
    const edges = [at("a", 100_000 - REFLOG_SLACK_MS), at("b", 200_000 + REFLOG_SLACK_MS), at("c", 100_000 - REFLOG_SLACK_MS - 1), at("d", 200_000 + REFLOG_SLACK_MS + 1)];
    expect(commitsInWindows(edges, windows)).toEqual(["a".repeat(40), "b".repeat(40)]);
  });

  it("finds nothing without windows", () => {
    expect(commitsInWindows([at("a", 1_000)], [])).toEqual([]);
  });
});
