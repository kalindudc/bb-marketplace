export interface ReportHeadlineNames {
  threadNames?: ReadonlyMap<string, string>;
  questNames?: ReadonlyMap<string, string>;
  reportNames?: ReadonlyMap<string, string>;
  waypointTitles?: ReadonlyMap<string, string>;
}

const VERDICT_LEAD = /^\s*(?:(?:VERIFIED|REJECTED|DONE|PASS(?:ED)?|FAIL(?:ED)?)\b[^.:\n]{0,40}[.:]|(?:Entry|Waypoint)\s+\w{1,8}\s+(?:verified|rejected|done)[.:])\s*/i;
const RAW_ID = /(?<![\w/\\-])(?:(?:thr_|quest_|report_)[\w-]+|w\d+)(?![\w/\\-])/i;

export function nameReportIds(
  text: string,
  names: ReportHeadlineNames = {},
): { text: string; unresolved: string[] } {
  const waypointIds = [...names.waypointTitles?.keys() ?? []]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const boundary = String.raw`[\w/\\-]`;
  const knownWaypoint = waypointIds.length
    ? new RegExp(`(?<!${boundary})(?:${waypointIds.join("|")})(?!${boundary})`)
    : null;
  const identifiers = new RegExp(
    `(?<!${boundary})(?:(?:thr_|quest_|report_)[\\w-]+|waypoint\\s+[\\w-]+${waypointIds.length ? `|${waypointIds.join("|")}` : ""})(?!${boundary})`,
    "gi",
  );
  const unresolved = new Set<string>();
  const named = text.replace(identifiers, token => {
    const waypoint = token.match(/^(waypoint\s+)([\w-]+)$/i);
    const id = waypoint?.[2] ?? token;
    const kind = id.toLowerCase();
    const report = kind.startsWith("report_");
    const lookup = kind.startsWith("thr_") ? names.threadNames
      : kind.startsWith("quest_") ? names.questNames
        : report ? names.reportNames : names.waypointTitles;
    if (!waypoint && !kind.startsWith("thr_") && !kind.startsWith("quest_") && !report && !lookup?.has(id)) return token;
    const label = lookup?.get(id)?.trim();
    if (!label || RAW_ID.test(label) || knownWaypoint?.test(label)) {
      if (report) return `${waypoint?.[1] ?? ""}a report`;
      unresolved.add(id);
      return token;
    }
    return `${waypoint?.[1] ?? ""}${label}`;
  });
  return { text: named, unresolved: [...unresolved] };
}

export function extractReportHeadline(
  report: { headline?: string | null; outcome: string },
  names: ReportHeadlineNames = {},
): string | null {
  const own = report.headline?.trim();
  const text = report.outcome.replace(VERDICT_LEAD, "").trim();
  // A filename's dot is not a sentence boundary, unlike punctuation before a new sentence.
  const first = own || (text.match(/^([\s\S]+?[.!?])(?=\s+[A-Z(]|\s*$)/)?.[1]?.trim() ?? text);
  if (!first || /^\(\d+\)/.test(first)) return null;
  const { text: headline, unresolved } = nameReportIds(first, names);
  if (unresolved.length || RAW_ID.test(headline) || headline.length < 12 || headline.length > 160) return null;
  return headline;
}
