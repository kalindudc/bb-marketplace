export const SPEECH_KEYS = ["idle", "working", "reported", "verified", "resting", "greet", "wrap"] as const;
export type SpeechKey = (typeof SPEECH_KEYS)[number];

const fields = ["quest", "waypoint", "checker", "minutes"] as const;
export type LineFacts = Partial<Record<(typeof fields)[number], string | number | null>>;

export function speechSeed(key: string): number {
  let seed = 2166136261;
  for (let i = 0; i < key.length; i++) seed = Math.imul(seed ^ key.charCodeAt(i), 16777619);
  return seed >>> 0;
}

export function pickLine(lines: readonly string[] | undefined, key: string, previous: string | null, facts: LineFacts): string | null {
  const ready = new Set<string>();
  for (const line of lines ?? []) {
    let missing = false;
    const filled = line.replace(/\{([^{}]+)\}/g, (_, field: string) => {
      const value = fields.find(f => f === field);
      const fact = value === undefined ? null : facts[value];
      if (fact != null && String(fact).trim()) return String(fact);
      missing = true;
      return "";
    });
    if (!missing && filled.trim() && filled !== previous) ready.add(filled);
  }
  return ready.size ? [...ready][speechSeed(key) % ready.size]! : null;
}
