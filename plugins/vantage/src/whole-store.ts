import type { KvStorage } from "./review-store";

const WHOLE_KEY = "whole";
const MAX_WHOLE = 500;

// The worktrees the user asked to see whole, with nothing picked or left out: one kv row holding their keys, newest last.
export function createWholeStore(kv: () => KvStorage) {
  let chain: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<string[]> => {
    const value = await kv().get<unknown>(WHOLE_KEY);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  };
  return {
    async keys(): Promise<Set<string>> {
      return new Set(await read());
    },
    // Writes one after another, so two quick choices do not both start from the same old list.
    set(key: string, whole: boolean): Promise<void> {
      const run = async () => {
        const kept = (await read()).filter((entry) => entry !== key);
        if (whole) kept.push(key);
        await kv().set(WHOLE_KEY, kept.slice(-MAX_WHOLE));
      };
      const next = chain.then(run, run);
      chain = next.catch(() => {});
      return next;
    },
  };
}
