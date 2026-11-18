import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TavernRuntime } from "../runtime";

export function registerReady(bb: BbPluginApi, runtime: TavernRuntime): void {
  bb.agents.registerTool({
    name: "tavern_ready",
    description: "Set up this placed member's provisioned checkout and scope before substantive work. Takes no inputs. Returns the exact carried tree, cwd and detection-only posture, or a visible blocker. Readiness is not a guard-armed receipt.",
    parameters: z.toJSONSchema(z.object({}).strict(), { io: "input" }),
    presentation: { label: { pending: "Preparing member workspace", completed: "Member workspace readiness" } },
    execute: async (_input, ctx) => runtime.placements().ready.forThread(ctx.threadId, ctx.signal),
  });
}
