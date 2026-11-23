import fs from "node:fs";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";

type Watch = readonly [path: string, directory?: true];
export function metadataStamp(path: string, directory = false, stableBefore?: bigint): string | null {
  try {
    const stat = fs.statSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) return "absent";
    const identity = `${stat.dev}:${stat.ino}:${stat.mode}`;
    if (directory && stat.isDirectory()) return `${identity}:${fs.realpathSync(path)}`;
    if (!stat.isFile() && path !== "/dev/null") return null;
    if (stableBefore !== undefined && (stat.mtimeNs >= stableBefore || stat.ctimeNs >= stableBefore)) return null;
    return `${identity}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return "absent";
    return null;
  }
}

function snapshot(paths: readonly Watch[], stableBefore?: bigint): string[] | null {
  const stamps = paths.map(([path, directory]) => metadataStamp(path, directory, stableBefore));
  return stamps.every(stamp => stamp !== null) ? stamps : null;
}
const unchanged = (a: readonly string[] | null, b: readonly string[] | null) => a !== null && b !== null && a.every((stamp, index) => stamp === b[index]) && a.length === b.length;
const absoluteFrom = (base: string, path: string) => isAbsolute(path) ? path : base + sep + path;

function pointer(path: string): string | undefined {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) return;
    const bytes = Buffer.alloc(8193);
    const size = fs.readSync(fd, bytes);
    if (size !== stat.size) return;
    return bytes.subarray(0, size).toString("utf8").replace(/[\r\n]+$/, "");
  } finally { fs.closeSync(fd); }
}

interface GitConfigLookup {
  key: string; environment: string; directory: string; paths: Watch[];
  system: string | undefined; home: string | undefined;
  layout?: { paths: Watch[]; stamps: string[] | null; local: string; worktree: string };
  cached?: CachedConfig;
}
export function configLookup(root: string, gitDir: string | undefined, cwd: string | undefined, env: NodeJS.ProcessEnv, program: string): GitConfigLookup | undefined {
  try {
    const directory = fs.realpathSync(gitDir ? cwd ?? process.cwd() : root);
    const home = env.HOME ? absoluteFrom(directory, env.HOME) : undefined;
    if (!home && !env.GIT_CONFIG_GLOBAL || env.GIT_TEST_ASSUME_DIFFERENT_OWNER !== undefined) return;
    const paths: Watch[] = [];
    const system = /^(?:1|true|yes|on)$/i.test(env.GIT_CONFIG_NOSYSTEM ?? "") ? "" : env.GIT_CONFIG_SYSTEM;
    const key = JSON.stringify(["full", directory, gitDir, program]);
    const environment = JSON.stringify(Object.entries(env).filter(([name]) => name.startsWith("GIT_CONFIG") || ["HOME", "XDG_CONFIG_HOME", "PATH", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_IMPLICIT_WORK_TREE", "GIT_TEST_DEFAULT_HASH", "GIT_TEST_DEFAULT_REF_FORMAT"].includes(name)).sort(([a], [b]) => a.localeCompare(b)));
    const cached = configCache.get(key);
    if (cached && cached.environment === environment && unchanged(cached.stamps, snapshot(cached.paths)))
      return { key, environment, directory, paths, system, home, cached };

    if (program !== "git") paths.push([program]);
    else if (system === undefined) {
      const path = env.PATH?.split(delimiter);
      if (!path?.length) return;
      let executable = false;
      for (const dir of path) {
        if (!isAbsolute(dir)) return;
        const file = join(dir, "git");
        paths.push([file]);
        try { fs.accessSync(file, fs.constants.X_OK); executable = fs.statSync(file).isFile(); } catch { continue; }
        if (executable) break;
      }
      if (!executable) return;
    }
    if (env.GIT_CONFIG_GLOBAL !== undefined) paths.push([absoluteFrom(directory, env.GIT_CONFIG_GLOBAL)]);
    else paths.push([absoluteFrom(home!, ".gitconfig")], [absoluteFrom(env.XDG_CONFIG_HOME ? absoluteFrom(directory, env.XDG_CONFIG_HOME) : absoluteFrom(home!, ".config"), "git/config")]);
    const observed = new Map<string, readonly [Watch, string | null]>();
    const watch = (path: string, directory?: true) => {
      const item: Watch = [path, directory];
      paths.push(item);
      if (!observed.has(path)) observed.set(path, [item, metadataStamp(path, directory)]);
    };
    for (const [file, directory] of [...paths]) if (file === program || file.endsWith("/git")) watch(file, directory);
    let metadata = gitDir && absoluteFrom(directory, gitDir);
    if (!metadata) {
      for (let candidate = directory; ; candidate = dirname(candidate)) {
        const marker = join(candidate, ".git");
        watch(marker, true);
        watch(join(candidate, "HEAD"));
        watch(join(candidate, "objects"), true);
        watch(join(candidate, "refs"), true);
        const stat = fs.statSync(marker, { throwIfNoEntry: false });
        if (stat?.isDirectory()) metadata = marker;
        else if (stat) {
          const target = pointer(marker);
          if (!target?.startsWith("gitdir: ")) return;
          metadata = absoluteFrom(candidate, target.slice(8));
        } else if (fs.existsSync(join(candidate, "HEAD")) && fs.existsSync(join(candidate, "objects"))) metadata = candidate;
        if (metadata) break;
        if (dirname(candidate) === candidate) return;
      }
    }
    const commonFile = absoluteFrom(metadata, "commondir"), head = absoluteFrom(metadata, "HEAD");
    watch(metadata, true); watch(head); watch(commonFile);
    const linked = fs.existsSync(commonFile), common = linked ? pointer(commonFile) : undefined;
    if (linked && !common) return;
    const commonDir = common ? absoluteFrom(metadata, common) : metadata;
    const objects = absoluteFrom(commonDir, "objects"), refs = absoluteFrom(commonDir, "refs");
    watch(commonDir, true); watch(objects, true); watch(refs, true);
    if (!fs.statSync(objects, { throwIfNoEntry: false })?.isDirectory() || !fs.existsSync(head)) return;
    const local = absoluteFrom(commonDir, "config"), worktree = absoluteFrom(metadata, "config.worktree");
    paths.push([local], [worktree]);
    const checks = [...observed.values()], stamps = checks.map(([, stamp]) => stamp);
    const layout = { paths: checks.map(([path]) => path), stamps: stamps.every(stamp => stamp !== null) ? stamps : null, local, worktree };
    return { key, environment, directory, paths, system, home, layout };
  } catch { return; }
}

export type ConfigRow = { scope: string; origin: string; key: string; value: string };
export function parseConfig(listing: string): ConfigRow[] {
  const fields = listing.split("\0");
  if (fields.pop() !== "" || fields.length % 3 !== 0) throw new Error("Tavern could not parse Git's scoped configuration.");
  const rows: ConfigRow[] = [];
  for (let i = 0; i < fields.length; i += 3) {
    const row = fields[i + 2]!, separator = row.indexOf("\n");
    const key = separator < 0 ? row : row.slice(0, separator);
    const value = separator < 0 ? (key.endsWith(".required") ? "true" : "") : row.slice(separator + 1);
    rows.push({ scope: fields[i]!, origin: fields[i + 1]!, key, value });
  }
  return rows;
}

type CachedConfig = { rows: ConfigRow[]; environment: string; paths: Watch[]; stamps: string[]; revision: object };
const configCache = new Map<string, CachedConfig>();

function distinct(paths: Watch[]): Watch[] {
  return [...new Map(paths.map(watch => [watch[0], watch])).values()];
}
function originPaths(rows: readonly ConfigRow[], directory: string, home: string | undefined): Watch[] | undefined {
  const paths: Watch[] = [];
  for (const { origin, key, value } of rows) {
    const file = origin.startsWith("file:") ? absoluteFrom(directory, origin.slice(5)) : undefined;
    if (file?.includes("\uFFFD")) return;
    if (file) paths.push([file]);
    else if (origin !== "command line:") return;
    // onbranch can follow symbolic refs stored outside HEAD, including in reftable.
    if (key.startsWith("includeif.") && key.endsWith(".path") && !/^includeif\.(?:gitdir(?:\/i)?:|hasconfig:remote\.\*\.url:)/.test(key)) return;
    if (key !== "include.path" && !/^includeif\..+\.path$/s.test(key)) continue;
    if (!value) continue;
    if (value.includes("\uFFFD")) return;
    if (value.startsWith("~/") && home) paths.push([absoluteFrom(home, value.slice(2))]);
    else if (value.startsWith("~") || value.startsWith("%(prefix)/")) return;
    else if (isAbsolute(value)) paths.push([value]);
    else if (file) paths.push([absoluteFrom(dirname(file), value)]);
    else return;
  }
  return paths;
}

export function configRead(lookup: GitConfigLookup, system: string, retained: (row: ConfigRow) => boolean) {
  const { layout } = lookup;
  if (!layout) return;
  const hasExpectedOrigins = (rows: readonly ConfigRow[]) => {
    const matches = (origin: string, path: string) => {
      try { return origin.startsWith("file:") && fs.realpathSync(absoluteFrom(lookup.directory, origin.slice(5))) === fs.realpathSync(path); }
      catch { return false; }
    };
    const local = rows.find(row => row.scope === "local"), worktree = rows.find(row => row.scope === "worktree");
    return local && matches(local.origin, layout.local) && (!worktree || matches(worktree.origin, layout.worktree));
  };
  const paths = distinct([...lookup.paths, ...(system ? [[absoluteFrom(lookup.directory, system)] as Watch] : [])]);
  // Same-size writes can share a timestamp tick; age files relative to the read, not its completion.
  const stableBefore = BigInt(Date.now() - 100) * 1_000_000n;
  const before = snapshot(paths, stableBefore);
  return (rows: ConfigRow[]) => {
    const discovered = originPaths(rows, lookup.directory, lookup.home);
    if (!discovered || !hasExpectedOrigins(rows) || !unchanged(layout.stamps, snapshot(layout.paths, stableBefore)) || !unchanged(before, snapshot(paths, stableBefore))) return;
    const watched = distinct([...paths, ...discovered]);
    const stamps = snapshot(watched, stableBefore);
    if (!stamps) return;
    const save = (current: ConfigRow[]) => configCache.set(lookup.key, { rows: current.filter(retained), environment: lookup.environment, paths: watched, stamps, revision: {} });
    const known = new Set(paths.map(([path]) => path));
    if (watched.some(([path]) => !known.has(path))) {
      // Git only reports origins with entries, so discover includes before sampling their contents.
      return (confirmed: ConfigRow[]) => {
        const dependencies = originPaths(confirmed, lookup.directory, lookup.home);
        if (!dependencies || !hasExpectedOrigins(confirmed) || !unchanged(stamps, snapshot(watched, stableBefore))) return;
        const verified = new Set(watched.map(([path]) => path));
        if (dependencies.every(([path]) => verified.has(path))) save(confirmed);
      };
    }
    save(rows);
  };
}
