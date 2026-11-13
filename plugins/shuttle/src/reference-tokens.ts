export function referenceNumbers(text: string): Array<{ number: number; token: string; offset: number }> {
  const spans = [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/[^\s)]+|\[[^\]\n]*\]\([^\n)]*\)/gu)].map((m) => [m.index, m.index + m[0].length]);
  const found: Array<{ number: number; token: string; offset: number }> = [];
  // Servers such as GitLab write `repo!12`; a `!` counts only after a repository, so a bare `!12` is never a reference.
  for (const match of text.matchAll(/(?<![\w/#])(?:[a-z][a-z0-9-]*:)?(?:(?:[\w.-]+\/[\w./-]+)?#|[\w.-]+\/[\w./-]+!)([1-9]\d{0,11})(?![\w])/gu)) {
    if (spans.some(([a, b]) => match.index >= a! && match.index < b!)) continue;
    const before = text.slice(Math.max(0, match.index - 35), match.index);
    if (/(?:cortex(?:\s+task)?|handover|task|colour|color|background|foreground)\s*[:=]?\s*$/iu.test(before)) continue;
    found.push({ number: Number(match[1]), token: match[0], offset: match.index });
  }
  return found;
}

