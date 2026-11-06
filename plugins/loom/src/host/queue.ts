import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { abortError } from "./process";

// Heavy index and tree work on one checkout, an import, a stacked base or a merge-tree, on a monorepo loads the machine and
// takes the repository's locks for minutes. One queue per checkout, in this process, keeps two tickets from doing it at once.
const tails = new Map<string, Promise<void>>();

const keyOf = (repo: string) => {
  try {
    return realpathSync(repo);
  } catch {
    return resolve(repo);
  }
};

/**
 * What a queued call has to start with: the deadline Loom's client gave the whole call, which began running when the call
 * arrived here, and the part of it the call's own work needs. The wait in the queue uses up the deadline, so a call whose
 * work no longer fits in what is left does not start.
 */
export interface Admission {
  budgetMs: number;
  needMs: number;
  now?: () => number;
}

/** A call that waited so long in the queue that its work would be cut off by its deadline; the message is one hostCallTransient waits out. */
export class CheckoutBusy extends Error {
  constructor(waitedMs: number) {
    super(`the project's checkout is busy with another call, so this one did not start after waiting ${Math.round(waitedMs / 1000)} seconds for it; Loom tries again later`);
  }
}

/**
 * Runs `work` once every earlier call for the same checkout has finished, however it ended. An abort while waiting ends the
 * wait. With `admission`, a call whose deadline can no longer cover its work when its turn comes throws CheckoutBusy.
 */
export function onCheckout<T>(repo: string, signal: AbortSignal | undefined, work: () => Promise<T>, admission?: Admission): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  const key = keyOf(repo);
  const now = admission?.now ?? Date.now;
  const arrived = now();
  const turn = tails.get(key) ?? Promise.resolve();
  const result = turn.then(() => {
    if (signal?.aborted === true) throw abortError();
    if (admission !== undefined) {
      const waited = now() - arrived;
      if (admission.budgetMs - waited < admission.needMs) throw new CheckoutBusy(waited);
    }
    return work();
  });
  const done = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, done);
  void done.then(() => {
    if (tails.get(key) === done) tails.delete(key);
  });
  if (signal === undefined) return result;
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    result.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
