import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFileTree, dirPaths, type TreeNode } from "../src/file-tree";
import { createRemembered } from "../src/remember";
import { createShared } from "../src/session";

afterEach(() => { window.localStorage.clear(); });

const isBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

describe("createRemembered", () => {
  it("keeps values across a reload of the page", () => {
    const first = createRemembered(window, "test:folds", isBoolean, 10);
    first.set("a", true);
    first.set("b", false);
    const second = createRemembered(window, "test:folds", isBoolean, 10);
    expect(second.snapshot().get("a")).toBe(true);
    expect(second.snapshot().get("b")).toBe(false);
  });

  it("forgets a key set to undefined, and writes several keys with one change", () => {
    const store = createRemembered(window, "test:folds", isBoolean, 10);
    let changes = 0;
    store.subscribe(() => { changes++; });
    store.setMany([["a", true], ["b", true], ["c", true]]);
    store.setMany([["a", undefined], ["b", false]]);
    expect(changes).toBe(2);
    expect([...store.snapshot()]).toEqual([["c", true], ["b", false]]);
  });

  it("drops the entries set longest ago once it holds more than its limit", () => {
    const store = createRemembered(window, "test:folds", isBoolean, 3);
    for (const key of ["a", "b", "c"]) store.set(key, true);
    store.set("a", false);
    store.set("d", true);
    expect([...store.snapshot().keys()]).toEqual(["c", "a", "d"]);
  });

  it("keeps every entry of one large write, dropping only older ones", () => {
    const store = createRemembered(window, "test:folds", isBoolean, 3);
    store.set("old", true);
    store.setMany(["p1", "p2", "p3", "p4"].map((key) => [key, true] as const));
    expect([...store.snapshot().keys()]).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("follows what another window writes, so its next write does not put the old value back", () => {
    const here = createRemembered(window, "test:folds", isBoolean, 10);
    const unsubscribe = here.subscribe(() => {});
    here.set("a", true);
    const there = createRemembered(window, "test:folds", isBoolean, 10);
    there.set("b", true);
    window.dispatchEvent(new StorageEvent("storage", { key: "test:folds" }));
    here.set("c", true);
    expect([...createRemembered(window, "test:folds", isBoolean, 10).snapshot().keys()]).toEqual(["a", "b", "c"]);
    unsubscribe();
  });

  it("keeps a value for this session when storage refuses the write", () => {
    const store = createRemembered(window, "test:folds", isBoolean, 10);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    try {
      expect(() => store.set("a", true)).not.toThrow();
      expect(store.get("a")).toBe(true);
    } finally {
      setItem.mockRestore();
    }
  });

  it("gives the same snapshot until something changes, so React does not render again", () => {
    const store = createRemembered(window, "test:folds", isBoolean, 10);
    const before = store.snapshot();
    expect(store.snapshot()).toBe(before);
    store.set("a", true);
    expect(store.snapshot()).not.toBe(before);
    const after = store.snapshot();
    store.set("a", true);
    expect(store.snapshot()).toBe(after);
  });

  it("starts empty from stored text it cannot read, and skips entries of the wrong type", () => {
    window.localStorage.setItem("test:broken", "[1,2");
    expect(createRemembered(window, "test:broken", isBoolean, 10).snapshot().size).toBe(0);
    window.localStorage.setItem("test:mixed", JSON.stringify([["a", true], ["b", "yes"], [3, false], "c"]));
    expect([...createRemembered(window, "test:mixed", isBoolean, 10).snapshot()]).toEqual([["a", true]]);
  });

  it("reads storage again on reload, for tests that clear it", () => {
    const store = createRemembered(window, "test:folds", isBoolean, 10);
    store.set("a", true);
    window.localStorage.clear();
    store.reload();
    expect(store.snapshot().size).toBe(0);
  });
});

describe("createShared with storage", () => {
  it("reads storage again on reload and falls back to its first value", () => {
    const shared = createShared<boolean>(false, { win: window, key: "test:wrap", parse: (raw) => (raw === "true" ? true : raw === "false" ? false : null) });
    shared.set(true);
    expect(window.localStorage.getItem("test:wrap")).toBe("true");
    window.localStorage.clear();
    shared.reload();
    expect(shared.get()).toBe(false);
  });
});

const names = (nodes: readonly TreeNode<string>[]): unknown[] =>
  nodes.map((node) => (node.kind === "dir" ? { [node.name]: names(node.children) } : node.name));

describe("buildFileTree", () => {
  const paths = ["src/ui/button.tsx", "src/ui/card.tsx", "src/index.ts", "README.md", "docs/guide/intro.md", "package.json"];
  const tree = buildFileTree(paths, (path) => path);

  it("nests files under their folders, folders first and each level sorted by name", () => {
    expect(names(tree)).toEqual([
      { "docs/guide": ["intro.md"] },
      { src: [{ ui: ["button.tsx", "card.tsx"] }, "index.ts"] },
      "package.json",
      "README.md",
    ]);
  });

  it("joins a chain of folders that each hold only one folder into one row, and lists every folder it stands for", () => {
    const docs = tree[0]!;
    expect(docs.kind === "dir" && docs.path).toBe("docs/guide");
    expect(docs.kind === "dir" && docs.chain).toEqual(["docs", "docs/guide"]);
    const src = tree[1]!;
    expect(src.kind === "dir" && src.chain).toEqual(["src"]);
  });

  it("counts the files below each folder and keeps the full path of every folder", () => {
    const src = tree[1]!;
    expect(src.kind === "dir" && src.files).toBe(3);
    expect(dirPaths(tree)).toEqual(["docs/guide", "src", "src/ui"]);
  });

  it("keeps two entries for one path, such as its uncommitted and committed changes", () => {
    const twice = buildFileTree([{ path: "a/b.ts", part: "uncommitted" }, { path: "a/b.ts", part: "committed" }], (entry) => entry.path);
    const dir = twice[0]!;
    expect(dir.kind === "dir" && dir.children.map((child) => child.kind === "file" && child.item.part)).toEqual(["uncommitted", "committed"]);
  });

  it("returns an empty tree for no files", () => {
    expect(buildFileTree([], (path: string) => path)).toEqual([]);
  });
});
