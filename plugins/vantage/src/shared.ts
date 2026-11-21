import { useMemo, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import { createCommentStore } from "./comments";
import type { ReviewLoaders } from "./review";

export const comments = createCommentStore(window);

const DIFF_CONCURRENCY = 2;
type Read = { key?: string; start(finish: () => void): void };
const patches: Read[] = [];
const sides: Read[] = [];
const foreground = new Map<string, number>();
let active = 0;
let activeForeground = 0;
let readingSides = false;
let scheduled = false;

function scheduleReads(): void {
  if (scheduled) return;
  scheduled = true;
  // Batch card effects so a patch can claim priority and enqueue its sides before lower-priority work starts.
  queueMicrotask(() => {
    scheduled = false;
    while (active < DIFF_CONCURRENCY) {
      const index = patches.findIndex(({ key }) => key === undefined || foreground.has(key));
      const first = index !== -1;
      if (!first && (foreground.size !== 0 || activeForeground !== 0 || readingSides)) return;
      const needsSides = !first && sides.length > 0;
      if (needsSides && active !== 0) return;
      const next = first ? patches.splice(index, 1)[0] : needsSides ? sides.shift() : patches.shift();
      if (next === undefined) return;
      active++;
      if (first) activeForeground++;
      if (needsSides) readingSides = true;
      next.start(() => {
        active--;
        if (first) activeForeground--;
        if (needsSides) readingSides = false;
        scheduleReads();
      });
    }
  });
}

function queueRead<T>(queue: Read[], run: () => Promise<T>, key?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    queue.push({
      key,
      start: (finish) => {
        new Promise<T>((start) => start(run())).then(resolve, reject).finally(finish);
      },
    });
    scheduleReads();
  });
}

function prioritizePatch(key: string): () => void {
  foreground.set(key, (foreground.get(key) ?? 0) + 1);
  scheduleReads();
  return () => {
    const count = foreground.get(key)!;
    if (count === 1) foreground.delete(key);
    else foreground.set(key, count - 1);
    scheduleReads();
  };
}

export function useLoaders(): ReviewLoaders {
  const rpc = useRpc<typeof rpcContract>();
  const ref = useRef(rpc);
  ref.current = rpc;
  return useMemo<ReviewLoaders>(
    () => ({
      patch: (input, key) => queueRead(patches, () => ref.current.call("patch", input), key),
      prioritizePatch,
      fileSides: (input) => queueRead(sides, () => ref.current.call("fileSides", input)),
      image: (input) => queueRead(sides, () => ref.current.call("image", input)),
      recordedEdits: (input) => ref.current.call("recordedEdits", input),
      commitFiles: (input) => ref.current.call("commitFiles", input),
    }),
    [],
  );
}
