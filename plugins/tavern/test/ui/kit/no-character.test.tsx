// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { CrestOf, KeeperRow, characterName, memberIdentity } from "../../../src/ui/kit";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { registry, richRoom } from "../page/scenes";
import type { Room } from "../../../src/shared/contract";

afterEach(cleanup);
type Keeper = Room["keepers"][number];
const smith = registry.classes.find(c => c.id === "smith")!;
const nobody = { classId: "smith", characterId: null, displayName: null };

describe("a member with no character", () => {
  it("is named by its class label and drawn as its class's plain crest", () => {
    const identity = memberIdentity(registry, nobody)!;
    expect(identity.character).toMatchObject({ name: smith.label, plain: true });
    expect(characterName(registry, nobody)).toBe(smith.label);
    const { container } = render(<CrestOf member={nobody} registry={registry} />);
    const crest = container.querySelector("svg.tavern-crest")!;
    expect(crest.getAttribute("aria-label")).toBe(`${smith.label}, no character`);
    expect(crest.querySelectorAll("path")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/null|undefined/);
  });

  it("keeps a display name, and falls back to the class for a character the registry no longer knows", () => {
    expect(characterName(registry, { ...nobody, displayName: "Juno II" })).toBe("Juno II");
    expect(memberIdentity(registry, { classId: "smith", characterId: "gone-character" })!.character).toMatchObject({ name: smith.label, plain: true });
    expect(memberIdentity(registry, { classId: "no-such-class", characterId: null })).toBeNull();
  });

  it("reads as its class in a Keeper row and in the widget row, never blank", async () => {
    const { displayName: _drop, ...keeperMember } = richRoom.keepers[0]!.member;
    const k: Keeper = { ...richRoom.keepers[0]!, member: { ...keeperMember, characterId: null }, archived: false };
    const keeperLabel = registry.classes.find(c => c.id === k.member.classId)!.label;
    const page = await loadPluginApp(definePluginApp(a => { a.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: () => <KeeperRow keeper={k} room={{ keepers: [k], decidedForYou: [] }} registry={registry} /> } as never); }));
    const row = renderSlot(page.navPanels[0]!, { subPath: "" }, {});
    expect((await row.findByRole("button", { name: new RegExp(`^Open ${keeperLabel}'s thread`) }))).toBeTruthy();
    cleanup();
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const banner = app.composerCustomizations.find(c => c.id === "tavern-thread")!.banners![0]!;
    const decor = { ...fixtureDecor, member: { ...fixtureDecor.member!, characterId: null, displayName: null } };
    const slot = renderSlot(banner, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" }, text: "" }, rpc: { decor: () => decor, registry: () => fixtureRegistry } });
    await slot.findByRole("region", { name: "Tavern widget" });
    const crest = slot.container.querySelector(".tw-id svg.tavern-crest")!;
    expect(crest.getAttribute("aria-label")).toMatch(/, no character$/);
    expect(slot.container.querySelector(".tw-id")!.getAttribute("title")).not.toMatch(/null/);
  });
});

describe("a Warden whose independence is not established", () => {
  it("is tagged as such and never counted as an independent check", async () => {
    const { CheckIndependence, taleFigures } = await import("../../../src/ui/kit");
    const { readmeDetail } = await import("../page/scenes");
    const { container } = render(<CheckIndependence member={{ checkIndependence: "not-established" }} />);
    expect(container.textContent).toBe("check independence not established");
    const members = readmeDetail.quest.members.map(m => m.classId === "warden" ? { ...m, checkIndependence: "not-established" as const } : m);
    const figures = taleFigures({ ...readmeDetail, quest: { ...readmeDetail.quest, members } });
    const checks = figures.find(f => /^checks?$/.test(f.label));
    expect(checks?.value).toMatch(/independence not established/);
    expect(checks?.value).not.toMatch(/\d+ independent/);
  });
});
