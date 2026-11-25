export function sentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const m of text.matchAll(/`[^`]*`|[.!?](?=\s+[\p{Lu}`])/gu)) {
    const end = m.index + m[0].length;
    if (m[0].startsWith("`") || /\b(?:e\.g|i\.e|etc|Mr|Ms|Dr|vs)\.$/i.test(text.slice(start, end))) continue;
    parts.push(text.slice(start, end).trim());
    start = end;
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function neverList(sentence: string): string[] | null {
  if (!/^no\s+/i.test(sentence)) return null;
  const parts = sentence.replace(/\.$/, "").split(/,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+/i)
    .map(part => part.trim().replace(/^no\s+/i, ""));
  // Ambiguous instructions belong in the original criterion, not in a rewritten guardrail.
  return parts.every(part => /^[\p{L}\p{N}][\p{L}\p{N}\s-]*$/u.test(part)
    && part.split(/\s+/).length <= 6
    && !/^one(?:\s|$)/i.test(part)
    && !/\b(?:am|is|are|was|were|be|been|being|can|could|may|might|must|shall|should|will|would|do|does|did|has|have|had|need|needs|remain|remains|fail|fails|requires?|happens?|occurs?|allowed|skipped|weakened|except|unless|without|because|not|until|if|when|after|before)\b/i.test(part))
    ? parts : null;
}

export function doneParts(text: string) {
  const criteria: string[] = [];
  const checks: string[] = [];
  const never: string[] = [];
  const neverSource: string[] = [];
  for (const sentence of sentences(text)) {
    if (/^Run\s+`[^`]+`(?:(?:,\s*(?:and\s+)?|\s+and\s+)`[^`]+`)*\.?$/.test(sentence)) {
      checks.push(...Array.from(sentence.matchAll(/`([^`]+)`/g), m => m[1]!));
      continue;
    }
    const phrases = neverList(sentence);
    if (phrases) {
      never.push(...phrases);
      neverSource.push(sentence);
    } else {
      criteria.push(sentence);
    }
  }
  return { criteria, checks, never, neverSource };
}

export function checkName(command: string): string {
  return command.match(/^npm\s+(?:--prefix\s+\S+\s+)?(test|(?:run\s+[\w:-]+))$/)?.[1]?.replace(/^run\s+/, "") ?? command;
}

export function roleOf(slot: { purpose: string }) {
  return slot.purpose.match(/^([^:\n]{2,32}):\s+/)?.[1]?.trim() || null;
}

export function scheduledWord(text: string | null) {
  return text?.match(/\b(?:automations?|cron(?:tab)?|launchd|systemd)\b/i)?.[0] ?? null;
}

function matchingPairs(a: string[], b: string[]) {
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? 1 + lengths[i + 1]![j + 1]! : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

export function listChanges(a: string[], b: string[]) {
  const pairs = matchingPairs(a, b);
  const unchanged = pairs.length;
  const removed: string[] = [], added: string[] = [];
  let i = 0, j = 0;
  for (const [x, y] of [...pairs, [a.length, b.length] as const]) {
    removed.push(...a.slice(i, x));
    added.push(...b.slice(j, y));
    i = x + 1; j = y + 1;
  }
  return { removed, added, unchanged };
}

export function sentenceChanges(before: string, after: string) {
  return listChanges(sentences(before), sentences(after));
}

type WordRun = { text: string } | { before: string; after: string };
export function wordDiff(before: string, after: string): WordRun[] {
  const a = before.match(/\S+/g) ?? [], b = after.match(/\S+/g) ?? [];
  const runs: WordRun[] = [];
  let i = 0, j = 0;
  let plain: string[] = [];
  for (const [x, y] of [...matchingPairs(a, b), [a.length, b.length] as const]) {
    if (x > i || y > j) {
      const was = a.slice(i, x).join(" "), now = b.slice(j, y).join(" ");
      const previous = runs.at(-1);
      // Read close edits as one old phrase followed by its replacement.
      if (previous && "before" in previous && plain.length <= 2) {
        previous.before = [previous.before, ...plain, was].filter(Boolean).join(" ");
        previous.after = [previous.after, ...plain, now].filter(Boolean).join(" ");
      } else {
        if (plain.length) runs.push({ text: plain.join(" ") });
        runs.push({ before: was, after: now });
      }
      plain = [];
    }
    if (x < a.length) plain.push(a[x]!);
    i = x + 1; j = y + 1;
  }
  if (plain.length) runs.push({ text: plain.join(" ") });
  return runs;
}

export function planForecast(plan: { eta: string | null; waypoints: { leadTime: string | null }[] }) {
  const unknown = plan.waypoints.filter(w => w.leadTime === null).length;
  return plan.eta ?? (unknown ? `pending ${unknown} unknown lead time${unknown === 1 ? "" : "s"}` : "no ETA given");
}
