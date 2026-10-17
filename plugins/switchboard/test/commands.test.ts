import { describe, expect, it, vi } from "vitest";
import { createCommands, registerListHandlers } from "../src/commands";

describe("palette commands", () => {
  it("registers four named commands and only the two non-colliding default shortcuts", () => {
    const commands = createCommands();
    expect(commands.map(({ id, title, defaultShortcut }) => ({ id, title, defaultShortcut }))).toEqual([
      { id: "focus-filter", title: "Switchboard: Focus the thread filter", defaultShortcut: { key: "f", mod: true, alt: true } },
      { id: "next-needs-you", title: "Switchboard: Go to the next thread that needs you", defaultShortcut: { key: "j", mod: true, alt: true } },
      { id: "toggle-view", title: "Switchboard: Switch between sections and status lanes", defaultShortcut: undefined },
      { id: "new-section", title: "Switchboard: New section", defaultShortcut: undefined },
    ]);
  });

  it("is available only while the list is registered and runs the matching handler", () => {
    const commands = createCommands();
    const context = {} as Parameters<(typeof commands)[number]["run"]>[0];
    expect(commands.every((command) => command.isAvailable?.(context) === false)).toBe(true);
    const handlers = { focusFilter: vi.fn(), nextNeedsYou: vi.fn(), toggleView: vi.fn(), newSection: vi.fn() };
    const unregister = registerListHandlers(handlers);
    expect(commands.every((command) => command.isAvailable?.(context) === true)).toBe(true);
    for (const command of commands) void command.run(context);
    for (const callback of Object.values(handlers)) expect(callback).toHaveBeenCalledOnce();
    unregister();
    expect(commands.every((command) => command.isAvailable?.(context) === false)).toBe(true);
  });
});
