import { z } from "zod";
import { defineContract } from "./define-contract";
import { settingsChangeSchema } from "./settings";

const heading = "Set up Tavern using the Setup section of the tavern skill.";
export const setupPrompt = (request: string) => `${heading}\n\n${request.trim()}`;
export const isSetupPrompt = (text: string) => text.startsWith(heading + "\n\n") && !!text.slice(heading.length).trim();
export const SETUP_CALLER_NOTICE = "Apply is yours to press. Tavern blocks agents it can recognise, but it can’t tell every agent’s call from your click.";

export const setupLineSchema = z.object({
  key: z.string(), status: z.enum(["pass", "fail", "unchecked"]), message: z.string(),
});
export type SetupLine = z.infer<typeof setupLineSchema>;
const id = z.uuid();
export const setupProposalSchema = z.object({
  id, revision: z.number().int().nonnegative(), state: z.enum(["pending", "stale", "applied", "dismissed"]),
  threadId: z.string().nullable(), classId: z.string().nullable(), proposedAt: z.number().nullable(),
  conflicts: z.array(z.object({ key: z.string(), at: z.number().nullable() })), changes: z.array(settingsChangeSchema.extend({ reason: z.string() })),
  preflight: z.array(setupLineSchema), decisionId: z.string().nullable(), forgeProbe: z.boolean(),
});
export type SetupProposal = z.infer<typeof setupProposalSchema>;
const lookup = z.object({ id }).strict();
const tags = () => ["tavern:setup", "tavern:settings"];
export const setupContract = defineContract({
  setupProposal: { input: lookup, output: setupProposalSchema.nullable(), tags },
  setupPending: { input: z.null(), output: z.array(setupProposalSchema), tags },
  setupProjects: { input: z.null(), output: z.array(z.object({ id: z.string(), name: z.string() })) },
  setupApply: { input: lookup, output: setupProposalSchema },
  setupDismiss: { input: lookup, output: setupProposalSchema },
});
