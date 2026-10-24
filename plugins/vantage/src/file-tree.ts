export type TreeNode<T> =
  // `chain` is the path of every folder a joined row stands for, outermost first: ["src", "src/lib"] for "src/lib".
  | { kind: "dir"; name: string; path: string; chain: string[]; files: number; children: TreeNode<T>[] }
  | { kind: "file"; name: string; path: string; item: T };

interface Folder<T> { dirs: Map<string, Folder<T>>; files: Array<{ name: string; path: string; item: T }> }

const byName = (a: string, b: string): number => a.localeCompare(b);

export function buildFileTree<T>(items: readonly T[], pathOf: (item: T) => string): TreeNode<T>[] {
  const root: Folder<T> = { dirs: new Map(), files: [] };
  for (const item of items) {
    const path = pathOf(item);
    const segments = path.split("/").filter((segment) => segment !== "");
    const name = segments.pop() ?? path;
    let folder = root;
    for (const segment of segments) {
      let next = folder.dirs.get(segment);
      if (next === undefined) folder.dirs.set(segment, next = { dirs: new Map(), files: [] });
      folder = next;
    }
    folder.files.push({ name, path, item });
  }
  return nodesOf(root, "");
}

function nodesOf<T>(folder: Folder<T>, prefix: string): TreeNode<T>[] {
  const dirs = [...folder.dirs].sort(([a], [b]) => byName(a, b)).map(([segment, child]): TreeNode<T> => {
    let name = segment;
    let inner = child;
    const chain = [prefix + segment];
    // A folder that holds only one folder is one row, as in GitHub's file tree, so deep paths do not waste a level each.
    while (inner.files.length === 0 && inner.dirs.size === 1) {
      const [nextName, next] = [...inner.dirs][0]!;
      name = `${name}/${nextName}`;
      inner = next;
      chain.push(prefix + name);
    }
    const path = prefix + name;
    const children = nodesOf(inner, `${path}/`);
    return { kind: "dir", name, path, chain, files: countFiles(children), children };
  });
  // A stable sort, so two entries for one path keep the order they came in.
  const files = [...folder.files].sort((a, b) => byName(a.name, b.name)).map((file): TreeNode<T> => ({ kind: "file", ...file }));
  return [...dirs, ...files];
}

const countFiles = <T>(nodes: readonly TreeNode<T>[]): number =>
  nodes.reduce((total, node) => total + (node.kind === "dir" ? node.files : 1), 0);

export type DirNode<T> = Extract<TreeNode<T>, { kind: "dir" }>;

export function dirNodes<T>(nodes: readonly TreeNode<T>[]): DirNode<T>[] {
  return nodes.flatMap((node) => (node.kind === "dir" ? [node, ...dirNodes(node.children)] : []));
}

export const dirPaths = <T>(nodes: readonly TreeNode<T>[]): string[] => dirNodes(nodes).map((node) => node.path);

export function filesBelow<T>(node: TreeNode<T>): T[] {
  return node.kind === "file" ? [node.item] : node.children.flatMap(filesBelow);
}
