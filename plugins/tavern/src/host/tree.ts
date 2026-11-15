// Rewrites a git tree for a few changed paths. Only the trees on the way to a changed path are read and written; the rest
// of a monorepo's tree is shared with the base by sha, which a whole-index read-tree and write-tree cannot do.
export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
}

export interface TreeIO {
  /** The entries of one tree object, by name. */
  list(tree: string): Promise<Map<string, TreeEntry>>;
  /** Writes a tree of these entries and returns its sha. */
  write(entries: ReadonlyMap<string, TreeEntry>): Promise<string>;
}

/** A file to put at a path, or null to remove the file there. */
export type TreeEdit = { mode: string; sha: string } | null;

// What the edits so far do at one name, in the order they came, as `update-index --index-info` does them to an index.
type Node =
  | { kind: "file"; mode: string; sha: string }
  // Removes a file at this name; a directory of the base stays.
  | { kind: "unlink" }
  // Nothing at this name, whatever the base has.
  | { kind: "gone" }
  // `inherit`: starts from the base's directory of this name, if the base has one. `touched`: a file was put below, so a file
  // or submodule of the base at this name is replaced by the directory even if it ends up empty.
  | { kind: "dir"; children: Map<string, Node>; inherit: boolean; touched: boolean };

const newDir = (inherit: boolean, touched: boolean): Node & { kind: "dir" } => ({ kind: "dir", children: new Map(), inherit, touched });

function record(root: Node & { kind: "dir" }, path: string, edit: TreeEdit): void {
  const names = path.split("/");
  const last = names.pop()!;
  let dir = root;
  for (const name of names) {
    const node = dir.children.get(name);
    if (edit === null) {
      // A removal below a file, a removed name or a directory that is not there changes nothing.
      if (node === undefined) {
        const created = newDir(true, false);
        dir.children.set(name, created);
        dir = created;
      } else if (node.kind === "dir") dir = node;
      else return;
    } else if (node?.kind === "dir") {
      node.touched = true;
      dir = node;
    } else {
      // A file put below a name replaces what was there: a file or a removed name starts an empty directory, a removal
      // that left the base's directory alone does not.
      const created = newDir(node === undefined || node.kind === "unlink", true);
      dir.children.set(name, created);
      dir = created;
    }
  }
  const node = dir.children.get(last);
  if (edit !== null) dir.children.set(last, { kind: "file", mode: edit.mode, sha: edit.sha });
  else if (node === undefined || node.kind === "unlink") dir.children.set(last, { kind: "unlink" });
  else if (node.kind === "file") dir.children.set(last, { kind: "gone" });
}

/**
 * The sha of `root` with `edits` applied in order, keyed by path from the root. The result is what `update-index
 * --index-info` and `write-tree` give on an index read from `root`: an edit replaces whatever is at its path, a file where a
 * directory was (or the reverse) included, and the last edit of a path wins; a removal drops a file only, never a directory;
 * a directory left empty is dropped; every other entry, a submodule included, stays as it is.
 */
export async function rewriteTree(io: TreeIO, root: string, edits: Iterable<readonly [string, TreeEdit]>): Promise<string> {
  const overlay = newDir(true, false);
  for (const [path, edit] of edits) record(overlay, path, edit);
  return (await build(io, overlay, root, true))!;
}

async function build(io: TreeIO, dir: Node & { kind: "dir" }, tree: string | null, isRoot: boolean): Promise<string | null> {
  const entries = tree === null ? new Map<string, TreeEntry>() : await io.list(tree);
  for (const [name, node] of dir.children) {
    const existing = entries.get(name);
    if (node.kind === "file") entries.set(name, { mode: node.mode, type: "blob", sha: node.sha });
    else if (node.kind === "gone") entries.delete(name);
    else if (node.kind === "unlink") {
      if (existing !== undefined && existing.type !== "tree") entries.delete(name);
    } else {
      const built = await build(io, node, node.inherit && existing?.type === "tree" ? existing.sha : null, false);
      if (built !== null) entries.set(name, { mode: "040000", type: "tree", sha: built });
      else if (node.touched || existing?.type === "tree") entries.delete(name);
    }
  }
  if (entries.size === 0 && !isRoot) return null;
  return io.write(entries);
}
