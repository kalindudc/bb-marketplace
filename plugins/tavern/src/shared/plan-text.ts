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
  const pairs: [number, number][] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    pairs.push([start, start]);
    start++;
  }
  if (start === a.length || start === b.length) return pairs;
  const remaining = new Set<string>();
  for (let i = start; i < a.length; i++) remaining.add(a[i]!);
  let shared = start;
  while (shared < b.length && !remaining.has(b[shared]!)) shared++;
  if (shared === b.length) return pairs;

  let scratch: [Int32Array, Int32Array, Int32Array, Int32Array] | undefined;
  function crossing(a0: number, a1: number, b0: number, b1: number, mid: number, suffix: number) {
    const width = b.length + 2;
    scratch ??= [new Int32Array(width), new Int32Array(width), new Int32Array(width), new Int32Array(width)];
    let [next, row, nextCross, rowCross] = scratch;
    const drops = a1 - a0 - suffix, inserts = b1 - b0 - suffix;
    // Matching the suffix gives an edit budget. Any optimal path stays within its insertion and deletion bounds.
    const bottom = Math.max(b0, b0 + a1 - a0 - drops);
    if (bottom > 0) next[bottom - 1] = -1;
    next.fill(0, bottom, b1 + 1);
    next[b1 + 1] = -1;
    for (let i = a1 - 1; i >= a0; i--) {
      const lo = Math.max(b0, b0 + i - a0 - drops), hi = Math.min(b1, b0 + i - a0 + inserts);
      if (lo > 0) row[lo - 1] = -1;
      row[hi + 1] = -1;
      for (let j = hi; j >= lo; j--) {
        let exit: number;
        if (j === b1) {
          row[j] = 0;
          exit = b1;
        } else if (a[i] === b[j]) {
          row[j] = next[j + 1]! + 1;
          exit = nextCross[j + 1]!;
        } else if (next[j]! >= row[j + 1]!) {
          row[j] = next[j]!;
          exit = nextCross[j]!;
        } else {
          row[j] = row[j + 1]!;
          exit = rowCross[j + 1]!;
        }
        rowCross[j] = i === mid ? j : exit;
      }
      [next, row] = [row, next];
      [nextCross, rowCross] = [rowCross, nextCross];
    }
    return nextCross[b0]!;
  }

  function compare(a0: number, a1: number, b0: number, b1: number) {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) pairs.push([a0++, b0++]);
    if (a0 === a1 || b0 === b1) return;

    let suffix = 0;
    while (suffix < a1 - a0 && suffix < b1 - b0 && a[a1 - suffix - 1] === b[b1 - suffix - 1]) suffix++;
    // A repeated token in the middle can move a suffix match under the old tie rule.
    let trim = 0;
    if (suffix) {
      const tail = new Set(a.slice(a1 - suffix, a1));
      if (!a.slice(a0, a1 - suffix).some(token => tail.has(token)) && !b.slice(b0, b1 - suffix).some(token => tail.has(token))) trim = suffix;
    }
    a1 -= trim;
    b1 -= trim;
    if (a0 < a1 && b0 < b1) {
      if (a1 - a0 === 1) {
        let j = b0;
        while (j < b1 && a[a0] !== b[j]) j++;
        if (j < b1) pairs.push([a0, j]);
      } else if (b1 - b0 === 1) {
        let i = a0;
        while (i < a1 && a[i] !== b[b0]) i++;
        if (i < a1) pairs.push([i, b0]);
      } else {
        const mid = a0 + Math.floor((a1 - a0) / 2);
        // Carry the old traceback's crossing, rather than choosing among equal LCS lengths at the split.
        const split = crossing(a0, a1, b0, b1, mid, suffix - trim);
        compare(a0, mid, b0, split);
        compare(mid, a1, split, b1);
      }
    }
    for (let i = 0; i < trim; i++) pairs.push([a1 + i, b1 + i]);
  }

  compare(start, a.length, start, b.length);
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
