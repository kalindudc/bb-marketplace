import { useCallback, useEffect, useMemo, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { z } from "zod";
import { findingSchema, VERDICTS } from "../contract";
import { prSeen, rememberSeen } from "./prefs";
import { createStored } from "./remember";

/** The PR view's tabs; Your review shows only on someone else's PR. */
export const PR_TABS = ["overview", "review", "conversation", "checks", "changes", "history"] as const;
export type PrTab = (typeof PR_TABS)[number];

const stateSchema = z.object({
  description: z.boolean(),
  tab: z.enum(PR_TABS),
  agentOpen: z.boolean(),
  /** A fold of one part, named by the scope: a resolved thread, a group of checks, a bot comment. */
  open: z.boolean(),
  /** When this PR was last looked at before now, kept while the view comes and goes. */
  lastLook: z.object({ since: z.number().nullable(), at: z.number() }).nullable(),
  replyOpen: z.boolean(),
  replyText: z.string(),
  comment: z.string(),
  verdict: z.enum(VERDICTS),
  summary: z.string(),
  findings: z.array(findingSchema.extend({ on: z.boolean() })),
});
type PrState = z.infer<typeof stateSchema>;
const statesSchema = z.record(z.string(), stateSchema.partial());
const MAX_STATES = 300;

// Unsent text stays in this browser tab's session, never in the device-wide preferences.
export const prStates = createStored<Record<string, Partial<PrState>>>("pr-state", {}, (value) => {
  const parsed = statesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}, 0, "sessionStorage");

export function usePrState<F extends keyof PrState>(
  prKey: string, field: F, initial: PrState[F] | (() => PrState[F]), scope = "",
): [PrState[F], Dispatch<SetStateAction<PrState[F]>>] {
  const key = JSON.stringify([prKey, scope]);
  const fallback = useMemo(() => typeof initial === "function" ? initial() : initial, [key, field]);
  const snapshot = () => prStates.get()[key]?.[field] ?? fallback;
  const value = useSyncExternalStore(prStates.subscribe, snapshot, snapshot) as PrState[F];
  const set = useCallback<Dispatch<SetStateAction<PrState[F]>>>((next) => {
    const current = prStates.get();
    const previous = current[key]?.[field] ?? fallback;
    const updated = typeof next === "function" ? next(previous as PrState[F]) : next;
    if (Object.is(previous, updated)) return;
    const { [key]: prior, ...rest } = current;
    prStates.set(Object.fromEntries([...Object.entries(rest).slice(-MAX_STATES + 1), [key, { ...prior, [field]: updated }]]));
  }, [key, field, fallback]);
  return [value, set];
}

const VISIT_MS = 30 * 60_000;

/**
 * When the user looked at this PR before this visit, for New marks; null the first time. A visit lasts while
 * its view is recreated or reopened within half an hour, so the marks do not vanish as the view comes back.
 */
export function useSeenSince(prKey: string): number | null {
  const [look, setLook] = usePrState(prKey, "lastLook", null);
  const visiting = look !== null && Date.now() - look.at < VISIT_MS;
  useEffect(() => {
    if (visiting) return;
    const now = Date.now();
    setLook({ since: prSeen.get()[prKey] ?? null, at: now });
    rememberSeen(prKey, now);
  }, [prKey, visiting, setLook]);
  return visiting ? look.since : prSeen.get()[prKey] ?? null;
}

/** Opens a PR's view on `tab` next time it shows, as a link to one of its parts asks. */
export function presetTab(prKey: string, tab: PrTab): void {
  const key = JSON.stringify([prKey, ""]);
  const current = prStates.get();
  const { [key]: prior, ...rest } = current;
  prStates.set(Object.fromEntries([...Object.entries(rest).slice(-MAX_STATES + 1), [key, { ...prior, tab }]]));
}
