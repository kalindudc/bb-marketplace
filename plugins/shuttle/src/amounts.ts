// Token counts and dollars as the CLI and the page show them.

/** Such as 812, 12.3K, 9.05M or 1.2B. */
export function tokenCount(n: number): string {
  const units: Array<[number, string]> = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, unit] of units) {
    if (n >= size) {
      const value = n / size;
      return `${value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : Math.round(value)}${unit}`;
    }
  }
  return String(Math.round(n));
}

/** Such as $5.74 or $1,234; `~` when some of it is a list-price estimate. */
export function dollars(n: number, estimated = false): string {
  const text = n > 0 && n < 0.01 ? "<$0.01" : `$${n.toLocaleString("en-US", { minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
  return estimated ? `~${text}` : text;
}

/** The change from `before` to `now` as a share, or null when there was nothing before to compare with. */
export function change(now: number, before: number): number | null {
  return before > 0 ? (now - before) / before : null;
}
