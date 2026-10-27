import type { DatabaseSync } from "node:sqlite";
import type { SameSite, SourceCookie } from "./cookies";

const LAX = 1;
const NONE = 0;
const STRICT = 2;
const RAW_SAMESITE_FIRST_SCHEMA = 10;
const RAW_SAMESITE_LAST_SCHEMA = 14;
/** Firefox stores expiry in milliseconds from this moz_cookies schema version on, and in seconds before it. */
const EXPIRY_MILLISECONDS_SCHEMA = 16;

interface Row {
  host: string;
  name: string;
  value: string;
  path: string;
  expiry: number | bigint;
  isSecure: number;
  isHttpOnly: number;
  sameSite: number | null;
  rawSameSite: number | null;
}

function sameSite(value: number | null, raw: number | null): SameSite | undefined {
  // Firefox records an unset SameSite as Lax with a raw value of None.
  if (value === LAX && raw === NONE) return undefined;
  if (value === NONE) return "None";
  if (value === LAX) return "Lax";
  if (value === STRICT) return "Strict";
  return undefined;
}

/** Cookies outside a container or private context (empty originAttributes), as bb's own import reads them. */
export function readFirefoxCookies(database: DatabaseSync): SourceCookie[] {
  const version = Number((database.prepare("pragma user_version").get() as { user_version?: unknown } | undefined)?.user_version ?? 0);
  const hasRaw = version >= RAW_SAMESITE_FIRST_SCHEMA && version <= RAW_SAMESITE_LAST_SCHEMA;
  const rows = database.prepare(
    `select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, ${hasRaw ? "rawSameSite" : "null as rawSameSite"}
       from moz_cookies where originAttributes = ''`,
  ).all() as unknown as Row[];
  return rows.map((row) => {
    const expiry = Number(row.expiry);
    const cookie: SourceCookie = {
      name: row.name,
      value: row.value,
      host: row.host,
      path: row.path || "/",
      secure: row.isSecure === 1,
      httpOnly: row.isHttpOnly === 1,
    };
    const site = sameSite(row.sameSite, row.rawSameSite);
    if (site) cookie.sameSite = site;
    if (expiry > 0) cookie.expires = version >= EXPIRY_MILLISECONDS_SCHEMA ? Math.floor(expiry / 1000) : expiry;
    return cookie;
  });
}
