// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { deriveMacKey } from "../src/chromium";
import { createKeychain, type CommandResult } from "../src/keychain";

describe("the Keychain reader", () => {
  it("derives the key from the Safe Storage password and asks macOS once", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "hunter2\n", stderr: "" }));
    const keychain = createKeychain(run);
    expect(await keychain.key("Chrome Safe Storage", "Chrome")).toEqual(deriveMacKey("hunter2"));
    await keychain.key("Chrome Safe Storage", "Chrome");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"]);
  });

  it("tells a missing item from a refused prompt", async () => {
    const missing = createKeychain(async () => ({ code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." }));
    await expect(missing.key("Arc Safe Storage", "Arc")).rejects.toMatchObject({ code: "keychainMissing" });
    const denied = createKeychain(async () => ({ code: 51, stdout: "", stderr: "User interaction is not allowed." }));
    await expect(denied.key("Arc Safe Storage", "Arc")).rejects.toMatchObject({ code: "keychainDenied" });
  });

  it("reports a prompt still on screen and lets the next call collect its answer without a second prompt", async () => {
    let answer!: (result: CommandResult) => void;
    const run = vi.fn(() => new Promise<CommandResult>((resolve) => (answer = resolve)));
    const keychain = createKeychain(run, 20);
    await expect(keychain.key("Chrome Safe Storage", "Chrome")).rejects.toMatchObject({ code: "keychainPending" });
    const second = keychain.key("Chrome Safe Storage", "Chrome");
    answer({ code: 0, stdout: "later\n", stderr: "" });
    expect(await second).toEqual(deriveMacKey("later"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("asks again after a refusal", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 51, stdout: "", stderr: "denied" })
      .mockResolvedValueOnce({ code: 0, stdout: "ok\n", stderr: "" });
    const keychain = createKeychain(run);
    await expect(keychain.key("Chrome Safe Storage", "Chrome")).rejects.toMatchObject({ code: "keychainDenied" });
    expect(await keychain.key("Chrome Safe Storage", "Chrome")).toEqual(deriveMacKey("ok"));
  });
});
