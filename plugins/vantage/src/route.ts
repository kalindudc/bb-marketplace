import type { OverviewTarget } from "./contract";

export type PageView = "worktrees" | "repositories";
export interface PageRoute { target: OverviewTarget; view: PageView; selectedKey: string | null }

const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_KEY_LENGTH = 400;
const KEY_TEXT = /^(?:[A-Za-z0-9._-]|~[0-9A-Fa-f]{2})*$/;

// bb encodes every address segment again and its router then rewrites "%2F", so a percent-encoded key
// comes back altered. A key is written with letters, digits, "." "_" "-" and "~XX" (a byte in hex)
// instead: no stage of the round trip changes those.
function encodeKey(key: string): string {
  return [...new TextEncoder().encode(key)].map((byte) => {
    const character = String.fromCharCode(byte);
    return byte < 128 && /[A-Za-z0-9._-]/.test(character) ? character : `~${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

function decodeKey(text: string): string | null {
  if (!KEY_TEXT.test(text)) return null;
  const bytes = [...text.matchAll(/~([0-9A-Fa-f]{2})|[^~]/g)].map((part) => (part[1] === undefined ? part[0].charCodeAt(0) : parseInt(part[1], 16)));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

const has = (rest: string, segment: string): boolean => rest === segment || rest.startsWith(`${segment}/`);

// An invalid part ends the parse: what came before it stays, the rest takes its default.
export function parseRoute(subPath: string): { route: PageRoute; canonical: string } {
  let rest = subPath.replace(/^\/+|\/+$/g, "");
  const take = (): string => {
    const end = rest.indexOf("/");
    const head = end === -1 ? rest : rest.slice(0, end);
    rest = end === -1 ? "" : rest.slice(end + 1);
    return head;
  };
  const route: PageRoute = { target: { kind: "all" }, view: "worktrees", selectedKey: null };
  if (has(rest, "tree")) {
    take();
    const threadId = take();
    if (THREAD_ID.test(threadId)) route.target = { kind: "tree", threadId };
    else rest = "";
  }
  if (has(rest, "repositories")) {
    take();
    route.view = "repositories";
  } else if (has(rest, "worktree")) {
    take();
    const key = decodeKey(rest);
    if (key !== null && key.length > 0 && key.length <= MAX_KEY_LENGTH) route.selectedKey = key;
  }
  return { route, canonical: formatRoute(route) };
}

export function formatRoute(route: PageRoute): string {
  const parts: string[] = [];
  if (route.target.kind === "tree") parts.push("tree", route.target.threadId);
  if (route.view === "repositories") parts.push("repositories");
  else if (route.selectedKey !== null) parts.push("worktree", encodeKey(route.selectedKey));
  return parts.join("/");
}
