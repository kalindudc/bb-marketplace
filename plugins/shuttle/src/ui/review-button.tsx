import { toast } from "sonner";
import { experimental_Icon as Icon, experimental_usePluginId, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Preset } from "../config";
import type { PrView, ReviewInput } from "../contract";
import { BUTTON, MENU_ITEM, Menu } from "./common";
import { settingsHref, shortKey } from "./format";
import { useShuttleMutation } from "./data";

/** The preset the server uses when a review names none. */
export const defaultPresetOf = (presets: readonly Preset[]): Preset | null => presets.find((preset) => preset.default) ?? presets[0] ?? null;

export function presetSummary(preset: Pick<Preset, "skill" | "model" | "reasoningLevel">): string {
  const parts = [preset.skill || "no skill", preset.model ?? "bb default model"];
  if (preset.reasoningLevel) parts.push(`thinking ${preset.reasoningLevel}`);
  return parts.join(" · ");
}

export function useStartReview() {
  const review = useShuttleMutation("review");
  const navigate = useBbNavigate();
  const start = async (input: ReviewInput, presetName: string) => {
    const result = await review.run(input);
    if (result !== null) {
      toast.success(`${presetName}: review thread started`, { action: { label: "Open", onClick: () => navigate.toThread(result.threadId) } });
    }
    return result;
  };
  return { busy: review.isPending, start };
}

/** Review with the default preset, or pick another from the arrow beside it. */
export function ReviewButton({ pr, presets, onCustomize }: { pr: PrView; presets: readonly Preset[] | null; onCustomize(pr: PrView): void }) {
  const pluginId = experimental_usePluginId();
  const { busy, start } = useStartReview();
  const preset = presets === null ? null : defaultPresetOf(presets);
  return (
    <span className="inline-flex">
      <button type="button" disabled={busy} className={`${BUTTON} rounded-r-none`} title={preset ? `Review with ${preset.name}` : "Review with your default preset"}
        onClick={() => void start({ key: pr.key }, preset?.name ?? "Default preset")}>
        <Icon name="Bot" className="size-3.5" aria-hidden />
        Review
      </button>
      <Menu label={`Pick a preset to review ${shortKey(pr)}`} trigger={<Icon name="ChevronDown" className="size-3.5" aria-hidden />}>
        {(close) => (
          <>
            {presets === null && <span className="px-2.5 py-1.5 text-xs text-muted-foreground">Loading presets…</span>}
            {presets?.map((item) => (
              <button key={item.id} type="button" role="menuitem" className={MENU_ITEM} onClick={() => { close(); void start({ key: pr.key, presetId: item.id }, item.name); }}>
                <span className="flex items-center gap-2 font-semibold">
                  {item.name}
                  {item.default && <span className="rounded-full border border-border px-1.5 text-[10.5px] font-normal text-muted-foreground">default</span>}
                </span>
                <span className="text-xs text-muted-foreground">{presetSummary(item)}</span>
              </button>
            ))}
            <span className="my-1 border-t border-border" />
            <button type="button" role="menuitem" className={`${MENU_ITEM} flex-row items-center gap-2`} onClick={() => { close(); onCustomize(pr); }}>
              <Icon name="SlidersHorizontal" className="size-3.5" aria-hidden />
              Customize this run…
            </button>
            <UrlLink role="menuitem" href={settingsHref(pluginId)} className={`${MENU_ITEM} flex-row items-center gap-2 text-muted-foreground`} onClick={() => close()}>
              <Icon name="Settings" className="size-3.5" aria-hidden />
              Edit presets in Settings
            </UrlLink>
          </>
        )}
      </Menu>
    </span>
  );
}
