export const KINDS = ["finding", "progress", "decision", "blocker", "summary"] as const;
export type Kind = (typeof KINDS)[number];

export const DEFAULT_KIND: Kind = "finding";

export const KIND_LABELS: Record<Kind, string> = {
  finding: "Finding",
  progress: "Progress",
  decision: "Decision",
  blocker: "Blocker",
  summary: "Summary",
};

/** Each kind's glyph, declared in the manifest's `bb.branding.experimental_icons`. */
export const KIND_ICONS: Record<Kind, string> = {
  finding: "flare/finding",
  progress: "flare/progress",
  decision: "flare/decision",
  blocker: "flare/blocker",
  summary: "flare/summary",
};

export function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}
