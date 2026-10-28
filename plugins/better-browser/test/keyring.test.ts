// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CommandResult } from "../src/keychain";
import { createLinuxKeyring } from "../src/keyring";

type Run = (file: string, args: readonly string[]) => Promise<CommandResult>;

function fakeRun(responses: Record<string, CommandResult>): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const run: Run = async (file, args) => {
    calls.push([file, ...args].join(" "));
    return responses[[file, ...args].join(" ")] ?? { code: 127, stdout: "", stderr: `${file}: not found` };
  };
  return { run, calls };
}

const secretTool = (application: string, schema: string) => `secret-tool lookup application ${application} xdg:schema ${schema}`;
const v1 = "chrome_libsecret_os_crypt_password_v1";
const v2 = "chrome_libsecret_os_crypt_password_v2";

describe("the Linux keyring", () => {
  it("reads the Safe Storage secret from the Secret Service and keeps the basic store as a fallback", async () => {
    const { run } = fakeRun({ [secretTool("chrome", v2)]: { code: 0, stdout: "s3cret\n", stderr: "" } });
    const keyring = createLinuxKeyring(run);
    expect(await keyring.secrets(["chrome"], "Chrome Safe Storage")).toEqual(["s3cret", "peanuts"]);
  });

  it("falls back to the older schema, then KWallet, then the basic store", async () => {
    const { run } = fakeRun({
      [secretTool("brave", v1)]: { code: 0, stdout: "older\n", stderr: "" },
      [`kwallet-query -r Brave Safe Storage kdewallet -f Passwords`]: { code: 0, stdout: "wallet\n", stderr: "" },
    });
    const keyring = createLinuxKeyring(run);
    expect(await keyring.secrets(["brave"], "Brave Safe Storage")).toEqual(["older", "wallet", "peanuts"]);
  });

  it("still offers the basic store when no keyring answers", async () => {
    const { run } = fakeRun({});
    const keyring = createLinuxKeyring(run);
    expect(await keyring.secrets(["chromium"], "Chromium Safe Storage")).toEqual(["peanuts"]);
  });

  it("reads each candidate application a browser may store its secret under", async () => {
    const { run, calls } = fakeRun({ [secretTool("vivaldi", v2)]: { code: 0, stdout: "v\n", stderr: "" } });
    const keyring = createLinuxKeyring(run);
    await keyring.secrets(["vivaldi-stable", "vivaldi"], "Vivaldi Safe Storage");
    expect(calls.filter((call) => call.startsWith("secret-tool"))).toEqual([
      secretTool("vivaldi-stable", v2),
      secretTool("vivaldi-stable", v1),
      secretTool("vivaldi", v2),
      secretTool("vivaldi", v1),
    ]);
  });

  it("asks the keyring once per browser and forgets on dispose", async () => {
    const { run, calls } = fakeRun({});
    const keyring = createLinuxKeyring(run);
    await keyring.secrets(["chrome"], "Chrome Safe Storage");
    await keyring.secrets(["chrome"], "Chrome Safe Storage");
    expect(calls).toHaveLength(4);
    keyring.forget();
    await keyring.secrets(["chrome"], "Chrome Safe Storage");
    expect(calls).toHaveLength(8);
  });
});
