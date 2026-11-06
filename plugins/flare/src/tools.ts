import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { flaresText } from "./format";
import { KINDS } from "./kinds";
import { BODY_DESCRIPTION, DUPLICATE, SENT, TOOL_DESCRIPTION, TOOL_INSTRUCTIONS, notSaved } from "./notes";
import { truthy, type FlareFields } from "./normalize";
import type { FlareService, SendResult } from "./service";

export const TOOL_TINT = { light: "#b45309", dark: "#f59e0b" };

// The provider validates a call against this schema before bb runs it (pi rejected kind "celebration" against an
// enum in the live check), so it only names the fields: no enum, no required list and no bounds. normalizeFlare and
// the clamps below answer an odd value with a note instead of a failed call.
const flareParameters = {
  type: "object",
  properties: {
    title: { type: "string", description: "Required: one line that stands on its own, about 80 characters." },
    body: { type: "string", description: BODY_DESCRIPTION },
    kind: { type: "string", description: `One of ${KINDS.join(", ")}; finding by default.` },
    notify: { type: "boolean", description: "Also push a notification to the user's devices. Blockers notify without it." },
  },
};

const listParameters = {
  type: "object",
  properties: {
    limit: { type: "integer", description: "How many flares, newest first, from 1 to 50; 10 by default." },
    children: { type: "boolean", description: "Include flares from threads this thread started; true by default." },
  },
};

/** Tool arguments as an object, whatever shape the provider delivered them in. */
export function argumentsOf(params: unknown): Record<string, unknown> {
  let value = params;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function resultText(result: SendResult): string {
  switch (result.status) {
    case "sent":
      return [SENT, ...result.notes].join(" ");
    case "duplicate":
      return DUPLICATE;
    case "refused":
      return result.reason;
    case "failed":
      return notSaved(result.reason);
  }
}

export function registerTools(bb: BbPluginApi, flares: FlareService): void {
  bb.agents.registerTool({
    name: "flare",
    description: TOOL_DESCRIPTION,
    instructions: TOOL_INSTRUCTIONS,
    presentation: {
      label: { pending: "Sending a flare", completed: "Sent a flare" },
      icon: { glyph: "flare/flare" },
      tint: TOOL_TINT,
    },
    parameters: flareParameters,
    // Synchronous on purpose: one row is written and the call returns, whatever happens to the notifications after.
    execute(params, { threadId, projectId }) {
      try {
        const fields: FlareFields = argumentsOf(params);
        return resultText(flares.send({ threadId, projectId: projectId || null, fields, source: "tool" }));
      } catch (error) {
        bb.log.warn(`The flare tool failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        return notSaved("an unexpected error");
      }
    },
  });

  bb.agents.registerTool({
    name: "flare_list",
    description: "Read the flares already sent in this thread, newest first, including those from threads it started.",
    presentation: {
      label: { pending: "Reading flares", completed: "Read flares" },
      icon: { glyph: "flare/flare" },
      suppress: true,
    },
    parameters: listParameters,
    execute(params, { threadId }) {
      const args = argumentsOf(params);
      const requested = Number(args.limit);
      const limit = Number.isFinite(requested) ? Math.min(50, Math.max(1, Math.floor(requested))) : 10;
      const children = args.children === undefined || truthy(args.children) || args.children === 1;
      return flaresText(flares.list(threadId, { limit, children }), threadId, Date.now(), { bodies: "excerpt" });
    },
  });
}
