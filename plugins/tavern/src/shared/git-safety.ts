import { execFile, execFileSync, type ExecFileSyncOptionsWithBufferEncoding, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { basename, delimiter as pathDelimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { configLookup, configRead, parseConfig, type ConfigRow } from "./git-config-cache";

const exec = promisify(execFile);
type Entry = [key: string, value: string];
export type GitKind = "full" | "porcelain";
export interface GitMetadata { gitDir: string; commonDir: string }
interface Options {
  kind?: GitKind;
  extra?: Record<string, string>;
  gitDir?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  privateIndex?: string;
  metadata?: GitMetadata | null;
  readOnly?: boolean;
  childGit?: boolean;
  networkRemote?: boolean;
}

const pinned: Entry[] = [
  ["core.fsmonitor", "false"], ["core.hooksPath", "/dev/null"],
  ["commit.gpgSign", "false"], ["tag.gpgSign", "false"], ["push.gpgSign", "false"], ["log.showSignature", "false"],
  ["core.pager", "cat"], ["core.editor", ":"], ["sequence.editor", ":"],
  ["gc.auto", "0"], ["maintenance.auto", "false"], ["submodule.recurse", "false"], ["push.recurseSubmodules", "no"],
  ["fetch.uriProtocols", ""], ["transfer.bundleURI", "false"],
];
const removed = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG", "GIT_EXTERNAL_DIFF"];
const allowed = new Set(["GIT_INDEX_FILE", "GIT_LITERAL_PATHSPECS", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE", "GIT_NO_REPLACE_OBJECTS"]);

function appendConfig(env: NodeJS.ProcessEnv, entries: Entry[]) {
  const first = Number(env.GIT_CONFIG_COUNT ?? "0");
  if (!Number.isSafeInteger(first) || first < 0 || first + entries.length > 4096)
    throw new Error("Tavern cannot safely extend the inherited Git config count.");
  for (const [index, [key, value]] of entries.entries()) {
    env[`GIT_CONFIG_KEY_${first + index}`] = key;
    env[`GIT_CONFIG_VALUE_${first + index}`] = value;
  }
  env.GIT_CONFIG_COUNT = String(first + entries.length);
}

function baseEnvironment(root: string, options: Options): NodeJS.ProcessEnv {
  const { extra } = options;
  for (const key of Object.keys(extra ?? {})) {
    if (key.startsWith("GIT_") && !allowed.has(key)) throw new Error(`Tavern does not allow ${key} in a Git caller's environment.`);
  }
  const env = { ...process.env };
  for (const key of removed) delete env[key];
  Object.assign(env, extra, { GIT_OPTIONAL_LOCKS: "0" });
  if (!options.childGit) Object.assign(env, {
    PWD: root, LC_ALL: "C", GIT_PRINT_SHA1_ELLIPSIS: "no", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: options.networkRemote ? "git:http:https:ssh" : "file:git:http:https:ssh", GIT_PAGER: "cat", GIT_EDITOR: ":", GIT_SEQUENCE_EDITOR: ":",
  });
  appendConfig(env, pinned);
  return env;
}

const credential = /^credential(?:\..*)?\.helper$/s;
const filterProgram = /^filter\.(.+)\.(clean|smudge|process)$/s;
const program = /^(?:core\.(?:sshcommand|askpass|gitproxy|alternaterefscommand)|diff\.external|diff\..*\.(?:command|textconv)|merge\..*\.driver|gpg(?:\..*)?\.program|gpg\.ssh\.defaultkeycommand)$/s;
const packProgram = /^remote\..+\.(?:uploadpack|receivepack)$/s;
const hookProgram = /^hook\..+\.(?:command|event|enabled)$/s;
const protectedRow = ({ key }: ConfigRow) => key === "core.worktree" || credential.test(key) || filterProgram.test(key)
  || /^filter\..+\.required$/s.test(key) || program.test(key) || packProgram.test(key) || hookProgram.test(key);
const packOverrides = new WeakMap<NodeJS.ProcessEnv, Map<string, string>>();
const neutral: Record<string, string> = { "core.sshcommand": "ssh", "core.alternaterefscommand": ":" };
function checkoutRoot(cwd: string) {
  for (let path = resolve(cwd); ; path = dirname(path)) {
    if (fs.existsSync(join(path, ".git"))) return path;
    if (dirname(path) === path) return cwd;
  }
}
function executableOnHostPath(tool: string) {
  for (const dir of (process.env.PATH ?? "").split(pathDelimiter)) {
    if (!isAbsolute(dir)) continue;
    const path = join(dir, tool);
    try {
      fs.accessSync(path, fs.constants.X_OK);
      if (fs.statSync(path).isFile()) return { path, resolved: fs.realpathSync(path) };
    } catch { continue; }
  }
}
const quoteExecutable = (path: string) => '"' + path.replace(/["\\$`]/g, c => "\\" + c) + '"';
function canonicalFilter(driver: string, repository: Map<string, string>): Map<string, string> {
  const key = (name: string) => `filter.${driver}.${name}`;
  if (repository.get(key("required")) !== "true") return new Map();
  if (driver === "lfs") {
    const commands = [["clean", "clean -- %f"], ["smudge", "smudge -- %f"], ["process", "filter-process"]] as const;
    if (commands.every(([name, args]) => repository.get(key(name)) === "git-lfs " + args)) {
      const bin = executableOnHostPath("git-lfs");
      if (bin) return new Map(commands.map(([name, args]) => [key(name), quoteExecutable(bin.resolved) + " " + args]));
    }
  }
  const crypt = /^git-crypt(?:-([a-zA-Z0-9_-]+))?$/.exec(driver);
  if (crypt && !repository.has(key("process")) && ["clean", "smudge"].every(name => repository.get(key(name))?.startsWith('"/'))) {
    const bin = executableOnHostPath("git-crypt"), suffix = crypt[1] ? ` --key-name=${crypt[1]}` : "";
    if (bin && [bin.path, bin.resolved].some(path => ["clean", "smudge"].every(name => repository.get(key(name)) === quoteExecutable(path) + " " + name + suffix))) {
      return new Map(["clean", "smudge"].map(name => [key(name), quoteExecutable(bin.resolved) + " " + name + suffix]));
    }
  }
  return new Map();
}
function protectRepository(env: NodeJS.ProcessEnv, rows: readonly ConfigRow[], root: string, options: Options) {
  const trusted: Entry[] = [], repository = new Map<string, string>(), firstPack = new Map<string, string>(), hooks = new Set<string>();
  for (const { scope, key, value } of rows) {
    if (hookProgram.test(key)) hooks.add(key.slice(0, key.lastIndexOf(".")) + ".enabled");
    if (packProgram.test(key) && !firstPack.has(key)) firstPack.set(key, scope);
    if (scope === "system" || scope === "global") trusted.push([key, value]);
    else if (scope === "local" || scope === "worktree") repository.set(key, value);
  }
  const last = new Map(trusted), entries: Entry[] = [], drivers = new Map<string, Map<string, string>>();
  for (const key of repository.keys()) {
    const filter = filterProgram.exec(key);
    if (key === "core.worktree" && !options.gitDir && !options.childGit) {
      // Repository setup reads core.worktree before Git applies environment config entries.
      env.GIT_WORK_TREE = checkoutRoot(root);
      entries.push([key, env.GIT_WORK_TREE]);
    } else if (filter) {
      const driver = filter[1]!;
      if (!drivers.has(driver)) drivers.set(driver, canonicalFilter(driver, repository));
      entries.push([key, drivers.get(driver)?.get(key) ?? last.get(key) ?? ""]);
    } else if (program.test(key)) entries.push([key, last.get(key) ?? neutral[key] ?? ""]);
  }
  for (const key of hooks) entries.push([key, "false"]);
  if ([...repository.keys()].some(key => credential.test(key))) {
    // A matching URL-specific reset clears the whole helper list, not just helpers for that URL.
    entries.push(["credential.helper", ""], ...trusted.filter(([key]) => credential.test(key)));
  }
  if (!options.childGit && repository.has("core.gitproxy") && env.GIT_PROXY_COMMAND === undefined) {
    // Git uses the first matching proxy, so an environment config entry cannot override it.
    const proxy = trusted.find(([key]) => key === "core.gitproxy")?.[1];
    if (proxy?.includes(" for ")) throw new Error("Tavern cannot safely use a repository Git proxy with domain-specific user Git proxies.");
    env.GIT_PROXY_COMMAND = proxy || "";
  }
  if (!options.childGit) {
    const packs = new Map<string, string>();
    for (const [key, scope] of firstPack) if (scope === "local" || scope === "worktree") {
      const fallback = key.endsWith(".uploadpack") ? "git-upload-pack" : "git-receive-pack";
      packs.set(key, trusted.find(([entry]) => entry === key)?.[1] ?? fallback);
    }
    if (packs.size) packOverrides.set(env, packs);
  }
  appendConfig(env, entries);
}

function subcommandIndex(args: readonly string[]) {
  let at = 0;
  for (;;) {
    const arg = args[at];
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") at += 2;
    else if (arg?.startsWith("--work-tree=") || arg?.startsWith("--git-dir=")) at++;
    else return at;
  }
}
function packArguments(args: readonly string[], env: NodeJS.ProcessEnv): readonly string[] {
  const packs = packOverrides.get(env);
  if (!packs) return args;
  const at = subcommandIndex(args), command = args[at], operands = args.slice(at + 1);
  const upload = command === "fetch" || command === "ls-remote" && !operands.includes("--get-url");
  if (!upload && command !== "push") return args;
  const end = operands.indexOf("--"), remote = end >= 0 ? operands[end + 1] : operands.find(value => !value.startsWith("-"));
  if (!remote) return args;
  const value = packs.get(`remote.${remote}.${upload ? "uploadpack" : "receivepack"}`);
  if (!value) return args;
  // Git takes the first remote pack setting; adding a command-scope config entry would not override it.
  return [...args.slice(0, at + 1), `--${upload ? "upload-pack" : "receive-pack"}=${value}`, ...operands];
}
export function gitArguments(args: readonly string[], kind: GitKind = "full"): string[] {
  if (kind === "porcelain") return [...args];
  const at = subcommandIndex(args), subcommand = args[at], rest = args.slice(at + 1), guards: string[] = [];
  if (["diff", "show", "log", "diff-files", "diff-index"].includes(subcommand!)) guards.push("--no-ext-diff", "--no-textconv", "--submodule=short");
  const delimiter = rest.indexOf("--");
  const optionEnd = delimiter < 0 ? rest.length : delimiter;
  if (subcommand === "status" || ["diff", "diff-files", "diff-index"].includes(subcommand!) && !rest.slice(0, optionEnd).some(arg => ["--cached", "--staged", "--no-index"].includes(arg))) {
    rest.splice(optionEnd, 0, "--ignore-submodules=dirty");
  }
  if (subcommand === "push") guards.push("--no-recurse-submodules");
  return subcommand ? [...args.slice(0, at + 1), ...guards, ...rest] : [...args];
}

export interface GitInvocation { file: string; args: string[]; outsideMetadataDenied?: true }
export function gitContainmentStderr(command: GitInvocation | undefined, stderr: string): string {
  return command?.outsideMetadataDenied && /operation not permitted|permission denied|read-only file system/i.test(stderr)
    ? stderr.trimEnd() + "\nTavern did not grant writes to outside Git metadata because it is not a standard linked worktree.\n"
    : stderr;
}
const sandboxExec = "/usr/bin/sandbox-exec";
const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
function gitSandbox(): string | undefined {
  if (os.platform() !== "darwin") return;
  if (!fs.existsSync(sandboxExec)) throw new Error("Tavern cannot run Git on macOS because sandbox-exec is unavailable.");
  return sandboxExec;
}
function wrapGit(file: string | undefined, args: readonly string[], directories: string[] = [], files: string[] = [], network = false): GitInvocation {
  if (!file) return { file: "git", args: [...args] };
  const profile = ["(version 1)", "(allow default)", "(deny file-write*)",
    `(allow file-write* ${[...new Set(directories)].map(subpath).join(" ")} ${[...new Set(["/dev/null", "/dev/stdout", "/dev/stderr", ...files])].map(literal).join(" ")} (subpath "/dev/fd") (regex #"^/dev/tty[^/]*$"))`,
    ...(network ? [] : ["(deny network*)"]),
  ].join("\n");
  return { file, args: ["-p", profile, "git", ...args] };
}
function gitRead(root: string, args: string[], options: Options, env: NodeJS.ProcessEnv) {
  return {
    command: wrapGit(gitSandbox(), [...(options.gitDir ? ["--git-dir", options.gitDir] : ["-C", root]), ...args]),
    options: { cwd: options.cwd, env, encoding: "utf8" as const, timeout: Math.min(options.timeoutMs ?? 3000, 3000), maxBuffer: 8 * 1024 * 1024 },
  };
}
const configList = ["config", "--list", "--show-origin", "--show-scope", "-z"];
const systemConfig = ["var", "GIT_CONFIG_SYSTEM"];

function systemPath(output: string): string | undefined {
  const value = output.replace(/\n$/, "");
  return isAbsolute(value) && !value.includes("\n") ? value : undefined;
}

export function gitConfigRevision(root: string, options: Options = {}): object | undefined {
  if (options.kind !== "porcelain") return configLookup(root, options.gitDir, options.cwd, baseEnvironment(root, options))?.cached?.revision;
}

function writeRoots(root: string, options: Options) {
  const checkout = fs.realpathSync(options.gitDir ?? (options.metadata ? root : checkoutRoot(root)));
  if (options.metadata) {
    const { gitDir, commonDir } = options.metadata;
    if (fs.realpathSync(gitDir) !== gitDir || fs.realpathSync(commonDir) !== commonDir)
      throw new Error("Tavern refused Git because its recorded metadata paths are no longer canonical.");
    return { checkout, discover: false, local: options.metadata };
  }
  const metadata = options.gitDir ? checkout : join(checkout, ".git");
  // Ordinary .git directories are already inside the checkout. Only separately located metadata needs another grant.
  const stat = fs.lstatSync(metadata, { throwIfNoEntry: false });
  const discover = stat !== undefined && (!stat.isDirectory() || fs.existsSync(join(metadata, "commondir")));
  const gitDir = stat?.isDirectory() ? metadata : checkout;
  return { checkout, discover, local: { gitDir, commonDir: gitDir } };
}
function metadataRead(root: string, options: Options, env: NodeJS.ProcessEnv) {
  const sanitized = { ...env };
  delete sanitized.GIT_INDEX_FILE;
  return gitRead(root, ["rev-parse", "--git-dir", ...(options.kind === "porcelain" ? [] : ["--git-common-dir"])], options, sanitized);
}
function metadataPaths(output: string, root: string, options: Options): GitMetadata {
  const paths = output.replace(/\n$/, "").split("\n");
  if (paths.length !== (options.kind === "porcelain" ? 1 : 2) || paths.some(path => !path))
    throw new Error("Tavern could not establish Git's metadata write paths.");
  const [gitDir, commonDir = gitDir] = paths.map(path => fs.realpathSync(resolve(options.gitDir ? options.cwd ?? root : root, path)));
  return { gitDir: gitDir!, commonDir: commonDir! };
}
function reciprocalWorktree(checkout: string, { gitDir, commonDir }: GitMetadata) {
  const worktrees = dirname(gitDir), gitfile = join(checkout, ".git"), backlink = join(gitDir, "gitdir");
  if (basename(worktrees) !== "worktrees" || dirname(worktrees) !== commonDir || !fs.lstatSync(gitfile, { throwIfNoEntry: false })?.isFile()) return false;
  try {
    const fd = fs.openSync(backlink, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size === 0 || stat.size > 8192) return false;
      const bytes = Buffer.alloc(8193), size = fs.readSync(fd, bytes);
      const path = bytes.subarray(0, size).toString("utf8").replace(/\r?\n$/, "");
      return size <= 8192 && fs.realpathSync(resolve(gitDir, path)) === gitfile;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}
function containedCommand(file: string, root: string, argv: readonly string[], checkout: string, metadata: GitMetadata, options: Options): GitInvocation {
  const outside = [metadata.gitDir, metadata.commonDir].filter(path => path !== checkout && !path.startsWith(checkout + sep));
  const outsideMetadataDenied = outside.length > 0 && !reciprocalWorktree(checkout, metadata);
  const directories = outsideMetadataDenied ? [checkout] : [checkout, ...outside];
  const subcommand = argv[subcommandIndex(argv)], network = subcommand === "fetch" || subcommand === "push" || subcommand === "ls-remote";
  const files: string[] = [];
  if (options.privateIndex) {
    const absolute = resolve(root, options.privateIndex), index = join(fs.realpathSync(dirname(absolute)), basename(absolute));
    files.push(index, index + ".lock");
  }
  if (network) files.push(join(fs.realpathSync(os.homedir()), ".ssh", "known_hosts"));
  if (directories.some(path => dirname(path) === path)) throw new Error("Tavern cannot give Git write access to the filesystem root.");
  return { ...wrapGit(file, argv, directories, files, network), ...(outsideMetadataDenied ? { outsideMetadataDenied: true } : {}) };
}
export async function gitInvocation(root: string, args: readonly string[], env: NodeJS.ProcessEnv, options: Options = {}): Promise<GitInvocation> {
  args = packArguments(args, env);
  const file = gitSandbox();
  if (!file || options.readOnly || args[subcommandIndex(args)] === "rev-parse") return wrapGit(file, args);
  const { checkout, discover, local } = writeRoots(root, options);
  let metadata = local;
  if (discover) {
    const read = metadataRead(root, options, env);
    const { stdout } = await exec(read.command.file, read.command.args, { ...read.options, signal: options.signal });
    metadata = metadataPaths(stdout, root, options);
  }
  return containedCommand(file, root, args, checkout, metadata, options);
}
function gitInvocationSync(root: string, args: readonly string[], env: NodeJS.ProcessEnv, options: Options): GitInvocation {
  args = packArguments(args, env);
  const file = gitSandbox();
  if (!file || options.readOnly || args[subcommandIndex(args)] === "rev-parse") return wrapGit(file, args);
  const { checkout, discover, local } = writeRoots(root, options);
  let metadata = local;
  if (discover) {
    const read = metadataRead(root, options, env);
    const stdout = execFileSync(read.command.file, read.command.args, { ...read.options, stdio: ["ignore", "pipe", "pipe"] });
    metadata = metadataPaths(stdout, root, options);
  }
  return containedCommand(file, root, args, checkout, metadata, options);
}

type SyncOptions = Options & { timeout: number };
export function execGitSync(root: string, args: readonly string[], options: SyncOptions & ExecFileSyncOptionsWithStringEncoding): string;
export function execGitSync(root: string, args: readonly string[], options: SyncOptions & ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function execGitSync(root: string, args: readonly string[], options: SyncOptions & (ExecFileSyncOptionsWithStringEncoding | ExecFileSyncOptionsWithBufferEncoding)): string | Buffer {
  const env = gitEnvironmentSync(root, { ...options, timeoutMs: options.timeout });
  const prefix = options.gitDir ? ["--git-dir", options.gitDir] : ["-C", root];
  const command = gitInvocationSync(root, [...prefix, ...gitArguments(args, options.kind)], env, options);
  try {
    return options.encoding && options.encoding !== "buffer"
      ? execFileSync(command.file, command.args, { ...options, encoding: options.encoding, env })
      : execFileSync(command.file, command.args, { ...options, encoding: null, env });
  } catch (error) {
    const failure = error as Error & { stderr?: string | Buffer };
    const stderr = failure.stderr?.toString();
    if (stderr) {
      const explained = gitContainmentStderr(command, stderr);
      if (explained !== stderr) {
        failure.message += "\n" + explained.slice(stderr.trimEnd().length).trim();
        failure.stderr = typeof failure.stderr === "string" ? explained : Buffer.from(explained);
      }
    }
    throw error;
  }
}
export async function gitEnvironment(root: string, options: Options = {}): Promise<NodeJS.ProcessEnv> {
  const env = baseEnvironment(root, options);
  if (options.kind === "porcelain") return env;
  if (options.signal?.aborted) options.signal.throwIfAborted();
  const lookup = configLookup(root, options.gitDir, options.cwd, env);
  const read = async (args: string[]) => {
    const call = gitRead(root, args, options, env);
    return (await exec(call.command.file, call.command.args, { ...call.options, signal: options.signal })).stdout;
  };
  let rows = lookup?.cached?.rows;
  if (!rows) {
    const system = lookup && (lookup.system ?? systemPath(await read(systemConfig).catch(error => {
      if (typeof error.code !== "number") throw error;
      return "";
    })));
    const complete = lookup && system !== undefined ? configRead(lookup, system, protectedRow) : undefined;
    rows = parseConfig(await read(configList));
    const confirm = complete?.(rows);
    if (confirm) { rows = parseConfig(await read(configList)); confirm(rows); }
  }
  protectRepository(env, rows, root, options);
  return env;
}
export function gitEnvironmentSync(root: string, options: Options = {}): NodeJS.ProcessEnv {
  const env = baseEnvironment(root, options);
  if (options.kind === "porcelain") return env;
  const lookup = configLookup(root, options.gitDir, options.cwd, env);
  const read = (args: string[]) => {
    const call = gitRead(root, args, options, env);
    return execFileSync(call.command.file, call.command.args, { ...call.options, stdio: ["ignore", "pipe", "pipe"] });
  };
  let rows = lookup?.cached?.rows;
  if (!rows) {
    let system = lookup?.system;
    if (lookup && system === undefined) {
      try { system = systemPath(read(systemConfig)); }
      catch (error) { if (typeof (error as { status?: number }).status !== "number") throw error; }
    }
    const complete = lookup && system !== undefined ? configRead(lookup, system, protectedRow) : undefined;
    rows = parseConfig(read(configList));
    const confirm = complete?.(rows);
    if (confirm) { rows = parseConfig(read(configList)); confirm(rows); }
  }
  protectRepository(env, rows, root, options);
  return env;
}
