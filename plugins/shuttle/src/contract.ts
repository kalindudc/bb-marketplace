// The RPC contract between Shuttle's server and its UI, and the shapes both sides share.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { configSchema, WATCH_MODES } from "./config";

export const SECTIONS = ["needs", "requested", "team", "mentioned", "watching", "inflight", "done"] as const;
export type Section = (typeof SECTIONS)[number];
export const REASONS = ["authored", "requested", "team", "mentioned"] as const;
export type Reason = (typeof REASONS)[number];
export const PR_STATES = ["open", "draft", "merged", "closed"] as const;
export type PrState = (typeof PR_STATES)[number];
export const CHECK_STATES = ["passed", "failed", "pending", "none"] as const;
export type CheckState = (typeof CHECK_STATES)[number];
export const REVIEW_STATES = ["approved", "changes", "required", "none"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const LINK_ROLES = ["owner", "review", "reference"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];
export const REVIEW_RUN_STATES = ["running", "done", "failed"] as const;

const key = z.string().min(3).max(400);

export const linkViewSchema = z.object({ threadId: z.string(), title: z.string(), role: z.enum(LINK_ROLES), archived: z.boolean() });
export type LinkView = z.infer<typeof linkViewSchema>;

export const reviewRunSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  state: z.enum(REVIEW_RUN_STATES),
  preset: z.string(),
  trigger: z.enum(["auto", "manual"]),
  head: z.string().nullable(),
  at: z.number(),
});
export type ReviewRunView = z.infer<typeof reviewRunSchema>;

export const prViewSchema = z.object({
  /** `server:repo#number`, the PR's id everywhere in Shuttle. */
  key: z.string(),
  server: z.string(),
  serverName: z.string(),
  repo: z.string(),
  number: z.number(),
  sep: z.enum(["#", "!"]),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  mine: z.boolean(),
  state: z.enum(PR_STATES),
  checks: z.enum(CHECK_STATES),
  review: z.enum(REVIEW_STATES),
  head: z.string().nullable(),
  headRef: z.string().nullable(),
  base: z.string().nullable(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  files: z.number().nullable(),
  updatedAt: z.number().nullable(),
  reasons: z.array(z.object({ reason: z.enum(REASONS), teams: z.array(z.string()) })),
  watch: z.enum(WATCH_MODES).nullable(),
  links: z.array(linkViewSchema),
  lastReview: reviewRunSchema.nullable(),
  /** Why the PR is in Needs you, or null. */
  needs: z.string().nullable(),
  /** The server's last sync failed, so this row may be out of date. */
  stale: z.boolean(),
  /** Review items found on a watched PR and not yet sent to its thread. */
  pendingItems: z.number(),
});
export type PrView = z.infer<typeof prViewSchema>;

export const serverStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["github", "command"]),
  enabled: z.boolean(),
  /** null until the first sync. */
  ok: z.boolean().nullable(),
  login: z.string().nullable(),
  error: z.string().nullable(),
  lastOkAt: z.number().nullable(),
  lastSyncAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  operations: z.array(z.string()),
});
export type ServerStatus = z.infer<typeof serverStatusSchema>;

export const eventViewSchema = z.object({
  id: z.number(),
  at: z.number(),
  kind: z.string(),
  text: z.string(),
  key: z.string().nullable(),
  threadId: z.string().nullable(),
});
export type EventView = z.infer<typeof eventViewSchema>;

export const overviewSchema = z.object({
  servers: z.array(serverStatusSchema),
  counts: z.record(z.enum(SECTIONS), z.number()),
  syncedAt: z.number().nullable(),
  syncing: z.boolean(),
  paused: z.boolean(),
});
export type Overview = z.infer<typeof overviewSchema>;

export const threadOptionSchema = z.object({ id: z.string(), title: z.string(), projectId: z.string().nullable(), status: z.string(), updatedAt: z.number().nullable() });
export type ThreadOption = z.infer<typeof threadOptionSchema>;
export const projectOptionSchema = z.object({ id: z.string(), name: z.string() });
export type ProjectOption = z.infer<typeof projectOptionSchema>;
export const testResultSchema = z.object({ operation: z.string(), ok: z.boolean(), detail: z.string(), ms: z.number() });
export type TestResult = z.infer<typeof testResultSchema>;

