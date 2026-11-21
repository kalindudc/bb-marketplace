import { z } from "zod";

export const SHELL_GRANT_ACTS = ["merge", "publish", "deploy", "send", "delete", "configure", "credential"] as const;
export const shellGrantActSchema = z.enum(SHELL_GRANT_ACTS);
export const shellGrantTargetSchema = z.object({
  act: shellGrantActSchema,
  command: z.string().min(1).max(8000),
  cwd: z.string().min(1).max(4000),
  destinations: z.array(z.string().min(1).max(2000)).max(16).optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ShellGrantTarget = z.infer<typeof shellGrantTargetSchema>;
export const shellGrantSchema = z.object({
  id: z.string().min(1).max(120),
  keeperThreadId: z.string().min(1),
  memberThreadId: z.string().min(1),
  boardQuestId: z.string().min(1),
  target: shellGrantTargetSchema,
  scope: z.enum(["once", "quest"]),
  state: z.enum(["issued", "used", "expired", "revoked"]),
  by: z.enum(["user", "keeper"]),
  issuedAt: z.number().int().nonnegative(),
  changedAt: z.number().int().nonnegative(),
}).strict();
export type ShellGrant = z.infer<typeof shellGrantSchema>;
