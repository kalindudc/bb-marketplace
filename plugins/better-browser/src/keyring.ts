import { runCommand, type RunCommand } from "./keychain";

/** The password of Chromium's basic password store, which Linux builds fall back to without a keyring. */
export const BASIC_PASSWORD = "peanuts";

const SECRET_SCHEMAS = ["chrome_libsecret_os_crypt_password_v2", "chrome_libsecret_os_crypt_password_v1"];
const KWALLET_WALLET = "kdewallet";
const LEGACY_KWALLET_FOLDER = "Passwords";

/**
 * The passwords Linux Chromium browsers may have encrypted their cookies with, most likely first: the browser's
 * "Safe Storage" secret from the Secret Service (GNOME Keyring, or KWallet's own Secret Service backend) under each
 * schema Chromium has used, then KWallet's own CLI, then the basic store's password. The host tries each against real
 * ciphertext, so a candidate that does not fit this browser costs only a moment and never a wrong read.
 */
export function createLinuxKeyring(run: RunCommand = runCommand) {
  const cache = new Map<string, Promise<string[]>>();

  async function read(apps: readonly string[], label: string): Promise<string[]> {
    const found: string[] = [];
    for (const app of apps) {
      for (const schema of SECRET_SCHEMAS) {
        const result = await run("secret-tool", ["lookup", "application", app, "xdg:schema", schema]);
        const password = result.stdout.replace(/\r?\n$/, "");
        if (result.code === 0 && password) found.push(password);
      }
    }
    // Chromium keeps its KWallet entry in a "<Product> Keys" folder; "Passwords" is where older setups kept it.
    const kwalletFolder = `${label.split(" ")[0]} Keys`;
    for (const folder of [kwalletFolder, LEGACY_KWALLET_FOLDER]) {
      const wallet = await run("kwallet-query", ["-r", label, KWALLET_WALLET, "-f", folder]);
      if (wallet.code !== 0) continue;
      const password = wallet.stdout.replace(/\r?\n$/, "");
      if (password) found.push(password);
    }
    found.push(BASIC_PASSWORD);
    return [...new Set(found)];
  }

  return {
    secrets(apps: readonly string[], label: string): Promise<string[]> {
      const id = `${apps.join("\u0000")}\u0000${label}`;
      let request = cache.get(id);
      if (!request) {
        request = read(apps, label);
        cache.set(id, request);
      }
      return request;
    },
    forget(): void {
      cache.clear();
    },
  };
}

export type LinuxKeyring = ReturnType<typeof createLinuxKeyring>;
