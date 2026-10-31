import { createHash } from "node:crypto";

export type SameSite = "Strict" | "Lax" | "None";
export type Priority = "Low" | "Medium" | "High";
export type SourceScheme = "Unset" | "NonSecure" | "Secure";

/** One cookie as the real browser stores it. `host` keeps the browser's leading dot for domain cookies. */
export interface SourceCookie {
  name: string;
  value: string;
  host: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: SameSite;
  /** Unix seconds; absent for a session cookie. */
  expires?: number;
  priority?: Priority;
  sourceScheme?: SourceScheme;
  sourcePort?: number;
}

/** The fields of a CDP Network.CookieParam this plugin sends. */
export interface CdpCookieParam {
  name: string;
  value: string;
  url: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: SameSite;
  expires?: number;
  priority?: Priority;
  sourceScheme?: SourceScheme;
  sourcePort?: number;
}

/** A cookie in bb's Browser, as CDP Network.getAllCookies reports it. */
export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  partitionKey?: unknown;
}

export interface CookieRef {
  name: string;
  domain: string;
  path: string;
}

/** What the last sync saw in the real browser, by cookie key: hashes only, never values. */
export type SyncMemory = Record<string, { f: string; v: string }>;

export type SyncMode = "changes" | "full";

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

export function cookieKey(cookie: { name: string; path: string } & ({ host: string } | { domain: string })): string {
  const host = "host" in cookie ? cookie.host : cookie.domain;
  return `${cookie.name}\u0000${host.toLowerCase()}\u0000${cookie.path}`;
}

export function valueHash(value: string): string {
  return hash(value);
}

export function fingerprint(cookie: SourceCookie): string {
  return hash(JSON.stringify([
    cookie.value, cookie.secure, cookie.httpOnly, cookie.sameSite ?? "", cookie.expires ?? null, cookie.priority ?? "", cookie.sourceScheme ?? "",
  ]));
}

function urlHost(host: string): string {
  const bare = host.startsWith(".") ? host.slice(1) : host;
  return bare.includes(":") && !bare.startsWith("[") ? `[${bare}]` : bare;
}

export function toCdpParam(cookie: SourceCookie): CdpCookieParam {
  const param: CdpCookieParam = {
    name: cookie.name,
    value: cookie.value,
    url: `${cookie.secure ? "https" : "http"}://${urlHost(cookie.host)}${cookie.path.startsWith("/") ? cookie.path : "/"}`,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
  if (cookie.host.startsWith(".")) param.domain = cookie.host;
  // Chromium refuses SameSite=None without Secure; such a cookie only survives as unspecified.
  if (cookie.sameSite && !(cookie.sameSite === "None" && !cookie.secure)) param.sameSite = cookie.sameSite;
  if (cookie.expires !== undefined) param.expires = cookie.expires;
  if (cookie.priority) param.priority = cookie.priority;
  if (cookie.sourceScheme) param.sourceScheme = cookie.sourceScheme;
  if (cookie.sourcePort !== undefined && cookie.sourcePort >= 1 && cookie.sourcePort <= 65_535) param.sourcePort = cookie.sourcePort;
  return param;
}

export function isExpired(cookie: SourceCookie, nowSeconds: number): boolean {
  return cookie.expires !== undefined && cookie.expires <= nowSeconds;
}

export interface SyncPlan {
  set: SourceCookie[];
  remove: CookieRef[];
  memory: SyncMemory;
}

/**
 * Decide what to write into bb's Browser. The real browser is the source of truth for what changed in it: a cookie it
 * added or changed since the last sync is written, and one it dropped is removed from bb only while bb still holds the
 * value the plugin wrote, so a cookie a site rotated inside bb is never clobbered by a stale copy. `full` ("Sync now"
 * and the sign-in handoff) also writes each unchanged cookie bb lacks or holds with another value, and the first sync
 * of a profile writes every cookie.
 *
 * `mirrorHosts` names sites bb should hold exactly as the real browser does: any cookie bb has for one of them that the
 * real browser does not is removed too. An access gateway's handoff uses it, because a half-finished sign-in inside bb
 * can leave a cookie (a pending request id) that makes the site ignore the session copied from the real browser.
 */
export function planSync(input: {
  source: readonly SourceCookie[];
  previous: SyncMemory | null;
  jar: readonly JarCookie[];
  mode: SyncMode;
  nowSeconds: number;
  /** False when the source could not be read completely, so a missing cookie may only be unreadable. */
  allowRemovals?: boolean;
  mirrorHosts?: readonly string[];
}): SyncPlan {
  const jar = new Map<string, string>();
  for (const cookie of input.jar) {
    if (cookie.partitionKey !== undefined) continue;
    jar.set(cookieKey(cookie), valueHash(cookie.value));
  }
  const full = input.mode === "full" || input.previous === null;
  const previous = input.previous ?? {};
  const memory: SyncMemory = {};
  const set: SourceCookie[] = [];
  for (const cookie of input.source) {
    if (isExpired(cookie, input.nowSeconds)) continue;
    const key = cookieKey(cookie);
    const entry = { f: fingerprint(cookie), v: valueHash(cookie.value) };
    memory[key] = entry;
    const changedInSource = previous[key]?.f !== entry.f;
    if (!(full || changedInSource)) continue;
    if (!changedInSource && jar.get(key) === entry.v) continue;
    set.push(cookie);
  }
  const remove: CookieRef[] = [];
  if (input.allowRemovals === false) return { set, remove, memory };
  const removing = new Set<string>();
  for (const [key, entry] of Object.entries(previous)) {
    if (memory[key] || jar.get(key) !== entry.v) continue;
    const [name, domain, path] = key.split("\u0000") as [string, string, string];
    remove.push({ name, domain, path });
    removing.add(key);
  }
  const mirrored = new Set((input.mirrorHosts ?? []).map((host) => host.toLowerCase()));
  if (mirrored.size === 0) return { set, remove, memory };
  for (const cookie of input.jar) {
    if (cookie.partitionKey !== undefined || !mirrored.has(cookie.domain.replace(/^\./, "").toLowerCase())) continue;
    const key = cookieKey(cookie);
    if (memory[key] || removing.has(key)) continue;
    remove.push({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    removing.add(key);
  }
  return { set, remove, memory };
}

/**
 * The memory to keep after a sync. A read that could not decrypt everything cannot see those cookies, so their previous
 * hashes are kept; forgetting them would make a later sync unable to remove them.
 */
export function keptMemory(previous: SyncMemory | null, memory: SyncMemory, readComplete: boolean): SyncMemory {
  return readComplete || previous === null ? memory : { ...previous, ...memory };
}

/** True when the real browser's cookies differ from what the last sync recorded. */
export function sourceChanged(source: readonly SourceCookie[], previous: SyncMemory | null, nowSeconds: number): boolean {
  if (previous === null) return true;
  let live = 0;
  for (const cookie of source) {
    if (isExpired(cookie, nowSeconds)) continue;
    live += 1;
    if (previous[cookieKey(cookie)]?.f !== fingerprint(cookie)) return true;
  }
  return live !== Object.keys(previous).length;
}
