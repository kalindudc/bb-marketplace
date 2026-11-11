// The model an agent thread runs on, as one "provider / model" label, recorded on its row when Loom spawns it.
import type { Spec } from "./spec";

/** "provider / model" with only the parts the spec sets, or null when it sets neither. */
export const modelLabel = ({ provider, model }: { provider?: string; model?: string }): string | null => [provider, model].filter((part) => part !== undefined).join(" / ") || null;

/** The label for a worker or reviewer spawned under `spec`. */
export const spawnModel = (spec: Spec, role: "worker" | "reviewer"): string | null => modelLabel(spec.agents[role]);
