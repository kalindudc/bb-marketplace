// What every adapter returns, whatever the server. Command adapters print these shapes as JSON;
// the built-in GitHub adapter maps gh's GraphQL answers onto them.
import { z } from "zod";
import { CHECK_STATES, REVIEW_STATES, REVIEWER_STATES, type CheckState, type Label, type PrState, type Reviewer, type ReviewState } from "./contract";

const text = (max: number) => z.string().max(max);
const id = z.union([z.string().min(1).max(300), z.number()]).transform(String);
const color = z.string().regex(/^#?[0-9a-f]{3,8}$/iu).transform((c) => c.replace(/^#/u, "").toLowerCase());
/** A label is a name, or a name with a colour such as "d73a4a" and a description. */
export const labelInputSchema = z.union([
  text(200).min(1).transform((name) => ({ name, color: null, description: null })),
  z.object({ name: text(200).min(1), color: color.nullish().catch(null), description: text(1000).nullish() })
    .transform((l) => ({ name: l.name, color: l.color ?? null, description: l.description ?? null })),
]);
export const reviewerInputSchema = z.object({ login: text(200).min(1), team: z.boolean().default(false), state: z.enum(REVIEWER_STATES) });

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
  /** view only: the description, in the server's Markdown. */
  body: text(65_536).nullish(),
  labels: z.array(labelInputSchema).max(200).nullish(),
  /** view only: requested reviewers and the latest review of everyone else who reviewed. */
  reviewers: z.array(reviewerInputSchema).max(200).nullish(),
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
  body: string | null;
  /** null when the server's answer did not include them, so the stored ones stay. */
  labels: Label[] | null;
  reviewers: Reviewer[] | null;
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
    body: raw.body ?? null,
    labels: raw.labels ? raw.labels.map((l) => ({ name: l.name, color: l.color })) : null,
    reviewers: raw.reviewers ?? null,
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

export const editOptionsSchema = z.union([
  z.array(labelInputSchema).max(1000).transform((labels) => ({ labels, people: [] as string[] })),
  z.object({ labels: z.array(labelInputSchema).max(1000).default([]), people: z.array(text(200).min(1)).max(200).default([]) }),
]);
export type EditOptions = z.output<typeof editOptionsSchema>;

export const whoamiSchema = z.object({ login: z.string().min(1).max(200) });
