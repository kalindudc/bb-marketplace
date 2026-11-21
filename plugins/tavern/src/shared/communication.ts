import { z } from "zod";

const name = z.string().min(1).max(200);
const id = z.string().min(1).max(120);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const messageTargetSchema = z.string().trim().min(1).max(4096).refine(value => !/[\u0000-\u001f]/.test(value), "Use one literal target");
export const draftTargetsSchema = z.array(messageTargetSchema).min(1).max(40).refine(items => new Set(items).size === items.length, "List each target once");
export const sendToolRuleSchema = z.object({
  pattern: name.regex(/^[a-zA-Z0-9_./:*\-]+$/).refine(pattern => /[^*]/.test(pattern), "Include a literal part in the tool pattern").optional(),
  shell: name.trim().regex(/^[a-zA-Z0-9_./:-]+(?: +[a-zA-Z0-9_./:-]+)*$/, "Use literal shell command words").optional(),
  act: z.enum(["send", "draft"]),
  targetKey: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,119}$/).optional(),
}).strict().refine(rule => Number(!!rule.pattern) + Number(!!rule.shell) === 1 && (!rule.shell || !rule.targetKey), "Use a tool pattern with an optional target key, or a literal shell prefix");
export const sendToolsSchema = z.array(sendToolRuleSchema).max(100);
export type SendTools = z.infer<typeof sendToolsSchema>;
export const communicationPreviewSchema = z.object({
  act: z.enum(["send", "draft"]), tool: name, target: messageTargetSchema.nullable(),
  body: z.string().max(256 * 1024).nullable(), detail: z.string().max(256 * 1024).optional(),
}).strict();
export const communicationHoldSchema = communicationPreviewSchema.extend({
  id: z.uuid(), threadId: id, scopeIssuedAt: z.number().int().nonnegative(), at: z.number().int().nonnegative(),
  callDigest: digest.nullable(), rulesDigest: digest,
}).strict();
export type CommunicationHold = z.infer<typeof communicationHoldSchema>;
export type CommunicationPreview = z.infer<typeof communicationPreviewSchema>;
export const communicationReceiptSchema = z.object({
  askId: id, callDigest: digest, rulesDigest: digest, scopeIssuedAt: z.number().int().nonnegative(),
  delegationId: id.optional(),
}).strict();
export const communicationAuthoritySchema = z.object({
  questId: id.nullable(), active: z.boolean(), delegationIds: z.array(id).max(100), receipts: z.array(communicationReceiptSchema).max(100),
}).strict();
