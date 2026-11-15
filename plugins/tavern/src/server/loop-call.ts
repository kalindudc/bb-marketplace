export class LoopTimeout extends Error {
  constructor(label: string, timeoutMs = 20_000) {
    super(`Tavern ${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
    this.name = "LoopTimeout";
  }
}

export async function loopCall<T>(work: Promise<T>, label: string, timeoutMs = 20_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LoopTimeout(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
