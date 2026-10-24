import { afterEach, describe, expect, it } from "vitest";
import { COMMENTS_STORAGE_KEY, composeReview, createCommentStore } from "../src/comments";
import { containsAcrossShadow } from "../src/file-card";
import { hunkRanges, overlapVerdict } from "../src/overlaps";
import { isReviewed, isStale, markId, progress, signature, worktreeParts } from "../src/reviewed";
import { fileChange, worktree } from "./fixtures";

afterEach(() => { window.localStorage.clear(); });

describe("review marks", () => {
  const file = fileChange({ path: "a.ts", additions: 2, deletions: 1 });
  const parts = worktreeParts(worktree({ uncommitted: [file], committed: [fileChange({ path: "b.ts" })] }));

  it("lists a worktree's uncommitted changes, then its committed ones", () => {
    expect(parts.map((part) => [part.part, part.file.path])).toEqual([["uncommitted", "a.ts"], ["committed", "b.ts"]]);
  });

  it("counts a part as reviewed only while its file still has the counts it had when ticked", () => {
    const marks = { [markId("uncommitted", "a.ts")]: signature(file) };
    expect(isReviewed(marks, parts[0]!)).toBe(true);
    expect(progress(marks, parts)).toEqual({ reviewed: 1, total: 2 });
    const changed = { [markId("uncommitted", "a.ts")]: signature({ ...file, additions: 5 }) };
    expect(isReviewed(changed, parts[0]!)).toBe(false);
    expect(isStale(changed, parts[0]!)).toBe(true);
    expect(isStale({}, parts[0]!)).toBe(false);
  });
});

describe("comments", () => {
  it("keeps drafts per worktree on this device until they are cleared", () => {
    const store = createCommentStore(window);
    store.add("w1", { path: "a.ts", part: "uncommitted", quote: "", text: "Rename this" });
    store.add("w2", { path: "b.ts", part: "committed", quote: "", text: "Add a test" });
    const [first] = store.get("w1");
    store.update("w1", first!.id, "Rename this to total");
    expect(createCommentStore(window).get("w1").map((comment) => comment.text)).toEqual(["Rename this to total"]);
    store.remove("w2", store.get("w2")[0]!.id);
    store.clear("w1");
    expect(JSON.parse(window.localStorage.getItem(COMMENTS_STORAGE_KEY)!)).toEqual({});
  });

  it("removes a sent comment only if it is unchanged since it was sent", () => {
    const store = createCommentStore(window);
    store.add("w1", { path: "a.ts", part: "uncommitted", quote: "", text: "One" });
    store.add("w1", { path: "b.ts", part: "uncommitted", quote: "", text: "Two" });
    const sent = store.get("w1");
    store.update("w1", sent[1]!.id, "Two, edited");
    store.add("w1", { path: "c.ts", part: "uncommitted", quote: "", text: "Three" });
    store.removeSent("w1", sent);
    expect(store.get("w1").map((comment) => comment.text)).toEqual(["Two, edited", "Three"]);
  });

  it("ignores a stored value it cannot read", () => {
    window.localStorage.setItem(COMMENTS_STORAGE_KEY, "[1,2");
    expect(createCommentStore(window).get("w1")).toEqual([]);
  });

  it("writes one message that names each file and quotes the lines a comment is about", () => {
    const message = composeReview([
      { id: "1", path: "README.md", part: "uncommitted", quote: "During the sale\nprices drop", text: "Say it comes off before tax.", at: 1 },
      { id: "2", path: "test/a.test.js", part: "commit:a1b2c3d4e5", quote: "", text: "Add a case for 0 cents.", at: 2 },
    ], "/work/one");
    expect(message).toBe([
      "Review notes from Vantage on your changes:",
      "",
      "1. `README.md` (not committed)",
      "   > During the sale",
      "   > prices drop",
      "   Say it comes off before tax.",
      "",
      "2. `test/a.test.js` (in commit a1b2c3d)",
      "   Add a case for 0 cents.",
      "",
      "Paths are relative to /work/one.",
    ].join("\n"));
  });
});

describe("overlap verdict", () => {
  const patch = (...hunks: string[]) => hunks.map((hunk) => `@@ ${hunk} @@\n+x`).join("\n");

  it("reads each hunk's old-side line range, counting an insertion as the line it follows", () => {
    expect(hunkRanges(patch("-7,0 +7,4", "-20,3 +24,5", "-40 +44"))).toEqual([{ start: 7, end: 7 }, { start: 20, end: 22 }, { start: 40, end: 40 }]);
  });

  it("guesses a conflict when two worktrees change the same or neighbouring lines", () => {
    expect(overlapVerdict([[patch("-6,0 +7,4")], [patch("-6,0 +7,3")]])).toBe("conflict");
    expect(overlapVerdict([[patch("-10,2 +10,2")], [patch("-12,1 +12,1")]])).toBe("conflict");
  });

  it("guesses a clean merge when the changes are apart, and gives no verdict without both patches", () => {
    expect(overlapVerdict([[patch("-1,2 +1,2")], [patch("-30,2 +30,2")]])).toBe("clean");
    expect(overlapVerdict([[patch("-1,2 +1,2")], []])).toBe("unknown");
    expect(overlapVerdict([[patch("-1,2 +1,2")], ["Binary files differ"]])).toBe("unknown");
  });
});

describe("containsAcrossShadow", () => {
  it("finds a selection made inside a diff's shadow root as inside the card", () => {
    const card = document.createElement("section");
    const host = document.createElement("div");
    card.append(host);
    const line = document.createTextNode("+ During the holiday sale");
    host.attachShadow({ mode: "open" }).append(line);
    expect(card.contains(line)).toBe(false);
    expect(containsAcrossShadow(card, line)).toBe(true);
    expect(containsAcrossShadow(card, document.createTextNode("elsewhere"))).toBe(false);
    expect(containsAcrossShadow(card, null)).toBe(false);
  });
});
