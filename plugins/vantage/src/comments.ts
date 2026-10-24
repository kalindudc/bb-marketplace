import { useSyncExternalStore } from "react";
import type { Part } from "./reviewed";

export interface Comment { id: string; path: string; part: Part; quote: string; text: string; at: number }

export const COMMENTS_STORAGE_KEY = "bb-plugin-vantage:comments";
const MAX_WORKTREES = 100;
const NONE: readonly Comment[] = [];

type Drafts = Record<string, Comment[]>;

function read(storage: Storage): Drafts {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(COMMENTS_STORAGE_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Drafts : {};
  } catch {
    return {};
  }
}

// Drafts stay on this device until they are sent or discarded.
export function createCommentStore(win: Window) {
  const storage = win.localStorage;
  const listeners = new Set<() => void>();
  let drafts = read(storage);
  let counter = 0;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const write = (next: Drafts) => {
    const keys = Object.keys(next).filter((key) => next[key]!.length > 0);
    drafts = Object.fromEntries(keys.slice(-MAX_WORKTREES).map((key) => [key, next[key]!]));
    storage.setItem(COMMENTS_STORAGE_KEY, JSON.stringify(drafts));
    notify();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== COMMENTS_STORAGE_KEY && event.key !== null) return;
    drafts = read(storage);
    notify();
  };
  return {
    get: (key: string): readonly Comment[] => drafts[key] ?? NONE,
    add(key: string, comment: Omit<Comment, "id" | "at">): void {
      const entry: Comment = { ...comment, id: `${Date.now().toString(36)}-${(counter++).toString(36)}`, at: Date.now() };
      write({ ...drafts, [key]: [...(drafts[key] ?? []), entry] });
    },
    update(key: string, id: string, text: string): void {
      write({ ...drafts, [key]: (drafts[key] ?? []).map((comment) => (comment.id === id ? { ...comment, text } : comment)) });
    },
    remove(key: string, id: string): void {
      write({ ...drafts, [key]: (drafts[key] ?? []).filter((comment) => comment.id !== id) });
    },
    removeMany(key: string, ids: readonly string[]): void {
      const gone = new Set(ids);
      write({ ...drafts, [key]: (drafts[key] ?? []).filter((comment) => !gone.has(comment.id)) });
    },
    clear(key: string): void {
      const next = { ...drafts };
      delete next[key];
      write(next);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) win.addEventListener("storage", onStorage);
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) win.removeEventListener("storage", onStorage);
      };
    },
  };
}

export type CommentStore = ReturnType<typeof createCommentStore>;

export function useComments(store: CommentStore, key: string): readonly Comment[] {
  return useSyncExternalStore(store.subscribe, () => store.get(key), () => store.get(key));
}

const PART_LABEL = (part: Part): string => (part === "uncommitted" ? "not committed" : part === "committed" ? "committed" : `in commit ${part.slice(7, 14)}`);

// One message for the agent: each comment names its file, quotes the lines it is about, then says what to change.
export function composeReview(comments: readonly Comment[], root: string | null): string {
  const lines = ["Review notes from Vantage on your changes:", ""];
  comments.forEach((comment, index) => {
    lines.push(`${index + 1}. \`${comment.path}\` (${PART_LABEL(comment.part)})`);
    if (comment.quote.trim() !== "") for (const quoted of comment.quote.split("\n")) lines.push(`   > ${quoted}`);
    for (const said of comment.text.split("\n")) lines.push(`   ${said}`);
    lines.push("");
  });
  if (root !== null) lines.push(`Paths are relative to ${root}.`);
  return lines.join("\n").trimEnd();
}
