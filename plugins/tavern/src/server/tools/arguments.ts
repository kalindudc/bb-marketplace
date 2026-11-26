import { z } from "zod";
import { askOptionSchema, askSchema, decisionSchema, reportFields, reportSchema } from "../../shared/schema";
import { IntakeLimits } from "../../shared/limits";

export const reportInput = (limit: IntakeLimits) => reportFields(limit)
  .pick({ status: true, evidence: true, artifacts: true, wait: true, checkpoint: true })
  .extend({ outcome: z.string().min(1), headline: z.string().trim().min(1).optional(), confidence: reportSchema.shape.confidence.default(null), sourceRouteId: reportSchema.shape.sourceRouteId });
const defaultReportInput = reportInput(new IntakeLimits());
const memberReportParameters = z.toJSONSchema(defaultReportInput.omit({ checkpoint: true })
  .extend({ status: defaultReportInput.shape.status.exclude(["checkpoint"]) }), { io: "input" });

export function reportTool(classId: string) {
  return classId === "ranger" ? "tavern_report" : { name: "tavern_report", parameters: memberReportParameters };
}

const optionShape = "Use a string label or an object with id and label.";
export const askOptionsInput = (shape: typeof askSchema.shape.options) => z.array(z.union([askOptionSchema.shape.label, askOptionSchema], { error: optionShape }),
  { error: "Use an array of string labels or option objects with id and label." })
  .transform((options): z.input<typeof askSchema.shape.options> => {
    const ids = new Set(options.flatMap(option => typeof option === "string" ? [] : [option.id]));
    let next = 0;
    return options.map(option => {
      if (typeof option !== "string") return option;
      let id: string;
      do { id = `option-${++next}`; } while (ids.has(id));
      return { id, label: option, detail: "", recommended: false };
    });
  }).pipe(shape);

export function askArgumentError(error: z.ZodError) {
  const root = error.issues[0];
  const optionIssue = root?.code === "invalid_union" && !root.path.length
    ? root.errors[0]?.find(issue => issue.path[0] === "options")
    : undefined;
  return optionIssue ? argumentError({ issues: [optionIssue] }) : error;
}

const id = z.string().min(1).max(120);
const reason = z.string().trim().min(1).max(500);

function field(ctx: z.RefinementCtx, name: string, message: string) {
  ctx.addIssue({ code: "custom", path: name.split("."), message });
  return z.NEVER;
}

function alias<T extends string>(ctx: z.RefinementCtx, name: string, expected: string, ...values: (T | undefined)[]): T {
  const present = values.filter(value => value !== undefined);
  if (!present.length) return field(ctx, name, expected);
  if (present.some(value => value !== present[0])) return field(ctx, name, "Conflicting values; use this field once.");
  return present[0]!;
}

export function memberInput<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, member: id.optional(), memberThreadId: id.optional() }).strict()
    .transform((value, ctx) => {
      const { member, memberThreadId, ...input } = value as z.output<z.ZodObject<T>> & { member?: string; memberThreadId?: string };
      return { ...input, member: alias(ctx, "member", "Give the member's name or thread id.", member, memberThreadId) };
    });
}

const action = z.enum(["accept", "continue"]).optional();
export const judgeInput = z.object({
  action, op: action, decision: action, reportId: id,
  reason: reason.optional(), minutes: z.number().int().min(1).optional(),
  questionNumbers: z.array(z.number().int().min(1)).min(1).optional(),
}).strict().transform((input, ctx) => {
  const action = alias(ctx, "action", "Choose accept or continue.", input.action, input.op, input.decision);
  if (action === "continue") {
    if (input.minutes === undefined) return field(ctx, "minutes", "Give the next check-in interval.");
    if (input.reason === undefined) return field(ctx, "reason", "Say why the Ranger should continue.");
    return { action, reportId: input.reportId, reason: input.reason, minutes: input.minutes, questionNumbers: input.questionNumbers };
  }
  if (input.minutes !== undefined || input.questionNumbers !== undefined) return field(ctx, "action", "Use continue with minutes or questionNumbers.");
  return { action, reportId: input.reportId, reason: input.reason };
});

const coverageKind = z.enum(["route", "rule", "answer", "plan", "ask"]);
const planVersion = z.number().int().positive();
const consequence = decisionSchema.shape.consequence.unwrap();
const legacyCoverage = z.object({
  kind: coverageKind, id: id.optional(), routeId: id.optional(), ruleId: id.optional(), askId: id.optional(), ref: id.optional(),
  version: planVersion.optional(), waypointId: id.optional(),
}).strict();
const options = decisionSchema.shape.options.unwrap();
const option = options.element;

