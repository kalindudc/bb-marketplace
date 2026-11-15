// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { definePluginApp, type ComposerMention } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { NAMES_PROVIDER, swapNameMentions } from "../../../src/ui/thread/mentions";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";

afterEach(cleanup);

const juno: ComposerMention = { kind: "plugin", pluginId: "test-plugin", provider: NAMES_PROVIDER, id: "thr_juno", label: "Juno", from: 4, to: 9 };
const text = "ask @Juno whether staging is green";

async function swapIn(scope: "thread" | "new-thread", mentions: ComposerMention[]) {
  const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const id = scope === "thread" ? "tavern-thread" : "tavern-new-thread";
  const banner = app.composerCustomizations.find(c => c.id === id)!.banners!.find(b => b.id === "names")!;
  return renderSlot(banner, {}, {
    composer: { scope: scope === "thread" ? { kind: "thread", threadId: "keeper-1" } : { kind: "new-thread", projectId: "p1" } as never, text, mentions },
    rpc: { decor: () => fixtureDecor, registry: () => fixtureRegistry },
  });
}

describe("a Tavern name mention becomes bb's thread mention", () => {
  it.each(["thread", "new-thread"] as const)("in a %s composer, over the same text and range, drawing nothing", async scope => {
    const slot = await swapIn(scope, [juno]);
    await waitFor(() => expect(slot.inspection.composer.draft.mentions[0]).toEqual({ kind: "thread", threadId: "thr_juno", label: "Juno", from: 4, to: 9 }));
    expect(slot.inspection.composer.draft.text).toBe(text);
    expect(slot.container.textContent).toBe("");
  });

  it("preserves a numeralled provider title as the thread mention label", () => {
    const draft = { text: "ask @Juno II now", mentions: [{ ...juno, label: "Juno II", from: 4, to: 12 }], attachments: [] };
    const swapped = swapNameMentions(draft, "test-plugin");
    expect(swapped.text).toBe(draft.text);
    expect(swapped.mentions[0]).toEqual({ kind: "thread", threadId: "thr_juno", label: "Juno II", from: 4, to: 12 });
  });

  it("leaves the class pill, another plugin's pills and bb's own mentions alone", () => {
    const others: ComposerMention[] = [
      { kind: "plugin", pluginId: "test-plugin", provider: "classes", id: "keeper", label: "Keeper", from: 0, to: 3 },
      { kind: "plugin", pluginId: "other-plugin", provider: NAMES_PROVIDER, id: "x", label: "X", from: 10, to: 12 },
      { kind: "thread", threadId: "thr_rook", label: "Rook", from: 14, to: 19 },
    ];
    const draft = { text: "x".repeat(30), mentions: others, attachments: [] };
    expect(swapNameMentions(draft, "test-plugin")).toBe(draft);
    const mixed = swapNameMentions({ ...draft, mentions: [...others, { ...juno, from: 21, to: 26 }] }, "test-plugin");
    expect(mixed.mentions.slice(0, 3)).toEqual(others);
    expect(mixed.mentions[3]).toEqual({ kind: "thread", threadId: "thr_juno", label: "Juno", from: 21, to: 26 });
    expect("attachments" in mixed).toBe(false);
  });
});
