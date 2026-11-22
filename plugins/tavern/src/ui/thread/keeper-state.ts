import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import type { ThreadDecor } from "../../shared/contract";
import { stopAllContract, type StopAllState } from "../../shared/stop-all";
import { KEEPER_STATE_HINT } from "../kit";
import { clusterGuardWords, sendGuardWords } from "../kit/member-identity";

export function useKeeperStop(enabled: boolean) {
  const { data } = experimental_useRpcQuery({ contract: stopAllContract, method: "stopAllStatus", input: {}, enabled });
  return data?.state === "stopped" ? data : null;
}

const activity = {
  listening: { word: "Idle", icon: "st-idle", detail: KEEPER_STATE_HINT.idle },
  busy: { word: "Working", icon: "st-work", detail: KEEPER_STATE_HINT.busy },
  holding: { word: "Holding", icon: "st-wait", detail: KEEPER_STATE_HINT.holding },
} as const;

export function keeperState(keeper: NonNullable<ThreadDecor["keeperView"]>, stopped: StopAllState | null) {
  if (stopped) return { word: "Stopped", icon: "block", detail: "Stop all is holding Tavern work.", since: stopped.since } as const;
  if (keeper.quietSince != null) return { word: "Quiet", icon: "pause", detail: KEEPER_STATE_HINT.quiet, since: keeper.quietSince } as const;
  return { ...activity[keeper.status], since: null };
}

export function keeperGuards(scope: ThreadDecor["scope"]) {
  const words = [sendGuardWords(scope), clusterGuardWords(scope)].filter((word): word is string => word !== null);
  const warning = [scope?.sendGuard, scope?.clusterGuard].some(state => state === "restart" || state === "not-prevented");
  return { words, warning };
}
