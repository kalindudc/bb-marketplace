import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { requireUserAct, type UserActReceipt } from "../authority";
import type { AwayCloseInput } from "../../shared/away";
import type { z } from "zod";
import type { awayDigestInputSchema } from "../../shared/away-rpc";
import type { TavernRuntime } from "../runtime";
import { readAwayDigest } from "./digest";
import { AwayConflict } from "./store";

export function requireAwayClient(context?: ExperimentalPluginRpcHandlerContext) {
  return requireUserAct(context, "awayReturn");
}
export function awayHandlers(runtime: TavernRuntime) {
  return {
    away: () => runtime.away.snapshot(),
    awayClose: async (input: AwayCloseInput, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      requireAwayClient(context);
      try { return await runtime.away.close(input, receipt); }
      catch (error) {
        if (!(error instanceof AwayConflict)) throw error;
        return { code: "stale" as const, state: runtime.away.snapshot() };
      }
    },
    awayReturn: async (input: { windowId: string }, context?: ExperimentalPluginRpcHandlerContext, receipt?: UserActReceipt) => {
      requireAwayClient(context);
      try { return await runtime.away.return({ kind: "explicit-return", threadId: null, refId: null }, input.windowId, receipt); }
      catch (error) {
        if (!(error instanceof AwayConflict)) throw error;
        return { code: "stale" as const, state: runtime.away.snapshot() };
      }
    },
    awayDigest: (input: z.input<typeof awayDigestInputSchema>) => readAwayDigest(runtime.keeper, runtime.away.store, input),
  };
}
