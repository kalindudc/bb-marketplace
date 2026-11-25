import { z } from "zod";
import { communicationAuthoritySchema, sendToolsSchema } from "../shared/communication";
import { gitOidSchema, workspaceKindSchema } from "../shared/placement";

export const scopeModeSchema = z.enum(["enforce", "watch", "off"]);
export const PRESETS = ["readonly", "checker", "worktree", "keeper", "open"] as const;
const patterns = z.array(z.string().min(1).max(1000)).max(200);
const regex = z.string().max(2000).refine(value => {
  try { new RegExp(value); return true; } catch { return false; }
}, "Invalid scope regular expression");
export const shellRuleSchema = z.object({
  id: z.string().min(1).max(100),
  argv: z.array(z.union([z.string(), z.array(z.string()).min(1)])).min(1).optional(),
  regex: regex.optional(),
  remote: z.string().optional(),
  requires: z.array(z.string()).optional(),
  why: z.string().min(1).max(1000),
}).strict().refine(rule => rule.argv !== undefined || rule.regex !== undefined, "A rule needs argv or regex");
export const prGrantIdSchema = z.string().regex(/^[a-zA-Z\d_-]{1,120}$/);
export const prGrantSchema = z.object({ id: prGrantIdSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const pullRequestPolicySchema = z.object({ alwaysAsk: z.boolean(), owned: z.array(z.url()).max(1000), grants: z.array(prGrantSchema).max(100) }).strict();
export const scopeSchema = z.object({
  v: z.literal(1),
  threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  role: z.string().min(1),
  preset: z.enum(PRESETS),
  issuedAt: z.number().int().nonnegative(),
  failClosed: z.literal(true),
  mode: scopeModeSchema.default("enforce"),
  commandTools: patterns.default(["bash", "Bash"]),
  expectedWorktree: z.string().optional(),
  writeRootIdentity: z.record(z.string(), z.string()).optional(),
  assignedBranch: z.string().min(1).max(1000).optional(),
  pullRequestPolicy: pullRequestPolicySchema.optional(),
  sendTools: sendToolsSchema.optional(),
  communicationAuthority: communicationAuthoritySchema.optional(),
  workspaceKind: workspaceKindSchema.optional(),
  checks: z.object({ worktree: z.string().min(1).optional(), commands: z.array(z.string().min(1).max(8000)).max(100) }).strict().optional(),
  controlRoots: z.array(z.string()).optional(),
  enforceFrom: z.number().int().nonnegative().optional(),
  writes: z.object({ mode: z.enum(["none", "worktree", "paths", "any"]), allow: patterns, deny: patterns }).strict(),
  tools: z.object({ allow: patterns, deny: patterns, hide: z.boolean() }).strict(),
  shell: z.object({ deny: z.array(shellRuleSchema).max(200), allow: z.array(shellRuleSchema).max(200) }).strict(),
  network: z.enum(["any", "none"]),
  github: z.enum(["none", "read", "draft-pr-only"]),
  env: z.object({ poisonGh: z.boolean(), blockGitPush: z.boolean(), variables: z.record(z.string(), z.string()).default({}) }).strict(),
  sandbox: z.boolean(),
  onViolation: z.literal("block"),
}).strict();
export const scopeHostBindingSchema = z.object({
  placementId: z.string().min(1).max(200).refine(value => !/[\0\r\n]/.test(value)),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  endpointId: z.string().min(1).max(200).refine(value => !/[\0\r\n]/.test(value)),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ScopeHostBinding = z.infer<typeof scopeHostBindingSchema>;
export const scopeHostTargetSchema = scopeHostBindingSchema.pick({ placementId: true, generation: true }).extend({ kind: z.literal("host") });
export const scopeControllerBindingSchema = z.object({ kind: z.literal("host"), placementId: scopeHostTargetSchema.shape.placementId.nullable(), generation: scopeHostTargetSchema.shape.generation.nullable() }).strict().refine(value => (value.placementId === null) === (value.generation === null), "Host placement and generation must be known together");
export type ScopeHostTarget = z.infer<typeof scopeHostTargetSchema>;
export type ScopeControllerBinding = z.infer<typeof scopeControllerBindingSchema>;
export const scopeWorkspaceBindingSchema = scopeHostBindingSchema.pick({ placementId: true, generation: true }).extend({
  kind: workspaceKindSchema, hostId: scopeHostBindingSchema.shape.endpointId, environmentId: scopeHostBindingSchema.shape.endpointId,
  root: z.string().min(1).max(32_768).regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/).refine(value => !/[\0\r\n]/.test(value)),
  snapshotId: scopeHostBindingSchema.shape.endpointId.nullable(), expectedTree: gitOidSchema.nullable(),
}).strict().refine(value => (value.snapshotId === null) === (value.expectedTree === null), "Snapshot and expected tree must be pinned together.");
export const scopeBindingEndpointsSchema = z.object({ threadStorage: scopeHostBindingSchema.shape.endpointId.optional() }).strict();
export const scopeDeliveryFileSchema = scopeSchema.extend({ bindingTemplate: scopeSchema, workspaceBinding: scopeWorkspaceBindingSchema, bindingEndpoints: scopeBindingEndpointsSchema.optional() }).strict().superRefine((value, ctx) => {
  const { bindingTemplate, workspaceBinding, bindingEndpoints: _endpoints, ...template } = value;
  if (JSON.stringify(template) !== JSON.stringify(bindingTemplate)) ctx.addIssue({ code: "custom", path: ["bindingTemplate"], message: "An incoming delivery must contain its original unbound template, not controller-bound or changed policy." });
  if ((value.preset === "checker" || value.role === "warden") && workspaceBinding.snapshotId === null) ctx.addIssue({ code: "custom", path: ["workspaceBinding", "snapshotId"], message: "A checker requires its pinned snapshot and expected tree." });
});
export type ScopeWorkspaceBinding = z.infer<typeof scopeWorkspaceBindingSchema>;
export type ScopeBindingEndpoints = z.infer<typeof scopeBindingEndpointsSchema>;
export type ScopeDeliveryFile = z.infer<typeof scopeDeliveryFileSchema>;
export const scopeRenderedFileSchema = scopeSchema.extend({ bindingTemplate: scopeSchema, hostBinding: scopeHostBindingSchema }).strict().refine(value => value.bindingTemplate.threadId === value.threadId && value.bindingTemplate.issuedAt === value.issuedAt, "Rendered scope template identity must match its bound scope");
export type ScopeRenderedFile = z.infer<typeof scopeRenderedFileSchema>;
export const presetProvenanceSchema = z.object({ id: z.enum(PRESETS), version: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const scopeFileSchema = scopeSchema.extend({ presetProvenance: presetProvenanceSchema.optional(), bindingTemplate: scopeSchema.optional(), bindingError: z.string().optional(), controllerBinding: scopeControllerBindingSchema.optional() }).refine(value => !value.bindingTemplate || value.bindingTemplate.threadId === value.threadId && value.bindingTemplate.issuedAt === value.issuedAt, "Scope template identity must match its bound scope");
export type Scope = z.infer<typeof scopeSchema>;
export type ShellRule = z.infer<typeof shellRuleSchema>;

export const scopeNarrowingSchema = z.object({
  tools: z.object({ allow: patterns.optional(), deny: patterns.optional() }).strict().optional(),
  writes: z.object({ allow: patterns.optional(), deny: patterns.optional() }).strict().optional(),
  shell: z.object({ deny: z.array(shellRuleSchema).max(200) }).strict().optional(),
  network: z.literal("none").optional(),
}).strict();
export type ScopeNarrowing = z.infer<typeof scopeNarrowingSchema>;
export const scopeOverrideSchema = z.object({
  allowRules: z.array(z.string().min(1).max(100)).max(100).optional(),
  denyRules: z.array(shellRuleSchema).max(100).optional(),
  tools: z.object({ allow: patterns.optional(), deny: patterns.optional(), removeAllow: patterns.optional(), removeDeny: patterns.optional() }).strict().optional(),
  writes: z.object({ allow: patterns.optional(), deny: patterns.optional() }).strict().optional(),
}).strict();
export type ScopeOverride = z.infer<typeof scopeOverrideSchema>;

export const classScopeSchema = z.union([
  z.enum(PRESETS),
  scopeNarrowingSchema.extend({ preset: z.enum(PRESETS) }),
]);
export type ClassScope = z.infer<typeof classScopeSchema>;
