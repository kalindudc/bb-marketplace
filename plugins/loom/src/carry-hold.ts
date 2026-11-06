// Loom's own messages to a thread wait while Loom carries work into that thread's worktree, so none of them starts a turn
// there in the middle of the carry; they go out, in order, once the carry is over. A turn the human starts meanwhile is
// not Loom's to hold, as with any editor.
import type { BbPort } from "./ports";

// A leaf, so any engine file can import it without an import cycle.
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const held = new Map<string, Array<() => Promise<void>>>();

/** The port the engine sends through: a send to a thread Loom is carrying into waits for the carry to end. */
export function holdingSends(bb: BbPort): BbPort {
  return new Proxy(bb, {
    get(target, key) {
      if (key === "send") {
        return (threadId: string, message: Parameters<BbPort["send"]>[1]) => {
          const queue = held.get(threadId);
          if (queue === undefined) return target.send(threadId, message);
          queue.push(() => target.send(threadId, message));
          return Promise.resolve();
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Runs a carry into `threadId`'s worktree with Loom's messages to that thread held, then sends them. */
export async function holdingMessages<T>(bb: BbPort, threadId: string, run: () => Promise<T>): Promise<T> {
  if (held.has(threadId)) return run();
  held.set(threadId, []);
  try {
    return await run();
  } finally {
    const queue = held.get(threadId) ?? [];
    held.delete(threadId);
    for (const send of queue) await send().catch((error: unknown) => bb.log("warn", `Could not send a message held during a carry to ${threadId}: ${errText(error)}`));
  }
}
