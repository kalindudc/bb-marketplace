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
    && !/\b(?:am|is|are|was|were|be|been|being|can|could|may|might|must|shall|should|will|would|do|does|did|has|have|had|need|needs|remain|remains|fail|fails|requires?|happens?|occurs?|allowed|skipped|weakened|except|unless|without|because|not)\b/i.test(part))
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

export function sentenceChanges(before: string, after: string) {
  const a = sentences(before), b = sentences(after);
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? 1 + lengths[i + 1]![j + 1]! : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const removed: string[] = [], added: string[] = [];
  let i = 0, j = 0, unchanged = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && a[i] === b[j]) { i++; j++; unchanged++; }
    else if (i < a.length && (j === b.length || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) removed.push(a[i++]!);
    else added.push(b[j++]!);
  }
  return { removed, added, unchanged };
}
