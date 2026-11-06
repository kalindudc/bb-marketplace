// Loom's own ways of starting a turn in a thread, its sends and its scheduled retries, wait while Loom carries work into
// that thread's worktree, so none of them starts a turn there in the middle of the carry. They go out, in order, once the
// carry is over, and each settles on bb's own answer then: a caller that keeps a message until bb takes it, as a hand-back
// does, keeps it through a delivery that fails and tries again later. A turn the human starts meanwhile is not Loom's to
// hold, as with any editor.
import type { BbPort } from "./ports";

const held = new Map<string, Array<() => Promise<void>>>();

/** The port the engine sends through: a send or a turn retry for a thread Loom is carrying into waits for the carry to end. */
export function holdingSends(bb: BbPort): BbPort {
  const later = (threadId: string, start: () => Promise<void>): Promise<void> => {
    const queue = held.get(threadId);
    if (queue === undefined) return start();
    return new Promise<void>((resolve, reject) => queue.push(() => start().then(resolve, reject)));
  };
  return new Proxy(bb, {
    get(target, key) {
      if (key === "send") return (threadId: string, message: Parameters<BbPort["send"]>[1]) => later(threadId, () => target.send(threadId, message));
      if (key === "retryTurn") return (threadId: string, turnRequestId: string, sendAt: number) => later(threadId, () => target.retryTurn(threadId, turnRequestId, sendAt));
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Whether a carry into `threadId`'s worktree holds Loom's sends to it now. */
export const holdsMessages = (threadId: string): boolean => held.has(threadId);

/** Runs a carry into `threadId`'s worktree with Loom's sends and turn retries for that thread held, then lets them go. */
export async function holdingMessages<T>(threadId: string, run: () => Promise<T>): Promise<T> {
  if (held.has(threadId)) return run();
  held.set(threadId, []);
  try {
    return await run();
  } finally {
    const queue = held.get(threadId) ?? [];
    held.delete(threadId);
    // In order; each one's own caller sees whether bb took it.
    for (const start of queue) await start().catch(() => undefined);
  }
}
