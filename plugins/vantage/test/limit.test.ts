import { describe, expect, it } from "vitest";
import { createLimiter } from "../src/limit";

describe("createLimiter", () => {
  it("never runs more than the limit at once", async () => {
    const run = createLimiter(2);
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const answers = Array.from({ length: 5 }, () => run(() => {
      running++;
      peak = Math.max(peak, running);
      return new Promise<void>((resolve) => { releases.push(() => { running--; resolve(); }); });
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(running).toBe(2);
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(answers);
    expect(peak).toBe(2);
  });

  it("frees the slot when a task throws before it returns a promise", async () => {
    const run = createLimiter(1);
    const broken = run((() => { throw new Error("sync failure"); }) as () => Promise<string>);
    const next = run(async () => "ran");
    await expect(broken).rejects.toThrow("sync failure");
    await expect(next).resolves.toBe("ran");
  });

  it("frees the slot when a task rejects", async () => {
    const run = createLimiter(1);
    const broken = run(() => Promise.reject(new Error("async failure")));
    const next = run(async () => "ran");
    await expect(broken).rejects.toThrow("async failure");
    await expect(next).resolves.toBe("ran");
  });
});
