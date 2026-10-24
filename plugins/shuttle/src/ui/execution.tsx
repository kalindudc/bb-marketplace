import { useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker, experimental_useProviders,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { BUTTON, BUTTON_GHOST } from "./common";

export type Execution = ExperimentalProviderModelPickerValue;

/** A preset's agent fields; all unset means bb's default agent, model and thinking level. */
interface ExecutionFields {
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
}

export const executionOf = (fields: ExecutionFields): Execution | null =>
  fields.providerId && fields.model ? { providerId: fields.providerId, model: fields.model, reasoningLevel: fields.reasoningLevel ?? "" } : null;

/** The fields with the execution in them; RPC input is strict JSON, so an unset field is left out rather than undefined. */
export function withExecution<T extends ExecutionFields>(fields: T, execution: Execution | null): T {
  const { providerId: _provider, model: _model, reasoningLevel: _level, ...rest } = fields;
  if (execution === null) return rest as T;
  return { ...rest, providerId: execution.providerId, model: execution.model, ...(execution.reasoningLevel === "" ? {} : { reasoningLevel: execution.reasoningLevel }) } as T;
}

/** bb's own agent and model picker, or "bb default" with a way to pick one. */
export function ExecutionPicker({ value, onChange, resetLabel }: { value: Execution | null; onChange(next: Execution | null): void; resetLabel: string | null }) {
  const providers = experimental_useProviders();
  const [seed, setSeed] = useState<Execution | null>(null);
  const shown = value ?? seed;
  if (shown === null) {
    const first = providers.providers.find((provider) => provider.available) ?? null;
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span data-execution="default" className="text-muted-foreground">bb default: the agent, model and thinking level bb starts new threads with</span>
        <button type="button" className={BUTTON} disabled={first === null}
          title={first === null ? (providers.status === "loading" ? "Loading agents…" : "No agent is available") : undefined}
          onClick={() => first !== null && setSeed({ providerId: first.id, model: "", reasoningLevel: "" })}>
          Choose an agent and model
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProviderModelPicker value={shown} onChange={(next) => { setSeed(null); onChange(next); }} />
      {value === null
        ? <button type="button" className={BUTTON_GHOST} onClick={() => setSeed(null)}>Cancel</button>
        : resetLabel !== null && <button type="button" className={BUTTON_GHOST} onClick={() => { setSeed(null); onChange(null); }}>{resetLabel}</button>}
    </div>
  );
}
