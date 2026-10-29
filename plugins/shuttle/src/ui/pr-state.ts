import { useCallback, useMemo, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { z } from "zod";
import { findingSchema, VERDICTS } from "../contract";
import { createStored } from "./remember";

const stateSchema = z.object({
  description: z.boolean(),
  details: z.boolean(),
  replyOpen: z.boolean(),
  replyText: z.string(),
  comment: z.string(),
  verdict: z.enum(VERDICTS),
  summary: z.string(),
  findings: z.array(findingSchema.extend({ on: z.boolean() })),
});
type PrState = z.infer<typeof stateSchema>;
const statesSchema = z.record(z.string(), stateSchema.partial());
const MAX_STATES = 100;

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
