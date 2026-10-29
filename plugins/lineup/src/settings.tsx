import { useEffect, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useProviders,
  useSdk,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { inLineup, MAX_LINEUP, modelKey, moveModel, resolveModel, toggleModel, type ModelRef } from "./lineup";
import { useLineupStore } from "./store";

/** A starting value for bb's picker: the first provider's default model. */
function useInitialPick(): ExperimentalProviderModelPickerValue | null {
  const sdk = useSdk();
  const { providers } = experimental_useProviders();
  const providerId = providers[0]?.id;
  const [pick, setPick] = useState<ExperimentalProviderModelPickerValue | null>(null);
  useEffect(() => {
    if (providerId === undefined) return;
    let live = true;
    sdk.providers.models({ providerId }).then(
      (result) => {
        const model = result.models.find((candidate) => candidate.isDefault) ?? result.models[0];
        if (live && model !== undefined) {
          setPick({ providerId, model: model.model, reasoningLevel: model.defaultReasoningEffort });
        }
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sdk, providerId]);
  return pick;
}

/** Reorder, remove and add lineup models; pins in the model menu do the same in place. */
export function LineupSettings() {
  const store = useLineupStore();
  const initialPick = useInitialPick();
  const [pick, setPick] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const { refreshCatalog } = store;
  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);
  useEffect(() => {
    if (pick === null && initialPick !== null) setPick(initialPick);
  }, [pick, initialPick]);

  if (store.state === null) return <p className="text-sm text-muted-foreground">Loading your lineup…</p>;
  const lineup = store.state.lineup;
  const catalog = store.catalog ?? [];
  const save = (next: ModelRef[]) => store.saveLineup(next);
  const chosen = pick === null ? null : { providerId: pick.providerId, model: pick.model };
  const already = chosen !== null && inLineup(lineup, chosen);
  const full = lineup.length >= MAX_LINEUP;

  return (
    <div className="flex flex-col gap-3">
      {lineup.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Your lineup is empty. Hover a model in the composer's model menu and click its pin, or add one below.
        </p>
      ) : (
        <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {lineup.map((ref, index) => {
            const model = resolveModel(catalog, ref);
            const name = model?.name ?? ref.model;
            return (
              <li key={modelKey(ref)} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">{name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {model === null ? `${ref.providerId} · not offered on this machine` : `${model.providerName} · ${ref.model}`}
                  </span>
                </span>
                <IconButton icon="ArrowUp" label={`Move ${name} up`} disabled={index === 0} onClick={() => save(moveModel(lineup, ref, -1))} />
                <IconButton
                  icon="ArrowDown"
                  label={`Move ${name} down`}
                  disabled={index === lineup.length - 1}
                  onClick={() => save(moveModel(lineup, ref, 1))}
                />
                <IconButton icon="X" label={`Remove ${name}`} onClick={() => save(toggleModel(lineup, ref))} />
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {pick === null ? (
          <span className="text-sm text-muted-foreground">Loading models…</span>
        ) : (
          <ProviderModelPicker value={pick} onChange={setPick} />
        )}
        <Button
          type="button"
          size="sm"
          disabled={chosen === null || already || full}
          onClick={() => chosen !== null && save(toggleModel(lineup, chosen))}
        >
          <Icon name="Plus" className="size-4" />
          {already ? "Already in your lineup" : full ? `Full (${MAX_LINEUP} models)` : "Add to lineup"}
        </Button>
      </div>
    </div>
  );
}

function IconButton({ icon, label, disabled, onClick }: { icon: string; label: string; disabled?: boolean; onClick(): void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      disabled={disabled}
      className="size-7 text-muted-foreground hover:text-foreground"
      onClick={onClick}
    >
      <Icon name={icon} className="size-4" />
    </Button>
  );
}
