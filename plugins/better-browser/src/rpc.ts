import { z } from "zod";
import { browserInfo, errorCode } from "./contract";
import { defineContract } from "./define-contract";

const issue = z.object({ code: errorCode, message: z.string(), at: z.number() }).strict();

export const syncSummary = z.object({
  at: z.number(),
  status: z.enum(["synced", "unchanged"]),
  set: z.number().int(),
  removed: z.number().int(),
  rejected: z.number().int(),
  cookies: z.number().int(),
  undecryptable: z.number().int(),
  /** The sites whose cookies changed, so a tab can tell whether a sync concerns it. */
  hosts: z.array(z.string()),
  reason: z.enum(["manual", "sign-in", "watch", "tab", "settings"]),
}).strict();
export type SyncSummary = z.infer<typeof syncSummary>;

export const status = z.object({
  supported: z.boolean(),
  browser: z.object({ id: z.string(), name: z.string(), syncable: z.boolean() }).strict().nullable(),
  /** The profile directory sessions come from, once the plugin has resolved it. */
  profile: z.string().nullable(),
  syncing: z.boolean(),
  lastSync: syncSummary.nullable(),
  error: issue.nullable(),
}).strict();
export type Status = z.infer<typeof status>;

const tab = { threadId: z.string().min(1).max(160), tabId: z.string().min(1).max(512) };

export const rpcContract = defineContract({
  status: { input: z.null(), output: status },
  browsers: {
    input: z.null(),
    output: z.object({
      supported: z.boolean(),
      defaultBrowserId: z.string().nullable(),
      browsers: z.array(browserInfo),
      chosen: z.object({ browser: z.string(), profile: z.string() }).strict(),
    }).strict(),
  },
  choose: {
    input: z.object({ browserId: z.string().max(64), profile: z.string().max(4096) }).strict(),
    output: status,
  },
  heartbeat: { input: z.object(tab).strict(), output: status },
  sync: {
    input: z.object({
      threadId: tab.threadId.optional(),
      mode: z.enum(["changes", "full"]),
      reason: z.enum(["manual", "sign-in", "tab"]),
    }).strict(),
    output: status,
  },
  openExternal: {
    input: z.object({ url: z.string().max(8192) }).strict(),
    output: z.union([z.object({ ok: z.literal(true), browser: z.string() }).strict(), z.object({ ok: z.literal(false), message: z.string() }).strict()]),
  },
});

export type RpcContract = typeof rpcContract;

export { STATUS_CHANNEL } from "./channel";
