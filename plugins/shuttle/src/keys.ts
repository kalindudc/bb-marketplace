// PR keys (`server:repo#number`) and links, for every configured server.
import type { ServerConfig } from "./config";

export interface PrRef {
  server: string;
  repo: string;
  number: number;
}

export class LookupError extends Error {
  override readonly name = "LookupError";
}

/** Keys always use `#`, whatever sign the server shows, so one PR has one key. */
export function prKey(ref: PrRef): string {
  return `${ref.server}:${ref.repo}#${ref.number}`;
}

const KEY = /^([a-z][a-z0-9-]{0,31}):([^\s#!]+)[#!](\d{1,12})$/u;

export function parseKey(text: string): PrRef | null {
  const match = KEY.exec(text.trim());
  if (!match) return null;
  return { server: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function linkPattern(server: ServerConfig): RegExp {
  if (server.pattern) return new RegExp(server.pattern, "u");
  const host = escape(server.hostname ?? "github.com");
  return new RegExp(`^https?://(?:www\\.)?${host}/(?<repo>[^/\\s]+/[^/\\s]+)/pull/(?<number>\\d+)`, "u");
}

export function linkFor(server: ServerConfig, repo: string, number: number): string {
  if (server.link) return server.link.replaceAll("{repo}", repo).replaceAll("{number}", String(number));
  return `https://${server.hostname ?? "github.com"}/${repo}/pull/${number}`;
}

export function parseLink(text: string, servers: readonly ServerConfig[]): PrRef | null {
  const value = text.trim();
  for (const server of servers) {
    if (!server.enabled) continue;
    const match = linkPattern(server).exec(value);
    const repo = match?.groups?.repo;
    const number = Number(match?.groups?.number);
    if (repo && Number.isInteger(number) && number > 0) return { server: server.id, repo, number };
  }
  return null;
}

/** A pasted link or key, resolved against the configured servers. */
export function resolveQuery(query: string, servers: readonly ServerConfig[]): PrRef {
  const key = parseKey(query);
  if (key) {
    if (!servers.some((s) => s.id === key.server)) throw new LookupError(`no server called ${key.server}; the servers are ${servers.map((s) => s.id).join(", ")}`);
    return key;
  }
  const link = parseLink(query, servers);
  if (link) return link;
  throw new LookupError("no server's link pattern matches that; paste a PR link or a key such as github:owner/repo#123");
}

export function displayKey(ref: PrRef, sep: "#" | "!"): string {
  return `${ref.repo}${sep}${ref.number}`;
}
