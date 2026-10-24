// What every adapter returns, whatever the server. Command adapters print these shapes as JSON;
// the built-in GitHub adapter maps gh's GraphQL answers onto them.
import { z } from "zod";
import { CHECK_STATES, REVIEW_STATES, type CheckState, type PrState, type ReviewState } from "./contract";

const text = (max: number) => z.string().max(max);
const id = z.union([z.string().min(1).max(300), z.number()]).transform(String);

export const prSummarySchema = z.object({
  repo: z.string().min(1).max(300).regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u, "must be path segments of letters, digits, dots, dashes and underscores"),
  number: z.number().int().positive(),
  title: text(1000),
  author: text(200).default(""),
  state: z.enum(["open", "draft", "merged", "closed"]),
  draft: z.boolean().nullish(),
  url: z.string().max(1000).nullish(),
  head: text(100).nullish(),
  head_ref: text(300).nullish(),
  base: text(300).nullish(),
  checks: z.enum(CHECK_STATES).nullish(),
  review: z.enum(REVIEW_STATES).nullish(),
  updated_at: z.string().max(60).nullish(),
  additions: z.number().int().nonnegative().nullish(),
  deletions: z.number().int().nonnegative().nullish(),
  files: z.number().int().nonnegative().nullish(),
  teams: z.array(text(200)).max(50).nullish(),
});
export type PrSummaryInput = z.input<typeof prSummarySchema>;

export interface PrSummary {
  repo: string;
  number: number;
  title: string;
  author: string;
  state: PrState;
  url: string | null;
  head: string | null;
  headRef: string | null;
  base: string | null;
  checks: CheckState;
  review: ReviewState;
  updatedAt: number | null;
  additions: number | null;
  deletions: number | null;
  files: number | null;
  teams: string[];
}

export function toSummary(raw: z.output<typeof prSummarySchema>): PrSummary {
  const updated = raw.updated_at ? Date.parse(raw.updated_at) : Number.NaN;
  return {
    repo: raw.repo,
    number: raw.number,
    title: raw.title,
    author: raw.author,
    state: raw.state === "open" && raw.draft ? "draft" : raw.state,
    url: raw.url ?? null,
    head: raw.head ?? null,
    headRef: raw.head_ref ?? null,
    base: raw.base ?? null,
    checks: raw.checks ?? "none",
    review: raw.review ?? "none",
    updatedAt: Number.isFinite(updated) ? updated : null,
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    files: raw.files ?? null,
    teams: raw.teams ?? [],
  };
}

export const ACTIVITY_KINDS = ["review", "thread", "comment", "check"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const activityItemSchema = z.object({
  /** Stays the same while the thing it names does not change, and changes when it does. */
  id,
  kind: z.enum(ACTIVITY_KINDS),
  author: text(200).nullish(),
  bot: z.boolean().nullish(),
  state: text(60).nullish(),
  body: text(20_000).nullish(),
  path: text(1000).nullish(),
  line: z.number().int().nullish(),
  url: text(1000).nullish(),
});
export type ActivityItem = z.output<typeof activityItemSchema>;

export const activitySchema = z.object({
  head: text(100).nullish(),
  items: z.array(activityItemSchema).max(1000),
});
export type Activity = z.output<typeof activitySchema>;

export const whoamiSchema = z.object({ login: z.string().min(1).max(200) });
