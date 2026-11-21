export function motionSeed(id: string) {
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  return seed >>> 0;
}

export function variation(seed: number, index: number) {
  let n = seed ^ Math.imul(index + 1, 0x9e3779b9);
  n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return ((n ^ (n >>> 16)) >>> 0) / 0x100000000;
}

export function strideCycle(seed: number, cycle: number) {
  const index = cycle * 3;
  const period = 0.66 + 0.18 * variation(seed, index);
  const length = 23 + 6 * variation(seed, index + 1);
  return { length, speed: length / period };
}

export function idlePulse(t: number, seed: number, period: number, spread: number, length: number) {
  // Jitter stays inside each window, so a late wake can find the next gesture without replaying earlier ones.
  const clock = t + ((seed >>> 0) % period);
  const window = Math.floor(clock / period);
  const at = clock - window * period;
  const offset = (slot: number) => Math.floor(variation(seed, slot) * spread);
  const start = offset(window), end = start + length;
  if (at < start) return { on: false, next: start - at, window } as const;
  if (at < end) return { on: true, next: end - at, window } as const;
  return { on: false, next: period - at + offset(window + 1), window } as const;
}
