import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Fn = (...args: any[]) => any;
export interface FilesystemIsolation { root: string; realHome: string; readRoots: string[] }
export function installFilesystemGuard(options: FilesystemIsolation, violation: (message: string) => void) {
  const original = Object.fromEntries(Object.entries(fs).filter(([, value]) => typeof value === "function")) as Record<string, Fn>;
  const descriptors = new Map<number, string>();
  const undo: (() => void)[] = [];
  const within = (path: string, root: string) => { const rest = relative(root, path); return !rest || rest !== ".." && !rest.startsWith(".." + sep) && !isAbsolute(rest); };
  const canonical = (path: string, depth = 0): string => {
    if (depth > 40) throw new Error("Test filesystem symlink loop");
    const absolute = resolve(path), base = parse(absolute).root, parts = absolute.slice(base.length).split(sep).filter(Boolean);
    let current = base;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      try {
        if (original.lstatSync!(current).isSymbolicLink()) return canonical(join(resolve(dirname(current), original.readlinkSync!(current)), ...parts.slice(i + 1)), depth + 1);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        return join(current, ...parts.slice(i + 1));
      }
    }
    return current;
  };
  const root = canonical(options.root), realHome = canonical(options.realHome), readRoots = options.readRoots.map(path => canonical(path));
  const reject = (operation: string, path: unknown): never => {
    const message = `Tavern test filesystem escape: ${operation} ${String(path)}`;
    violation(message); throw Object.assign(new Error(message), { code: "EACCES" });
  };
  const check = (value: any, write: boolean, follow = true, contents = false): string | undefined => {
    if (typeof value === "number") {
      if (value >= 0 && value <= 2) return;
      const path = descriptors.get(value); if (!path) return reject("unknown descriptor", value);
      return check(path, write, follow, contents);
    }
    if (value && typeof value.fd === "number") return check(value.fd, write, follow, contents);
    const path = resolve(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);
    const actual = follow ? canonical(path) : join(canonical(dirname(path)), parse(path).base);
    if (write ? !within(actual, root) : within(actual, realHome) && !within(actual, root) && !readRoots.some(dir => within(actual, dir))) reject(write ? "write" : "read", path);
    if (contents) {
      try { if (original.statSync!(actual).isFile() && original.statSync!(actual).nlink > 1) reject("write through hard link", path); }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    return actual;
  };
  const replace = (target: Record<string, any>, name: string, factory: (fn: Fn) => Fn) => {
    if (typeof target[name] !== "function") return;
    const fn = target[name] as Fn, wrapped = Object.assign(factory(fn), fn);
    if (typeof (fn as any).native === "function") (wrapped as any).native = factory((fn as any).native);
    target[name] = wrapped; undo.push(() => { target[name] = fn; });
  };
  const namespaces = [fs as unknown as Record<string, any>, fs.promises as unknown as Record<string, any>];
  for (const api of namespaces) {
    const promise = api === fs.promises;
    const wrap = (name: string, validate: (args: any[]) => void) => replace(api, name, fn => promise
      ? async (...args) => { validate(args); return fn(...args); }
      : (...args) => { validate(args); return fn(...args); });
    const each = (names: string[], validate: (args: any[]) => void) => {
      for (const name of names) { wrap(name, validate); if (!promise) wrap(name + "Sync", validate); }
    };
    each(["access", "exists", "readFile", "readdir", "opendir", "stat", "lstat", "statfs", "realpath", "readlink", "watch", "watchFile"], args => { check(args[0], false); });
    each(["appendFile", "writeFile", "truncate"], args => { check(args[0], true, true, true); });
    each(["mkdir", "mkdtemp", "chmod", "chown", "utimes"], args => { check(args[0], true); });
    each(["rm", "rmdir", "unlink", "lchmod", "lchown", "lutimes"], args => { check(args[0], true, false); });
    each(["rename"], args => { check(args[0], true, false); check(args[1], true, false); });
    each(["copyFile"], args => { check(args[0], false); check(args[1], true, true, true); });
    const copy = (fn: Fn) => (...args: any[]) => {
      check(args[0], false); check(args[1], true, true, true);
      const options = typeof args[2] === "function" ? undefined : args[2];
      if (options !== undefined && (!options || typeof options !== "object")) return fn(...args);
      const guarded = { ...options, filter: (source: string, target: string) => {
        check(source, false); check(target, true, true, true);
        return options?.filter ? options.filter(source, target) : true;
      } };
      if (typeof args[2] === "function") args.splice(2, 0, guarded); else args[2] = guarded;
      return fn(...args);
    };
    replace(api, "cp", fn => promise ? async (...args) => copy(fn)(...args) : copy(fn));
    if (!promise) replace(api, "cpSync", copy);
    each(["link"], args => { check(args[0], true); check(args[1], true, false); });
    each(["symlink"], args => { check(args[1], true, false); });
    each(["read", "readv", "fstat"], args => { check(args[0], false); });
    each(["write", "writev", "fchmod", "fchown", "ftruncate", "futimes", "fsync", "fdatasync"], args => { check(args[0], true, true, true); });
    const writable = (flags: string | number = "r") => typeof flags === "number" ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(flags);
    replace(api, "open", fn => promise ? async (...args) => {
      const write = writable(args[1]), path = check(args[0], write, true, write)!;
      const handle = await fn(...args); descriptors.set(handle.fd, path);
      const close = handle.close.bind(handle); handle.close = async () => { const fd = handle.fd; try { return await close(); } finally { descriptors.delete(fd); } };
      return handle;
    } : (...args) => {
      const write = writable(args[1]), path = check(args[0], write, true, write)!, callback = args[args.length - 1];
      args[args.length - 1] = (error: unknown, fd: number) => { if (!error) descriptors.set(fd, path); callback(error, fd); };
      return fn(...args);
    });
    if (!promise) {
      replace(api, "openSync", fn => (...args) => { const write = writable(args[1]), path = check(args[0], write, true, write)!, fd = fn(...args); descriptors.set(fd, path); return fd; });
      for (const [name, write] of [["createReadStream", false], ["createWriteStream", true]] as const) replace(api, name, fn => (...args) => { check(args[1]?.fd ?? args[0], write, true, write); return fn(...args); });
      for (const name of ["close", "closeSync"]) replace(api, name, fn => (...args) => { descriptors.delete(args[0]); return fn(...args); });
    }
  }
  syncBuiltinESMExports();
  return () => { for (const restore of undo.reverse()) restore(); syncBuiltinESMExports(); };
}
