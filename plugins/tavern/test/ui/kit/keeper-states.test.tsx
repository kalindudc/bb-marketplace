// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { Glyph, KEEPER_STATE_HINT, KeeperRow, StateMark, keeperStatus } from "../../../src/ui/kit";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { registry, richRoom } from "../page/scenes";
import type { Room } from "../../../src/shared/contract";

afterEach(cleanup);
type Keeper = Room["keepers"][number];
const keeper = richRoom.keepers[0]!;

const cases: [Partial<Keeper>, string, string][] = [
  [{ status: "listening", quietSince: null, archived: false }, "Idle", "Between turns. It takes your next message, or its party's next report."],
  [{ status: "busy", quietSince: null, archived: false }, "Busy", "Working on a turn now."],
  [{ status: "holding", quietSince: null, archived: false }, "Holding while you type", "Tavern holds its updates while you type to it."],
  [{ status: "listening", quietSince: 5, archived: false }, "Quiet", "You've paused its updates. Your messages still reach it."],
  [{ status: "busy", quietSince: null, archived: true }, "Thread archived", "Its thread is archived; its quests and record are kept."],
];

describe("a Keeper's state", () => {
  it.each(cases)("%o reads %s and explains itself on hover", async (patch, label, hint) => {
    const k: Keeper = { ...keeper, ...patch };
    expect(keeperStatus(k)).toMatchObject({ label, hint });
    const app = await loadPluginApp(definePluginApp(a => { a.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: () => <KeeperRow keeper={k} room={{ keepers: [k], decidedForYou: [] }} registry={registry} /> } as never); }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {});
    expect((await slot.findByText(label)).closest(".tv-st")!.getAttribute("title")).toBe(`${label}: ${hint}`);
    expect(slot.container.textContent).not.toMatch(/listening/i);
  });

  it("explains a state wherever StateMark draws it, unless the caller gives its own title", () => {
    const { container } = render(<><StateMark tone="idle">Idle</StateMark><StateMark tone="busy">Busy</StateMark><StateMark tone="listening">Idle</StateMark><StateMark tone="busy" title="Own">Busy</StateMark><StateMark tone="done">Done</StateMark></>);
    expect([...container.querySelectorAll(".tv-st")].map(e => e.getAttribute("title"))).toEqual([KEEPER_STATE_HINT.idle, KEEPER_STATE_HINT.busy, KEEPER_STATE_HINT.idle, "Own", null]);
  });

  it("says idle in the widget row's tooltip, with what it means", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const banner = app.composerCustomizations.find(c => c.id === "tavern-thread")!.banners![0]!;
    const decor = { ...fixtureDecor, keeperView: { ...fixtureDecor.keeperView!, status: "listening" as const, quietSince: null } };
    const slot = renderSlot(banner, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" }, text: "" }, rpc: { decor: () => decor, registry: () => fixtureRegistry } });
    await slot.findByRole("region", { name: "Tavern widget" });
    const id = slot.container.querySelector(".tw-id")!;
    expect(id.getAttribute("title")).toContain(`Idle: ${KEEPER_STATE_HINT.idle}`);
    expect(id.getAttribute("title")).not.toMatch(/listening/i);
  });
});

describe("the work mark", () => {
  it.each(["st-work", "st-busy"] as const)("%s is a closed ring with a filled half, never an open arc", name => {
    const { container } = render(<Glyph name={name} />);
    const paths = [...container.querySelectorAll("path")];
    expect(paths).toHaveLength(2);
    expect(paths[0]!.getAttribute("fill")).toBe("currentColor");
    expect(paths[1]!.getAttribute("d")).toMatch(/Z$/);
  });
});

describe("controls inside a clickable row", () => {
  const css = readFileSync("src/ui/kit/components.css", "utf8");
  it("keep the row unlit while Tale or Cellar is hovered or focused, and light as their own box", () => {
    expect(css).toContain(".tavern.qrow:hover:not(:has(:is(.qrow-tale, .qrow-x):is(:hover, :focus-visible))) { background: var(--tavern-hover); }");
    expect(css).toMatch(/\.tavern\.qrow :is\(\.qrow-tale, \.qrow-x\)\.act:is\(:hover, :focus-visible\):not\(:disabled\) \{[^}]*background: var\(--tavern-inner-hover\);[^}]*box-shadow: inset 0 0 0 1px var\(--tavern-muted\);[^}]*cursor: pointer;/);
  });
  it("leave the Keeper row's decided count part of the row, explained in the row's tooltip", async () => {
    expect(css).not.toMatch(/\.krow-dec \{ position: relative; z-index: 1; \}/);
    const k: Keeper = { ...keeper, status: "listening", quietSince: null, archived: false };
    const decided = richRoom.decidedForYou[0]!;
    const room = { keepers: [k], decidedForYou: [{ ...decided, keeperThreadId: k.member.threadId, undone: false, seenAt: null }] };
    const app = await loadPluginApp(definePluginApp(a => { a.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: () => <KeeperRow keeper={k} room={room} registry={registry} /> } as never); }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {});
    const open = await slot.findByRole("button", { name: /^Open .*'s thread/ });
    expect(open.getAttribute("title")).toMatch(/· 1 decided for you \(reversible calls\), not yet seen$/);
    expect(slot.container.querySelector(".krow-dec")!.getAttribute("title")).toBeNull();
  });
});
