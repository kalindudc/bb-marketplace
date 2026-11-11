import { experimental_ProviderIcon as ProviderIcon } from "@get-bb/plugin-sdk/app";

/** "pi / anthropic/claude-opus-5-5" as the provider's icon and "claude-opus-5-5", the whole name in its title. */
export function ModelName({ model }: { model: string }) {
  const [provider, ...rest] = model.split(" / ");
  const name = rest.join(" / ").trim() || model;
  return (
    <span data-model-name={model} title={model} className="inline-flex min-w-0 items-center gap-1.5">
      <ProviderIcon providerKind="agent" provider={{ id: provider!.trim() }} fallback="Bot" aria-label={provider!.trim()} className="size-3.5 shrink-0" />
      <span className="truncate">{name.split("/").at(-1)}</span>
    </span>
  );
}
