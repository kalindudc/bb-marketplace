// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { LineupSettings } from "../src/settings";
import { resetStore } from "../src/store";
import type { LineupState } from "../src/lineup";

afterEach(() => {
  cleanup();
  resetStore();
});

function render(models: (providerId: string) => Promise<unknown>) {
  let stored: LineupState = { lineup: [], lastView: "native" };
  const pins: unknown[] = [];
  const config: RenderSlotOptions = {
    rpc: {
      state: () => stored,
      catalog: () => ({ providers: [] }),
      pin: (input: unknown) => {
        pins.push(input);
        const { providerId, model } = input as { providerId: string; model: string };
        stored = { ...stored, lineup: [...stored.lineup, { providerId, model }] };
        return stored;
      },
    },
    providers: {
      status: "ready",
      providers: [{ id: "broken", displayName: "Broken" }, { id: "codex", displayName: "Codex" }] as never,
    },
    sdk: { providers: { models: ({ providerId }: { providerId: string }) => models(providerId) } } as unknown as RenderSlotOptions["sdk"],
  };
  return { slot: renderSlot({ component: LineupSettings }, {}, config), pins };
}

const gpt4 = { model: "gpt-4", displayName: "GPT-4", defaultReasoningEffort: "medium", isDefault: false };

describe("Lineup settings", () => {
  it("skips a provider that fails and starts the picker on the next one, including models bb lists only when selected", async () => {
    const { slot, pins } = render(async (providerId) => {
      if (providerId === "broken") throw new Error("not signed in");
      return { modelLoadError: null, models: [], selectedOnlyModels: [gpt4] };
    });
    const picker = await slot.findByTestId("bb-provider-model-picker");
    expect((picker.querySelector('[aria-label="Provider ID"]') as HTMLInputElement).value).toBe("codex");
    expect((picker.querySelector('[aria-label="Model"]') as HTMLInputElement).value).toBe("gpt-4");
    fireEvent.click(slot.getByRole("button", { name: /Add to lineup/ }));
    await waitFor(() => expect(pins).toEqual([{ providerId: "codex", model: "gpt-4", pinned: true }]));
  });

  it("says so when no provider offers a model, instead of loading forever", async () => {
    const { slot } = render(async () => {
      throw new Error("offline");
    });
    expect(await slot.findByText(/No provider offered a model/)).toBeTruthy();
    expect(slot.queryByText("Loading models…")).toBeNull();
  });
});
