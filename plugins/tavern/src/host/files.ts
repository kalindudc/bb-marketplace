import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { BLOB_MAX_BYTES, CHUNK_BYTES } from "../host-contract";
import { HostError } from "./registry";

export const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export function decodeChunk(data: string): Buffer {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > CHUNK_BYTES || bytes.toString("base64") !== data) throw new HostError("invalid-chunk", "Use canonical base64 for at most 4 MiB of file bytes.");
  return bytes;
}
export function writeChunk(file: string, offset: number, bytes: Buffer): number {
  if (offset + bytes.length > BLOB_MAX_BYTES) throw new HostError("file-too-large", "Files over 100 MiB cannot move between machines.");
  const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const status = fstatSync(fd);
    if (!status.isFile() || status.nlink !== 1) throw new HostError("invalid-upload", "Uploads must be private regular files.");
    if (offset < status.size) {
      if (offset + bytes.length > status.size) throw new HostError("chunk-offset", "A retried range overlaps the upload's current end.");
      const previous = Buffer.alloc(bytes.length); readSync(fd, previous, 0, previous.length, offset);
      if (!previous.equals(bytes)) throw new HostError("chunk-conflict", "A retried range differs from the bytes already accepted; reconcile this transfer.");
      return status.size;
    }
    if (offset !== status.size) throw new HostError("chunk-offset", `The upload has ${status.size} bytes, not ${offset}; resume from its accepted offset.`);
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at, offset + at);
    return offset + bytes.length;
  } finally { closeSync(fd); }
}
