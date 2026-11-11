// The worker's structured ask on loom_block: an optional question, the options it sees with what each one leads to, and
// the one it recommends. It is stored on the block post beside the reason, so the page can draw the question as a form
// with the worker's pick preselected. A block without it keeps today's prose and offers no options.
import { z } from "zod";
import type { PostRow } from "./db/store";
import { LoomError } from "./projects";

export const MAX_ASK_OPTIONS = 4;

export const blockAskSchema = {
  question: z.string().trim().min(1).max(300).optional().describe("The one question the human answers, in a sentence, such as \"How should the 2M-row memory check run?\"."),
  options: z
    .array(
      z
        .object({
          label: z.string().trim().min(1).max(120).describe("The option in a few words, such as \"Nightly runner for 2M rows; 200k rows in CI\"."),
          consequence: z.string().trim().min(1).max(200).optional().describe("What choosing it leads to, in a few words, such as \"nightly runner has 200 GB\"."),
        })
        .strict(),
    )
    .min(2)
    .max(MAX_ASK_OPTIONS)
    .optional()
    .describe(`The answers you see, 2 to ${MAX_ASK_OPTIONS}, each with what it leads to. The human picks one, or writes their own.`),
  recommended: z.number().int().min(1).max(MAX_ASK_OPTIONS).optional().describe("The option you recommend, by its number in options (1 is the first)."),
};

export interface BlockAsk {
  question: string | null;
  options: Array<{ label: string; consequence: string | null }>;
  /** The option the worker recommends, as an index into options; null when it named none. */
  recommended: number | null;
}

/** The ask a worker passed to loom_block, checked: a recommendation must name one of its options. Null when it gave none. */
export function blockAskOf(input: { question?: string | undefined; options?: Array<{ label: string; consequence?: string | undefined }> | undefined; recommended?: number | undefined }): BlockAsk | null {
  const question = input.question?.trim() || null;
  const options = (input.options ?? []).map((option) => ({ label: option.label.trim(), consequence: option.consequence?.trim() || null }));
  if (input.recommended !== undefined && input.recommended > options.length) throw new LoomError("loom_invalid_input", `recommended is ${input.recommended}, but there ${options.length === 1 ? "is 1 option" : `are ${options.length} options`}. Name one of them by its number, or leave recommended out.`);
  if (question === null && options.length === 0) return null;
  return { question, options, recommended: input.recommended === undefined ? null : input.recommended - 1 };
}

const isAsk = (value: unknown): value is BlockAsk => {
  if (typeof value !== "object" || value === null) return false;
  const ask = value as Partial<BlockAsk>;
  return (ask.question === null || typeof ask.question === "string") && Array.isArray(ask.options) && ask.options.every((option) => typeof option?.label === "string") && (ask.recommended === null || typeof ask.recommended === "number");
};

/** The ask on the newest block post, the one the ticket is blocked by; null when that block carries prose only. */
export function askOfPosts(posts: readonly Pick<PostRow, "kind" | "data_json">[]): BlockAsk | null {
  const block = posts.filter((post) => post.kind === "block").at(-1);
  if (block === undefined) return null;
  const ask = (JSON.parse(block.data_json) as { ask?: unknown }).ask;
  if (!isAsk(ask)) return null;
  return { question: ask.question, options: ask.options.map((option) => ({ label: option.label, consequence: option.consequence ?? null })), recommended: ask.recommended !== null && ask.recommended < ask.options.length ? ask.recommended : null };
}
