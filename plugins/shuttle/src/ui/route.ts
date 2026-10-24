import type { Section } from "../contract";
import { SECTIONS } from "./constants";

export type Route =
  | { view: "section"; section: Section; key: string | null }
  | { view: "activity" }
  | { view: "pr"; key: string };

/**
 * The page's subPath: "" is Needs you, a section id that section, "<section>/<server>/<repo…>/<number>"
 * a PR selected in it, "activity" the log, and "pr/<server>/<repo…>/<number>" one looked-up PR.
 * A key travels as plain path segments: bb encodes the subPath again, so a percent-encoded key
 * would come back still encoded.
 */
export function parseRoute(subPath: string): Route {
  const [first = "", ...rest] = subPath.replace(/^\/+|\/+$/gu, "").split("/");
  if (first === "activity" && rest.length === 0) return { view: "activity" };
  if (first === "pr") {
    const key = keyFromSegments(rest);
    return key === null ? { view: "section", section: "needs", key: null } : { view: "pr", key };
  }
  const section = first === "" ? "needs" : SECTIONS.find((id) => id === first);
  if (section === undefined) return { view: "section", section: "needs", key: null };
  return { view: "section", section, key: rest.length === 0 ? null : keyFromSegments(rest) };
}

export function formatRoute(route: Route): string {
  if (route.view === "pr") return `pr/${keySegments(route.key)}`;
  if (route.view === "activity") return "activity";
  if (route.key !== null) return `${route.section}/${keySegments(route.key)}`;
  return route.section === "needs" ? "" : route.section;
}

const KEY = /^([a-z][a-z0-9-]{0,31}):(.+)#(\d+)$/u;
const SAFE = /^[A-Za-z0-9._-]+$/u;

function keySegments(key: string): string {
  const match = KEY.exec(key);
  if (!match) return encodeURIComponent(key);
  const [, server, repo, number] = match;
  return [server, ...repo!.split("/").map((part) => (SAFE.test(part) ? part : encodeURIComponent(part))), number].join("/");
}

function keyFromSegments(segments: string[]): string | null {
  if (segments.length < 3) return null;
  const server = segments[0]!;
  const number = segments.at(-1)!;
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(server) || !/^\d+$/u.test(number)) return null;
  try {
    return `${server}:${segments.slice(1, -1).map((part) => decodeURIComponent(part)).join("/")}#${number}`;
  } catch {
    // A hand-edited URL with a stray "%": show no selection rather than a broken page.
    return null;
  }
}
