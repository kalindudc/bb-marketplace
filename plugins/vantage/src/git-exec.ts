import { createLimiter } from "./limit";

// The host worker serves every worktree at once; without a cap, a busy overview starts dozens of git processes together.
export const GIT_CONCURRENCY = 3;

export function limitGit<Args extends unknown[], Result>(
  exec: (...args: Args) => Promise<Result>, limit: number = GIT_CONCURRENCY,
): (...args: Args) => Promise<Result> {
  const run = createLimiter(limit);
  return (...args) => run(() => exec(...args));
}
