import { describe, expect, it, vi } from "vitest";
import { openWorktreeTerminal, shellQuote, terminalCommand } from "../src/terminal";

describe("shellQuote", () => {
  it("wraps a path in single quotes, keeping spaces", () => {
    expect(shellQuote("/work/my project")).toBe("'/work/my project'");
  });

  it("turns each single quote into '\\''", () => {
    expect(shellQuote("/work/it's")).toBe("'/work/it'\\''s'");
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});

describe("terminalCommand", () => {
  it("changes into the directory and replaces itself with the user's login shell", () => {
    expect(terminalCommand("/work/it's here")).toBe(`cd '/work/it'\\''s here' && exec "\${SHELL:-/bin/sh}" -l`);
  });
});

describe("openWorktreeTerminal", () => {
  const input = { threadId: "thr_1", path: "/work/one", title: "Child A · feature/work" };

  it("starts a thread-scoped terminal that runs the command, then shows it in the panel", async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ id: "term_1" }));
    const experimental_openTerminal = vi.fn(async (..._args: unknown[]) => true);
    const opened = await openWorktreeTerminal(
      { terminals: { create } } as never, { experimental_openTerminal } as never, input,
    );
    expect(opened).toBe(true);
    expect(create).toHaveBeenCalledWith({
      cols: 120, rows: 32, scope: { kind: "thread", threadId: "thr_1" }, title: "Child A · feature/work",
      start: { mode: "command", command: terminalCommand("/work/one") },
    });
    expect(experimental_openTerminal).toHaveBeenCalledWith({ terminalId: "term_1" });
  });

  it("returns false when bb cannot show the terminal, and lets a failed create reject", async () => {
    const create = vi.fn(async (..._args: unknown[]) => ({ id: "term_1" }));
    expect(await openWorktreeTerminal({ terminals: { create } } as never, { experimental_openTerminal: async () => false } as never, input)).toBe(false);
    create.mockRejectedValueOnce(new Error("no terminal for you"));
    await expect(openWorktreeTerminal({ terminals: { create } } as never, { experimental_openTerminal: async () => true } as never, input)).rejects.toThrow("no terminal for you");
  });
});
