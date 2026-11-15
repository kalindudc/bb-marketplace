import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import type { AwayCloseInput } from "../../shared/away";
import type { z } from "zod";
import type { awayDigestInputSchema } from "../../shared/away-rpc";
import type { TavernRuntime } from "../runtime";
import { readAwayDigest } from "./digest";
import { AwayConflict } from "./store";

export function requireAwayClient(context?: ExperimentalPluginRpcHandlerContext) {
  if (context?.experimental_caller.kind !== "client") throw new experimental_PluginRpcRefusal({
    code: "forbidden", message: "Closing time and returning require an explicit client action; a plugin cannot change the away window or answer for you.",
  });
}
export function awayHandlers(runtime: TavernRuntime) {
  return {
    away: () => runtime.away.snapshot(),
    awayClose: async (input: AwayCloseInput, context?: ExperimentalPluginRpcHandlerContext) => {
      requireAwayClient(context);
      try { return await runtime.away.close(input); }
      catch (error) {
        if (!(error instanceof AwayConflict)) throw error;
        return { code: "stale" as const, state: runtime.away.snapshot() };
      }
    },
    awayReturn: async (input: { windowId: string }, context?: ExperimentalPluginRpcHandlerContext) => {
      requireAwayClient(context);
      try { return await runtime.away.return({ kind: "explicit-return", threadId: null, refId: null }, input.windowId); }
      catch (error) {
        if (!(error instanceof AwayConflict)) throw error;
        return { code: "stale" as const, state: runtime.away.snapshot() };
      }
    },
    awayDigest: (input: z.input<typeof awayDigestInputSchema>) => readAwayDigest(runtime.keeper, runtime.away.store, input),
  };
}