const ok = z.object({ ok: z.literal(true) });
const prOut = z.object({ pr: prViewSchema });

export const reviewInputSchema = z.object({
  key,
  presetId: z.string().max(32).optional(),
  /** Per-run overrides of the preset. */
  skill: z.string().max(100).optional(),
  providerId: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  reasoningLevel: z.string().max(40).optional(),
  note: z.string().max(4000).optional(),
  /** Send the review prompt to this existing thread instead of starting one. */
  threadId: z.string().max(100).optional(),
  projectId: z.string().max(100).optional(),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;

// Reads carry tags and writes declare what they invalidate; background syncs invalidate "prs" and "servers" from the server.
const PRS = () => ["prs"];
const CONFIG = () => ["config"];

export const rpcContract = defineRpcContract({
  overview: { input: z.object({}), output: overviewSchema, tags: () => ["prs", "servers", "config"] },
  list: { input: z.object({ section: z.enum(SECTIONS) }), output: z.object({ prs: z.array(prViewSchema) }), tags: PRS },
  detail: { input: z.object({ key }), output: z.object({ pr: prViewSchema, events: z.array(eventViewSchema) }), tags: PRS },
  /** A link or a key such as delta:shop/world#2261179; fetched from its server and kept. */
  lookup: { input: z.object({ query: z.string().min(1).max(500) }), output: prOut, invalidates: PRS },
  activity: { input: z.object({ limit: z.number().int().min(1).max(500).optional() }), output: z.object({ events: z.array(eventViewSchema) }), tags: PRS },
  sync: { input: z.object({}), output: ok, invalidates: () => ["prs", "servers"] },
  link: { input: z.object({ key, threadId: z.string().min(1).max(100), role: z.enum(LINK_ROLES).optional() }), output: prOut, invalidates: PRS },
  unlink: { input: z.object({ key, threadId: z.string().min(1).max(100) }), output: prOut, invalidates: PRS },
  watch: { input: z.object({ key, mode: z.enum(WATCH_MODES).nullable() }), output: prOut, invalidates: PRS },
  review: { input: reviewInputSchema, output: z.object({ threadId: z.string() }), invalidates: PRS },
  /** Start a thread that owns the PR ("own") or reviews it ("review"), and link it. */
  newThread: { input: z.object({ key, start: z.enum(["own", "review"]), projectId: z.string().max(100).optional() }), output: z.object({ threadId: z.string() }), invalidates: PRS },
  /** Clear the PR's Needs you entry until something new happens. */
  dismiss: { input: z.object({ key }), output: prOut, invalidates: PRS },
  threadPrs: { input: z.object({ threadId: z.string().min(1).max(100) }), output: z.object({ prs: z.array(prViewSchema), sent: z.array(eventViewSchema) }), tags: PRS },
  /** Send every pending review item of the thread's watched PRs now, without waiting for the batch window. */
  sendUnread: { input: z.object({ threadId: z.string().min(1).max(100) }), output: z.object({ sent: z.number() }), invalidates: PRS },
  threads: { input: z.object({ query: z.string().max(200).optional() }), output: z.object({ threads: z.array(threadOptionSchema) }) },
  projects: { input: z.object({ key: key.optional() }), output: z.object({ projects: z.array(projectOptionSchema), suggested: z.string().nullable() }) },
  getConfig: { input: z.object({}), output: z.object({ config: configSchema }), tags: CONFIG },
  saveConfig: { input: z.object({ config: z.unknown() }), output: z.object({ config: configSchema }), invalidates: () => ["config", "prs", "servers"] },
  /** Run a server's commands once (a saved server by id, or an unsaved one) and report each. */
  testServer: { input: z.object({ id: z.string().max(32).optional(), server: z.unknown().optional() }), output: z.object({ results: z.array(testResultSchema) }) },
  exportToml: { input: z.object({}), output: z.object({ toml: z.string() }), tags: CONFIG },
  importToml: { input: z.object({ toml: z.string().max(200_000), apply: z.boolean() }), output: z.object({ changes: z.array(z.string()), config: configSchema.nullable() }), invalidates: (input) => (input.apply ? ["config", "prs", "servers"] : []) },
  skills: { input: z.object({ projectId: z.string().max(100).optional() }), output: z.object({ skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })) }) },
});
