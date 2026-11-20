import { z } from "zod";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function boundedJson(value: unknown, maxDepth = 32, maxBytes = 32 * 1024): value is Json {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > maxDepth) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null) return false;
    ancestors.add(item);
    const valid = Array.isArray(item)
      ? Array.from(item).every(child => visit(child, depth + 1))
      : Object.values(item).every(child => visit(child, depth + 1));
    ancestors.delete(item);
    return valid;
  };
  return visit(value, 0) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
}

function reservedInputKey(value: unknown, path: PropertyKey[] = []): { key: string; path: PropertyKey[] } | null {
  if (value === null || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) return { key, path };
    const nested = reservedInputKey(child, [...path, Array.isArray(value) ? Number(key) : key]);
    if (nested) return nested;
  }
  return null;
}
function inputPath(path: PropertyKey[]) {
  const start = path.indexOf("rules");
  return (start < 0 ? path : path.slice(start)).reduce<string>((text, part) => {
    if (typeof part === "number") return `${text}[${part}]`;
    const key = String(part);
    return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key) ? `${text}${text ? "." : ""}${key}` : `${text}[${JSON.stringify(key)}]`;
  }, "");
}
export const providerInputsSchema: z.ZodType<Json, Json> = z.any().refine(value => boundedJson(value) && !reservedInputKey(value), {
  error: issue => {
    const reserved = boundedJson(issue.input) ? reservedInputKey(issue.input) : null;
    if (!reserved) return "Use JSON at most 32 levels deep and 32 KiB encoded.";
    const path = [...(issue.path?.length ? issue.path : ["inputs"]), ...reserved.path];
    return `Provider inputs can't use the key ${reserved.key} (${inputPath(path)}): bb's RPC can't carry it`;
  },
});
export const settingsJsonValueSchema: z.ZodType<Json, Json> = z.any().refine(value => boundedJson(value, 64, Infinity), {
  message: "Use JSON at most 64 levels deep.",
});
const id = z.string().min(1).max(100);
const ids = z.array(id).min(1).max(100);
const globs = z.array(z.string().min(1).max(1000)).min(1).max(100);
const cap = z.number().int().min(1).max(1000);

export const placementMatchSchema = z.object({
  projectIds: ids.optional(),
  repoRemotes: globs.optional(),
  keeperPathGlobs: globs.optional(),
  keeperEnvironmentProviders: ids.optional(),
  classes: ids.optional(),
  questIds: ids.optional(),
}).strict();

export const placementMachineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("keeper") }).strict(),
  z.object({ type: z.literal("project-checkout") }).strict(),
  z.object({ type: z.literal("existing"), hostId: id }).strict(),
  z.object({
    type: z.literal("new"), machineProviderId: id,
    inputs: providerInputsSchema.optional(),
  }).strict(),
]);

export const placementTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).strict(),
  z.object({
    kind: z.literal("provider"), environmentProviderId: id,
    inputs: providerInputsSchema.optional(),
    machine: placementMachineSchema,
    workspace: z.enum(["linked-worktree", "dedicated-machine"]),
  }).strict(),
]);

export const placementConsentSchema = z.object({
  guardInstall: z.boolean().default(false),
  remoteDetectionOnly: z.boolean().default(false),
  linuxUncontainedChecks: z.boolean().default(false),
}).strict();
const noConsent = {
  guardInstall: false, remoteDetectionOnly: false, linuxUncontainedChecks: false,
};

export const forgeProfileSchema = z.discriminatedUnion("kind", [
  z.object({ id: id.regex(/^[a-z][a-z0-9-]{0,31}$/), name: z.string().min(1).max(200), enabled: z.boolean().default(true), kind: z.literal("github") }).strict(),
  z.object({ id: id.regex(/^[a-z][a-z0-9-]{0,31}$/), name: z.string().min(1).max(200), enabled: z.boolean().default(true), kind: z.literal("command"), open: z.string().trim().min(1).max(16000), state: z.string().trim().min(1).max(16000).optional(), close: z.string().trim().min(1).max(16000).optional() }).strict(),
]);
export type ForgeProfile = z.infer<typeof forgeProfileSchema>;
export const pullRequestsSchema = z.discriminatedUnion("at", [
  z.object({ at: z.literal("member") }).strict(),
  z.object({ at: z.literal("home"), profile: id }).strict(),
]);

