import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TavernRuntime } from "../runtime";
import { toolInput } from "./parameters";

export function registerReady(bb: BbPluginApi, runtime: TavernRuntime): void {
  const draft = z.object({ title: z.string().trim().min(1).max(500), body: z.string().max(100_000).optional(), url: z.string().url().regex(/^https?:\/\//).optional(), forge: z.string().min(1).max(100).optional(), base: z.string().min(1).max(1024).optional() }).strict();
  bb.agents.registerTool({
    name: "tavern_draft_pr",
    description: "Smiths whose placement opens pull requests from home use title and body to open a draft from the committed head tree; uncommitted files are excluded. Otherwise open a draft with your own tools, then supply its url, title and optional base to record it without pushing. Supply forge as gh or a configured profile id when known; omitted forge is recorded as unknown. Base defaults to the source base branch. Opens or records drafts only; never marks ready or merges.",
    parameters: toolInput(draft).parameters,
    execute: async (input, ctx) => runtime.placements().forge.forThread(ctx.threadId, draft.parse(input), ctx.signal),
  });
  bb.agents.registerTool({
    name: "tavern_ready",
    description: "Set up this placed member's provisioned checkout and scope before substantive work. Takes no inputs. Returns the exact carried tree, cwd and detection-only posture, or a visible blocker. Readiness is not a guard-armed receipt.",
    parameters: toolInput(z.object({}).strict()).parameters,
    presentation: { label: { pending: "Preparing member workspace", completed: "Member workspace readiness" } },
    execute: async (_input, ctx) => runtime.placements().ready.forThread(ctx.threadId, ctx.signal),
  });
}