export const decideInput = (limit: IntakeLimits) => decisionSchema.pick({ reversible: true, source: true, leadPlan: true, exceeds: true, askId: true, optionId: true, kind: true }).extend({
  why: limit.prose(decisionSchema.shape.why),
  text: decisionSchema.shape.text.optional(), decision: decisionSchema.shape.text.optional(),
  boardQuestId: id.nullish(), sourceRef: id.nullish(), source: decisionSchema.shape.source.default("keeper"),
  unsure: decisionSchema.shape.unsure.unwrap(),
  coverageKind: coverageKind.optional(), coverageId: id.optional(), planVersion: planVersion.optional(), waypointId: id.optional(),
  ...consequence.partial().shape, consequence: consequence.optional(), coveredBy: legacyCoverage.optional(),
  options: z.array(z.union([option, z.object({ label: option, id: id.optional() }).strict()])).min(1).optional(),
}).strict().transform((input, ctx) => {
  const { text, decision, coveredBy, coverageKind, coverageId, planVersion, waypointId, change, audience, undo, consequence, options, ...common } = input;
  const summary = alias(ctx, "text", "Give the decision text.", text, decision);
  const flatConsequence = change !== undefined || audience !== undefined || undo !== undefined;
  if (consequence && flatConsequence) return field(ctx, "change", "Use change, audience and undo without consequence.");
  if (change === undefined && !consequence) return field(ctx, "change", "Say what changes.");
  if (audience === undefined && !consequence) return field(ctx, "audience", "Say who is affected.");
  if (undo === undefined && !consequence) return field(ctx, "undo", "Say how to undo the decision.");
  const result = { ...common, text: summary, consequence: consequence ?? { change: change!, audience: audience!, undo: undo! } };
  const flatCoverage = coverageKind !== undefined || coverageId !== undefined || planVersion !== undefined || waypointId !== undefined;
  if (common.askId !== undefined || common.optionId !== undefined || common.kind !== undefined) {
    if (coveredBy || flatCoverage || options || common.exceeds || common.leadPlan) return field(ctx, "askId", "Answer with askId and optionId, without coverage, options, exceeds or leadPlan.");
    if (!common.askId) return field(ctx, "askId", "Give the exact ask id.");
    if (common.optionId === undefined) return field(ctx, "optionId", "Give the exact option id.");
    return result;
  }
  if (coveredBy && flatCoverage) return field(ctx, "coverageKind", "Use flat coverage fields without coveredBy.");
  const kind = coverageKind ?? coveredBy?.kind;
  if (!kind) return field(ctx, "coverageKind", "Choose route, rule, answer or plan.");
  if (!options) return field(ctx, "options", "List the alternatives you considered.");
  type Coverage = z.infer<typeof decisionSchema.shape.coveredBy>;
  let coverage: Coverage;
  if (kind === "plan") {
    const version = planVersion ?? coveredBy?.version, waypoint = waypointId ?? coveredBy?.waypointId;
    if (version === undefined || waypoint === undefined) return field(ctx, "planVersion", "Give planVersion and waypointId for plan coverage.");
    if (coverageId || coveredBy?.id || coveredBy?.routeId || coveredBy?.ruleId || coveredBy?.askId || coveredBy?.ref) return field(ctx, "planVersion", "Use only planVersion and waypointId for plan coverage.");
    coverage = { kind, version, waypointId: waypoint };
  } else {
    if (planVersion !== undefined || waypointId !== undefined || coveredBy?.version !== undefined || coveredBy?.waypointId !== undefined) return field(ctx, "coverageId", "Give the exact receipt id, not a planVersion or waypointId.");
    const type = kind === "ask" ? "answer" : kind;
    const legacyId = type === "route" ? coveredBy?.routeId : type === "rule" ? coveredBy?.ruleId : coveredBy?.askId;
    if (type !== "route" && coveredBy?.routeId || type !== "rule" && coveredBy?.ruleId || type !== "answer" && coveredBy?.askId)
      return field(ctx, "coverageId", "Give an id for the stated coverageKind.");
    coverage = { kind: type, id: alias(ctx, "coverageId", "Give the exact receipt id.", coverageId, coveredBy?.id, coveredBy?.ref, legacyId) };
  }
  return { ...result, coveredBy: coverage, options: options.map(option => typeof option === "string" ? option : option.label) };
});

export function argumentError(error: Pick<z.ZodError, "issues">) {
  return new Error(error.issues.map(issue => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("\n"));
}