export const classModelSchema = z.object({
  provider: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(1000),
  reasoning: z.string().trim().min(1).max(100).optional(),
}).strict();
export const placementRuleSchema = z.object({
  id: id.regex(/^[a-z][a-z0-9-]{0,63}$/),
  label: z.string().min(1).max(200),
  enabled: z.boolean(),
  match: placementMatchSchema,
  target: placementTargetSchema,
  consent: placementConsentSchema.default(noConsent),
  pullRequests: pullRequestsSchema.default({ at: "member" }),
  classModels: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), classModelSchema).default({}),
}).strict().superRefine((rule, ctx) => {
  const target = rule.target;
  if (target.kind === "provider" && target.workspace === "dedicated-machine" &&
      target.machine.type !== "new") {
    ctx.addIssue({ code: "custom", path: ["target", "workspace"],
      message: "Dedicated-machine placement needs a new machine for this member." });
  }
  if (rule.enabled && target.kind === "provider" && target.machine.type === "new" &&
      (!rule.consent.guardInstall || !rule.consent.remoteDetectionOnly ||
       !rule.consent.linuxUncontainedChecks)) {
    ctx.addIssue({ code: "custom", path: ["consent"],
      message: "Confirm this rule's marked guard install, remote detection-only execution and Linux checks without containment." });
  }
});

const rules = z.array(placementRuleSchema).max(50);
function uniqueRuleIds(value: { rules?: Array<{ id: string }> }, ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  value.rules?.forEach((rule, index) => {
    if (seen.has(rule.id)) ctx.addIssue({ code: "custom", path: ["rules", index, "id"],
      message: "Rule IDs must be unique." });
    seen.add(rule.id);
  });
}
function validForges(value: { rules?: z.infer<typeof placementRuleSchema>[]; forges?: ForgeProfile[] }, ctx: z.RefinementCtx) {
  const ids = new Set<string>();
  value.forges?.forEach((forge, index) => {
    if (ids.has(forge.id)) ctx.addIssue({ code: "custom", path: ["forges", index, "id"], message: "Forge IDs must be unique." });
    ids.add(forge.id);
  });
  if (value.forges === undefined) return;
  value.rules?.forEach((rule, index) => {
    const location = rule.pullRequests;
    if (location.at === "home" && !value.forges?.some(forge => forge.id === location.profile && forge.enabled))
      ctx.addIssue({ code: "custom", path: ["rules", index, "pullRequests"], message: "Choose an enabled forge profile that exists." });
  });
}
export const placementSettingsSchema = z.object({
  maxMakers: cap.default(2),
  maxCheckers: cap.default(2),
  rules: rules.default([]),
  forges: z.array(forgeProfileSchema).max(50).default([]),
}).strict().superRefine(uniqueRuleIds).superRefine(validForges);
export const placementSettingsPatchSchema = z.object({
  maxMakers: cap.optional(),
  maxCheckers: cap.optional(),
  rules: rules.optional(),
  forges: z.array(forgeProfileSchema).max(50).optional(),
}).strict().superRefine(uniqueRuleIds);

export type PlacementRule = Omit<z.infer<typeof placementRuleSchema>, "pullRequests" | "classModels"> & { pullRequests?: z.infer<typeof pullRequestsSchema>; classModels?: Record<string, z.infer<typeof classModelSchema>> };
export type PlacementSettings = z.infer<typeof placementSettingsSchema>;
export type PlacementSettingsPatch = Omit<z.infer<typeof placementSettingsPatchSchema>, "rules"> & { rules?: PlacementRule[] };

export const placementPolicyReadSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("valid"), revision: z.number().int().nonnegative(), settings: placementSettingsSchema }).strict(),
  z.object({ state: z.literal("invalid"), revision: z.number().int().nonnegative(),
    problems: z.array(z.object({ path: z.string(), message: z.string() }).strict()) }).strict(),
]);
export type PlacementPolicyRead = z.infer<typeof placementPolicyReadSchema>;
