// Calendar days in the local time zone of bb's server, as YYYY-MM-DD, for the Usage view's periods. The page and the CLI
// take "today" from the server's answer, so all three agree on which day it is.
import type { UsageRange } from "./contract";

export const RANGE_DAYS: Record<UsageRange, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

const parts = (day: string) => day.split("-").map(Number) as [number, number, number];
const pad = (n: number) => String(n).padStart(2, "0");

/** The local day an epoch-ms time falls on. */
export function dayOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The day's first millisecond, local time. */
export function dayStart(day: string): number {
  const [y, m, d] = parts(day);
  return new Date(y, m - 1, d).getTime();
}

/** The day `n` days after `day`; whole days, so a change to or from daylight saving time never shifts it. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return date.toISOString().slice(0, 10);
}

/** A real calendar day, such as 2026-11-05, and not 2026-02-30. */
export const isDay = (day: string): boolean => DAY.test(day) && day >= "2000-01-01" && addDays(day, 0) === day;

/** The last day of the period `by` periods away, or null once that reaches today, which follows today. */
export function stepEnd(range: UsageRange, last: string, by: -1 | 1, today: string): string | null {
  const next = addDays(last, by * RANGE_DAYS[range]);
  return next >= today ? null : next;
}

const format = (day: string, options: Intl.DateTimeFormatOptions) => {
  const [y, m, d] = parts(day);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", options);
};

/** "Today, Nov 6", "Yesterday, Nov 5", "Wed, Nov 4", "Oct 31 – Nov 6" or "Nov 1 – 7"; a year only outside today's. */
export function periodLabel(range: UsageRange, last: string, today: string): string {
  const year = today.slice(0, 4);
  const short: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (range === "today") {
    if (last === today) return `Today, ${format(last, short)}`;
    if (last === addDays(today, -1)) return `Yesterday, ${format(last, short)}`;
    return format(last, { weekday: "short", ...short, ...(last.startsWith(year) ? {} : { year: "numeric" }) });
  }
  const first = addDays(last, 1 - RANGE_DAYS[range]);
  if (!first.startsWith(year) || !last.startsWith(year)) return `${format(first, { ...short, year: "numeric" })} \u2013 ${format(last, { ...short, year: "numeric" })}`;
  if (first.slice(0, 7) === last.slice(0, 7)) return `${format(first, short)} \u2013 ${format(last, { day: "numeric" })}`;
  return `${format(first, short)} \u2013 ${format(last, short)}`;
}

/** What a period's figures are compared with: "yesterday by now", "the day before" a past day, or "the 7 days before". */
export function previousText(range: UsageRange, latest: boolean): string {
  if (range === "today") return latest ? "yesterday by now" : "the day before";
  return `the ${RANGE_DAYS[range]} days before`;
}
