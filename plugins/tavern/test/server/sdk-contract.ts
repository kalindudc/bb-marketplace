import { z } from "zod";

const id = z.string().min(1);
const pluginId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const signal = z.instanceof(AbortSignal).optional();
const json = z.json();
const metadata = z.record(z.string(), json).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024, "pluginMetadata exceeds 256 KiB");
const prompt = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), mentions: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), resource: z.object({ kind: id, label: z.string() }).passthrough() })).optional(), visibility: z.literal("agent-only").optional() }),
  z.object({ type: z.literal("image"), url: z.string().url(), visibility: z.literal("agent-only").optional() }),
  z.object({ type: z.literal("localImage"), path: z.string(), hostId: id.optional(), sourceProjectId: id.optional(), visibility: z.literal("agent-only").optional() }),
  z.object({ type: z.literal("localFile"), path: z.string(), hostId: id.optional(), sourceProjectId: id.optional(), name: z.string().optional(), sizeBytes: z.number().int().nonnegative().optional(), mimeType: z.string().optional(), visibility: z.literal("agent-only").optional() }),
]);
const worktreeBranch = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: id }).strict(),
  z.object({ kind: z.literal("default") }).strict(),
]);
const worktreeInputs = z.union([
  z.object({ kind: z.literal("existing"), path: id }).strict(),
  z.object({ branch: worktreeBranch.optional() }).strict(),
]);
const environment = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reuse"), environmentId: id }),
  z.object({ type: z.literal("project-default") }),
  z.object({ type: z.literal("host"), hostId: id.optional(), workspace: z.discriminatedUnion("type", [
    z.object({ type: z.literal("unmanaged"), path: z.string().trim().min(1).nullable(), branch: z.discriminatedUnion("kind", [z.object({ kind: z.literal("existing"), name: id }), z.object({ kind: z.literal("new"), baseBranch: id })]).optional() }),
    z.object({ type: z.literal("managed-worktree"), baseBranch: z.discriminatedUnion("kind", [z.object({ kind: z.literal("named"), name: id }), z.object({ kind: z.literal("default") })]) }),
    z.object({ type: z.literal("personal") }),
  ]) }),
  z.object({ type: z.literal("provider"), environmentProviderId: id, inputs: json.optional(), machine: z.discriminatedUnion("type", [z.object({ type: z.literal("existing"), hostId: id }), z.object({ type: z.literal("new"), machineProviderId: id, inputs: json.optional() })]).optional() }),
]);
const execution = { model: z.string().optional(), providerId: z.string().optional(), reasoningLevel: z.string().optional(), serviceTier: z.string().optional(), permissionMode: z.enum(["auto", "accept-edits", "full", "workspace-write"]).optional() };
const submission = z.object({ pluginId, data: json }).optional();
const thread = z.object({ threadId: id, signal });
const routing = { environmentId: id.optional(), projectId: id.optional(), hostId: id.optional(), signal };
const digits = z.string().regex(/^\d+$/);
export const SDK_CONTRACTS: Record<string, z.ZodType> = {
  "threads.spawn": z.object({ projectId: id, environment, input: z.array(prompt).optional(), prompt: z.string().optional(), ...execution, parentThreadId: id.optional(), parentNotifications: z.enum(["auto", "off", "stuck"]).optional(), title: id.optional(), pluginMetadata: metadata.optional(), pluginSubmission: submission, origin: z.enum(["app", "cli", "sdk", "plugin"]).optional(), originPluginId: id.optional(), originKind: z.literal("fork").nullable().optional(), sourceSeqEnd: z.number().int().nonnegative().optional(), sendAt: z.number().int().nonnegative().optional() }).superRefine((value, ctx) => {
    if ((value.input === undefined) === (value.prompt === undefined)) ctx.addIssue({ code: "custom", message: "Provide exactly one of input or prompt" });
    if (value.originKind == null && value.input?.length === 0) ctx.addIssue({ code: "custom", message: "input must contain at least one entry", path: ["input"] });
    if (value.originKind == null && value.sourceSeqEnd !== undefined) ctx.addIssue({ code: "custom", message: "sourceSeqEnd requires an originKind" });
    if (value.environment.type === "provider" && value.environment.environmentProviderId === "git-worktree" && value.environment.inputs !== undefined) {
      const result = worktreeInputs.safeParse(value.environment.inputs);
      if (!result.success) ctx.addIssue({ code: "custom", message: `git-worktree inputs: ${result.error.message}`, path: ["environment", "inputs"] });
    }
  }),
  "threads.send": thread.extend({ input: z.array(prompt).min(1), mode: z.enum(["auto", "steer", "queue-if-active"]), ...execution, pluginSubmission: submission, senderThreadId: id.optional(), sendAt: z.number().int().nonnegative().optional(), compactFirst: z.literal(true).optional() }),
  "threads.get": thread,
  "threads.update": thread.extend({ model: z.string().nullable().optional(), reasoningLevel: z.string().nullable().optional(), title: z.string().nullable().optional() }).strict(),
  "threads.stop": thread,
  // The voice check deletes only the hidden threads it recorded; childThreadsConfirmed false makes bb refuse one that has children.
  "threads.delete": z.object({ threadId: id, childThreadsConfirmed: z.literal(false) }).strict(),
  "threads.archive": thread,
  "threads.defaultExecutionOptions": thread,
  "threads.storageLocation": thread,
  "threads.queuedMessages.list": thread,
  "threads.queuedMessages.delete": thread.extend({ queuedMessageId: id }),
  "threads.getPluginMetadata": thread.extend({ pluginId: pluginId.optional() }),
  "threads.updatePluginMetadata": thread.extend({ pluginId: pluginId.optional(), set: metadata.optional(), remove: z.array(z.string()).optional() }).superRefine((value, ctx) => {
    if (value.remove && new Set(value.remove).size !== value.remove.length) ctx.addIssue({ code: "custom", message: "remove contains duplicate keys" });
    if (value.remove?.some(key => value.set && Object.hasOwn(value.set, key))) ctx.addIssue({ code: "custom", message: "set and remove overlap" });
  }),
  "threads.list": z.object({ ...routing, parentThreadId: id.optional(), originPluginId: id.optional(), archived: z.boolean().optional(), includeHidden: z.boolean().optional(), limit: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().optional() }).optional(),
  "threads.events.list": thread.extend({ afterSeq: digits.optional(), beforeSeq: digits.optional(), limit: digits.refine(value => Number(value) <= 100, "Thread event limit cannot exceed 100").optional(), order: z.enum(["asc", "desc"]).optional(), types: z.array(z.enum(["item/started", "item/completed", "client/turn/requested", "system/thread/interrupted", "thread/compacted", "turn/started", "turn/mainRun/updated", "turn/completed"])).optional() }),
  "environments.get": z.object({ environmentId: id, signal }),
  "environments.listProviders": z.object({ projectId: id.optional(), hostId: id.optional(), signal }).superRefine((value, ctx) => {
    if (value.hostId !== undefined && value.projectId === undefined) ctx.addIssue({ code: "custom", message: "hostId requires projectId", path: ["hostId"] });
  }).optional(),
  "hosts.get": z.object({ hostId: id, signal }),
  "hosts.experimental_listProviders": z.object({ signal }).optional(),
  "hosts.list": z.object({ includeCreating: z.boolean().optional(), type: z.enum(["ephemeral", "persistent"]).optional(), signal }).optional(),
  "projects.get": z.object({ projectId: id, signal }),
  "projects.list": z.object({ include: z.string().optional(), includePersonal: z.boolean().optional(), signal }).optional(),
  "system.config": z.object({ signal }).optional(),
  "providers.list": z.object(routing).optional(),
  "providers.models": z.object({ ...routing, providerId: id }),
  "plugins.list": z.object({ signal }).optional(),
  "plugins.callRpc": z.object({ pluginId, method: id, input: json.optional(), signal }),
  "files.read": z.object({ hostId: id, path: id, signal }),
  "files.write": z.object({ hostId: id, path: id, content: z.string(), contentEncoding: z.enum(["utf8", "base64"]).optional(), signal }),
};
export class SdkContractError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_request") { super(message); }
}
export function validateSdkCall(path: string, args: unknown[]) {
  const schema = SDK_CONTRACTS[path];
  if (!schema) throw new Error(`No audited SDK contract for ${path}`);
  const result = schema.safeParse(args[0]);
  if (!result.success) throw new SdkContractError(`${path}: ${result.error.message}`);
}
