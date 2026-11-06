export async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const next = (): void => {
    const start = active < limit ? waiting.shift() : undefined;
    if (start !== undefined) {
      active++;
      start();
    }
  };
  return <T>(task: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    waiting.push(() => {
      new Promise<T>((started) => started(task())).then(resolve, reject).finally(() => {
        active--;
        next();
      });
    });
    next();
  });
}
