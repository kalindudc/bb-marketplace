import { z } from "zod";
import { browserInfo, errorCode, mirrorHosts } from "./contract";
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
const webUrl = z.string().max(8192).regex(/^https?:\/\//i);
const signInEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), onSignInPage: z.boolean(), now: z.number() }).strict(),
  z.object({ type: z.literal("form"), visible: z.boolean().nullable(), now: z.number() }).strict(),
  z.object({ type: z.literal("tick"), now: z.number() }).strict(),
  z.object({ type: z.literal("synced"), set: z.number().int().nonnegative(), now: z.number() }).strict(),
  z.object({ type: z.literal("syncFailed"), now: z.number() }).strict(),
  z.object({ type: z.literal("start"), now: z.number() }).strict(),
  z.object({ type: z.literal("dismiss") }).strict(),
]);
const episode = z.object({
  phase: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("idle") }).strict(),
    z.object({ kind: z.literal("settling"), since: z.number() }).strict(),
    z.object({ kind: z.literal("offer") }).strict(),
    z.object({ kind: z.literal("refreshing"), since: z.number() }).strict(),
    z.object({ kind: z.literal("checking"), since: z.number() }).strict(),
    z.object({ kind: z.literal("waiting"), since: z.number() }).strict(),
    z.object({ kind: z.literal("stalled") }).strict(),
  ]),
  opened: z.boolean(),
  consented: z.boolean(),
  arrived: z.boolean(),
  formVisible: z.boolean().nullable(),
  absentSince: z.number().nullable(),
}).strict();

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
  heartbeat: { input: z.object({ ...tab, focused: z.boolean().default(true) }).strict(), output: status },
  handoff: {
    input: z.object({
      ...tab, mode: z.enum(["automatic", "ask", "off"]), event: signInEvent, targetUrl: webUrl.nullable(), gateway: z.boolean().optional(),
      consentUrl: webUrl.optional(),
    }).strict(),
    output: z.object({
      episode,
      effects: z.array(z.object({ kind: z.enum(["sync", "reload", "open"]) }).strict()).max(3),
      targetUrl: webUrl.nullable(),
      gateway: z.boolean(),
      consentUrl: webUrl.nullable(),
    }).strict(),
  },
  sync: {
    input: z.object({
      threadId: tab.threadId.optional(),
      mode: z.enum(["changes", "full"]),
      reason: z.enum(["manual", "sign-in", "tab"]),
      /** Sites whose cookies bb should hold only as the real browser holds them, during an access gateway's handoff. */
      mirrorHosts: mirrorHosts.optional(),
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
