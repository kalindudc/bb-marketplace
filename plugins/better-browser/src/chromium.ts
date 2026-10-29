import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Priority, SameSite, SourceCookie, SourceScheme } from "./cookies";

const AES_CBC_IV = Buffer.alloc(16, 0x20);
const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
/** From this Cookies schema version on, Chromium prefixes each plaintext with SHA-256 of the cookie's host. */
const DOMAIN_BOUND_SCHEMA_VERSION = 24;

/** macOS Chromium browsers derive the cookie key from their "<Browser> Safe Storage" Keychain password. */
export function deriveMacKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/**
 * Linux Chromium browsers derive it the same way, except PBKDF2 runs one round instead of 1003, the password comes
 * from the Secret Service or KWallet (or the hardcoded "peanuts" of the basic store), and v11 means keyring-sourced
 * rather than a different cipher: Linux encrypts both v10 and v11 with AES-128-CBC.
 */
export function deriveLinuxKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
}

const PREFIXES = new Set(["v10", "v11"]);

export function decryptValue(encrypted: Uint8Array, key: Buffer, host: string, schemaVersion: number): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length === 0) return "";
  if (!PREFIXES.has(buffer.subarray(0, 3).toString("latin1"))) return null;
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, AES_CBC_IV);
    plaintext = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
  if (schemaVersion >= DOMAIN_BOUND_SCHEMA_VERSION) {
    const expected = createHash("sha256").update(host).digest();
    if (plaintext.length < 32 || !plaintext.subarray(0, 32).equals(expected)) return null;
    plaintext = plaintext.subarray(32);
  }
  return plaintext.toString("utf8");
}

/** The inverse of decryptValue, for tests and fixtures. */
export function encryptValue(value: string, key: Buffer, host: string, schemaVersion: number, prefix: "v10" | "v11" = "v10"): Buffer {
  const body = schemaVersion >= DOMAIN_BOUND_SCHEMA_VERSION
    ? Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value, "utf8")])
    : Buffer.from(value, "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, AES_CBC_IV);
  return Buffer.concat([Buffer.from(prefix, "latin1"), cipher.update(body), cipher.final()]);
}

const SAME_SITE: Record<number, SameSite> = { 0: "None", 1: "Lax", 2: "Strict" };
const PRIORITY: Record<number, Priority> = { 0: "Low", 1: "Medium", 2: "High" };
const SOURCE_SCHEME: Record<number, SourceScheme> = { 0: "Unset", 1: "NonSecure", 2: "Secure" };

interface Row {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array | null;
  path: string;
  /** Seconds since 1601; SQLite divides, because the stored microseconds overflow a JavaScript number. */
  expires_seconds: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  persistent: number;
  priority: number;
  source_scheme: number;
  source_port: number;
  partitioned: number;
}

export interface ChromiumRead {
  cookies: SourceCookie[];
  /** Cookies the plugin could not decrypt. */
  undecryptable: number;
  /** Partitioned (CHIPS) cookies, which are left out like bb's own import leaves them out. */
  partitioned: number;
}

export function schemaVersion(database: DatabaseSync): number {
  const row = database.prepare("select value from meta where key = 'version'").get() as { value?: unknown } | undefined;
  const version = Number(row?.value);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("The Cookies database has no schema version");
  return version;
}

/** True when any cookie value is encrypted, so the platform's Safe Storage key is needed. */
export function needsKey(database: DatabaseSync): boolean {
  return database.prepare("select 1 from cookies where substr(encrypted_value, 1, 3) in (x'763130', x'763131') limit 1").get() !== undefined;
}

/**
 * A handful of stored ciphertexts to test candidate keys against, so the wrong key source is never silently chosen.
 * Each sample keeps the host its cookie belongs to, because the plaintext is bound to that host from schema 24 on.
 */
export interface EncryptedSample {
  host: string;
  encrypted: Uint8Array;
}

export function encryptedSamples(database: DatabaseSync, limit = 5): EncryptedSample[] {
  // Only v10/v11 values are keys this plugin can use: v12 (portal-encrypted, e.g. inside a Flatpak sandbox) never
  // decrypts, so sampling those first would reject a key that works for the readable cookies.
  const rows = database.prepare(
    "select host_key, encrypted_value from cookies where substr(encrypted_value, 1, 3) in (x'763130', x'763131') limit ?",
  ).all(limit) as { host_key: string; encrypted_value: Uint8Array }[];
  return rows.map((row) => ({ host: row.host_key, encrypted: row.encrypted_value })).filter((sample) => sample.encrypted.length > 0);
}

/** The first candidate that decrypts a sample; null when none does, which leaves those cookies unreadable. */
export function workingKey(samples: readonly EncryptedSample[], schemaVersion: number, candidates: readonly Buffer[]): Buffer | null {
  for (const key of candidates) {
    if (samples.some((sample) => decryptValue(sample.encrypted, key, sample.host, schemaVersion) !== null)) return key;
  }
  return null;
}

export function readChromiumCookies(database: DatabaseSync, key: Buffer | null): ChromiumRead {
  const version = schemaVersion(database);
  const columns = new Set(
    (database.prepare("pragma table_info(cookies)").all() as { name: string }[]).map((column) => column.name),
  );
  const pick = (name: string, fallback: string) => (columns.has(name) ? name : fallback);
  const rows = database.prepare(
    `select host_key, name, value, encrypted_value, path, expires_utc / 1000000 as expires_seconds, is_secure, is_httponly,
            ${pick("samesite", "-1")} as samesite,
            ${columns.has("is_persistent") ? "is_persistent" : pick("persistent", "1")} as persistent,
            ${pick("priority", "1")} as priority,
            ${pick("source_scheme", "0")} as source_scheme,
            ${pick("source_port", "-1")} as source_port,
            ${columns.has("top_frame_site_key") ? "top_frame_site_key != ''" : "0"} as partitioned
       from cookies`,
  ).all() as unknown as Row[];
  const cookies: SourceCookie[] = [];
  let undecryptable = 0;
  let partitioned = 0;
  for (const row of rows) {
    if (row.partitioned) {
      partitioned += 1;
      continue;
    }
    const encrypted = row.encrypted_value ?? new Uint8Array();
    const value = encrypted.length === 0 ? row.value : key ? decryptValue(encrypted, key, row.host_key, version) : null;
    if (value === null) {
      undecryptable += 1;
      continue;
    }
    const expires = row.persistent && row.expires_seconds > 0 ? row.expires_seconds - WEBKIT_EPOCH_OFFSET_SECONDS : undefined;
    const cookie: SourceCookie = {
      name: row.name,
      value,
      host: row.host_key,
      path: row.path || "/",
      secure: row.is_secure === 1,
      httpOnly: row.is_httponly === 1,
    };
    const sameSite = SAME_SITE[row.samesite];
    if (sameSite) cookie.sameSite = sameSite;
    if (expires !== undefined) cookie.expires = expires;
    const priority = PRIORITY[row.priority];
    if (priority) cookie.priority = priority;
    const scheme = SOURCE_SCHEME[row.source_scheme];
    if (scheme) cookie.sourceScheme = scheme;
    if (row.source_port >= 1 && row.source_port <= 65_535) cookie.sourcePort = row.source_port;
    cookies.push(cookie);
  }
  return { cookies, undecryptable, partitioned };
}
