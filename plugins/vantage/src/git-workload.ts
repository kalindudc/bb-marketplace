import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SIDE_LIMIT = 1024 * 1024;
export const COUNT_BYTES = 8 * SIDE_LIMIT;
export const COUNT_PATHS = 128;
export const FOLDER_SCAN_LIMIT = 512;
const BINARY_SNIFF_BYTES = 8000;

export const DIFF_FLAGS = [
  "--no-renames",
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules=all",
  "--no-color",
  "--no-relative",
] as const;
export const literal = (path: string): string => `:(literal)${path}`;
export const regularMode = (mode: string): boolean => mode === "100644" || mode === "100755";
export const isText = (content: Buffer): boolean => !content.subarray(0, BINARY_SNIFF_BYTES).includes(0);

export interface RawChange {
  path: string;
  code: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
}

export function parseRaw(output: string): RawChange[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new Error("Git returned incomplete change metadata");
  const parts = output.slice(0, -1).split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const entry = /^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([ADMTUX])$/.exec(parts[i]!);
    const path = parts[i + 1];
    if (entry === null || !path) throw new Error("Git returned invalid change metadata");
    changes.push({
      path,
      code: entry[5]!,
      oldMode: entry[1]!,
      newMode: entry[2]!,
      oldOid: entry[3]!,
      newOid: entry[4]!,
    });
  }
  return changes;
}

export function parseCheckoutStatus(output: string): {
  head: string | null | undefined;
  untracked: string[];
  tracked: RawChange[];
  indexIds: string[];
  needsRawDiff: boolean;
} {
  const untracked: string[] = [];
  const tracked: RawChange[] = [];
  const indexIds: string[] = [];
  let needsRawDiff = false;
  let head: string | null | undefined;
  if (output !== "" && !output.endsWith("\0")) throw new Error("Git returned incomplete checkout status");
  for (const row of output.split("\0")) {
    if (row.startsWith("# branch.oid ")) {
      const oid = row.slice(13);
      head = oid === "(initial)" ? null : oid;
      continue;
    }
    if (row === "" || row.startsWith("# ")) continue;
    if (row.startsWith("? ")) {
      untracked.push(row.slice(2));
      continue;
    }
    if (row.startsWith("u ")) {
      needsRawDiff = true;
      continue;
    }
    const match =
      /^1 ([.ADMT]{2}) (N\.\.\.|S[.C][.M][.U]) (\d{6}) (\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) (.+)$/s.exec(
        row,
      );
    if (match === null) throw new Error("Git returned invalid checkout status");
    const xy = match[1]!,
      oldMode = match[3]!,
      indexMode = match[4]!,
      newMode = match[5]!;
    const oldOid = match[6]!,
      indexOid = match[7]!,
      path = match[8]!;
    if (match[2] !== "N...") needsRawDiff = true;
    if (oldMode === "000000" && newMode === "000000") continue;
    // With both staged and unstaged changes, the working file may match HEAD again.
    if (xy[0] !== "." && xy[1] !== "." && oldMode !== "000000" && newMode !== "000000") needsRawDiff = true;
    const code =
      newMode === "000000" ? "D" : oldMode === "000000" ? "A" : oldMode.slice(0, 3) === newMode.slice(0, 3) ? "M" : "T";
    tracked.push({ path, code, oldMode, newMode, oldOid, newOid: "0" });
    if (indexMode !== "000000" && !regularMode(indexMode)) needsRawDiff = true;
    if (!/^0+$/.test(indexOid)) indexIds.push(indexOid);
  }
  return { head, untracked, tracked, indexIds, needsRawDiff };
}

// ENOTDIR: a folder on the path became a file, so nothing can exist below it.
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export class UnsafeWorkingPath extends Error {
  constructor(options?: ErrorOptions) {
    super("The working file path contains a symbolic link", options);
  }
}

async function openWorkingFile(root: string, path: string) {
  const full = join(root, path);
  const parent = dirname(full);
  try {
    if ((await realpath(parent)) !== parent) throw new UnsafeWorkingPath();
    return await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof UnsafeWorkingPath) throw error;
    if (error instanceof Error && "code" in error && error.code === "ELOOP")
      throw new UnsafeWorkingPath({ cause: error });
    throw new Error("A working file could not be opened safely", { cause: error });
  }
}

export async function workingSize(root: string, path: string): Promise<number | null> {
  const handle = await openWorkingFile(root, path);
  if (handle === null) return null;
  try {
    const info = await handle.stat();
    if (info.isDirectory()) return null;
    if (!info.isFile()) throw new Error("A working file is not a regular file");
    return info.size;
  } finally {
    await handle.close();
  }
}

export async function readWorkingFile(
  root: string,
  path: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer | null; tooLarge: boolean }> {
  signal?.throwIfAborted();
  const handle = await openWorkingFile(root, path);
  if (handle === null) return { bytes: null, tooLarge: false };
  try {
    const info = await handle.stat();
    if (info.isDirectory()) return { bytes: null, tooLarge: false };
    if (!info.isFile()) throw new Error("A working file is not a regular file");
    if (info.size > limit) return { bytes: null, tooLarge: true };
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > info.size) return { bytes: null, tooLarge: true };
    return { bytes: buffer.subarray(0, total), tooLarge: false };
  } finally {
    await handle.close();
  }
}

export async function scanFolder(
  root: string,
  folder: string,
  limit: number,
  signal: AbortSignal,
): Promise<{ paths: string[]; visits: number; partial: boolean; repository: boolean }> {
  const paths: string[] = [];
  const pending = [folder.replace(/\/$/, "")];
  let visits = 0;
  let partial = false;
  while (pending.length > 0 && visits < limit) {
    signal.throwIfAborted();
    const dir = pending.shift()!;
    visits++;
    const full = join(root, dir);
    if ((await realpath(full)) !== full) throw new Error("An untracked folder is a symbolic link");
    try {
      await lstat(join(full, ".git"));
      return { paths, visits, partial: true, repository: true };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const handle = await opendir(full, { bufferSize: 16 });
    try {
      while (visits < limit) {
        signal.throwIfAborted();
        const entry = await handle.read();
        if (entry === null) break;
        visits++;
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) pending.push(path);
        else paths.push(path);
      }
      if (visits === limit) partial = true;
    } finally {
      await handle.close();
    }
  }
  return { paths: paths.sort(), visits, partial: partial || pending.length > 0, repository: false };
}
